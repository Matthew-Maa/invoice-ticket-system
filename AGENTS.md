# AGENTS.md — 给 AI 编码助手的项目说明

> 本文件面向"下一个接手这个仓库的 LLM"。读完应能不改一行代码就定位到任意功能，并在动手前知道哪些约束不能碰。

## 1. 这是什么

**领票系统（tickits）**：一个"点开链接就能用"的双端领票小系统。

- **抢票端** `/`：填姓名 + 学号 → 看各票型剩余票数 → 选票型 → 确定领取 → 拿到票号。
- **发票端** `/admin`：凭秘钥登录 → 设置票型与票数 → 开关领票 → 看/删名单 → 导出 CSV。

技术栈刻意压到最小：**Node 24 + Fastify + 原生 HTML/CSS/JS**，零构建步骤。

- 持久化：**SQLite**，用 Node **内置** `node:sqlite`（不要引入 better-sqlite3 —— 那会带来原生编译，部署需要 node-gyp）。
- 单进程同时提供 API 和静态页面，部署到 Render（Starter 实例 + 1GB 持久盘）。
- 依赖只有两个：`fastify`、`@fastify/static`。

## 2. 怎么跑

```bash
npm install
npm start            # 生产入口 src/server.js，端口 $PORT 或 3000，监听 0.0.0.0
npm run dev          # 同上，带 --watch
npm run smoke        # 端到端冒烟测试（19 项断言）
```

启动日志会打印：抢票端/发票端地址、局域网地址、**发票端秘钥**、存储后端与数据位置。

环境变量：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `3000` |
| `ADMIN_KEY` | 发票端秘钥；**设置了就不再用文件** | 无 |
| `DATA_DIR` | 数据目录（SQLite 文件 + 秘钥文件） | `./data` |
| `HOST` | 监听地址 | `0.0.0.0` |

秘钥解析顺序（`src/admin-key.js`）：`ADMIN_KEY` 环境变量 → `DATA_DIR/admin-key.txt` → 自动生成 10 位十六进制并写文件、打印到日志。校验用 `crypto.timingSafeEqual`。

## 3. 目录结构（每行都重要）

```
src/server.js      入口：await init() → 建 Fastify → listen → 打印横幅 → 注册 SIGTERM/SIGINT 优雅关闭
src/app.js         buildApp({adminKey}) → 全部路由（不 listen，便于测试直接 import）
src/db.js          存储层门面：export * from './db-sqlite.js'（换后端只改这里）
src/db-sqlite.js   唯一存储实现：建表 SQL + 票型/领票/名单全部查询
src/db-shared.js   纯校验，无 SQL：normalizeTypes()、NAME_MAX、SID_RE
src/data-dir.js    DATA_DIR 解析 + 确保目录存在（db 和秘钥文件都用它）
src/admin-key.js   秘钥来源解析 + safeEqual
public/index.html  单页骨架：顶部 tab（抢票端/发票端）+ 两个 <section> 视图
public/app.js      前端全部逻辑（无框架）：路由、轮询、抢票、发票端面板
public/style.css   全部样式（浅色、留白、圆角卡片）
tools/smoke.js     端到端测试：真起服务 + 真发 HTTP + 19 项断言
render.yaml        Render 蓝图（Starter + 1GB 盘挂 /var/data + DATA_DIR）
.env.example       可用的环境变量示例（项目不自动读 .env）
```

`src/db.js` 与 `src/app.js` 的分工：**app.js 只做 HTTP 层**（参数校验、状态码、鉴权、限流），**所有 SQL 与事务在 db 层**。

## 4. 数据模型（3 张表）

```sql
ticket_types(id INTEGER PK AUTOINCREMENT, name TEXT UNIQUE NOT NULL, total INTEGER NOT NULL,
             active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
             created_at TEXT DEFAULT (datetime('now','localtime')))

claims(id INTEGER PK AUTOINCREMENT, ticket_type_id INTEGER NOT NULL REFERENCES ticket_types(id),
       name TEXT NOT NULL, student_id TEXT NOT NULL, seat_no INTEGER NOT NULL,
       created_at TEXT DEFAULT (datetime('now','localtime')))
CREATE UNIQUE INDEX idx_claims_student ON claims(student_id)   -- 一个学号只能领一张

settings(k TEXT PRIMARY KEY, v TEXT NOT NULL)                 -- title、open
```

关键语义：

- `claims.student_id` 有**唯一索引**：一个学号只能领一张票（任何票型）。
- `seat_no` 是**该票型内**按领取先后递增的序号（= `MAX(seat_no)+1`），展示为 `001`。
- `ticket_types.active` 是**软删除位**：发票端"删掉"票型其实是 `active=0`，历史名单不受影响；同名票型再加回来会沿用原记录。
- 时间统一是**本地时间字符串** `'YYYY-MM-DD HH:MM:SS'`，前端与 CSV 不做二次格式化。
- SQLite 开了 `journal_mode=WAL` 与 `foreign_keys=ON`。

## 5. HTTP 接口

公开：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | `{title, open, types:[{id,name,total,claimed,remaining}]}`，抢票端 5 秒轮询它 |
| POST | `/api/claim` | `{name, studentId, typeId}` → `{ok, claim:{...seat_no}, types:[...]}` |

发票端（**必须**带 `x-admin-key` 请求头；CSV 允许 `?key=` 便于下载）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | 校验秘钥 |
| GET | `/api/admin/data` | 票型（含停用）+ 全部名单 |
| POST | `/api/admin/types` | `{types:[{name,total}]}` **覆盖式**设置票型 |
| POST | `/api/admin/settings` | `{title?, open?}` |
| POST | `/api/admin/claim/delete` | `{id}` 删单条记录（释放票号） |
| POST | `/api/admin/reset` | `{confirm:"DELETE"}` 清空名单（票型保留） |
| GET | `/api/admin/claims.csv` | 导出台账（BOM + 学号前加制表符，防 Excel 吃前导 0） |

错误一律 `{ok:false, code, error}`，中文 `error` 直接展示给用户。业务码：`BAD_KEY / CLOSED / DUPLICATE / SOLD_OUT / NO_TYPE / NO_NAME / BAD_NAME / BAD_SID / RATE_LIMIT / NO_TYPES / BAD_TYPES / NO_ID / NOT_FOUND / NO_CONFIRM`。

限流（内存实现，见 `app.js` 的 `rateLimiter`）：领票 30 次/分/IP，秘钥尝试 20 次/分/IP。

## 6. 不能破坏的不变量（改代码前先读这段）

1. **领票必须在数据库写事务里完成**：`src/db-sqlite.js` 的 `claim()` 用 `BEGIN IMMEDIATE` 包住"查重复 → 查票型 → 数已领 → 生成 seat_no → 插入"，任何错误路径都 `ROLLBACK`（`setTypes()` 同样用 `BEGIN IMMEDIATE`）。这是"20 人抢 10 张票不超发"的唯一保证，别把 CHECK 与 INSERT 拆到事务外。
2. **所有存储函数都是 async**，即使 SQLite 实现是同步的。`src/app.js` 里每处调用都 `await`；新增函数也要保持 async，门面才可能换后端。
3. **票型设置是覆盖式**：`setTypes()` 先 `UPDATE ... SET active=0`，再按名单 upsert（同名复用），最后返回新的 `listTypes()`。校验（`db-shared.js` 的 `normalizeTypes`）与"已领数量不能被新票数压过去"的收窄保护都不能去掉。
4. **前端是单页 + 路径路由**：`/` 与 `/admin` 由 `public/app.js` 的 `route()` 按 `location.pathname` 切视图，`app.js` 的 `setNotFoundHandler` 负责把非 `/api/` 路径回落到 index.html。发票端的自动登录靠 `sessionStorage` 里的秘钥（`adminLogin(useInput)` 的 `useInput=false` 分支）——**不要把"刷新后自动登录"改回从输入框读值**，那会导致刷新 `/admin` 进不去。
5. **秘钥与数据文件绝不入库**：`data/` 已在 `.gitignore`；秘钥只从环境变量或 `DATA_DIR/admin-key.txt` 读。
6. **不要引入构建步骤**（打包器、TS 编译、框架）、**不要引入需要原生编译的依赖**。Node 必须 ≥ 24（`node:sqlite` 从 24 起免 flag）：`package.json` 的 `engines` 与 `.node-version` 都锁了这一点。
7. **不要为"省 Render 的钱"擅自加第二个存储后端**。曾经写过 Postgres 后端，因为本机起不来真库（Postgres 子进程 `0xC0000142`）拿不到验证，已整个撤掉。若确需切换云数据库，前提是**能对着真库把 `npm run smoke` 跑绿**，并保持同样的 async 接口。

## 7. 怎么验证改动（必须做）

```bash
npm run smoke
```

19 项端到端断言，全部真发 HTTP：秘钥错误被拒、无秘钥被拒、设置票型、余票查询、领票成功（校验票号）、重复学号被拒、售罄被拒、学号格式校验、发票端看名单、CSV 内容、票数收窄保护、删记录后余票回升、关闭领票后 403、**并发 20 人抢 10 张恰好 10 成功且票号连续不重复**、SQLite 落盘、静态页可访问。

测试机制（改测试时要保留）：起服务前先设 `process.env.DATA_DIR = mkdtemp()` 与 `ADMIN_KEY`，再 **`await import('../src/app.js')`**（ESM 的静态 import 会被提升到 env 赋值之前，必须动态 import）；关闭时先 `await closeDatabase()` 再删临时目录，否则 Windows 上 `EPERM`。

前端 UI 端到端（仓库外、可选，Playwright 会拖慢 Render 构建所以没进依赖）：

```bash
mkdir -p "$LOCALAPPDATA/Temp/tickits-e2e" && cd "$LOCALAPPDATA/Temp/tickits-e2e"
npm init -y && npm i playwright && npx playwright install chromium
# 写一个脚本：page.goto → fill_input → click → 断言 textContent，另加 page.on('pageerror')
```
断言一律读 DOM 文本（不要靠截图肉眼判断）。

## 8. 本机（Windows + git-bash）踩过的坑

- 停旧服务：`taskkill //PID` 在 git-bash 下无效，用 `taskkill.exe /PID <pid> /F`；且 `npm start` 杀掉的是 npm 外壳，**node 子进程还在占端口**，先用 `netstat -ano | grep ':3000'` 找 PID。
- 用 MSYS 的 `curl -d '{"name":"中文"}'` 会报 `FST_ERR_CTP_INVALID_CONTENT_LENGTH`（编码导致长度不符）→ 发中文 JSON 一律用 `node -e` 里的 `fetch`。

## 9. 部署要点

- `render.yaml` 已配好：`plan: starter`、`DATA_DIR=/var/data`、1GB 盘挂 `/var/data`、健康检查 `/api/state`、`ADMIN_KEY` 用 `sync: false` 让创建时手填。
- **`plan: free` 不能挂盘**（蓝图里同时写 disk 会部署失败）；免费实例重启/重建会清空 SQLite 文件，且闲置 15 分钟休眠。
- 成本 ≈ $7（Starter）+ $0.25（1GB 盘）/月；Hobby 工作区方案本身 $0，含 5GB 出站带宽与 500 分钟构建。
