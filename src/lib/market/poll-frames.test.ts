import { describe, expect, it, vi } from "vitest";
import type { Balance, BookResponse, CandlesResponse, InstrumentsResponse, Order, Position, ServerEvent, TradesResponse } from "@/shared";
import { DEFAULT_FEE_SCHEDULE, auditRefOf } from "@/shared";
import { serverEventSchema, serverFrameSchema } from "../../../server/ws-schema.mjs";
import { createBatcher } from "./batcher";
import { NO_SEQ, framesFromAccount, framesFromBook, framesFromCandles, framesFromInstruments, framesFromTrades } from "./poll-frames";
import { createTransportManager } from "./transport";
import { createWsClient } from "./ws-client";

// 翻译结果必须与 WS 事件同形(server/ws-schema.mjs 的 serverEventSchema 通过),seq 原样带入、无序号为 0;
// seq 0 的帧经 batcher 只会到 apply,不会让任何传输层发出重订阅。

const SYM = "VCS-FOR-2021";
const instrument = (symbol: string) => ({
  id: `a-${symbol}`,
  symbol,
  name: "n",
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
  currency: "USD" as const,
  lastPrice: 1234,
});
const ticker = (symbol: string, ts = 10) => ({ symbol, lastPrice: 1234, bestBid: 1230, bestAsk: 1240, change24h: -1.5, high24h: 1300, low24h: 1200, volume24h: 42, ts });
const trade = (id: string, ts: number) => ({ id, symbol: SYM, price: 1234, quantity: 2, takerSide: "SELL" as const, ts, auditRef: auditRefOf(id) });
const order = (id: string): Order => ({
  id,
  clientOrderId: null,
  assetId: `a-${SYM}`,
  symbol: SYM,
  side: "BUY",
  type: "LIMIT",
  price: 1200,
  quantity: 5,
  filledQuantity: 0,
  status: "OPEN",
  avgFillPrice: null,
  cancelReason: null,
  createdAt: 1,
  updatedAt: 1,
});
const position = (symbol: string): Position => ({
  assetId: `a-${symbol}`,
  symbol,
  quantity: 10,
  locked: 2,
  available: 8,
  retired: 0,
  lastPrice: 1234,
  marketValue: 12340,
  averagePurchasePrice: null,
  unrealisedPnl: null,
  costBasisStatus: "unknown_acquisition_cost",
  isScenario: false,
});
const balance: Balance = { cashBalance: 100_000, lockedCash: 6_000 };

const validFrame = (frame: ServerEvent[]) => {
  const parsed = serverFrameSchema.safeParse(frame);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  for (const ev of frame) expect(serverEventSchema.safeParse(ev).success).toBe(true);
};

describe("poll-frames", () => {
  it("framesFromBook:一条 book.snapshot,seq / 档位 / ts 原样", () => {
    const r: BookResponse = { symbol: SYM, bids: [{ price: 1230, quantity: 3, orders: 1 }], asks: [{ price: 1240, quantity: 1, orders: 2 }], ts: 99, seq: 17 };
    const frame = framesFromBook(SYM, r);
    validFrame(frame);
    expect(frame).toEqual([{ t: "book.snapshot", topic: `book:${SYM}`, seq: 17, symbol: SYM, bids: r.bids, asks: r.asks, ts: 99 }]);
    expect(frame[0]).not.toBe(r); // 新对象,不借用响应对象本身
  });

  it("framesFromTrades:一条 trades,按 ts 升序(REST 是 desc),seq 原样,不改原数组", () => {
    const r: TradesResponse = { trades: [trade("c", 3), trade("b", 2), trade("a", 1)], seq: 5 };
    const frame = framesFromTrades(SYM, r);
    validFrame(frame);
    const ev = frame[0] as Extract<ServerEvent, { t: "trades" }>;
    expect(ev.topic).toBe(`trades:${SYM}`);
    expect(ev.seq).toBe(5);
    expect(ev.trades.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(r.trades.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("framesFromTrades:同一毫秒的多笔成交(desc 里倒着)按创建顺序排出,与 WS 一致", () => {
    // 创建顺序 a b c d e(b c d 同一毫秒);REST 按 createdAt desc 返回 e d c b a
    const r: TradesResponse = { trades: [trade("e", 3), trade("d", 2), trade("c", 2), trade("b", 2), trade("a", 1)], seq: 5 };
    const ev = framesFromTrades(SYM, r)[0] as Extract<ServerEvent, { t: "trades" }>;
    expect(ev.trades.map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(r.trades.map((t) => t.id)).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("framesFromInstruments:每标的一条 ticker:* 全量事件,seq 0", () => {
    const r: InstrumentsResponse = {
      instruments: [
        { instrument: instrument(SYM), ticker: ticker(SYM) },
        { instrument: instrument("GS-REN-2022"), ticker: ticker("GS-REN-2022", 11) },
      ],
      feeSchedule: DEFAULT_FEE_SCHEDULE,
      serverTime: 12,
    };
    const frame = framesFromInstruments(r);
    validFrame(frame);
    expect(frame).toHaveLength(2);
    expect(frame[0]).toEqual({ t: "ticker", topic: "ticker:*", seq: NO_SEQ, symbol: SYM, ticker: ticker(SYM) });
    expect((frame[1] as { symbol: string }).symbol).toBe("GS-REN-2022");
    expect(framesFromInstruments({ ...r, instruments: [] })).toEqual([]);
  });

  it("framesFromCandles:每根 bar 一条 candle,interval 以调用方为准,seq 0", () => {
    const r: CandlesResponse = { interval: "5m", candles: [{ t: 0, o: 1, h: 2, l: 1, c: 2, v: 3 }, { t: 300_000, o: 2, h: 2, l: 2, c: 2, v: 0 }] };
    const frame = framesFromCandles(SYM, "5m", r);
    validFrame(frame);
    expect(frame.map((e) => e.t)).toEqual(["candle", "candle"]);
    expect(frame[0]).toEqual({ t: "candle", topic: `candles:${SYM}:5m`, seq: NO_SEQ, symbol: SYM, interval: "5m", candle: r.candles[0] });
    expect(framesFromCandles(SYM, "1d", { interval: "1d", candles: [] })).toEqual([]);
  });

  it("framesFromAccount:balance → 逐条 order → 逐条 position,与 hub 的 account 快照同序,seq 0", () => {
    const frame = framesFromAccount([order("o1"), order("o2")], [position(SYM)], balance);
    validFrame(frame);
    expect(frame.map((e) => e.t)).toEqual(["balance", "order", "order", "position"]);
    expect(frame[0]).toEqual({ t: "balance", topic: "account", seq: NO_SEQ, balance });
    expect((frame[1] as { order: Order }).order.id).toBe("o1");
    expect(framesFromAccount([], [], balance)).toHaveLength(1);
  });

  it("seq 0 的轮询帧经 batcher 只到 apply;喂给 ws-client 也不发重订阅;轮询模式的传输管理器从不建 socket", () => {
    vi.useFakeTimers();
    try {
      const apply = vi.fn();
      const b = createBatcher(apply, { hidden: () => false });
      const frames = [
        ...framesFromBook(SYM, { symbol: SYM, bids: [], asks: [], ts: 1, seq: 0 }),
        ...framesFromTrades(SYM, { trades: [trade("a", 1)], seq: 0 }),
        ...framesFromInstruments({ instruments: [{ instrument: instrument(SYM), ticker: ticker(SYM) }], feeSchedule: DEFAULT_FEE_SCHEDULE, serverTime: 1 }),
        ...framesFromCandles(SYM, "1m", { interval: "1m", candles: [{ t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 }] }),
        ...framesFromAccount([order("o1")], [], balance),
      ];
      b.push(frames);
      b.flush();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply.mock.calls[0][0]).toHaveLength(frames.length);

      // 同样的帧从一条已连上的 ws 连接进来:seq 全 0,乱序也不算缺口,没有任何 subscribe / unsubscribe
      FakeSock.instances = [];
      const client = createWsClient({ url: "ws://x", onFrame: () => {}, onState: () => {}, wsImpl: FakeSock as unknown as typeof WebSocket });
      client.subscribe(`book:${SYM}`);
      client.subscribe(`trades:${SYM}`);
      client.subscribe("account");
      client.start();
      const sock = FakeSock.instances[0];
      sock.readyState = 1;
      sock.onmessage?.({ data: JSON.stringify([{ t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: null, maxTopics: 64 }]) } as MessageEvent);
      sock.sent = [];
      sock.onmessage?.({ data: JSON.stringify(frames) } as MessageEvent);
      sock.onmessage?.({ data: JSON.stringify(frames.slice().reverse()) } as MessageEvent);
      expect(sock.sent).toEqual([]);
      client.stop();

      // 强制轮询:订阅、reconnect、等 2 分钟,一个 socket 都不建
      FakeSock.instances = [];
      const onState = vi.fn();
      const manager = createTransportManager({ mode: "poll", wsUrl: "ws://x", onFrame: () => {}, onState, ws: { wsImpl: FakeSock as unknown as typeof WebSocket } });
      manager.start();
      manager.subscribe(`book:${SYM}`);
      manager.reconnect();
      vi.advanceTimersByTime(120_000);
      expect(FakeSock.instances).toHaveLength(0);
      expect(manager.kind).toBe("poll");
      expect(onState).toHaveBeenCalledWith({ transport: "poll", state: "degraded", lastMessageAt: null, rttMs: null });
      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeSock {
  static instances: FakeSock[] = [];
  readyState = 0;
  sent: string[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    FakeSock.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
}
