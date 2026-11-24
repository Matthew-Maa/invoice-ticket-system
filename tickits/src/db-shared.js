/** 两种存储后端共用的纯校验逻辑（不碰 SQL） */

/** 校验并规范化发票端提交的票型列表 */
export function normalizeTypes(types) {
  const normalized = [];
  const seen = new Set();

  for (const t of types) {
    const name = String(t?.name ?? '').trim();
    const total = Number(t?.total);
    if (!name) return { ok: false, error: '票型名称不能为空' };
    if (name.length > 40) return { ok: false, error: `票型「${name}」名称过长（≤40 字）` };
    if (!Number.isInteger(total) || total < 0 || total > 100000) {
      return { ok: false, error: `票型「${name}」的票数需为 0~100000 的整数` };
    }
    if (seen.has(name)) return { ok: false, error: `票型「${name}」重复` };
    seen.add(name);
    normalized.push({ name, total });
  }

  return { ok: true, types: normalized };
}

export const NAME_MAX = 24;
export const SID_RE = /^[A-Za-z0-9_-]{3,20}$/;
