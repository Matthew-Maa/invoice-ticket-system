# 领票系统（Tickits）

极简的「发票端 / 抢票端」双端领票系统。点开链接就能用，发票端凭秘钥设置票型和票数，抢票端填姓名 + 学号领票，双方都能看到实时余票，名单写进数据库（本地是 SQLite 文件，部署后落在 Render 的持久盘上）。

对应需求逐条落实：

| 需求 | 实现 |
| --- | --- |
| 点击链接进去网站 | 一个网址搞定，`/` 是抢票端，`/admin` 是发票端 |
| 发票端输入秘钥设置票型和票数 | `/admin` 输秘钥 → 可增删票型、改票数、随时保存 |
| 抢票端输入姓名 + 学号 | 两个输入框，一个学号只能领一张 |
| 查看当前各票型剩余票数 | 抢票端实时显示「剩余 N / 总数」，5 秒自动刷新 |
| 选择并确定 | 点票型卡片 → 点「确定领取」，成功页回显姓名/学号/票型/票号 |
| 存入信息 | 写入 SQLite（部署后落在 Render 持久盘 `/var/data` 上），重启/重新部署都不丢 |
| 发票端输入秘钥查看 | 名单表格 + 人数 + 一键导出 CSV |

技术栈：Node 24（内置 `node:sqlite`，无需编译原生模块）+ Fastify + 原生 HTML/CSS/JS，零构建步骤。所有存储函数都是 async，将来要换云数据库只需新增一个实现同一套函数的模块（`src/db.js` 处切换），上层代码不用改。

---

## 一、本地跑起来

需要 Node **24 以上**（`node -v` 检查；本项目用的是 Node 内置 SQLite，24 开始免 flag）。

```bash
cd tickits
npm install
npm start
```

启动后终端会打印：

```
  抢票端   http://localhost:8102/
  发票端   http://localhost:8102/admin
  局域网   http://192.168.x.x:8102/   (手机连同一 WiFi 时用这个)
  秘钥     a1b2c3d4e5   (来自 data/admin-key.txt)
  存储     [sqlite] .../data/tickits.db
```

- **发票端秘钥**：没设环境变量时，首次启动会自动生成一个 10 位口令存到 `data/admin-key.txt`，并打印在日志里。想自己指定：`ADMIN_KEY=我的口令 npm start`。
- **手机试玩**：让手机和电脑连同一个 WiFi，用日志里的「局域网」地址。若 WiFi 开了 AP 隔离（手机能上网但连不上电脑），换手机热点让电脑连上，再看日志里新出现的局域网地址。

### 用一遍

1. 打开 `http://localhost:8102/admin`，填秘钥进入。
2. 在「票型与票数」里加票型（如 `内场票 30`、`看台票 50`），点保存。
3. 换到 `http://localhost:8102/`（或点右上角「抢票端」），填姓名、学号，点票型，点确定领取。
4. 回发票端就能看到名单；点「导出 CSV」拿表格。

### 冒烟测试

```bash
npm run smoke
```

会临时起一个服务、跑完 19 项端到端断言（含**并发 20 人抢 10 张票，恰好 10 人成功、票号连续不重复**的超发测试），跑完自动清理，不碰你 `data/` 里的真实名单。

---

## 二、上传到 GitHub

已经初始化好 git 仓库并完成首次提交，直接推到你的 GitHub 即可。

1. 在 GitHub 网页点 **New repository**，仓库名填 `tickits`，**不要**勾选 Add README / .gitignore（本地已有），创建。
2. 在项目目录执行（把 `你的用户名` 换成自己的）：

```bash
cd tickits
git remote add origin https://github.com/你的用户名/tickits.git
git branch -M main
git push -u origin main
```

推送时会弹出浏览器让你登录 GitHub（Git Credential Manager），登录一次以后就免密了。

> 没装 git？`winget install Git.Git`，或用 GitHub Desktop 图形界面。仓库是私有的也没关系，Render 授权后照样能读。

---

## 三、部署到 Render

1. 打开 <https://dashboard.render.com> → **New** → **Blueprint**（读仓库里的 `render.yaml`，最省事；选 **Web Service** 手动填也一样，下面 3 项照着填）。
2. 连接 GitHub，选中 `tickits` 仓库。
3. Render 会读出 `render.yaml` 里的配置：**Starter 实例**、`npm install` / `npm start`、健康检查 `/api/state`、**1GB 持久盘挂在 `/var/data`**、`DATA_DIR=/var/data`。创建时它会让你填 `ADMIN_KEY` —— 填你自己的发票端口令。
4. 点 **Apply / Create Web Service**，等 1~2 分钟变绿，访问：

```
https://<服务名>.onrender.com/          ← 抢票端（发到群里/贴到通知里的就是这个链接）
https://<服务名>.onrender.com/admin     ← 发票端（只你自己知道）
```

费用：Starter $7/月 + 1GB 盘 $0.25/月 ≈ **$7.25/月**，需要先在 Render 账号里绑一张卡。手动创建时也就三处要选对：Instance Type 选 **Starter**、加一块 **Disk**（Mount Path `/var/data`、1GB）、环境变量加 `DATA_DIR=/var/data` 和 `ADMIN_KEY`。

### 为什么这样名单不会丢

`DATA_DIR=/var/data` 指向那块持久盘，`tickits.db`（票型 + 名单 + 秘钥文件）都落在盘上：**重新部署、重启、实例重建都还在**。只有你手动删盘或删服务才会清空。

### 想省钱用免费实例（不推荐给正式发票用）

把 `render.yaml` 的 `plan` 改成 `free`，删掉 `disk` 和 `DATA_DIR` 两段。代价：免费实例没有持久盘，**服务一重启 / 一重新部署，名单和票型全清空**；而且闲置 15 分钟休眠，下一个人打开要等 30~50 秒。试玩可以，真发票别省这 7 美元。

> 还想再省？可以不用持久盘、改成接一个免费云数据库（Neon / Supabase 免费 Postgres），代价是要多写一个存储后端。要这条路跟我说，我加上并在真库上把冒烟跑通再交给你。

---

## 四、规则与边界（都是有意设计的）

- **一个学号只能领一张票**：重复领会被拦，并提示已领的票型与票号。
- **票型票数收窄保护**：已领 12 张的票型，票数不允许改成小于 12。
- **并发安全**：领票走 SQLite 写事务（`BEGIN IMMEDIATE`），20 个人同时抢 10 张票不会超发。
- **停用票型**：删除某个票型只是停用，历史名单不受影响；同名的票型重新加回来会沿用原来的领取记录。
- **关闭领票**：发票端一键「关闭领票」，抢票端立刻不能提交，余票仍可查看。
- **纠错**：发票端可删单条记录（释放该票号，该学号可重新领）。
- **限流**：同一 IP 每分钟最多 30 次领票、20 次秘钥尝试。

## 五、接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 票型 + 剩余票数 + 是否开放（抢票端轮询用） |
| POST | `/api/claim` | `{name, studentId, typeId}` 领票 |
| POST | `/api/admin/login` | 校验秘钥 |
| GET | `/api/admin/data` | 票型 + 全部名单 |
| POST | `/api/admin/types` | `{types:[{name,total}]}` 覆盖式设置票型 |
| POST | `/api/admin/settings` | `{title?, open?}` 标题 / 开关领票 |
| POST | `/api/admin/claim/delete` | `{id}` 删记录 |
| POST | `/api/admin/reset` | `{confirm:"DELETE"}` 清空名单（票型保留） |
| GET | `/api/admin/claims.csv` | 导出 CSV |

发票端接口鉴权用请求头 `x-admin-key: <秘钥>`。

## 六、目录结构

```
src/server.js     启动入口：初始化数据库、监听端口、打印地址/秘钥/存储位置
src/app.js        Fastify 路由（公共接口 + 发票端接口 + 静态页面）
src/db.js         存储层门面：导出全部 async 存储函数（换后端只改这里）
src/db-sqlite.js  SQLite 实现：建表 + 票型/领票/名单的全部 SQL
src/db-shared.js  参数校验（票型规范化、姓名/学号规则）
src/data-dir.js   数据目录（DATA_DIR 或 ./data）
src/admin-key.js  秘钥来源解析（环境变量 → 文件 → 自动生成）
public/           前端单页：index.html / style.css / app.js
tools/smoke.js    端到端冒烟测试（19 项断言，临时数据目录）
render.yaml       Render 部署蓝图（Starter + 1GB 持久盘）
```
