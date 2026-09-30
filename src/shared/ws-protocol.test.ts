// TS 类型(src/shared/ws-protocol.ts、types.ts)与运行时 zod schema(server/ws-schema.mjs)的往返校验:
// 每个 ClientOp / ServerEvent 变体的示例值都必须通过 schema 且解析结果与输入逐字相等(没有被 strip 的字段),
// 非法 op、未知 topic 前缀与 trades:* 通配必须被拒绝;常量两边相等;类型层断言 Instrument 无 anchorPrice 等。
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  CANDLE_INTERVALS as MJS_CANDLE_INTERVALS,
  WS_HEARTBEAT_MS as MJS_WS_HEARTBEAT_MS,
  WS_MAX_TOPICS as MJS_WS_MAX_TOPICS,
  WS_PROTOCOL_VERSION as MJS_WS_PROTOCOL_VERSION,
  WS_TAPE_RING as MJS_WS_TAPE_RING,
  clientOpSchema,
  serverEventSchema,
  serverFrameSchema,
  topicSchema,
} from "../../server/ws-schema.mjs";
import { CANDLE_INTERVALS, auditRefOf } from "./constants";
import type {
  Balance,
  CandleBar,
  DraftError,
  Fill,
  Instrument,
  Order,
  OrderBookLevel,
  Position,
  TapeEntry,
} from "./types";
import {
  WS_HEARTBEAT_MS,
  WS_MAX_TOPICS,
  WS_PROTOCOL_VERSION,
  WS_TAPE_RING,
  type ClientOp,
  type ServerEvent,
  type ServerFrame,
  type Topic,
} from "./ws-protocol";

const SYMBOL = "VCS-FOR-2021";
const NOW = 1_790_000_000_000; // 固定时间戳,便于逐字比较

// ---- 示例值(用 TS 类型标注,类型错了 tsc 先报) ----
const level = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const tape: TapeEntry = { id: "trd_1", symbol: SYMBOL, price: 6800, quantity: 5, takerSide: "BUY", ts: NOW, auditRef: auditRefOf("trd_1") };
const bar: CandleBar = { t: NOW - (NOW % 60_000), o: 6800, h: 6810, l: 6790, c: 6805, v: 12 };
const order: Order = {
  id: "ord_1", clientOrderId: "8b1e0a1c-4d0b-4c7e-9a5d-2f3c5b6a7d8e", assetId: "ast_1", symbol: SYMBOL, side: "BUY", type: "LIMIT",
  price: 6800, quantity: 10, filledQuantity: 4, status: "PARTIAL", avgFillPrice: 6799, cancelReason: null, createdAt: NOW - 1000, updatedAt: NOW,
};
const fill: Fill = {
  id: "trd_1", orderId: "ord_1", symbol: SYMBOL, side: "BUY", role: "TAKER", price: 6800, quantity: 4, notional: 27_200, feeCents: 0,
  ts: NOW, auditRef: auditRefOf("trd_1"), ledgerRefs: ["led_1", "led_2"],
};
const balance: Balance = { cashBalance: 1_000_000, lockedCash: 68_000 };
const position: Position = {
  assetId: "ast_1", symbol: SYMBOL, quantity: 30, locked: 10, available: 20, retired: 3, lastPrice: 6800, marketValue: 204_000,
  averagePurchasePrice: 6500, unrealisedPnl: 9_000, costBasisStatus: "complete", isScenario: false,
};

const clientOps: { [K in ClientOp["op"]]: Extract<ClientOp, { op: K }> } = {
  subscribe: {
    op: "subscribe",
    topics: [`book:${SYMBOL}`, `trades:${SYMBOL}`, `ticker:${SYMBOL}`, "ticker:*", `candles:${SYMBOL}:1m`, "account"],
    since: { [`trades:${SYMBOL}`]: 41 },
  },
  unsubscribe: { op: "unsubscribe", topics: [`book:${SYMBOL}`, "account"] },
  ping: { op: "ping", t0: NOW },
};

// 键集 = ServerEvent["t"] 全部 15 个变体:漏一个 tsc 就报错
const serverEvents: { [K in ServerEvent["t"]]: Extract<ServerEvent, { t: K }> } = {
  hello: { t: "hello", v: 1, serverTime: NOW, heartbeatMs: 25000, userId: null, maxTopics: 64 },
  subscribed: { t: "subscribed", topic: `book:${SYMBOL}`, seq: 7 },
  unsubscribed: { t: "unsubscribed", topic: "ticker:*" },
  pong: { t: "pong", t0: NOW - 20, serverTime: NOW },
  error: { t: "error", code: "unknown_topic", message: "no such symbol", topic: "book:NOPE" },
  "book.snapshot": { t: "book.snapshot", topic: `book:${SYMBOL}`, seq: 7, symbol: SYMBOL, bids: [level(6795, 20, 2)], asks: [level(6805, 15)], ts: NOW },
  "book.delta": { t: "book.delta", topic: `book:${SYMBOL}`, seq: 8, symbol: SYMBOL, bids: [level(6795, 0, 0)], asks: [], ts: NOW },
  trades: { t: "trades", topic: `trades:${SYMBOL}`, seq: 42, symbol: SYMBOL, trades: [tape] },
  ticker: { t: "ticker", topic: "ticker:*", seq: 3, symbol: SYMBOL, ticker: { symbol: SYMBOL, ts: NOW, lastPrice: 6800, change24h: -1.23, volume24h: 120 } },
  candle: { t: "candle", topic: `candles:${SYMBOL}:1m`, seq: 5, symbol: SYMBOL, interval: "1m", candle: bar },
  order: { t: "order", topic: "account", seq: 11, order },
  fill: { t: "fill", topic: "account", seq: 12, fill },
  balance: { t: "balance", topic: "account", seq: 13, balance },
  position: { t: "position", topic: "account", seq: 14, position },
  resync: { t: "resync", topic: `trades:${SYMBOL}`, reason: "backpressure" },
};

describe("ClientOp ↔ clientOpSchema", () => {
  it.each(Object.entries(clientOps))("%s 通过 schema 且往返不变", (_op, value) => {
    const r = clientOpSchema.safeParse(value);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(value);
  });

  it.each<unknown>([
    { op: "nope" },
    { op: "ping" },
    { op: "ping", t0: "now" },
    { op: "ping", t0: Number.NaN },
    { op: "subscribe" },
    { op: "subscribe", topics: `book:${SYMBOL}` },
    { op: "subscribe", topics: [`book:${SYMBOL}`], since: { [`book:${SYMBOL}`]: -1 } },
    { op: "subscribe", topics: [`book:${SYMBOL}`], since: { [`book:${SYMBOL}`]: 1.5 } },
    { op: "subscribe", topics: [`book:${SYMBOL}`], since: { "nope:X": 1 } },
    { op: "unsubscribe", topics: [42] },
    "subscribe",
    null,
    [],
    {},
  ])("拒绝非法 op %j", (bad) => {
    expect(clientOpSchema.safeParse(bad).success).toBe(false);
  });
});

describe("topicSchema", () => {
  it.each<Topic>([`book:${SYMBOL}`, `trades:${SYMBOL}`, `ticker:${SYMBOL}`, "ticker:*", `candles:${SYMBOL}:1m`, `candles:${SYMBOL}:1d`, "account", "book:CEA-SCENARIO"])(
    "接受 %s",
    (topic) => {
      expect(topicSchema.safeParse(topic).success).toBe(true);
    },
  );

  it.each<string>([
    "foo:VCS-FOR-2021", // 未知前缀
    "books:VCS-FOR-2021",
    "BOOK:VCS-FOR-2021", // 前缀区分大小写
    "ticker", // 缺 symbol
    "book:", // 空 symbol
    "book:VCS FOR", // 空白
    "account:me", // account 无后缀
    "candles:VCS-FOR-2021", // 缺 interval
    "candles:VCS-FOR-2021:2m", // 非法 interval
    "candles:VCS-FOR-2021:1m:x",
    "",
  ])("拒绝未知 topic %j", (bad) => {
    expect(topicSchema.safeParse(bad).success).toBe(false);
    expect(clientOpSchema.safeParse({ op: "subscribe", topics: [bad] }).success).toBe(false);
  });

  it("只有 ticker:* 是通配;trades:* / book:* / candles:*:1m 一律拒绝", () => {
    expect(topicSchema.safeParse("ticker:*").success).toBe(true);
    for (const bad of ["trades:*", "book:*", "candles:*:1m", "candles:VCS-FOR-2021:*", "ticker:**"]) {
      expect(topicSchema.safeParse(bad).success, bad).toBe(false);
      expect(clientOpSchema.safeParse({ op: "subscribe", topics: [bad] }).success, bad).toBe(false);
    }
  });
});

describe("ServerEvent ↔ serverEventSchema", () => {
  it.each(Object.entries(serverEvents))("%s 通过 schema 且往返不变", (_t, value) => {
    const r = serverEventSchema.safeParse(value);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(value);
  });

  it("一个服务端帧 = ServerEvent[] 数组;非数组拒绝", () => {
    const frame: ServerFrame = Object.values(serverEvents);
    const r = serverFrameSchema.safeParse(frame);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(frame);
    expect(serverFrameSchema.safeParse(serverEvents.hello).success).toBe(false);
    expect(serverFrameSchema.safeParse([{ t: "nope" }]).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ["未知 t", { t: "nope" }],
    ["hello 协议版本不对", { ...serverEvents.hello, v: 2 }],
    ["hello 心跳不是 25000", { ...serverEvents.hello, heartbeatMs: 1000 }],
    ["hello maxTopics 不是 64", { ...serverEvents.hello, maxTopics: 10 }],
    ["book.snapshot 的 topic 不是 book:", { ...serverEvents["book.snapshot"], topic: `trades:${SYMBOL}` }],
    ["trades 的 topic 不是 trades:", { ...serverEvents.trades, topic: `book:${SYMBOL}` }],
    ["candle 的 topic 不是 candles:", { ...serverEvents.candle, topic: `book:${SYMBOL}` }],
    ["order 的 topic 不是 account", { ...serverEvents.order, topic: `book:${SYMBOL}` }],
    ["价格不是整数分", { ...serverEvents["book.snapshot"], bids: [level(67.95, 1)] }],
    ["数量不是整数吨", { ...serverEvents.trades, trades: [{ ...tape, quantity: 0.5 }] }],
    ["auditRef 不是 SIM-TRD- 前缀", { ...serverEvents.trades, trades: [{ ...tape, auditRef: "REG-12345" }] }],
    ["error code 未知", { ...serverEvents.error, code: "boom" }],
    ["resync reason 未知", { ...serverEvents.resync, reason: "because" }],
    ["seq 为负", { ...serverEvents.subscribed, seq: -1 }],
    ["position 的 costBasisStatus 未知", { ...serverEvents.position, position: { ...position, costBasisStatus: "guess" } }],
    ["order 的 status 未知", { ...serverEvents.order, order: { ...order, status: "NEW" } }],
  ])("拒绝 %s", (_label, bad) => {
    expect(serverEventSchema.safeParse(bad).success).toBe(false);
  });
});

describe("常量两边一致", () => {
  it("WS_* 常量 TS 与 ws-schema.mjs 相等", () => {
    expect(MJS_WS_PROTOCOL_VERSION).toBe(WS_PROTOCOL_VERSION);
    expect(MJS_WS_HEARTBEAT_MS).toBe(WS_HEARTBEAT_MS);
    expect(MJS_WS_MAX_TOPICS).toBe(WS_MAX_TOPICS);
    expect(MJS_WS_TAPE_RING).toBe(WS_TAPE_RING);
    expect([WS_PROTOCOL_VERSION, WS_HEARTBEAT_MS, WS_MAX_TOPICS, WS_TAPE_RING]).toEqual([1, 25_000, 64, 64]);
  });
  it("CANDLE_INTERVALS 两边相等且顺序一致", () => {
    expect([...MJS_CANDLE_INTERVALS]).toEqual([...CANDLE_INTERVALS]);
    expect(CANDLE_INTERVALS).toEqual(["1m", "5m", "15m", "1h", "4h", "1d"]);
  });
});

describe("类型层断言(由 tsc --noEmit 检查)", () => {
  it("Instrument 无 anchorPrice / description / createdAt,键集恰为 18 个", () => {
    expectTypeOf<Instrument>().not.toHaveProperty("anchorPrice");
    expectTypeOf<Instrument>().not.toHaveProperty("description");
    expectTypeOf<Instrument>().not.toHaveProperty("createdAt");
    expectTypeOf<keyof Instrument>().toEqualTypeOf<
      | "id" | "symbol" | "name" | "standard" | "projectType" | "vintage" | "country" | "registry" | "isScenario"
      | "projectId" | "methodology" | "verificationStatus" | "tickSize" | "pricePrecision" | "qtyStep" | "minQty" | "currency" | "lastPrice"
    >();
  });
  it("DraftError 恰为十个字面量", () => {
    expectTypeOf<DraftError>().toEqualTypeOf<
      "invalidPrice" | "invalidQty" | "belowMinQty" | "offTick" | "offStep" | "insufficientCash" | "insufficientQty" | "noLiquidity" | "overMaxNotional" | "overMaxPrice"
    >();
  });
  it("TS 协议类型可赋给 zod 输入类型(TS 少字段 / 类型不符时 tsc 报错)", () => {
    expectTypeOf<ClientOp>().toExtend<z.input<typeof clientOpSchema>>();
    expectTypeOf<ServerEvent>().toExtend<z.input<typeof serverEventSchema>>();
    expectTypeOf<ServerFrame>().toEqualTypeOf<ServerEvent[]>();
  });
});
