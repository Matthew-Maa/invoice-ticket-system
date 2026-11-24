/**
 * 存储层门面：目前只有 SQLite 一种后端（Node 内置 node:sqlite，免编译原生依赖）。
 * 这里导出的函数全是 async，将来若要换云数据库，只需新增一个实现同一套函数的模块并在本文件切换，
 * 上层（src/app.js、src/server.js）不用改。
 */
export const backend = 'sqlite';
export * from './db-sqlite.js';
