/**
 * 端到端冒烟测试：在内存临时数据目录里真起一个 HTTP 服务，跑完整个业务流。
 * 运行： npm run smoke
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tickits-smoke-'));
process.env.DATA_DIR = tmpDir; // 临时数据目录，跑完删掉，不碰真实名单
process.env.ADMIN_KEY = 'smoke-key';

const { buildApp } = await import('../src/app.js');
const db = await import('../src/db.js');
const { closeDatabase, describe, init } = db;

await init();
const driverInfo = describe();

const { app } = buildApp({ adminKey: 'smoke-key' });
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${app.server.address().port}`;

let pass = 0;
const fails = [];
async function check(label, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    fails.push(`${label} → ${err.message}`);
    console.log(`  ✗ ${label} → ${err.message}`);
  }
}

const call = async (url, { method = 'GET', body, key } = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { 'x-admin-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data, text };
};

const K = 'smoke-key';
console.log(`\n领票系统冒烟测试（存储后端：${driverInfo.driver} → ${driverInfo.target}）\n`);

// 每次跑都从干净状态开始
await call('/api/admin/reset', { method: 'POST', key: K, body: { confirm: 'DELETE' } });

await check('初始状态：无票型、开放领票', async () => {
  const { data } = await call('/api/state');
  assert.equal(data.ok, true);
  assert.equal(data.open, true);
  assert.deepEqual(data.types, []);
});

await check('秘钥错误被拒（401）', async () => {
  const { status, data } = await call('/api/admin/data', { key: 'wrong' });
  assert.equal(status, 401);
  assert.equal(data.code, 'BAD_KEY');
});

await check('无秘钥访问发票端接口被拒（401）', async () => {
  const { status } = await call('/api/admin/data');
  assert.equal(status, 401);
});

await check('发票端设置票型：内场票 2 张、看台票 1 张', async () => {
  const { data } = await call('/api/admin/types', {
    method: 'POST',
    key: K,
    body: { types: [{ name: '内场票', total: 2 }, { name: '看台票', total: 1 }] },
  });
  assert.equal(data.ok, true);
  assert.deepEqual(data.types.map((t) => [t.name, t.total, t.remaining]), [['内场票', 2, 2], ['看台票', 1, 1]]);
});

await check('抢票端能查到各票型剩余', async () => {
  const { data } = await call('/api/state');
  assert.deepEqual(data.types.map((t) => `${t.name}:${t.remaining}/${t.total}`), ['内场票:2/2', '看台票:1/1']);
});

let innerId;
await check('A 同学领内场票成功，票号 001，余票变 1', async () => {
  const st = await call('/api/state');
  innerId = st.data.types.find((t) => t.name === '内场票').id;
  const { data } = await call('/api/claim', { method: 'POST', body: { name: '张三', studentId: '2023001', typeId: innerId } });
  assert.equal(data.ok, true);
  assert.equal(data.claim.seat_no, 1);
  assert.equal(data.types.find((t) => t.name === '内场票').remaining, 1);
});

await check('同一学号重复领取被拒（409 DUPLICATE）', async () => {
  const { status, data } = await call('/api/claim', { method: 'POST', body: { name: '张三', studentId: '2023001', typeId: innerId } });
  assert.equal(status, 409);
  assert.equal(data.code, 'DUPLICATE');
});

await check('B 同学领内场票：票号 002，余票 0', async () => {
  const { data } = await call('/api/claim', { method: 'POST', body: { name: '李四', studentId: '2023002', typeId: innerId } });
  assert.equal(data.claim.seat_no, 2);
  assert.equal(data.types.find((t) => t.name === '内场票').remaining, 0);
});

await check('售罄后继续领被拒（409 SOLD_OUT）', async () => {
  const { status, data } = await call('/api/claim', { method: 'POST', body: { name: '王五', studentId: '2023003', typeId: innerId } });
  assert.equal(status, 409);
  assert.equal(data.code, 'SOLD_OUT');
});

await check('学号格式不对被拒（400 BAD_SID）', async () => {
  const { status, data } = await call('/api/claim', { method: 'POST', body: { name: '王五', studentId: 'a', typeId: innerId } });
  assert.equal(status, 400);
  assert.equal(data.code, 'BAD_SID');
});

await check('王五改领看台票成功（不含已售罄的内场）', async () => {
  const st = await call('/api/state');
  const standId = st.data.types.find((t) => t.name === '看台票').id;
  const { data } = await call('/api/claim', { method: 'POST', body: { name: '王五', studentId: '2023003', typeId: standId } });
  assert.equal(data.ok, true);
  assert.equal(data.types.find((t) => t.name === '看台票').remaining, 0);
});

await check('发票端能看到全部 3 条记录', async () => {
  const { data } = await call('/api/admin/data', { key: K });
  assert.equal(data.claims.length, 3);
  assert.deepEqual(data.claims.map((c) => `${c.name}/${c.student_id}/${c.type_name}/${c.seat_no}`), [
    '张三/2023001/内场票/1',
    '李四/2023002/内场票/2',
    '王五/2023003/看台票/1',
  ]);
});

await check('导出 CSV 含表头与全部记录', async () => {
  const { text } = await call('/api/admin/claims.csv', { key: K });
  const lines = text.split('\r\n').filter(Boolean);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes('姓名') && lines[0].includes('学号'));
  assert.ok(text.includes('张三') && text.includes('2023003'));
});

await check('票数不能改成小于已领数量', async () => {
  const { status, data } = await call('/api/admin/types', { method: 'POST', key: K, body: { types: [{ name: '内场票', total: 1 }] } });
  assert.equal(status, 400);
  assert.ok(data.error.includes('内场票'));
});

await check('发票端删除一条记录后余票回升', async () => {
  const before = await call('/api/admin/data', { key: K });
  const target = before.data.claims.find((c) => c.student_id === '2023001');
  await call('/api/admin/claim/delete', { method: 'POST', key: K, body: { id: target.id } });
  const after = await call('/api/state');
  assert.equal(after.data.types.find((t) => t.name === '内场票').remaining, 1);
});

await check('关闭领票后抢票被拒（403 CLOSED）', async () => {
  await call('/api/admin/settings', { method: 'POST', key: K, body: { open: false } });
  const { status, data } = await call('/api/claim', { method: 'POST', body: { name: '赵六', studentId: '2023099', typeId: innerId } });
  assert.equal(status, 403);
  assert.equal(data.code, 'CLOSED');
  await call('/api/admin/settings', { method: 'POST', key: K, body: { open: true } });
});

await check('并发 20 人抢 10 张票：恰好 10 人成功，绝不超发', async () => {
  await call('/api/admin/reset', { method: 'POST', key: K, body: { confirm: 'DELETE' } });
  const set = await call('/api/admin/types', { method: 'POST', key: K, body: { types: [{ name: '限量票', total: 10 }] } });
  const id = set.data.types[0].id;
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      call('/api/claim', { method: 'POST', body: { name: `同学${i}`, studentId: `S${1000 + i}`, typeId: id } }),
    ),
  );
  const ok = results.filter((r) => r.data.ok).length;
  const soldOut = results.filter((r) => r.data.code === 'SOLD_OUT').length;
  assert.equal(ok, 10, `成功数应为 10，实际 ${ok}`);
  assert.equal(soldOut, 10);
  const st = await call('/api/state');
  assert.equal(st.data.types[0].remaining, 0);
  const seats = results.filter((r) => r.data.ok).map((r) => r.data.claim.seat_no).sort((a, b) => a - b);
  assert.deepEqual(seats, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '票号必须连续不重复');
});

await check('存储后端可用（SQLite 文件已落盘）', async () => {
  const dbFilePath = path.join(tmpDir, 'tickits.db');
  assert.ok(fs.existsSync(dbFilePath) && fs.statSync(dbFilePath).size > 0, 'SQLite 文件未生成');
});

await check('静态页面可访问（/ 与 /admin）', async () => {
  for (const p of ['/', '/admin']) {
    const res = await fetch(base + p);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('抢票端') && html.includes('发票端'));
  }
});

await app.close();
try {
  await closeDatabase(); // 关闭数据库句柄，否则 Windows 上临时目录删不掉
} catch {}
try {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
} catch {}

console.log(`\n[${driverInfo.driver}] 结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  console.log(fails.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('全部通过 ✅\n');
