/**
 * SQLite 后端（本地开发 / 单机部署，零配置）。
 * 与 Postgres 后端实现同一套 async 函数（见 src/db.js 的接口约定）。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './data-dir.js';
import { normalizeTypes } from './db-shared.js';

export const dbFile = path.join(DATA_DIR, 'tickits.db');

export const db = new DatabaseSync(dbFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ticket_types (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL UNIQUE,
    total      INTEGER NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    sort       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS claims (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
    name           TEXT    NOT NULL,
    student_id     TEXT    NOT NULL,
    seat_no        INTEGER NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_student ON claims(student_id);

  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`;

export async function init() {
  db.exec(SCHEMA); // SQLite 的建表是同步且幂等的
}

export function describe() {
  return { driver: 'sqlite', target: dbFile };
}

export async function getSettings() {
  const rows = db.prepare('SELECT k, v FROM settings').all();
  const out = { title: '领票登记', open: true };
  for (const r of rows) out[r.k] = r.k === 'open' ? r.v === '1' : r.v;
  return out;
}

export async function setSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  );
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    stmt.run(String(k), typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  return getSettings();
}

const TYPES_SQL = (where) => `
  SELECT t.id, t.name, t.total, t.active,
         COALESCE(c.cnt, 0) AS claimed,
         t.total - COALESCE(c.cnt, 0) AS remaining
    FROM ticket_types t
    LEFT JOIN (SELECT ticket_type_id, COUNT(*) AS cnt FROM claims GROUP BY ticket_type_id) c
           ON c.ticket_type_id = t.id
   ${where}
   ORDER BY t.active DESC, t.sort ASC, t.id ASC`;

/** 票型 + 已领 + 剩余 */
export async function listTypes({ includeInactive = false } = {}) {
  return db
    .prepare(TYPES_SQL(includeInactive ? '' : 'WHERE t.active = 1'))
    .all()
    .map((r) => ({ ...r, active: r.active === 1 }));
}

/**
 * 覆盖式设置票型：同名的票型复用（保留其已领记录），未出现在列表里的票型置为停用。
 * 已有领取记录多于新票数时直接报错，避免出现「超领」。
 */
export async function setTypes(types) {
  const norm = normalizeTypes(types);
  if (!norm.ok) return norm;

  const existing = db.prepare('SELECT id, name FROM ticket_types').all();
  const byName = new Map(existing.map((r) => [r.name, r.id]));

  for (const t of norm.types) {
    const id = byName.get(t.name);
    if (id == null) continue;
    const { claimed } = db
      .prepare('SELECT COUNT(*) AS claimed FROM claims WHERE ticket_type_id = ?')
      .get(id);
    if (claimed > t.total) {
      return { ok: false, error: `票型「${t.name}」已领 ${claimed} 张，票数不能小于该值` };
    }
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE ticket_types SET active = 0').run();
    const upsert = db.prepare(`
      INSERT INTO ticket_types (name, total, active, sort) VALUES (?, ?, 1, ?)
      ON CONFLICT(name) DO UPDATE SET total = excluded.total, active = 1, sort = excluded.sort
    `);
    norm.types.forEach((t, i) => upsert.run(t.name, t.total, i));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true, types: await listTypes() };
}

/** 领票：一个学号只能领一张（任何票型）；票型售罄即拒绝。整段在写事务里，避免并发超发。 */
export async function claim({ name, studentId, typeId }) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const dup = db
      .prepare('SELECT c.id, c.seat_no, t.name AS type_name FROM claims c JOIN ticket_types t ON t.id = c.ticket_type_id WHERE c.student_id = ?')
      .get(studentId);
    if (dup) {
      db.exec('ROLLBACK');
      return { ok: false, code: 'DUPLICATE', error: `该学号已领过「${dup.type_name}」（序号 ${dup.seat_no}）` };
    }

    const type = db
      .prepare('SELECT id, name, total FROM ticket_types WHERE id = ? AND active = 1')
      .get(typeId);
    if (!type) {
      db.exec('ROLLBACK');
      return { ok: false, code: 'NO_TYPE', error: '票型不存在或已下架，请刷新页面' };
    }

    const { claimed } = db
      .prepare('SELECT COUNT(*) AS claimed FROM claims WHERE ticket_type_id = ?')
      .get(type.id);
    if (claimed >= type.total) {
      db.exec('ROLLBACK');
      return { ok: false, code: 'SOLD_OUT', error: `「${type.name}」已领完` };
    }

    const { next } = db
      .prepare('SELECT COALESCE(MAX(seat_no), 0) + 1 AS next FROM claims WHERE ticket_type_id = ?')
      .get(type.id);
    const info = db
      .prepare('INSERT INTO claims (ticket_type_id, name, student_id, seat_no) VALUES (?, ?, ?, ?)')
      .run(type.id, name, studentId, next);
    const row = db
      .prepare(
        `SELECT c.id, c.name, c.student_id, c.seat_no, c.created_at, t.name AS type_name, t.id AS type_id
           FROM claims c JOIN ticket_types t ON t.id = c.ticket_type_id WHERE c.id = ?`,
      )
      .get(info.lastInsertRowid);
    db.exec('COMMIT');
    return { ok: true, claim: row };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  }
}

export async function listClaims() {
  return db
    .prepare(
      `SELECT c.id, c.name, c.student_id, c.seat_no, c.created_at, t.name AS type_name
         FROM claims c JOIN ticket_types t ON t.id = c.ticket_type_id
        ORDER BY t.sort ASC, c.id ASC`,
    )
    .all();
}

export async function deleteClaim(id) {
  return db.prepare('DELETE FROM claims WHERE id = ?').run(id).changes > 0;
}

/** 危险操作：清空所有领取记录（票型保留） */
export async function resetClaims() {
  return Number(db.prepare('DELETE FROM claims').run().changes);
}

export async function closeDatabase() {
  db.close();
}
