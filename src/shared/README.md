# `src/shared/` — 前后端共用契约

终端(`/trade/[symbol]`)的浏览器端、Next route handler、`instrumentation` 与自定义 `server.mjs` 共用的**类型、实时协议、总线消息、REST 形状与常量**。这里只有类型与纯数据/纯函数,没有 React、没有 Next、没有 Prisma。

## 规则

- **纯度**:非测试文件不得 import `react`、`next/*`、`@/generated`、`@/lib`、`../lib`、`prisma`。`purity.test.ts` 静态扫描 `src/shared/**/*.ts(x)`(排除 `*.test.ts`)强制;测试文件可以导入 `zod` 与 `../../server/ws-schema.mjs`。
- **单位**:金额一律整数分,数量一律整数吨,时间一律 unix 毫秒(只有图表适配层才转秒)。
- **诚实**:`Instrument` 不含 `anchorPrice` / `description` / `createdAt`;`verificationStatus` 只能是 `"SIMULATED_UNVERIFIED"` 或 `null`;`methodology` / `projectId` 未知即 `null`(UI 显示「未提供」);成交引用是 `SIM-TRD-<tradeId>`(`auditRefOf`),披露常量 `FILL_DISCLOSURE`——都是模拟引用,不是登记机构记录。
- **`Ticker.change24h` 是百分数**:`1.23` = +1.23%,与 `/api/assets` 及现有 `toFixed(2) + "%"` 渲染一致,不是小数比例。
- **跨 bundle 状态只挂 `globalThis`**:`instrumentation`、route handler、`server.mjs` 是三个独立 realm,共享状态只能放 `globalThis.__carbadia*`,且只放 JSON 可序列化纯数据(无 class、无 `instanceof`)。声明在 `bus.ts` 的 `declare global`。

## 文件

| 文件 | 内容 |
|---|---|
| `types.ts` | 领域类型:`Side`、`OrderType`、`OrderStatus`、`CandleInterval`、`VerificationStatus`、`AuditRef`、`Instrument`、`Ticker`、`TickerUpdate`、`InstrumentListItem`、`OrderBookLevel/Snapshot/Delta`、`TapeEntry`、`CandleBar`、`Order`、`Fill`、`LedgerLineView`、`Position`、`Balance`、`Me`、`FeeSchedule`、`ConnectionState`、`DraftError` |
| `ws-protocol.ts` | WebSocket 协议:`Topic`、`ClientOp`、`ServerEvent`、`ServerFrame`、`WsErrorCode`;常量 `WS_PROTOCOL_VERSION`、`WS_HEARTBEAT_MS`、`WS_MAX_TOPICS`、`WS_TAPE_RING` |
| `bus.ts` | 进程内总线 `BusMessage` / `AccountEvent` / `CarbadiaBus`,`WsStats`、`Presence`,以及 `globalThis.__carbadia*` 的类型声明 |
| `api-shapes.ts` | REST 的 `data` 形状(`InstrumentsResponse`、`BookResponse`、`TradesResponse`、`CandlesResponse`、`AccountOrdersResponse`、`FillsResponse`、`FillDetailResponse`、`PositionsResponse`、`AccountOverview` / `AccountOverviewResponse`、`AccountTotals`、`EquityChange`(`pct` 是小数比例,不是百分数)、`OtcListingView`、`PlaceOrderRequest/Response`、`HealthResponse`、`ApiEnvelope`) |
| `constants.ts` | `DEFAULT_TERMINAL_SYMBOL`、`BASE_UNIT`、`FILL_DISCLOSURE`、`auditRefOf`、`CANDLE_INTERVALS`、`AGG_STEPS`、`DEPTH_OPTIONS`、`MAX_TAPE`、`MAX_BARS`、`DEFAULT_FEE_SCHEDULE` |
| `index.ts` | 以上五个文件的统一出口(纯函数模块按文件名单独导入,如 `@/shared/order-math`) |
| `orderbook.ts` | 盘口:`applyDelta`(quantity 0 删档,返回新 Map)、`diffBook`(与 `applyDelta` 往返恒等)、`aggregateLevels`(BUY 向下、SELL 向上取整到 step)、`cumulate`(`pct` 0..1)、`spread`(`abs` 分、`bps` 按中间价) |
| `order-math.ts` | 下单算术:`roundToTick`(买向下、卖向上)、`roundToStep`、`qtyFromAmount`、`amountFromQty`、`qtyFromPercent`、`clampQty`、`validateDraft`(十个 `DraftError` 各有触发路径,通过即给出 `PlaceOrderRequest`);`MAX_PRICE_CENTS` / `MAX_NOTIONAL_CENTS` 与 `src/lib/exchange/limits.ts` 同值(测试断言) |
| `fees.ts` | `estimateFee(notionalCents, bps, minFeeCents)`:费率 0 恒 0,否则 `max(minFee, ceil(notional × bps / 10000))` |
| `indicators.ts` | `sma` / `ema`(整段,前 period − 1 位 null;EMA 以 SMA 起算)、`smaLast` / `emaNext`(实时只更新最后一根) |
| `taker.ts` | `takerSideOf`:MARKET → 挂单价 ≠ 成交价 → `createdAt` 晚 → id 大(计划 §9.1 第 25 条) |
| `candle-live.ts` | `INTERVAL_MS`、`bucketUpdate(prev, trade, intervalMs)`(同桶更新 h/l/c、累加 v;跨桶 `isNew`;更早桶的乱序成交忽略)、`toCandleBar`(ISO t → unix ms) |
| `precision.ts` | `formatPrice(cents, precision, locale)`(精度钳到 0..2)、`formatQty(qty, step, locale)`,`Intl.NumberFormat` 按 locale + 小数位缓存,非法 locale 回退 en-US;组件侧用 `src/lib/format.ts` 的 `fmtPrice(cents, instrument, lang)` 包装(按界面语言选 locale、空值「—」) |
| `account-totals.ts` | 账户合计:`computeAccountTotals(balance, positions, priceOf)`(服务端按持仓行上的价格、客户端按行情的最新价;没有价格的持仓不计入市值并令 `valuationComplete = false`,情景标的不算 `heldCredits`,成本或估值不完整时 `unrealisedPnl` 为 null);从 `unrealised-pnl.ts` 再导出 `unrealisedPnlAt` |
| `unrealised-pnl.ts` | `unrealisedPnlAt(position, price)`(一行持仓按给定价格的浮盈,成本取服务端算好的那一份);账户合计与逐行估值(`position-groups.ts` 的 `positionValue`)共用,单独成模块是为了终端首屏不带上合计(P2-10) |
| `purity.test.ts` | 纯度静态扫描 |
| `ws-protocol.test.ts` | TS 类型 ↔ zod schema 的往返校验与类型层断言 |
| `*.test.ts` | 每个纯函数模块的同名测试(各 ≥ 8 用例) |

## 实时协议与运行时 schema

- 一个客户端文本帧 = 一个 `ClientOp`(JSON);一个服务端文本帧 = `ServerEvent[]`(hub 每连接 50 ms 合帧)。
- `Topic` 的合法形态:`book:<symbol>`、`trades:<symbol>`、`ticker:<symbol>`、`ticker:*`(唯一的通配)、`candles:<symbol>:<interval>`、`account`。`trades:*`、`book:*` 不存在。
- 运行时校验在 **`server/ws-schema.mjs`**(纯 JS,`import { z } from "zod"`),因为 hub 不经 Next 编译、不得 import `src/**`。它导出 `topicSchema`、`clientOpSchema`、`serverEventSchema`、`serverFrameSchema`,以及与本目录同值的 `WS_*` 常量和 `CANDLE_INTERVALS`。hub 对入站帧只接受 `clientOpSchema.safeParse` 通过的 op。
- `ws-protocol.test.ts` 把每个 `ClientOp` / `ServerEvent` 变体的示例值(用 TS 类型标注)送进 schema,要求通过且解析结果与输入逐字相等;同时用 `expectTypeOf` 断言 `ClientOp` / `ServerEvent` 可赋给 `z.input<typeof …Schema>`。所以:**改协议时 TS 与 zod 两边都要改**,漏一边测试或 `tsc --noEmit` 会报错。
- 一个刻意的选择:`clientOpSchema` 不限制单个 op 的 `topics` 条数——每连接 ≤ `WS_MAX_TOPICS` 是 hub 的累计上限,超出要回 `error too_many_topics`,而不是把它当 `bad_request`。

## 改契约怎么做

1. 改 `types.ts` / `ws-protocol.ts` / `api-shapes.ts` 里的 TS 类型。
2. 同步改 `server/ws-schema.mjs` 的 zod schema(字段、字面量、枚举)。
3. 更新 `ws-protocol.test.ts` 的示例值(新增事件变体时,`serverEvents` 的键集由 `ServerEvent["t"]` 推导,漏了会在 `tsc` 报错)。
4. 跑 `npx tsc --noEmit && npx vitest run src/shared`。
