import { beforeEach, describe, expect, it } from "vitest";
import type { CandleBar, Instrument, InstrumentListItem, OrderBookLevel, ServerEvent, TapeEntry, Ticker } from "@/shared";
import { MAX_BARS, MAX_TAPE, auditRefOf } from "@/shared";
import { newestFirst } from "@/components/terminal/TradesTape";
import { framesFromTrades } from "./poll-frames";
import { candleKey, createInitialState, marketActions, reduceEvents, useMarketStore } from "./store";

const SYM = "VCS-FOR-2021";
const OTHER = "GS-REN-2020";
const L = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const snapshot = (symbol: string, bids: OrderBookLevel[], asks: OrderBookLevel[], seq = 1, ts = 1_000): ServerEvent => ({
  t: "book.snapshot",
  topic: `book:${symbol}`,
  seq,
  symbol,
  bids,
  asks,
  ts,
});
const delta = (symbol: string, bids: OrderBookLevel[], asks: OrderBookLevel[], seq = 2, ts = 1_001): ServerEvent => ({
  t: "book.delta",
  topic: `book:${symbol}`,
  seq,
  symbol,
  bids,
  asks,
  ts,
});
const trade = (id: string, price: number, ts: number, symbol = SYM): TapeEntry => ({
  id,
  symbol,
  price,
  quantity: 1,
  takerSide: "BUY",
  ts,
  auditRef: auditRefOf(id),
});
const trades = (symbol: string, entries: TapeEntry[], seq = 1): ServerEvent => ({ t: "trades", topic: `trades:${symbol}`, seq, symbol, trades: entries });
const ticker = (symbol: string, partial: Partial<Omit<Ticker, "symbol" | "ts">>, ts = 5, seq = 1): ServerEvent => ({
  t: "ticker",
  topic: `ticker:${symbol}`,
  seq,
  symbol,
  ticker: { symbol, ts, ...partial },
});
const bar = (t: number, c = 100): CandleBar => ({ t, o: c, h: c, l: c, c, v: 1 });
const candle = (symbol: string, interval: "1m" | "5m", b: CandleBar, seq = 1): ServerEvent => ({
  t: "candle",
  topic: `candles:${symbol}:${interval}`,
  seq,
  symbol,
  interval,
  candle: b,
});
const instrument = (symbol: string, lastPrice: number | null = 1000): Instrument => ({
  id: `id-${symbol}`,
  symbol,
  name: symbol,
  standard: "VCS",
  projectType: "FOR",
  vintage: 2021,
  country: "BR",
  registry: "Verra",
  isScenario: false,
  projectId: null,
  methodology: null,
  verificationStatus: null,
  tickSize: 1,
  pricePrecision: 2,
  qtyStep: 1,
  minQty: 1,
  currency: "USD",
  lastPrice,
});
const fullTicker = (symbol: string, ts = 1, lastPrice: number | null = 1000): Ticker => ({
  symbol,
  lastPrice,
  bestBid: null,
  bestAsk: null,
  change24h: null,
  high24h: null,
  low24h: null,
  volume24h: 0,
  ts,
});
const item = (symbol: string, ts = 1): InstrumentListItem => ({ instrument: instrument(symbol), ticker: fullTicker(symbol, ts) });

beforeEach(() => {
  useMarketStore.setState(createInitialState(), true);
});

describe("createInitialState", () => {
  it("全部为空;每次调用都是新对象", () => {
    const a = createInitialState();
    const b = createInitialState();
    expect(a).not.toBe(b);
    expect(a.instruments).toEqual({});
    expect(a.books).toEqual({});
    expect(a.tapes).toEqual({});
    expect(a.tapeReady).toEqual({});
    expect(a.candles).toEqual({});
    expect(a.watchlist).toEqual([]);
    expect(a.instrumentsVersion).toBe(0);
    expect(a.tickersVersion).toBe(0);
    expect(a.connection).toEqual({ transport: "none", state: "offline", lastMessageAt: null, rttMs: null });
    expect(a.draft).toEqual({ symbol: "", nonce: 0 });
    expect(useMarketStore.getInitialState()).toEqual(a);
  });
});

describe("applyEvents: book", () => {
  it("snapshot 建簿:Map 按价格索引,seq / ts 记录,version 递增", () => {
    marketActions.applyEvents([snapshot(SYM, [L(1000, 5), L(990, 3)], [L(1010, 2)], 7, 123)]);
    const book = useMarketStore.getState().books[SYM];
    expect(book.bids.get(1000)).toEqual(L(1000, 5));
    expect(book.bids.get(990)).toEqual(L(990, 3));
    expect(book.asks.get(1010)).toEqual(L(1010, 2));
    expect(book.seq).toBe(7);
    expect(book.ts).toBe(123);
    expect(book.version).toBeGreaterThan(0);
  });

  it("delta 改档、新增档、quantity 0 删档;version 递增、旧引用不被改", () => {
    marketActions.applyEvents([snapshot(SYM, [L(1000, 5), L(990, 3)], [L(1010, 2)])]);
    const before = useMarketStore.getState().books[SYM];
    marketActions.applyEvents([delta(SYM, [L(1000, 8), L(990, 0, 0), L(980, 1)], [L(1010, 0, 0)], 9, 200)]);
    const after = useMarketStore.getState().books[SYM];
    expect(after).not.toBe(before);
    expect(after.version).toBeGreaterThan(before.version);
    expect([...after.bids.values()].sort((a, b) => b.price - a.price)).toEqual([L(1000, 8), L(980, 1)]);
    expect(after.asks.size).toBe(0);
    expect(after.seq).toBe(9);
    expect(after.ts).toBe(200);
    // 旧 BookState 的 Map 未被就地修改
    expect(before.bids.get(990)).toEqual(L(990, 3));
    expect(before.asks.size).toBe(1);
  });

  it("没有快照在手的 delta 被忽略(不凭空建簿)", () => {
    marketActions.applyEvents([delta(SYM, [L(1000, 1)], [])]);
    expect(useMarketStore.getState().books[SYM]).toBeUndefined();
  });

  it("同一批多条 delta 顺序应用,只产生一次 version 递增", () => {
    marketActions.applyEvents([snapshot(SYM, [L(1000, 5)], [])]);
    const v0 = useMarketStore.getState().books[SYM].version;
    marketActions.applyEvents([delta(SYM, [L(1000, 6)], [], 2), delta(SYM, [L(1000, 0, 0), L(999, 4)], [], 3)]);
    const book = useMarketStore.getState().books[SYM];
    expect(book.version).toBe(v0 + 1);
    expect([...book.bids.values()]).toEqual([L(999, 4)]);
    expect(book.seq).toBe(3);
  });

  it("结构共享:只替换被触碰的 symbol,其它 symbol 引用相等;未触碰的切片引用相等", () => {
    marketActions.applyEvents([snapshot(SYM, [L(1000, 5)], []), snapshot(OTHER, [L(500, 1)], []), trades(SYM, [trade("t1", 1000, 1)])]);
    const s1 = useMarketStore.getState();
    marketActions.applyEvents([delta(SYM, [L(1000, 6)], [])]);
    const s2 = useMarketStore.getState();
    expect(s2.books).not.toBe(s1.books);
    expect(s2.books[SYM]).not.toBe(s1.books[SYM]);
    expect(s2.books[OTHER]).toBe(s1.books[OTHER]);
    expect(s2.tapes).toBe(s1.tapes);
    expect(s2.tickers).toBe(s1.tickers);
    expect(s2.candles).toBe(s1.candles);
    expect(s2.instruments).toBe(s1.instruments);
  });

  it("version 在快照之间也严格递增", () => {
    marketActions.applyEvents([snapshot(SYM, [L(1, 1)], [])]);
    const v1 = useMarketStore.getState().books[SYM].version;
    marketActions.applyEvents([snapshot(SYM, [L(2, 1)], [])]);
    const v2 = useMarketStore.getState().books[SYM].version;
    marketActions.evictSymbol(SYM);
    marketActions.applyEvents([snapshot(SYM, [L(3, 1)], [])]);
    const v3 = useMarketStore.getState().books[SYM].version;
    expect(v2).toBeGreaterThan(v1);
    expect(v3).toBeGreaterThan(v2);
  });
});

describe("applyEvents: trades", () => {
  it("追加(旧 → 新)并按 id 去重", () => {
    marketActions.applyEvents([trades(SYM, [trade("a", 100, 1), trade("b", 101, 2)])]);
    marketActions.applyEvents([trades(SYM, [trade("b", 101, 2), trade("c", 102, 3)])]);
    expect(useMarketStore.getState().tapes[SYM].map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("环 MAX_TAPE:超出时丢最旧的,且被丢掉的 id 之后可以再进来", () => {
    const first = Array.from({ length: MAX_TAPE + 30 }, (_, i) => trade(`t${i}`, 100 + i, i + 1));
    marketActions.applyEvents([trades(SYM, first)]);
    const tape = useMarketStore.getState().tapes[SYM];
    expect(tape).toHaveLength(MAX_TAPE);
    expect(tape[0].id).toBe("t30");
    expect(tape[MAX_TAPE - 1].id).toBe(`t${MAX_TAPE + 29}`);
    marketActions.applyEvents([trades(SYM, [trade("t0", 100, 999)])]);
    const again = useMarketStore.getState().tapes[SYM];
    expect(again).toHaveLength(MAX_TAPE);
    expect(again[MAX_TAPE - 1].id).toBe("t0");
  });

  it("WS → 轮询降级:WS 快照 t37..t100 之后,REST 的 t100..t1 按 ts 稳定排进去(去重),顶行仍是最新成交 t100", () => {
    const all = Array.from({ length: 100 }, (_, i) => trade(`t${i + 1}`, 1_000 + i, 10_000 + i * 10));
    marketActions.setConnection({ transport: "ws", state: "open", lastMessageAt: null, rttMs: null });
    marketActions.applyEvents([trades(SYM, all.slice(36), 7)]); // hub 环里最多 64 笔
    marketActions.setConnection({ transport: "poll", state: "degraded", lastMessageAt: null, rttMs: null });
    // REST trades?limit=100 新 → 旧,经 poll-frames 翻成升序的一条 trades 事件
    marketActions.applyEvents(framesFromTrades(SYM, { trades: all.slice().reverse(), seq: 0 }));
    const tape = useMarketStore.getState().tapes[SYM];
    expect(tape.map((e) => e.id)).toEqual(all.map((e) => e.id));
    expect(newestFirst(tape)[0].id).toBe("t100");
    // 再来一份相同的 REST 快照:全是重复,不产生 patch
    expect(reduceEvents(useMarketStore.getState(), framesFromTrades(SYM, { trades: all.slice().reverse(), seq: 0 }))).toBeNull();
  });

  it("乱序只按 ts 稳定排序:同一毫秒的成交保持到达顺序(一笔吃多档),不按 id 排", () => {
    marketActions.applyEvents([trades(SYM, [trade("z", 100, 20), trade("y", 101, 30), trade("x", 102, 30)])]);
    // 迟到的更早成交,其中一笔与已有成交同毫秒
    marketActions.applyEvents([trades(SYM, [trade("m", 99, 10), trade("b", 103, 30)])]);
    expect(useMarketStore.getState().tapes[SYM].map((e) => e.id)).toEqual(["m", "z", "y", "x", "b"]);
  });

  it("乱序批次超出 MAX_TAPE 时按 ts 丢最旧的,不是按数组位置", () => {
    const newer = Array.from({ length: MAX_TAPE }, (_, i) => trade(`n${i}`, 100, 1_000 + i));
    marketActions.applyEvents([trades(SYM, newer)]);
    marketActions.applyEvents([trades(SYM, [trade("late", 100, 500)])]);
    const tape = useMarketStore.getState().tapes[SYM];
    expect(tape).toHaveLength(MAX_TAPE);
    expect(tape[0].id).toBe("n0");
    expect(tape.some((e) => e.id === "late")).toBe(false);
    expect(tape[MAX_TAPE - 1].id).toBe(`n${MAX_TAPE - 1}`);
  });

  it("空 trades 快照只置 tapeReady、不建 tape 键;再来一次空的不产生 patch;其它 symbol 的 tape 引用不变", () => {
    marketActions.applyEvents([trades(OTHER, [trade("o1", 1, 1, OTHER)])]);
    const s1 = useMarketStore.getState();
    expect(reduceEvents(s1, [trades(SYM, [])])).toEqual({ tapeReady: { [OTHER]: true, [SYM]: true } });
    marketActions.applyEvents([trades(SYM, [])]);
    const s2 = useMarketStore.getState();
    expect(s2.tapes).toBe(s1.tapes);
    expect(s2.tapes[SYM]).toBeUndefined();
    expect(s2.tapeReady[SYM]).toBe(true);
    // 轮询每 2 s 一份空快照:已就绪时不产生 patch
    expect(reduceEvents(s2, [trades(SYM, [])])).toBeNull();
    marketActions.applyEvents([trades(SYM, [trade("a", 100, 1)])]);
    const s3 = useMarketStore.getState();
    expect(s3.tapes[OTHER]).toBe(s1.tapes[OTHER]);
    expect(s3.tapes[SYM]).toHaveLength(1);
    expect(s3.tapeReady).toBe(s2.tapeReady);
  });

  it("tapeReady:收到 trades 事件(快照或增量)置位;hub 回 unsubscribed{trades:S} 清掉,其它 topic 的退订不碰", () => {
    const s0 = useMarketStore.getState();
    expect(s0.tapeReady[SYM]).toBeUndefined();
    marketActions.applyEvents([{ t: "subscribed", topic: `trades:${SYM}`, seq: 4 }, trades(SYM, [trade("a", 100, 1)], 4)]);
    expect(useMarketStore.getState().tapeReady).toEqual({ [SYM]: true });
    // 盘口快照不代表成交快照到了
    marketActions.applyEvents([snapshot(OTHER, [L(1000, 1)], [])]);
    expect(useMarketStore.getState().tapeReady[OTHER]).toBeUndefined();
    // 退订盘口 / 订阅确认不动标记
    const s1 = useMarketStore.getState();
    expect(reduceEvents(s1, [{ t: "unsubscribed", topic: `book:${SYM}` }, { t: "subscribed", topic: `trades:${SYM}`, seq: 9 }])).toBeNull();
    // 换标的:退订 trades:S → 清掉(tape 本身留到 evictSymbol);结构共享,其它键不变
    marketActions.applyEvents([trades(OTHER, [])]);
    const s2 = useMarketStore.getState();
    marketActions.applyEvents([{ t: "unsubscribed", topic: `trades:${SYM}` }]);
    const s3 = useMarketStore.getState();
    expect(s3.tapeReady).toEqual({ [OTHER]: true });
    expect(s3.tapes).toBe(s2.tapes);
    expect(s3.tapes[SYM]).toHaveLength(1);
    // 没置位的标的被退订:不产生 patch
    expect(reduceEvents(s3, [{ t: "unsubscribed", topic: `trades:${SYM}` }])).toBeNull();
  });

  it("tapeReady:同一批里「退订 → 重新订阅 → 快照」按顺序折叠,最后是就绪", () => {
    marketActions.applyEvents([trades(SYM, [])]);
    const batch: ServerEvent[] = [
      { t: "unsubscribed", topic: `trades:${SYM}` },
      { t: "subscribed", topic: `trades:${SYM}`, seq: 0 },
      trades(SYM, [], 0),
    ];
    marketActions.applyEvents(batch);
    expect(useMarketStore.getState().tapeReady).toEqual({ [SYM]: true });
    marketActions.applyEvents([{ t: "unsubscribed", topic: `trades:${SYM}` }, { t: "subscribed", topic: `trades:${SYM}`, seq: 0 }]);
    expect(useMarketStore.getState().tapeReady[SYM]).toBeUndefined();
    marketActions.applyEvents([trades(SYM, [], 0)]);
    expect(useMarketStore.getState().tapeReady[SYM]).toBe(true);
  });

  it("WS 模式下成交不折进 K 线", () => {
    marketActions.setConnection({ transport: "ws", state: "open", lastMessageAt: null, rttMs: null });
    marketActions.applyEvents([candle(SYM, "1m", bar(60_000, 100))]);
    marketActions.applyEvents([trades(SYM, [trade("a", 100, 60_001)])]);
    const before = useMarketStore.getState().candles[candleKey(SYM, "1m")];
    marketActions.applyEvents([trades(SYM, [trade("b", 150, 60_002)])]);
    const after = useMarketStore.getState().candles[candleKey(SYM, "1m")];
    expect(after).toBe(before);
    expect(after).toEqual([bar(60_000, 100)]);
  });

  it("轮询模式下,比已知最新成交更新的成交折进已加载的 interval(同桶更新、跨桶开新桶),首批与更早的不折", () => {
    marketActions.setConnection({ transport: "poll", state: "open", lastMessageAt: null, rttMs: null });
    marketActions.applyEvents([candle(SYM, "1m", { t: 60_000, o: 100, h: 100, l: 100, c: 100, v: 1 }), candle(SYM, "5m", { t: 0, o: 100, h: 100, l: 100, c: 100, v: 1 })]);
    // 首批 tape(之前没有 tape):不折
    marketActions.applyEvents([trades(SYM, [trade("a", 100, 60_001)])]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "1m")]).toEqual([{ t: 60_000, o: 100, h: 100, l: 100, c: 100, v: 1 }]);
    // 之后的新成交:1m 同桶更新,5m 同桶更新;更早的成交(ts ≤ 已知最新)不折
    marketActions.applyEvents([trades(SYM, [trade("old", 50, 30_000), trade("b", 150, 60_002)])]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "1m")]).toEqual([{ t: 60_000, o: 100, h: 150, l: 100, c: 150, v: 2 }]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "5m")]).toEqual([{ t: 0, o: 100, h: 150, l: 100, c: 150, v: 2 }]);
    // 跨桶:1m 开新桶,5m 仍同桶
    marketActions.applyEvents([trades(SYM, [trade("c", 120, 120_000)])]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "1m")]).toEqual([
      { t: 60_000, o: 100, h: 150, l: 100, c: 150, v: 2 },
      { t: 120_000, o: 120, h: 120, l: 120, c: 120, v: 1 },
    ]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "5m")]).toEqual([{ t: 0, o: 100, h: 150, l: 100, c: 120, v: 3 }]);
    // 未加载的 interval 不凭空出现
    expect(useMarketStore.getState().candles[candleKey(SYM, "1h")]).toBeUndefined();
  });
});

describe("applyEvents: ticker", () => {
  it("部分字段合并;首次出现时其余字段取空值;tickersVersion 每批 +1", () => {
    marketActions.applyEvents([ticker(SYM, { lastPrice: 1000, bestBid: 990 }, 5)]);
    let s = useMarketStore.getState();
    expect(s.tickers[SYM]).toEqual({ ...fullTicker(SYM, 5, 1000), bestBid: 990 });
    expect(s.tickersVersion).toBe(1);
    marketActions.applyEvents([ticker(SYM, { bestAsk: 1010 }, 6), ticker(SYM, { lastPrice: 1005 }, 7)]);
    s = useMarketStore.getState();
    expect(s.tickers[SYM]).toEqual({ ...fullTicker(SYM, 7, 1005), bestBid: 990, bestAsk: 1010 });
    expect(s.tickersVersion).toBe(2);
  });

  it("显式 undefined 字段不覆盖旧值;其它 symbol 的 ticker 引用不变", () => {
    marketActions.applyEvents([ticker(SYM, { lastPrice: 1000 }), ticker(OTHER, { lastPrice: 500 })]);
    const s1 = useMarketStore.getState();
    marketActions.applyEvents([ticker(SYM, { lastPrice: undefined, volume24h: 9 }, 8)]);
    const s2 = useMarketStore.getState();
    expect(s2.tickers[SYM].lastPrice).toBe(1000);
    expect(s2.tickers[SYM].volume24h).toBe(9);
    expect(s2.tickers[SYM].ts).toBe(8);
    expect(s2.tickers[OTHER]).toBe(s1.tickers[OTHER]);
    expect(s2.tickers).not.toBe(s1.tickers);
  });
});

describe("applyEvents: candle", () => {
  it("按 t upsert:末根替换、更新的 t 追加、更早的 t 插入到正确位置", () => {
    marketActions.applyEvents([candle(SYM, "1m", bar(120_000, 1)), candle(SYM, "1m", bar(180_000, 2))]);
    marketActions.applyEvents([candle(SYM, "1m", bar(180_000, 3))]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "1m")]).toEqual([bar(120_000, 1), bar(180_000, 3)]);
    marketActions.applyEvents([candle(SYM, "1m", bar(60_000, 0)), candle(SYM, "1m", bar(120_000, 9)), candle(SYM, "1m", bar(240_000, 4))]);
    expect(useMarketStore.getState().candles[candleKey(SYM, "1m")]).toEqual([bar(60_000, 0), bar(120_000, 9), bar(180_000, 3), bar(240_000, 4)]);
  });

  it("超过 MAX_BARS 从最旧一端裁掉;不同 interval / symbol 的键互不影响", () => {
    const many = Array.from({ length: MAX_BARS + 5 }, (_, i) => candle(SYM, "1m", bar((i + 1) * 60_000, i)));
    marketActions.applyEvents([...many, candle(SYM, "5m", bar(0, 7)), candle(OTHER, "1m", bar(0, 8))]);
    const s = useMarketStore.getState();
    const bars = s.candles[candleKey(SYM, "1m")];
    expect(bars).toHaveLength(MAX_BARS);
    expect(bars[0].t).toBe(6 * 60_000);
    expect(s.candles[candleKey(SYM, "5m")]).toEqual([bar(0, 7)]);
    expect(s.candles[candleKey(OTHER, "1m")]).toEqual([bar(0, 8)]);
    const before = s.candles[candleKey(OTHER, "1m")];
    marketActions.applyEvents([candle(SYM, "1m", bar(1, 1))]);
    expect(useMarketStore.getState().candles[candleKey(OTHER, "1m")]).toBe(before);
  });
});

describe("applyEvents: 控制事件", () => {
  it("hello / subscribed / pong / error / resync 与 account 事件不改 store(reduceEvents 返回 null)", () => {
    marketActions.applyEvents([snapshot(SYM, [L(1000, 1)], [])]);
    const s1 = useMarketStore.getState();
    // (退订 trades:S 会清 tapeReady,见 applyEvents: trades;这里是没有就绪标记的 book 主题)
    const control: ServerEvent[] = [
      { t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: null, maxTopics: 64 },
      { t: "subscribed", topic: `book:${SYM}`, seq: 3 },
      { t: "unsubscribed", topic: `book:${SYM}` },
      { t: "pong", t0: 1, serverTime: 2 },
      { t: "error", code: "rate_limited", message: "slow down" },
      { t: "resync", topic: `book:${SYM}`, reason: "backpressure" },
      { t: "balance", topic: "account", seq: 1, balance: { cashBalance: 1, lockedCash: 0 } },
    ];
    expect(reduceEvents(s1, control)).toBeNull();
    marketActions.applyEvents(control);
    expect(useMarketStore.getState()).toBe(s1);
    expect(useMarketStore.getState().books[SYM]).toBe(s1.books[SYM]);
  });

  it("空数组不触发 set", () => {
    const s1 = useMarketStore.getState();
    marketActions.applyEvents([]);
    expect(useMarketStore.getState()).toBe(s1);
  });
});

describe("setInstruments", () => {
  it("灌入后 instrumentsVersion / tickersVersion 递增;instruments 整体替换", () => {
    marketActions.setInstruments([item(SYM), item(OTHER)]);
    let s = useMarketStore.getState();
    expect(Object.keys(s.instruments).sort()).toEqual([OTHER, SYM].sort());
    expect(s.instrumentsVersion).toBe(1);
    expect(s.tickersVersion).toBe(1);
    marketActions.setInstruments([item(SYM)]);
    s = useMarketStore.getState();
    expect(Object.keys(s.instruments)).toEqual([SYM]);
    expect(s.instrumentsVersion).toBe(2);
  });

  it("onlyIfEmpty:已灌过则不写;未灌过则写", () => {
    marketActions.setInstruments([item(SYM)], { onlyIfEmpty: true });
    expect(useMarketStore.getState().instrumentsVersion).toBe(1);
    marketActions.setInstruments([item(OTHER)], { onlyIfEmpty: true });
    const s = useMarketStore.getState();
    expect(s.instrumentsVersion).toBe(1);
    expect(Object.keys(s.instruments)).toEqual([SYM]);
  });

  it("不用更旧的 ticker 覆盖 live 值,但更新的会覆盖", () => {
    marketActions.applyEvents([ticker(SYM, { lastPrice: 1234 }, 10)]);
    marketActions.setInstruments([item(SYM, 5)]);
    expect(useMarketStore.getState().tickers[SYM].lastPrice).toBe(1234);
    marketActions.setInstruments([item(SYM, 11)]);
    expect(useMarketStore.getState().tickers[SYM].lastPrice).toBe(1000);
  });
});

describe("setConnection / setDraft / setWatchlist / evictSymbol", () => {
  it("setConnection 相同值不触发 set,不同值替换", () => {
    const s0 = useMarketStore.getState();
    marketActions.setConnection({ transport: "none", state: "offline", lastMessageAt: null, rttMs: null });
    expect(useMarketStore.getState()).toBe(s0);
    marketActions.setConnection({ transport: "ws", state: "open", lastMessageAt: 1, rttMs: 20 });
    expect(useMarketStore.getState().connection).toEqual({ transport: "ws", state: "open", lastMessageAt: 1, rttMs: 20 });
  });

  it("setDraft 整颗替换种子并 nonce + 1:同价再点也变;只带 side 的调用不带回上一次点价的 price", () => {
    marketActions.setDraft({ symbol: SYM, price: 1000, side: "SELL" });
    expect(useMarketStore.getState().draft).toEqual({ symbol: SYM, price: 1000, side: "SELL", nonce: 1 });
    // 同价再点:内容一样,nonce 变了(OrderPanel 的 effect 照样触发)
    marketActions.setDraft({ symbol: SYM, price: 1000, side: "SELL" });
    expect(useMarketStore.getState().draft).toEqual({ symbol: SYM, price: 1000, side: "SELL", nonce: 2 });
    // 手机买卖条 / 持仓 Sell / b · s 热键:只带方向 → 种子里没有 price(不是沿用 1000)
    marketActions.setDraft({ symbol: SYM, side: "BUY" });
    const sideOnly = useMarketStore.getState().draft;
    expect(sideOnly).toEqual({ symbol: SYM, side: "BUY", nonce: 3 });
    expect("price" in sideOnly).toBe(false);
    // 显式 price: undefined(P1-22 这一波的写法)兼容:效果相同
    marketActions.setDraft({ symbol: SYM, side: "SELL", price: undefined });
    expect(useMarketStore.getState().draft).toEqual({ symbol: SYM, side: "SELL", price: undefined, nonce: 4 });
    expect(useMarketStore.getState().draft.price).toBeUndefined();
    // 不带 symbol:symbol 为 "",不沿用上一颗的标的(面板不认)
    marketActions.setDraft({ price: 1000 });
    expect(useMarketStore.getState().draft).toEqual({ symbol: "", price: 1000, nonce: 5 });
  });

  it("setWatchlist 相同内容不触发 set,不同内容复制一份", () => {
    const input = [SYM, OTHER];
    marketActions.setWatchlist(input);
    const w1 = useMarketStore.getState().watchlist;
    expect(w1).toEqual(input);
    expect(w1).not.toBe(input);
    marketActions.setWatchlist([SYM, OTHER]);
    expect(useMarketStore.getState().watchlist).toBe(w1);
    marketActions.setWatchlist([OTHER]);
    expect(useMarketStore.getState().watchlist).toEqual([OTHER]);
  });

  it("evictSymbol 丢盘口 / tape(连同 tapeReady)/ 各 interval K 线,保留 instruments / tickers 与其它 symbol", () => {
    marketActions.setInstruments([item(SYM), item(OTHER)]);
    marketActions.applyEvents([
      snapshot(SYM, [L(1, 1)], []),
      snapshot(OTHER, [L(2, 1)], []),
      trades(SYM, [trade("a", 1, 1)]),
      candle(SYM, "1m", bar(0)),
      candle(SYM, "5m", bar(0)),
      candle(OTHER, "1m", bar(0)),
    ]);
    const s1 = useMarketStore.getState();
    marketActions.evictSymbol(SYM);
    const s2 = useMarketStore.getState();
    expect(s2.books[SYM]).toBeUndefined();
    expect(s2.tapes[SYM]).toBeUndefined();
    expect(s2.tapeReady[SYM]).toBeUndefined();
    expect(s2.candles[candleKey(SYM, "1m")]).toBeUndefined();
    expect(s2.candles[candleKey(SYM, "5m")]).toBeUndefined();
    expect(s2.books[OTHER]).toBe(s1.books[OTHER]);
    expect(s2.candles[candleKey(OTHER, "1m")]).toBe(s1.candles[candleKey(OTHER, "1m")]);
    expect(s2.instruments).toBe(s1.instruments);
    expect(s2.tickers).toBe(s1.tickers);
    // 再 evict 一个没有数据的 symbol:不触发 set
    marketActions.evictSymbol("NOPE");
    expect(useMarketStore.getState()).toBe(s2);
  });
});
