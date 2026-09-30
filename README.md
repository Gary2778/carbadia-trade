# Carbadia Trade · 碳信用交易模拟盘

Carbadia Trade（cbda.trade）是 Carbadia 的碳信用交易模拟盘：真实的订单簿撮合与 OTC 挂牌流程，行情由做市机器人生成，不涉及任何真实资金或碳资产。主站 carbadia.io 保留 Studio、Bridge 与 Atlas 三个板块；本站的 Projects 与 Market data 两页通过服务端代理读取 carbadia.io 的公开登记簿接口。

- **订单簿撮合**：限价单 / 市价单，价格-时间优先撮合引擎。
- **OTC 挂牌**：卖方挂牌、买方按单价直接成交（支持部分成交、最小购买量）。
- **自绘 K 线 / 深度图**：前端从成交记录实时聚合 OHLCV 并手写渲染。
- **做市机器人**：7x24 随机游走报价、多档买卖盘挂单、概率吃单。
- **模拟注销与私有凭证**：按账户记录模拟注销，幂等请求防重复扣减，不产生登记簿注销或真实减排声明。
- **影子价格实验**：情景标的价格纯由本盘交易形成；每日快照与真实收盘的内部对照只供研究，任何接口都不返回真实价格。
- **两种界面语言**：English、简体中文。
- **两种外观**：浅色、深色（星空 + 液态玻璃）。

> ⚠️ 仅供学习演示，非真实交易、不涉及真实资金或碳资产。

## 技术栈

- **Next.js 16**（App Router）+ **React 19** + **TypeScript**
- **Tailwind CSS v4**
- **Prisma 6 + SQLite**
- **Zod** 入参校验；Node `crypto` scrypt 密码哈希 + HMAC 签名会话 Cookie

## 快速开始

```bash
npm install
cp .env.example .env    # 本地开发环境变量(SQLite 路径;dev 有内置 SESSION_SECRET 回退)
npm run db:migrate      # 建库 + 生成 Prisma Client(首次)
npm run db:seed         # 写入演示用户/标的/订单簿/OTC 挂牌
npm run dev             # http://localhost:3000(node server.mjs:Next + WebSocket /ws)
```

行情表初始有 12 个标的；另外 2 个情景标的由影子价格同步首次运行时创建（合计 14 个），`SYNC_DISABLED=1` 时不会出现，属正常。

### 演示账号（密码均为 `password123`）

| 邮箱 | 角色 |
|---|---|
| alice@carbadia.io | 碳资产开发商（主要卖方） |
| bob@carbadia.io   | 减排企业 |
| carol@carbadia.io | 碳基金 |
| dave@carbadia.io  | 履约企业 |

每个账号初始 $500,000 演示资金；新注册账号赠送 $100,000。

## 目录结构

```
server.mjs                   自定义 server:Next 页面、REST 与 WebSocket /ws 同一端口
server/                      纯 JS 的 server 模块:事件总线、WebSocket hub、会话签名、客户端 IP、生命周期
src/
  app/
    page.tsx                 行情(现货市场)
    trade/[symbol]/          交易终端:标的列表、K 线、盘口与成交、下单、委托 / 成交 / 持仓
    market/[symbol]/         标的页:总览与简易交易(高级交易进终端)
    otc/ portfolio/ dashboard/ orders/ transactions/ retirement/ account/
    projects/ watchlist/ research/ learn/
    login/ register/ feedback/ terms/ privacy/
    api/                     Route Handlers(认证、行情、交易、持仓、注销、反馈、埋点、健康检查)
    api/market/ api/account/ 终端的公开行情快照与私有账户接口
    api/real/[...path]/      登记簿数据代理(→ carbadia.io/api/real/*)
  components/
    terminal/                交易终端的面板、快捷键帮助与布局
    ui/                      全站共用的骨架、空态、错误态、对话框与虚拟列表
    exchange/                交易页组件及专属界面逻辑
    charts/ anim/            图表与动效
    Nav, Footer, 主题与语言切换、星空与液态玻璃
  hooks/ providers/ i18n/    hooks、主题状态、语言(en + zh-CN)
  shared/                    前后端共用的类型、WebSocket 协议与纯函数(不依赖 React / Next / Prisma)
  lib/
    market/                  终端的行情与账户 store、WebSocket / 轮询传输、选择器、下单草稿、快捷键
    exchange/                撮合、OTC、做市、账本、持仓分析与模拟注销
    server/                  数据库、认证、限流、API 响应处理、行情发布与快照
    real-sync/               影子价格采集
    registry-proxy.ts        代理路由的白名单与上游地址
    http/client.ts format.ts redirects.ts
  instrumentation.ts         做市机器人与影子价格同步入口
prisma/                      数据模型、迁移、种子
scripts/perf/                性能度量脚本(chunk 预算、Lighthouse、WebSocket 压测)
scripts/smoke-ws.mjs         /ws 冒烟
infra/cloudflare-proxy/      cbda.trade 反代 Worker(内部)
scripts/prod/                生产检查与诊断脚本(内部)
docs/                        设计、计划、发布记录(内部)
.railway/                    Railway 基础设施定义(内部)
```

标了「内部」的目录只在私有工作区里,不随公开源码快照发布;公开仓 github.com/Gary2778/carbadia-trade 里没有它们。

测试文件与对应模块放在一起。

## 撮合引擎要点（`src/lib/exchange/matching.ts`）

- **价格优先、时间优先**；成交价取被动挂单方价格（taker 获得价格改善）。
- **下单即冻结**：限价买冻结现金、卖单冻结持仓；成交按冻结结算，撤单/剩余精确解冻。
- **市价单**：买单受实时可用现金约束，剩余未成交部分自动撤销。
- **防自成交**：不与自己的挂单成交。
- 全流程在单个数据库事务中完成，保证资金 / 持仓 / 订单状态一致。

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | SQLite 连接串。线上必须指向持久卷,形如 `file:/data/trade.db`(容器启动脚本会校验前缀) |
| `SESSION_SECRET` | 是 | 会话 cookie 的 HMAC 签名密钥,用 `openssl rand -hex 32` 生成;生产环境缺失会拒绝启动(本地 dev 有内置回退) |
| `BOT_DISABLED` | 否 | 设为 `1` 时不启动做市机器人 |
| `SYNC_DISABLED` | 否 | 设为 `1` 时不启动影子价格采集;本地页面预览建议与 `BOT_DISABLED=1` 一起使用 |
| `RETENTION_DAYS` | 否 | 机器人历史数据保留天数,默认 `7`;任何真人参与的成交/订单永久保留 |
| `PROXY_SECRET` | 否 | 反代密钥(生产建议设)。Cloudflare Worker 转发时注入请求头 `x-proxy-secret=<此值>`;应用只在该头匹配时才信任 `cf-connecting-ip` 做限流分桶 |
| `REGISTRY_UPSTREAM` | 否 | 登记簿数据上游,默认 `https://carbadia.io` |
| `BOT_TICK_MS` | 否 | 做市机器人节奏(毫秒),默认 `2500`;本地压盘口可设 `500`,生产不改 |
| `START_MODE` | 否 | 容器启动方式:`custom`(默认,`node server.mjs`,Next + WebSocket `/ws` 同端口)或 `next`(回滚到 `next start`,无 `/ws`)。`docker-entrypoint.sh` 据它选启动命令;终端页在服务端也读它,为 `next` 时页面首帧就轮询、不试 `/ws` |
| `WS_DISABLED` | 否 | 设为 `1` 时 `server.mjs` 不挂 `/ws`,`/api/health` 的 `ws.enabled` 为 `false` |
| `WS_MAX_CONNECTIONS` | 否 | `/ws` 总连接上限,默认 `500`;超出的握手回 HTTP 503 + `Retry-After: 30` |
| `WS_MAX_PER_IP` | 否 | `/ws` 每 IP 连接上限,默认 `8`;IP 经 `PROXY_SECRET` 信任链解析;本地开发(没有 `PROXY_SECRET`、没有 IP 头)不按 IP 限、只受总上限约束 |
| `WS_MAX_UNTRUSTED` | 否 | 直连源站(`x-proxy-secret` 不匹配)的 `/ws` 连接共用一个桶,默认上限 `16` |
| `WS_ALLOWED_ORIGINS` | 否 | `/ws` 放行的 `Origin`,逗号分隔,`:*` 结尾匹配任意端口;默认 `https://cbda.trade`,非生产环境额外放行 `http://localhost:*`。本地用生产模式在浏览器里看终端时要设成 `http://localhost:<端口>`,否则 `/ws` 被拒、终端降级轮询 |
| `MAX_RSS_MB` | 否 | RSS 告警阈值(MB),默认 `900`;每 30 s 采样,超过只记告警不退出 |
| `NEXT_PUBLIC_MARKET_TRANSPORT` | 否 | 构建期。终端行情传输:`ws`(默认)或 `poll`(强制轮询 `/api/market/*`) |
| `NEXT_PUBLIC_WS_URL` | 否 | 构建期。WebSocket 地址,默认同源 `/ws`(https 页面自动用 wss) |

`DATABASE_URL` 的相对路径以 `prisma/` 目录为基准:`file:./dev.db` 指向 `prisma/dev.db`,写成 `file:./prisma/dev.db` 会落到不存在的 `prisma/prisma/dev.db`。自定义 server 相关的变量全部有代码内默认,生产环境不需要新增;回滚只需把 `START_MODE` 设为 `next` 并重新部署。

## 常用脚本

```bash
npm run db:reset    # 重置数据库(清空并重跑迁移)
npm run db:seed     # 重新灌入演示数据
npm run db:studio   # Prisma Studio
RUST_LOG=info npm test
npm run lint
BOT_DISABLED=1 SYNC_DISABLED=1 npm run build
npm run test:worker   # Cloudflare 反代 Worker 的 node:test
npm run dev           # node server.mjs:Next + WebSocket /ws 同端口(读 PORT,也接受 -p / --port)
npm run dev:plain     # next dev 逃生口:没有 /ws,终端自动降级轮询,用来排查自定义 server 与 HMR 的冲突
npm run start         # 生产模式的 server.mjs(先 npm run build);npm run start:plain = next start
npm run smoke:ws -- ws://localhost:3000/ws VCS-FOR-2021   # /ws 冒烟:10 s 内收到 hello、subscribed 与一帧 book 即 exit 0
npm run perf:chunks  # 首屏 JS 体积门禁(先 npm run build):各路由 gzip 预算、库检测与阳性对照,超标 exit 1;--json 输出明细
npm run perf:lh -- http://localhost:3000       # Lighthouse:终端页与首页各跑移动 3 次 + 桌面 3 次,取中位数(npx lighthouse@12,需本机 Chrome)
npm run perf:ws-flood -- --url ws://localhost:3000/ws --clients 300 --seconds 60   # /ws 压测
```

## 运行与发布

Railway 使用 Dockerfile 构建，并在构建时执行测试与 ESLint。容器启动时校验环境变量、应用 Prisma 迁移、重建查询统计，然后启动 `node server.mjs`（Next 页面、REST 与 WebSocket `/ws` 同一端口；`START_MODE=next` 时退回 `next start`，无 `/ws`，终端自动降级轮询）；生产 SQLite 必须挂载在 `/data` 持久化卷上。`GET /api/health` 返回 `{ db, bot, startMode, ws }`，其中 `ws` 是 hub 的连接 / 订阅 / 帧数 / 背压统计（`WS_DISABLED=1` 时 `enabled: false`）。基础设施定义在内部目录 `.railway/railway.ts`（`railway config plan` / `apply`），反代 Worker 在内部目录 `infra/cloudflare-proxy/`。

## 与 carbadia.io 的关系

本仓库从 carbadia.io 仓库的提交 `8cac5e2c` 分离（2026-09-24），设计文档在内部仓库的 `docs/superpowers/specs/2026-09-24-carbadia-trade-separation-design.md`。两边只剩两条弱连接：主站导航与首页的外链指向这里；这里的 `/api/real/*` 代理读主站的公开接口。
