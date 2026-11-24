import fs from 'node:fs';
import path from 'node:path';

/** 数据目录：本地默认 <项目>/data，部署时可用 DATA_DIR 指向持久盘 */
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(process.cwd(), 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });
