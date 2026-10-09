// WebSocket 协议的运行时 schema(zod)。与 src/shared/ws-protocol.ts / types.ts 的 TS 类型逐条对应。
// 纯 JS:hub(server/ws-hub.mjs)不经 Next 编译、不得 import src/**,所以运行时校验放在这里;
// src/shared/ws-protocol.test.ts 反过来导入本文件,把 TS 示例值往返校验,保证 TS 类型与 zod schema 不漂移。
// hub 对入站帧只接受 clientOpSchema.safeParse 通过的 op;出站事件的 serverEventSchema 给测试与冒烟脚本用。
// 单位:金额整数分、数量整数吨、时间 unix 毫秒,所以数值字段一律 int。
import { z } from "zod";

// 与 src/shared/ws-protocol.ts 同值;ws-protocol.test.ts 断言相等
export const WS_PROTOCOL_VERSION = 1;
export const WS_HEARTBEAT_MS = 25_000;
export const WS_MAX_TOPICS = 64;
export const WS_TAPE_RING = 64;
// 与 src/shared/constants.ts 的 CANDLE_INTERVALS 同值同序
export const CANDLE_INTERVALS = /** @type {const} */ (["1m", "5m", "15m", "1h", "4h", "1d"]);

// ---- topic ----
// symbol 只限定字符集(不含冒号、星号、空白);是否真实存在由 hub 查标的缓存后以 error unknown_topic 回答。
const SYMBOL = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const INTERVAL = CANDLE_INTERVALS.join("|");
/** @param {string} body */
const exact = (body) => new RegExp(`^(?:${body})$`);

export const bookTopicSchema = z.string().regex(exact(`book:${SYMBOL}`), "unknown topic");
export const tradesTopicSchema = z.string().regex(exact(`trades:${SYMBOL}`), "unknown topic");
/** ticker:* 是唯一的通配 topic */
export const tickerTopicSchema = z.string().regex(exact(`ticker:(?:${SYMBOL}|\\*)`), "unknown topic");
export const candlesTopicSchema = z.string().regex(exact(`candles:${SYMBOL}:(?:${INTERVAL})`), "unknown topic");
export const accountTopicSchema = z.literal("account");
export const topicSchema = z
  .string()
  .regex(exact(`book:${SYMBOL}|trades:${SYMBOL}|ticker:(?:${SYMBOL}|\\*)|candles:${SYMBOL}:(?:${INTERVAL})|account`), "unknown topic");

// ---- 基础字段 ----
const int = z.number().int();
const cents = int.nonnegative(); // 金额,分
const tonnes = int.nonnegative(); // 数量,吨
const unixMs = int.nonnegative(); // 时间,unix 毫秒
const seq = int.nonnegative(); // topic 序号,进程启动从 1 起,快照不增
const sideSchema = z.enum(["BUY", "SELL"]);
const orderTypeSchema = z.enum(["LIMIT", "MARKET"]);
const orderStatusSchema = z.enum(["OPEN", "PARTIAL", "FILLED", "CANCELLED"]);
const triggerDirectionSchema = z.enum(["ABOVE", "BELOW"]);
const triggerReasonSchema = z.enum(["USER", "OCO", "INSUFFICIENT_CASH", "INSUFFICIENT_QTY", "NO_FILL", "INVALID"]);
export const candleIntervalSchema = z.enum(CANDLE_INTERVALS);
/** SIM-TRD-<tradeId>:模拟成交引用,不是登记机构记录 */
const auditRefSchema = z.string().startsWith("SIM-TRD-");

// ---- 领域对象(与 src/shared/types.ts 同形) ----
export const orderBookLevelSchema = z.object({ price: cents, quantity: tonnes, orders: int.nonnegative() });
export const tapeEntrySchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  price: cents,
  quantity: tonnes,
  takerSide: sideSchema,
  ts: unixMs,
  auditRef: auditRefSchema,
});
export const candleBarSchema = z.object({ t: unixMs, o: cents, h: cents, l: cents, c: cents, v: tonnes });
/** ticker 事件是部分字段(symbol、ts 必带);change24h 是百分数,可为负、非整数 */
export const tickerUpdateSchema = z.object({
  symbol: z.string().min(1),
  ts: unixMs,
  lastPrice: cents.nullable().optional(),
  bestBid: cents.nullable().optional(),
  bestAsk: cents.nullable().optional(),
  change24h: z.number().nullable().optional(),
  high24h: cents.nullable().optional(),
  low24h: cents.nullable().optional(),
  volume24h: tonnes.optional(),
});
export const orderSchema = z.object({
  id: z.string().min(1),
  clientOrderId: z.string().nullable(),
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  side: sideSchema,
  type: orderTypeSchema,
  price: cents.nullable(),
  quantity: tonnes,
  filledQuantity: tonnes,
  status: orderStatusSchema,
  avgFillPrice: cents.nullable(),
  cancelReason: z.enum(["USER", "MARKET_REMAINDER", "SELF_TRADE"]).nullable(),
  createdAt: unixMs,
  updatedAt: unixMs,
});
export const fillSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  symbol: z.string().min(1),
  side: sideSchema,
  role: z.enum(["MAKER", "TAKER"]),
  price: cents,
  quantity: tonnes,
  notional: cents,
  feeCents: cents,
  ts: unixMs,
  auditRef: auditRefSchema,
  ledgerRefs: z.array(z.string()),
});
export const balanceSchema = z.object({ cashBalance: cents, lockedCash: cents });
/** 条件单 / 价格提醒(计划 §6.3.2 C2);side / orderType / limitPrice / quantity 只有 ORDER 才非 null */
export const triggerSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["ORDER", "ALERT"]),
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  direction: triggerDirectionSchema,
  triggerPrice: cents,
  side: sideSchema.nullable(),
  orderType: orderTypeSchema.nullable(),
  limitPrice: cents.nullable(),
  quantity: tonnes.nullable(),
  ocoGroupId: z.string().min(1).nullable(),
  status: z.enum(["PENDING", "TRIGGERING", "TRIGGERED", "REJECTED", "CANCELLED"]),
  reason: triggerReasonSchema.nullable(),
  orderId: z.string().min(1).nullable(),
  firedPrice: cents.nullable(),
  createdAt: unixMs,
  updatedAt: unixMs,
  firedAt: unixMs.nullable(),
});
/** 通知 = 公共头 + 按 kind 区分的载荷(NoticePayload) */
const noticeHead = { id: z.string().min(1), createdAt: unixMs, readAt: unixMs.nullable() };
export const noticeSchema = z.discriminatedUnion("kind", [
  z.object({
    ...noticeHead,
    kind: z.literal("fill"),
    orderId: z.string().min(1),
    symbol: z.string().min(1),
    side: sideSchema,
    role: z.enum(["MAKER", "TAKER"]),
    quantity: tonnes,
    price: cents,
    orderStatus: orderStatusSchema,
  }),
  z.object({
    ...noticeHead,
    kind: z.literal("trigger"),
    triggerId: z.string().min(1),
    symbol: z.string().min(1),
    outcome: z.enum(["TRIGGERED", "REJECTED", "CANCELLED"]),
    reason: triggerReasonSchema.nullable(),
    side: sideSchema.nullable(),
    quantity: tonnes.nullable(),
    triggerPrice: cents,
    orderId: z.string().min(1).nullable(),
  }),
  z.object({
    ...noticeHead,
    kind: z.literal("price_alert"),
    triggerId: z.string().min(1),
    symbol: z.string().min(1),
    direction: triggerDirectionSchema,
    triggerPrice: cents,
    firedPrice: cents,
  }),
]);
export const positionSchema = z.object({
  assetId: z.string().min(1),
  symbol: z.string().min(1),
  quantity: tonnes,
  locked: tonnes,
  lockedBy: z.object({ orders: tonnes, otc: tonnes }), // 锁定来源:未完结 SELL 挂单的剩余量 / ACTIVE 场外挂牌(计划 §6.2.2 C1)
  available: tonnes,
  retired: tonnes,
  lastPrice: cents.nullable(),
  marketValue: cents,
  averagePurchasePrice: cents.nullable(),
  unrealisedPnl: int.nullable(), // 可为负
  costBasisStatus: z.enum(["complete", "unknown_acquisition_cost", "incomplete_ledger"]),
  isScenario: z.boolean(),
});

// ---- 客户端 → 服务端:一个文本帧 = 一个 ClientOp ----
// topics 的条数不在这里限制:每连接 ≤ WS_MAX_TOPICS 是 hub 的累计上限,超出要回 error too_many_topics 而不是 bad_request。
const topicsSchema = z.array(topicSchema);
/** since[topic] = 客户端最后收到的 seq;只对 trades:* 回放,其它 topic 由 hub 忽略。
 *  值取 optional 是为了与 TS 的 Partial<Record<Topic, number>>(值为 number | undefined)同形;JSON 里不会出现 undefined */
const sinceSchema = z.record(topicSchema, seq.optional());
export const clientOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("subscribe"), topics: topicsSchema, since: sinceSchema.optional() }),
  z.object({ op: z.literal("unsubscribe"), topics: topicsSchema }),
  z.object({ op: z.literal("ping"), t0: z.number() }),
]);

// ---- 服务端 → 客户端:一个文本帧 = ServerEvent[] ----
export const wsErrorCodeSchema = z.enum(["bad_request", "unauthorized", "too_many_topics", "unknown_topic", "rate_limited"]);
const bookEventFields = { topic: bookTopicSchema, seq, symbol: z.string().min(1), bids: z.array(orderBookLevelSchema), asks: z.array(orderBookLevelSchema), ts: unixMs };
export const serverEventSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("hello"),
    v: z.literal(WS_PROTOCOL_VERSION),
    serverTime: unixMs,
    heartbeatMs: z.literal(WS_HEARTBEAT_MS),
    userId: z.string().nullable(),
    maxTopics: z.literal(WS_MAX_TOPICS),
    bootId: z.string().min(1).optional(),
  }),
  z.object({ t: z.literal("subscribed"), topic: topicSchema, seq }),
  z.object({ t: z.literal("unsubscribed"), topic: topicSchema }),
  z.object({ t: z.literal("pong"), t0: z.number(), serverTime: unixMs }),
  z.object({ t: z.literal("error"), code: wsErrorCodeSchema, message: z.string(), topic: topicSchema.optional() }),
  z.object({ t: z.literal("book.snapshot"), ...bookEventFields }),
  z.object({ t: z.literal("book.delta"), ...bookEventFields }),
  z.object({ t: z.literal("trades"), topic: tradesTopicSchema, seq, symbol: z.string().min(1), trades: z.array(tapeEntrySchema) }),
  z.object({ t: z.literal("ticker"), topic: tickerTopicSchema, seq, symbol: z.string().min(1), ticker: tickerUpdateSchema }),
  z.object({
    t: z.literal("candle"),
    topic: candlesTopicSchema,
    seq,
    symbol: z.string().min(1),
    interval: candleIntervalSchema,
    candle: candleBarSchema,
  }),
  z.object({ t: z.literal("order"), topic: accountTopicSchema, seq, order: orderSchema }),
  z.object({ t: z.literal("fill"), topic: accountTopicSchema, seq, fill: fillSchema }),
  z.object({ t: z.literal("balance"), topic: accountTopicSchema, seq, balance: balanceSchema }),
  z.object({ t: z.literal("position"), topic: accountTopicSchema, seq, position: positionSchema }),
  z.object({ t: z.literal("trigger"), topic: accountTopicSchema, seq, trigger: triggerSchema }),
  z.object({ t: z.literal("notice"), topic: accountTopicSchema, seq, notice: noticeSchema, unread: int.nonnegative() }),
  z.object({ t: z.literal("resync"), topic: topicSchema, reason: z.enum(["backpressure", "restart"]) }),
]);
export const serverFrameSchema = z.array(serverEventSchema);
