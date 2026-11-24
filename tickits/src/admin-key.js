import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './data-dir.js';

const KEY_FILE = path.join(DATA_DIR, 'admin-key.txt');

/**
 * 发票端秘钥来源（优先级）：
 *   1. 环境变量 ADMIN_KEY（Render 上就用这个）
 *   2. data/admin-key.txt（首次启动自动生成并写入，启动日志会打印）
 */
export function resolveAdminKey() {
  const fromEnv = process.env.ADMIN_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: 'env' };

  if (fs.existsSync(KEY_FILE)) {
    const saved = fs.readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) return { key: saved, source: 'file' };
  }
  const generated = crypto.randomBytes(5).toString('hex'); // 10 位十六进制
  fs.writeFileSync(KEY_FILE, generated + '\n', 'utf8');
  return { key: generated, source: 'generated' };
}

/** 定长比较，避免计时侧信道 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
