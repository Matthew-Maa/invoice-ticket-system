import os from 'node:os';
import { buildApp } from './app.js';
import { resolveAdminKey } from './admin-key.js';
import { backend, closeDatabase, describe, init } from './db.js';

const PORT = Number(process.env.PORT ?? 8102);
const HOST = process.env.HOST ?? '0.0.0.0';

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

try {
  await init();
} catch (err) {
  console.error(`\n  数据库初始化失败（${backend}）：${err.message}\n  检查 DATABASE_URL 是否正确、数据库是否可访问。\n`);
  process.exit(1);
}

const { key, source } = resolveAdminKey();
const { app } = buildApp({ adminKey: key });

await app.listen({ port: PORT, host: HOST });

const db = describe();
const sourceText =
  source === 'env'
    ? '来自环境变量 ADMIN_KEY'
    : source === 'file'
      ? '来自 data/admin-key.txt'
      : '本次自动生成并已保存到 data/admin-key.txt';

console.log('');
console.log('  领票系统已启动');
console.log('  ────────────────────────────────────────────');
console.log(`  抢票端   http://localhost:${PORT}/`);
console.log(`  发票端   http://localhost:${PORT}/admin`);
for (const ip of lanAddresses()) {
  console.log(`  局域网   http://${ip}:${PORT}/   (手机连同一 WiFi 时用这个)`);
}
console.log(`  秘钥     ${key}   (${sourceText})`);
console.log(`  存储     [${db.driver}] ${db.target}`);
console.log('');

// Render 重新部署 / 重启时会发 SIGTERM，优雅收尾，别把数据库连接晾着
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`\n  收到 ${sig}，正在关闭…`);
    try {
      await app.close();
      await closeDatabase();
    } catch {}
    process.exit(0);
  });
}
