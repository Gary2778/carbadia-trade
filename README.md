# Carbadia Trade · 碳信用交易模拟盘

Carbadia Trade（cbda.trade）是 Carbadia 的碳信用交易模拟盘：真实的订单簿撮合与 OTC 挂牌流程，行情由做市机器人生成，不涉及任何真实资金或碳资产。主站 carbadia.io 保留 Studio、Bridge 与 Atlas 三个板块；本站的 Projects 与 Market data 两页通过服务端代理读取 carbadia.io 的公开登记簿接口。

- **订单簿撮合**：限价单 / 市价单，价格-时间优先撮合引擎。
- **OTC 挂牌**：卖方挂牌、买方按单价直接成交（支持部分成交、最小购买量）。
- **自绘 K 线 / 深度图**：前端从成交记录实时聚合 OHLCV 并手写渲染。
- **做市机器人**：7x24 随机游走报价、多档买卖盘挂单、概率吃单。
- **模拟注销与私有凭证**：按账户记录模拟注销，幂等请求防重复扣减，不产生登记簿注销或真实减排声明。
- **影子价格实验**：情景标的价格纯由本盘交易形成；每日快照与真实收盘的内部对照只供研究，任何接口都不返回真实价格。
- **两种界面语言**：English、简体中文。
- **三种外观**：浅色、深色（星空 + 液态玻璃）、儿童护眼。

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
npm run dev             # http://localhost:3000
```

行情表初始有 6 个标的；另外 2 个情景标的由影子价格同步首次运行时创建，`SYNC_DISABLED=1` 时不会出现，属正常。

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
src/
  app/
    page.tsx                 行情(现货市场)
    market/[symbol]/         标的页:订单簿、K 线、深度、交易
    otc/ portfolio/ dashboard/ orders/ transactions/ retirement/ account/
    projects/ watchlist/ research/ learn/
    login/ register/ feedback/ terms/ privacy/
    api/                     Route Handlers(认证、行情、交易、持仓、注销、反馈、埋点、健康检查)
    api/real/[...path]/      登记簿数据代理(→ carbadia.io/api/real/*)
  components/
    exchange/                交易页组件及专属界面逻辑
    charts/ anim/            图表与动效
    Nav, Footer, 主题与语言切换、星空与液态玻璃
  hooks/ providers/ i18n/    hooks、主题状态、语言(en + zh-CN)
  lib/
    exchange/                撮合、OTC、做市、账本、持仓分析与模拟注销
    server/                  数据库、认证、限流与 API 响应处理
    real-sync/               影子价格采集
    registry-proxy.ts        代理路由的白名单与上游地址
    http/client.ts format.ts redirects.ts
  instrumentation.ts         做市机器人与影子价格同步入口
prisma/                      数据模型、迁移、种子
infra/cloudflare-proxy/      cbda.trade 反代 Worker
scripts/prod/                生产检查与诊断脚本
docs/                        设计、计划、发布记录
```

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

## 常用脚本

```bash
npm run db:reset    # 重置数据库(清空并重跑迁移)
npm run db:seed     # 重新灌入演示数据
npm run db:studio   # Prisma Studio
RUST_LOG=info npm test
npm run lint
BOT_DISABLED=1 SYNC_DISABLED=1 npm run build
npm run test:worker   # Cloudflare 反代 Worker 的 node:test
```

## 运行与发布

Railway 使用 Dockerfile 构建，并在构建时执行测试与 ESLint。容器启动时校验环境变量、应用 Prisma 迁移、重建查询统计，然后启动 Next.js；生产 SQLite 必须挂载在 `/data` 持久化卷上。基础设施定义在 `.railway/railway.ts`（`railway config plan` / `apply`），反代 Worker 在 `infra/cloudflare-proxy/`。

## 与 carbadia.io 的关系

本仓库从 carbadia.io 仓库的提交 `8cac5e2c` 分离（2026-09-24），设计见 `docs/superpowers/specs/2026-09-24-carbadia-trade-separation-design.md`。两边只剩两条弱连接：主站导航与首页的外链指向这里；这里的 `/api/real/*` 代理读主站的公开接口。
