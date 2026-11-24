import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { claim, deleteClaim, getSettings, listClaims, listTypes, resetClaims, setSettings, setTypes } from './db.js';
import { NAME_MAX, SID_RE } from './db-shared.js';
import { resolveAdminKey, safeEqual } from './admin-key.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

/** 极简内存限流：key -> {count, resetAt} */
function rateLimiter({ limit, windowMs }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || rec.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    rec.count += 1;
    return rec.count <= limit;
  };
}

export function buildApp({ adminKey } = {}) {
  const key = adminKey ?? resolveAdminKey().key;
  const app = Fastify({ logger: false, trustProxy: true });

  const loginLimit = rateLimiter({ limit: 20, windowMs: 60_000 });
  const claimLimit = rateLimiter({ limit: 30, windowMs: 60_000 });

  const bad = (reply, status, error, code) => reply.code(status).send({ ok: false, code, error });

  function requireAdmin(req, reply) {
    const provided = req.headers['x-admin-key'] ?? req.query?.key ?? req.body?.key ?? '';
    if (!provided || !safeEqual(provided, key)) {
      bad(reply, 401, '秘钥不正确', 'BAD_KEY');
      return false;
    }
    return true;
  }

  // ---------- 公共接口 ----------

  app.get('/api/state', async () => {
    const s = await getSettings();
    return { ok: true, title: s.title, open: s.open, types: await listTypes() };
  });

  app.post('/api/claim', async (req, reply) => {
    if (!claimLimit(req.ip)) return bad(reply, 429, '操作过于频繁，请稍后再试', 'RATE_LIMIT');

    const s = await getSettings();
    if (!s.open) return bad(reply, 403, '当前未开放领票', 'CLOSED');

    const name = String(req.body?.name ?? '').trim();
    const studentId = String(req.body?.studentId ?? '').trim();
    const typeId = Number(req.body?.typeId);

    if (!name) return bad(reply, 400, '请填写姓名', 'NO_NAME');
    if (name.length > NAME_MAX) return bad(reply, 400, `姓名过长（≤${NAME_MAX} 字）`, 'BAD_NAME');
    if (!SID_RE.test(studentId)) return bad(reply, 400, '学号格式不正确（3~20 位字母、数字、- 或 _）', 'BAD_SID');
    if (!Number.isInteger(typeId)) return bad(reply, 400, '请选择票型', 'NO_TYPE');

    const result = await claim({ name, studentId, typeId });
    if (!result.ok) {
      const status = result.code === 'DUPLICATE' || result.code === 'SOLD_OUT' ? 409 : 400;
      return bad(reply, status, result.error, result.code);
    }
    return { ok: true, claim: result.claim, types: await listTypes() };
  });

  // ---------- 发票端接口（需要秘钥） ----------

  app.post('/api/admin/login', async (req, reply) => {
    if (!loginLimit(req.ip)) return bad(reply, 429, '尝试过于频繁，请稍后再试', 'RATE_LIMIT');
    if (!requireAdmin(req, reply)) return;
    return { ok: true };
  });

  app.get('/api/admin/data', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const s = await getSettings();
    return {
      ok: true,
      title: s.title,
      open: s.open,
      types: await listTypes({ includeInactive: true }),
      claims: await listClaims(),
    };
  });

  app.post('/api/admin/types', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const types = req.body?.types;
    if (!Array.isArray(types) || types.length === 0) return bad(reply, 400, '至少配置一个票型', 'NO_TYPES');
    const res = await setTypes(types);
    if (!res.ok) return bad(reply, 400, res.error, 'BAD_TYPES');
    return { ok: true, types: res.types };
  });

  app.post('/api/admin/settings', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const patch = {};
    if (typeof req.body?.title === 'string') patch.title = req.body.title.trim().slice(0, 60) || '领票登记';
    if (typeof req.body?.open === 'boolean') patch.open = req.body.open;
    const s = await setSettings(patch);
    return { ok: true, title: s.title, open: s.open };
  });

  app.post('/api/admin/claim/delete', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const id = Number(req.body?.id);
    if (!Number.isInteger(id)) return bad(reply, 400, '缺少记录 id', 'NO_ID');
    const done = await deleteClaim(id);
    if (!done) return bad(reply, 404, '记录不存在', 'NOT_FOUND');
    return { ok: true };
  });

  app.post('/api/admin/reset', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (req.body?.confirm !== 'DELETE') return bad(reply, 400, '需要确认字段 confirm=DELETE', 'NO_CONFIRM');
    const removed = await resetClaims();
    return { ok: true, removed };
  });

  app.get('/api/admin/claims.csv', async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const rows = await listClaims();
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    // 学号前加制表符：防止 Excel 把前导 0 吃掉（CSV 里最省事的保号技巧）
    const sid = (v) => `"\t${String(v).replace(/"/g, '""')}"`;
    const csv =
      '\uFEFF' +
      [
        '姓名,学号,票型,票号,领取时间',
        ...rows.map((r) => [esc(r.name), sid(r.student_id), esc(r.type_name), esc(String(r.seat_no).padStart(3, '0')), esc(r.created_at)].join(',')),
      ].join('\r\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="claims.csv"')
      .send(csv);
  });

  // ---------- 静态页面 ----------

  app.register(fastifyStatic, { root: PUBLIC_DIR, index: 'index.html' });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return bad(reply, 404, '接口不存在', 'NOT_FOUND');
    return reply.sendFile('index.html'); // 前端单页：/admin 也走这里
  });

  return { app, adminKey: key };
}
