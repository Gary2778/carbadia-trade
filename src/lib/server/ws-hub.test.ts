// server/ws-hub.mjs 的核心 createHub 用假 socket 测(计划 §3.3):hello、50 ms 合帧、每 topic 单调 seq 与 __carbadiaTopicSeq、
// since 回放(≤64 逐条、>64 快照)、第 65 个 topic、21 op/s、unknown_topic、坏帧、presence、背压(delta 与订阅快照)、心跳、统计日志、close(1012)。
// 背压、心跳与关闭用假时钟(vi.useFakeTimers)显式推进,不靠 sleep 的毫秒余量(这套测试是 Docker 构建门禁,卡顿的构建机不能让它翻车)。
// 每一帧都过 serverFrameSchema:hub 发出的东西必须与 TS 协议同形。
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../server/bus.mjs";
import { approxBytes, createHub, originAllowed, parseAllowedOrigins, zeroWsStats } from "../../../server/ws-hub.mjs";
import { serverFrameSchema } from "../../../server/ws-schema.mjs";
import type { AccountEvent, BusMessage } from "@/shared/bus";
import { auditRefOf } from "@/shared/constants";
import type { Order, OrderBookSnapshot, Position, TapeEntry } from "@/shared/types";
import type { ServerEvent, Topic } from "@/shared/ws-protocol";

class FakeWs extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  frames: ServerEvent[][] = [];
  pings = 0;
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  terminated = false;
  /** 收到 ping 就回 pong(默认);测心跳超时时置 false */
  answersPing = true;

  send(data: string, cb?: (err?: Error) => void) {
    this.frames.push(JSON.parse(data));
    cb?.();
  }
  close(code?: number, reason?: string) {
    if (this.closedWith) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", code ?? 1005, reason ?? ""));
  }
  terminate() {
    this.terminated = true;
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit("close", 1006, ""));
  }
  ping() {
    this.pings += 1;
    if (this.answersPing) queueMicrotask(() => this.emit("pong"));
  }
  /** 全部已发事件(先校验每帧都合协议) */
  events(): ServerEvent[] {
    for (const frame of this.frames) serverFrameSchema.parse(frame);
    return this.frames.flat();
  }
  of<T extends ServerEvent["t"]>(t: T): Extract<ServerEvent, { t: T }>[] {
    return this.events().filter((e): e is Extract<ServerEvent, { t: T }> => e.t === t);
  }
  /** 客户端 → 服务端一帧 */
  message(data: unknown) {
    this.emit("message", typeof data === "string" ? data : JSON.stringify(data), false);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const hubs: ReturnType<typeof createHub>[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close(1001, "test over");
  globalThis.__carbadiaAccountSnapshot = undefined;
  globalThis.__carbadiaBookRefresh = undefined;
  globalThis.__carbadiaRecentTrades = undefined;
  vi.restoreAllMocks();
});

function makeHub(opts: Parameters<typeof createHub>[0] = {}) {
  const bus = createBus();
  const hub = createHub({ bus, log: () => {}, batchMs: 5, backpressureScanMs: 5, isKnownSymbol: (s) => s !== "NOPE", ...opts });
  hubs.push(hub);
  return { hub, bus };
}

function snapshot(symbol: string, ts = 1_700_000_000_000): OrderBookSnapshot {
  return { symbol, bids: [{ price: 6_800, quantity: 10, orders: 1 }], asks: [{ price: 6_810, quantity: 5, orders: 1 }], ts };
}
function bookMsg(symbol: string, delta: boolean): BusMessage {
  const snap = snapshot(symbol);
  return { kind: "book", symbol, snapshot: snap, delta: delta ? { symbol, bids: [{ price: 6_800, quantity: 0, orders: 0 }], asks: [], ts: snap.ts } : null };
}
function trade(symbol: string, i: number): TapeEntry {
  return { id: `t${i}`, symbol, price: 6_800 + i, quantity: 1, takerSide: "BUY", ts: 1_700_000_000_000 + i, auditRef: `SIM-TRD-t${i}` };
}
function order(id: string): Order {
  return {
    id, clientOrderId: null, assetId: "a1", symbol: "VCS-FOR-2021", side: "BUY", type: "LIMIT", price: 6_800, quantity: 5, filledQuantity: 0,
    status: "OPEN", avgFillPrice: null, cancelReason: null, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
  };
}
function position(assetId: string): Position {
  return {
    assetId, symbol: "VCS-FOR-2021", quantity: 10, locked: 0, available: 10, retired: 0, lastPrice: 6_800, marketValue: 68_000,
    averagePurchasePrice: null, unrealisedPnl: null, costBasisStatus: "unknown_acquisition_cost", isScenario: false,
  };
}
async function connected(hub: ReturnType<typeof createHub>, userId: string | null = null) {
  const ws = new FakeWs();
  hub.accept(ws, { userId, ip: "local" });
  await vi.waitFor(() => expect(ws.of("hello")).toHaveLength(1));
  return ws;
}
async function subscribed(hub: ReturnType<typeof createHub>, topics: Topic[], userId: string | null = null) {
  const ws = await connected(hub, userId);
  ws.message({ op: "subscribe", topics });
  await vi.waitFor(() => expect(ws.of("subscribed")).toHaveLength(topics.length));
  return ws;
}

describe("createHub · 握手与合帧", () => {
  it("接管连接后先发 hello:v 1、heartbeatMs 25000、maxTopics 64、userId", async () => {
    const { hub } = makeHub();
    const ws = await connected(hub, "user_1");
    expect(ws.of("hello")[0]).toEqual({ t: "hello", v: 1, serverTime: expect.any(Number), heartbeatMs: 25_000, userId: "user_1", maxTopics: 64, bootId: expect.any(String) });
    expect(hub.stats().connections).toBe(1);
  });

  it("hello 带本进程(hub)的启动标识 bootId:同一个 hub 的连接都一样,另起的 hub(= 重启后的进程)不一样;可注入(终审 P1-25a)", async () => {
    // 没有它,非 1012 的重启(崩溃、OOM、pong 超时重连)之后客户端带旧进程的 trades since 重订阅,新进程的 seq 若恰好落在
    // [since, since + 64] 里,hub 会当它已追平,只回放 seq > since 的那几笔
    const first = makeHub().hub;
    const a = await connected(first);
    const b = await connected(first);
    const idA = a.of("hello")[0].bootId;
    expect(idA).toMatch(/^[0-9a-z-]{8,}$/);
    expect(b.of("hello")[0].bootId).toBe(idA);
    const restarted = await connected(makeHub().hub);
    expect(restarted.of("hello")[0].bootId).not.toBe(idA);
    const injected = await connected(makeHub({ bootId: "boot-fixed" }).hub);
    expect(injected.of("hello")[0].bootId).toBe("boot-fixed");
  });

  it("50 ms 合帧:同一窗口内的事件合成一个数组帧,窗口结束前什么都不发", async () => {
    const { hub, bus } = makeHub({ batchMs: 50 });
    const ws = new FakeWs();
    hub.accept(ws, { userId: null, ip: "local" });
    expect(ws.frames).toHaveLength(0); // hello 也走合帧
    await sleep(70);
    expect(ws.frames).toHaveLength(1);
    ws.message({ op: "subscribe", topics: ["book:X"] });
    await sleep(70);
    expect(ws.frames).toHaveLength(2);
    expect(ws.frames[1].map((e) => e.t)).toEqual(["subscribed"]); // hub 还没有这本簿:不发空快照
    bus.publish(bookMsg("X", true));
    bus.publish(bookMsg("X", true));
    bus.publish(bookMsg("X", true));
    expect(ws.frames).toHaveLength(2); // 同步发布不会立刻出帧
    await sleep(70);
    expect(ws.frames).toHaveLength(3);
    // 订阅时没有簿的连接,本 symbol 的第一条盘口消息对它以整份快照发出(它手里没有簿,delta 叠不上去),之后照常 delta
    expect(ws.frames[2].map((e) => e.t)).toEqual(["book.snapshot", "book.delta", "book.delta"]);
    expect(hub.stats().framesOut).toBe(3);
    expect(hub.stats().bytesOut).toBe(ws.frames.reduce((n, f) => n + Buffer.byteLength(JSON.stringify(f)), 0));
  });
});

describe("createHub · seq 与快照", () => {
  it("book:未发布过时 subscribed{seq: 0} 不带快照;整份快照 seq 1、delta 每次 +1,__carbadiaTopicSeq 与发出的 seq 一致;再订阅发缓存的快照", async () => {
    const { hub, bus } = makeHub();
    const ws = await subscribed(hub, ["book:X"]);
    expect(ws.of("subscribed")[0]).toEqual({ t: "subscribed", topic: "book:X", seq: 0 });
    await sleep(20);
    expect(ws.of("book.snapshot")).toHaveLength(0); // 没有缓存就不发(空快照会把客户端的簿清空)
    bus.publish(bookMsg("X", false));
    bus.publish(bookMsg("X", true));
    await vi.waitFor(() => expect(ws.of("book.delta")).toHaveLength(1));
    expect(ws.of("book.snapshot")[0]).toMatchObject({ topic: "book:X", seq: 1, symbol: "X", bids: snapshot("X").bids });
    expect(ws.of("book.delta")[0]).toMatchObject({ topic: "book:X", seq: 2, bids: [{ price: 6_800, quantity: 0, orders: 0 }] });
    expect(globalThis.__carbadiaTopicSeq?.get("book:X")).toBe(2);
    // 再订阅(幂等):快照带当前 seq 且用的是缓存的 50 档
    ws.message({ op: "subscribe", topics: ["book:X"] });
    await vi.waitFor(() => expect(ws.of("book.snapshot")).toHaveLength(2));
    expect(ws.of("book.snapshot")[1]).toMatchObject({ seq: 2, bids: snapshot("X").bids });
    expect(hub.stats().subscriptions).toBe(1);
  });

  it("总线 book 消息 delta 为 null 时推整份快照(seq +1)", async () => {
    const { hub, bus } = makeHub();
    const ws = await subscribed(hub, ["book:X"]);
    bus.publish(bookMsg("X", false));
    await vi.waitFor(() => expect(ws.of("book.snapshot")).toHaveLength(1));
    expect(ws.of("book.snapshot")[0]).toMatchObject({ seq: 1, bids: snapshot("X").bids });
  });

  it("ticker:SYM 发最后值(部分字段合并);ticker:* 有自己的 seq 并逐条发全部标的", async () => {
    const { hub, bus } = makeHub();
    await subscribed(hub, ["ticker:*", "book:A"]); // 有人订阅(发布器在喂),hub 才缓存最后值;书顶还要有人订 book:A
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 1, lastPrice: 100 } });
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 2, bestBid: 99 } });
    bus.publish({ kind: "ticker", symbol: "B", ticker: { symbol: "B", ts: 3, lastPrice: 200 } });
    const ws = await subscribed(hub, ["ticker:A", "ticker:*"]);
    expect(ws.of("subscribed")).toEqual([
      { t: "subscribed", topic: "ticker:A", seq: 2 },
      { t: "subscribed", topic: "ticker:*", seq: 3 },
    ]);
    const tickers = ws.of("ticker");
    expect(tickers[0]).toEqual({ t: "ticker", topic: "ticker:A", seq: 2, symbol: "A", ticker: { symbol: "A", ts: 2, lastPrice: 100, bestBid: 99 } });
    expect(tickers.slice(1)).toEqual([
      { t: "ticker", topic: "ticker:*", seq: 3, symbol: "A", ticker: { symbol: "A", ts: 2, lastPrice: 100, bestBid: 99 } },
      { t: "ticker", topic: "ticker:*", seq: 3, symbol: "B", ticker: { symbol: "B", ts: 3, lastPrice: 200 } },
    ]);
    bus.publish({ kind: "ticker", symbol: "B", ticker: { symbol: "B", ts: 4, lastPrice: 201 } });
    await vi.waitFor(() => expect(ws.of("ticker")).toHaveLength(4));
    expect(ws.of("ticker")[3]).toEqual({ t: "ticker", topic: "ticker:*", seq: 4, symbol: "B", ticker: { symbol: "B", ts: 4, lastPrice: 201 } });
    expect(globalThis.__carbadiaTopicSeq?.get("ticker:B")).toBe(2);
  });

  it("candles 只回 subscribed,不发历史;candle 事件按 interval 分 topic", async () => {
    const { hub, bus } = makeHub();
    const ws = await subscribed(hub, ["candles:X:1m"]);
    expect(ws.events().map((e) => e.t)).toEqual(["hello", "subscribed"]);
    const candle = { t: 1_700_000_000_000, o: 1, h: 2, l: 1, c: 2, v: 3 };
    bus.publish({ kind: "candle", symbol: "X", interval: "5m", candle });
    bus.publish({ kind: "candle", symbol: "X", interval: "1m", candle });
    await vi.waitFor(() => expect(ws.of("candle")).toHaveLength(1));
    expect(ws.of("candle")[0]).toEqual({ t: "candle", topic: "candles:X:1m", seq: 1, symbol: "X", interval: "1m", candle });
  });
});

describe("createHub · trades 环与 since 回放", () => {
  function publishTrades(bus: ReturnType<typeof createBus>, n: number) {
    for (let i = 1; i <= n; i += 1) bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", i)] });
  }

  it("每笔成交各占一个 seq;无 since 时快照 = 环里最近 ≤64 笔(一条 trades 事件,时间升序)", async () => {
    const { hub, bus } = makeHub();
    publishTrades(bus, 70);
    expect(globalThis.__carbadiaTopicSeq?.get("trades:X")).toBe(70);
    const ws = await subscribed(hub, ["trades:X"]);
    expect(ws.of("subscribed")[0]).toEqual({ t: "subscribed", topic: "trades:X", seq: 70 });
    const snap = ws.of("trades");
    expect(snap).toHaveLength(1);
    expect(snap[0].seq).toBe(70);
    expect(snap[0].trades.map((e) => e.id)).toEqual(Array.from({ length: 64 }, (_, i) => `t${i + 7}`));
  });

  it("缺口 ≤ 64:subscribed{seq: since} 后逐条回放,seq 连续且各带原 seq", async () => {
    const { hub, bus } = makeHub();
    publishTrades(bus, 70);
    const ws = await connected(hub);
    ws.message({ op: "subscribe", topics: ["trades:X"], since: { "trades:X": 6 } });
    await vi.waitFor(() => expect(ws.of("trades")).toHaveLength(64));
    expect(ws.of("subscribed")[0]).toEqual({ t: "subscribed", topic: "trades:X", seq: 6 });
    const replayed = ws.of("trades");
    expect(replayed.map((e) => e.seq)).toEqual(Array.from({ length: 64 }, (_, i) => 7 + i));
    expect(replayed.every((e) => e.trades.length === 1 && e.trades[0].id === `t${e.seq}`)).toBe(true);
  });

  it("缺口 > 64 或 since 在未来:退回快照(subscribed{seq: current} + 一条 trades)", async () => {
    const { hub, bus } = makeHub();
    publishTrades(bus, 70);
    const a = await connected(hub);
    a.message({ op: "subscribe", topics: ["trades:X"], since: { "trades:X": 5 } });
    await vi.waitFor(() => expect(a.of("trades")).toHaveLength(1));
    expect(a.of("subscribed")[0].seq).toBe(70);
    expect(a.of("trades")[0].trades).toHaveLength(64);
    const b = await connected(hub);
    b.message({ op: "subscribe", topics: ["trades:X"], since: { "trades:X": 99 } });
    await vi.waitFor(() => expect(b.of("trades")).toHaveLength(1));
    expect(b.of("subscribed")[0].seq).toBe(70);
  });

  it("since === current:只回 subscribed,不回放也不发快照", async () => {
    const { hub, bus } = makeHub();
    publishTrades(bus, 3);
    const ws = await connected(hub);
    ws.message({ op: "subscribe", topics: ["trades:X"], since: { "trades:X": 3 } });
    await vi.waitFor(() => expect(ws.of("subscribed")).toHaveLength(1));
    await sleep(20);
    expect(ws.of("subscribed")[0].seq).toBe(3);
    expect(ws.of("trades")).toHaveLength(0);
  });

  it("进程刚起(环未满)也能回放:since 0 → 从 seq 1 起全部回放", async () => {
    const { hub, bus } = makeHub();
    publishTrades(bus, 3);
    const ws = await connected(hub);
    ws.message({ op: "subscribe", topics: ["trades:X"], since: { "trades:X": 0 } });
    await vi.waitFor(() => expect(ws.of("trades")).toHaveLength(3));
    expect(ws.of("trades").map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("book / ticker 忽略 since(永远快照 / 最后值)", async () => {
    const { hub, bus } = makeHub();
    await subscribed(hub, ["book:X"]); // 有人订阅,hub 才缓存这本簿
    bus.publish(bookMsg("X", true));
    bus.publish(bookMsg("X", true));
    const ws = await connected(hub);
    ws.message({ op: "subscribe", topics: ["book:X"], since: { "book:X": 1 } });
    await vi.waitFor(() => expect(ws.of("book.snapshot")).toHaveLength(1));
    expect(ws.of("subscribed")[0].seq).toBe(2);
    expect(ws.of("book.delta")).toHaveLength(0);
  });
});

describe("createHub · 错误码", () => {
  it("第 65 个 topic → too_many_topics;重复订阅不占名额", async () => {
    const { hub } = makeHub();
    const ws = await connected(hub);
    const topics = Array.from({ length: 64 }, (_, i) => `candles:S${i}:1m` as Topic);
    ws.message({ op: "subscribe", topics });
    await vi.waitFor(() => expect(ws.of("subscribed")).toHaveLength(64));
    ws.message({ op: "subscribe", topics: ["candles:S0:1m", "candles:S64:1m"] });
    await vi.waitFor(() => expect(ws.of("error")).toHaveLength(1));
    expect(ws.of("subscribed")).toHaveLength(65); // 重复的那条仍回 subscribed
    expect(ws.of("error")[0]).toEqual({ t: "error", code: "too_many_topics", message: expect.any(String), topic: "candles:S64:1m" });
    expect(hub.stats().subscriptions).toBe(64);
  });

  it("21 op/s → 第 21 个 op 被丢并回 rate_limited", async () => {
    const { hub } = makeHub();
    const ws = await connected(hub);
    for (let i = 0; i < 21; i += 1) ws.message({ op: "ping", t0: i });
    await vi.waitFor(() => expect(ws.of("error")).toHaveLength(1));
    expect(ws.of("pong")).toHaveLength(20);
    expect(ws.of("error")[0]).toMatchObject({ code: "rate_limited" });
  });

  it("symbol 不存在 → unknown_topic(带 topic),其余 topic 照常订阅", async () => {
    const { hub } = makeHub();
    const ws = await connected(hub);
    ws.message({ op: "subscribe", topics: ["book:NOPE", "book:X"] });
    await vi.waitFor(() => expect(ws.of("subscribed")).toHaveLength(1));
    expect(ws.of("error")[0]).toEqual({ t: "error", code: "unknown_topic", message: expect.any(String), topic: "book:NOPE" });
    expect(ws.of("subscribed")[0].topic).toBe("book:X");
  });

  it("默认的 symbol 判定:总线见过的算存在;没有标的缓存时一律放行;有标的缓存时以缓存 ∪ 总线为准", async () => {
    const { hub, bus } = makeHub({ isKnownSymbol: undefined });
    const a = await connected(hub);
    a.message({ op: "subscribe", topics: ["book:ANY"] });
    await vi.waitFor(() => expect(a.of("subscribed")).toHaveLength(1)); // 一无所知 → 放行
    bus.publish(bookMsg("X", true));
    const b = await connected(hub);
    // 总线见过 X、还没见过 Y、也没有标的缓存:「见过别的」不是否定信号(发布器上线后 bot 第一轮逐个标的报价,不能误拒),两者都放行
    b.message({ op: "subscribe", topics: ["book:X", "book:Y"] });
    await vi.waitFor(() => expect(b.of("subscribed")).toHaveLength(2));
    expect(b.of("error")).toHaveLength(0);
    globalThis.__carbadiaInstrumentsCache = {
      at: Date.now(),
      value: { instruments: [{ instrument: { symbol: "Y" } } as never], feeSchedule: { makerBps: 0, takerBps: 0, minFeeCents: 0, demo: true }, serverTime: 0 },
    };
    try {
      const c = await connected(hub);
      c.message({ op: "subscribe", topics: ["book:Y", "book:X", "book:Z"] });
      await vi.waitFor(() => expect(c.of("error")).toHaveLength(1));
      expect(c.of("subscribed").map((e) => e.topic)).toEqual(["book:Y", "book:X"]);
      expect(c.of("error")[0]).toMatchObject({ topic: "book:Z" });
    } finally {
      globalThis.__carbadiaInstrumentsCache = undefined;
    }
  });

  it("标的列表过期(P1-25b 起作废只标过期、保留旧列表)仍按列表判断;全局缓存被整个清掉也用 hub 最后见过的那份:不在列表里的 symbol 一律 unknown_topic、零刷新(终审 P1-25a)", async () => {
    const bookRefresh = vi.fn();
    const { hub } = makeHub({ isKnownSymbol: undefined, bookRefresh });
    const list = { instruments: [{ instrument: { symbol: "Y" } } as never], feeSchedule: { makerBps: 0, takerBps: 0, minFeeCents: 0, demo: true as const }, serverTime: 0 };
    try {
      globalThis.__carbadiaInstrumentsCache = { at: -Infinity, value: list }; // 过期,但列表还在
      const a = await connected(hub);
      a.message({ op: "subscribe", topics: ["book:Y", "book:RANDOM1"] });
      await vi.waitFor(() => expect(a.of("error")).toHaveLength(1));
      expect(a.of("subscribed").map((e) => e.topic)).toEqual(["book:Y"]);
      expect(a.of("error")[0]).toMatchObject({ code: "unknown_topic", topic: "book:RANDOM1" });
      globalThis.__carbadiaInstrumentsCache = undefined; // 今天的 invalidateInstrumentsCache():整个清掉
      const b = await connected(hub);
      b.message({ op: "subscribe", topics: ["book:RANDOM2", "trades:Y"] });
      await vi.waitFor(() => expect(b.of("error")).toHaveLength(1));
      expect(b.of("error")[0]).toMatchObject({ code: "unknown_topic", topic: "book:RANDOM2" });
      expect(b.of("subscribed").map((e) => e.topic)).toEqual(["trades:Y"]);
      expect(bookRefresh.mock.calls).toEqual([["Y"]]);
    } finally {
      globalThis.__carbadiaInstrumentsCache = undefined;
    }
  });

  it("非 JSON / 不合 schema 的帧 → bad_request;连续 5 次 → close 1008;合法 op 重置计数", async () => {
    const { hub } = makeHub();
    const ws = await connected(hub);
    ws.message("not json");
    ws.message({ op: "subscribe" });
    ws.message({ op: "subscribe", topics: ["nonsense"] });
    ws.message({ op: "ping", t0: "late" });
    await vi.waitFor(() => expect(ws.of("error")).toHaveLength(4));
    expect(ws.of("error").every((e) => e.code === "bad_request")).toBe(true);
    ws.message({ op: "ping", t0: 1 }); // 重置连续计数
    ws.message("{");
    ws.message("{");
    ws.message("{");
    ws.message("{");
    await vi.waitFor(() => expect(ws.of("error")).toHaveLength(8));
    expect(ws.closedWith).toBeNull();
    ws.message("{"); // 连续第 5 次
    await vi.waitFor(() => expect(ws.closedWith).toEqual({ code: 1008, reason: expect.any(String) }));
    await vi.waitFor(() => expect(hub.stats().connections).toBe(0));
  });

  it("处理一帧时的意外抛错不外泄(否则经 ws 的接收器变成 uncaughtException):记一行日志,按坏帧回 bad_request、计入连续坏帧", async () => {
    const lines: string[] = [];
    const { hub } = makeHub({
      log: (line) => lines.push(line),
      isKnownSymbol: () => {
        throw new Error("boom");
      },
    });
    const ws = await connected(hub);
    expect(() => ws.message({ op: "subscribe", topics: ["book:X"] })).not.toThrow();
    await vi.waitFor(() => expect(ws.of("error")).toHaveLength(1));
    expect(ws.of("error")[0]).toMatchObject({ code: "bad_request" });
    expect(lines.some((l) => l.includes("[ws] message handler failed") && l.includes("boom"))).toBe(true);
    for (let i = 0; i < 4; i += 1) ws.message({ op: "subscribe", topics: ["book:X"] });
    await vi.waitFor(() => expect(ws.closedWith).toEqual({ code: 1008, reason: expect.any(String) }));
  });

  it("匿名订阅 account → unauthorized;登录用户订阅 account 只收自己的事件,seq 按用户各自单调", async () => {
    const { hub, bus } = makeHub();
    const anon = await connected(hub);
    anon.message({ op: "subscribe", topics: ["account"] });
    await vi.waitFor(() => expect(anon.of("error")).toHaveLength(1));
    expect(anon.of("error")[0]).toEqual({ t: "error", code: "unauthorized", message: expect.any(String), topic: "account" });

    const u1 = await subscribed(hub, ["account"], "u1");
    const u2 = await subscribed(hub, ["account"], "u2");
    const balance = { cashBalance: 100, lockedCash: 0 };
    bus.publish({ kind: "account", userId: "u2", event: { t: "balance", balance } });
    bus.publish({ kind: "account", userId: "u1", event: { t: "balance", balance } });
    await vi.waitFor(() => expect(u1.of("balance")).toHaveLength(1));
    await vi.waitFor(() => expect(u2.of("balance")).toHaveLength(1));
    expect(u1.of("balance")[0]).toEqual({ t: "balance", topic: "account", seq: 1, balance });
    expect(u2.of("balance")[0]).toEqual({ t: "balance", topic: "account", seq: 1, balance });
    expect(globalThis.__carbadiaTopicSeq?.has("account")).toBe(false);
  });

  it("account 订阅时若注入了快照来源,逐条发出且带当前 seq", async () => {
    const balance = { cashBalance: 5, lockedCash: 1 };
    const { hub } = makeHub({ accountSnapshot: async (userId) => [{ t: "balance", balance: { ...balance, cashBalance: userId.length } }] });
    const ws = await subscribed(hub, ["account"], "u1");
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(1));
    expect(ws.of("balance")[0]).toEqual({ t: "balance", topic: "account", seq: 0, balance: { cashBalance: 2, lockedCash: 1 } });
  });

  it("没注入选项时每次订阅读 globalThis.__carbadiaAccountSnapshot(发布器挂的钩子),{ balance, orders, positions } 展开为 balance → order → position", async () => {
    const { hub } = makeHub();
    const noHook = await subscribed(hub, ["account"], "u1");
    await sleep(20);
    expect(noHook.events().filter((e) => e.t === "balance" || e.t === "order" || e.t === "position")).toHaveLength(0); // 钩子还没挂:不发快照

    const hook = vi.fn(async (userId: string) => ({
      balance: { cashBalance: userId.length, lockedCash: 0 },
      orders: [order("o1"), order("o2")],
      positions: [position("a1")],
    }));
    globalThis.__carbadiaAccountSnapshot = hook;
    const ws = await subscribed(hub, ["account"], "u1"); // 钩子在 hub 之后才挂上也能用:订阅时才读
    await vi.waitFor(() => expect(ws.of("position")).toHaveLength(1));
    expect(hook).toHaveBeenCalledWith("u1");
    const snapshot = ws.events().filter((e) => e.t === "balance" || e.t === "order" || e.t === "position");
    expect(snapshot.map((e) => e.t)).toEqual(["balance", "order", "order", "position"]);
    expect(snapshot[0]).toEqual({ t: "balance", topic: "account", seq: 0, balance: { cashBalance: 2, lockedCash: 0 } });
    expect(snapshot[1]).toMatchObject({ t: "order", topic: "account", seq: 0, order: { id: "o1" } });
    expect(snapshot[3]).toMatchObject({ t: "position", topic: "account", seq: 0, position: { assetId: "a1" } });
  });

  it("查询期间该用户有事件流出 → 这份快照可能读于那笔提交之前,不发、重查;重查期间没有事件才发,带与最近一条事件相同的 seq", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const older = { cashBalance: 1, lockedCash: 0 };
    const newer = { cashBalance: 2, lockedCash: 0 };
    const source = vi
      .fn<(userId: string) => Promise<AccountEvent[]>>()
      .mockImplementationOnce(async () => {
        await gate; // 查询还没回来;它读到的是事件那笔提交之前的余额
        return [{ t: "balance", balance: older }, { t: "order", order: order("o1") }];
      })
      .mockImplementationOnce(async () => [{ t: "balance", balance: newer }]);
    const { hub, bus } = makeHub({ accountSnapshot: source });
    const ws = await subscribed(hub, ["account"], "u1");
    expect(ws.of("subscribed")[0]).toEqual({ t: "subscribed", topic: "account", seq: 0 });
    // 查询期间:o1 成交(FILLED)、余额变成 2,事件以 seq 1、2 送达
    bus.publish({ kind: "account", userId: "u1", event: { t: "order", order: { ...order("o1"), status: "FILLED", filledQuantity: 5 } } });
    bus.publish({ kind: "account", userId: "u1", event: { t: "balance", balance: newer } });
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(1));
    release!();
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(2));
    await sleep(20);
    expect(source).toHaveBeenCalledTimes(2);
    // 第一份(旧余额 1、o1 还是 OPEN)从没发出:否则它带 seq 2,客户端按 seq === last 照常应用,FILLED 的单变回 OPEN
    expect(ws.of("balance")).toEqual([
      { t: "balance", topic: "account", seq: 2, balance: newer },
      { t: "balance", topic: "account", seq: 2, balance: newer },
    ]);
    expect(ws.of("order").map((e) => [e.seq, e.order.status])).toEqual([[1, "FILLED"]]);
  });

  it("快照前面的增量不会比快照新:查询期间卖光 a1(position qty 0 先送达),读在那之前的快照(a1 qty 10)不发,重查读到的才发", async () => {
    // P1-11b 第 7 条的前提核对:审查设想的帧 [subscribed(3), position(4, a1, 0), balance(4), position(4, a1, 5)] 里,
    // 带 seq 4 的快照只可能来自 seq 4 之后才开始的查询(上面的 seq 检查),所以它的 a1 = 5 读在那条 qty 0 之后,不是更旧的值
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const soldOut: Position = { ...position("a1"), quantity: 0, available: 0, marketValue: 0 };
    const source = vi
      .fn<(userId: string) => Promise<AccountEvent[]>>()
      .mockImplementationOnce(async () => {
        await gate; // 读在卖光之前
        return [{ t: "balance", balance: { cashBalance: 1, lockedCash: 0 } }, { t: "position", position: position("a1") }];
      })
      .mockImplementationOnce(async () => [{ t: "balance", balance: { cashBalance: 2, lockedCash: 0 } }]); // 卖光之后:没有 a1
    const { hub, bus } = makeHub({ accountSnapshot: source });
    const ws = await subscribed(hub, ["account"], "u1");
    bus.publish({ kind: "account", userId: "u1", event: { t: "position", position: soldOut } });
    await vi.waitFor(() => expect(ws.of("position")).toHaveLength(1));
    release();
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(1));
    await sleep(20);
    const account = ws.events().filter((e) => e.t === "subscribed" || e.t === "balance" || e.t === "position");
    expect(account).toEqual([
      { t: "subscribed", topic: "account", seq: 0 },
      { t: "position", topic: "account", seq: 1, position: soldOut },
      { t: "balance", topic: "account", seq: 1, balance: { cashBalance: 2, lockedCash: 0 } },
    ]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("连续 3 次查询都被该用户的事件穿插 → 不发快照,记为欠快照:扫描发一次 resync、其后的事件先不发;客户端重订阅时再查", async () => {
    let racing = true;
    let bus: ReturnType<typeof createBus> | null = null;
    const source = vi.fn(async (userId: string): Promise<AccountEvent[]> => {
      // 每次查询期间都有一笔成交的余额事件流出(一个成交不停的账户)
      if (racing) bus!.publish({ kind: "account", userId, event: { t: "balance", balance: { cashBalance: 9, lockedCash: 0 } } });
      return [{ t: "balance", balance: { cashBalance: 1, lockedCash: 0 } }];
    });
    const made = makeHub({ accountSnapshot: source, accountSnapshotCooldownMs: 20 }); // 冷却(默认 2 s)调短:重订阅在冷却之后
    bus = made.bus;
    const ws = await subscribed(made.hub, ["account"], "u1");
    await vi.waitFor(() => expect(ws.of("resync")).toHaveLength(1)); // 扫描间隔 5 ms
    expect(ws.of("resync")[0]).toEqual({ t: "resync", topic: "account", reason: "backpressure" });
    expect(source).toHaveBeenCalledTimes(3);
    // 三次查询期间的事件照常送达(seq 1..3,都是 9);三份快照(1)一份也没发
    expect(ws.of("balance").map((e) => [e.seq, e.balance.cashBalance])).toEqual([[1, 9], [2, 9], [3, 9]]);
    // 欠快照期间的事件不发(客户端等重订阅拿快照),resync 也不重复
    racing = false;
    bus.publish({ kind: "account", userId: "u1", event: { t: "balance", balance: { cashBalance: 8, lockedCash: 0 } } });
    await sleep(30);
    expect(ws.of("balance")).toHaveLength(3);
    expect(ws.of("resync")).toHaveLength(1);
    // 这不是背压:resync 与跳过的那条事件都不计入 droppedDeltas / resyncs(ws-flood 按它们度量背压),记在独立的 snapshotRaces 里
    expect(made.hub.stats().droppedDeltas).toBe(0);
    expect(made.hub.stats().resyncs).toBe(0);
    expect(made.hub.stats().snapshotRaces).toBe(1);
    // 客户端照 resync 重订阅:这次查询期间没有事件 → 快照带当前 seq(4)发出,之后的事件与之连续
    ws.message({ op: "subscribe", topics: ["account"] });
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(4));
    expect(ws.of("subscribed").at(-1)).toEqual({ t: "subscribed", topic: "account", seq: 4 });
    expect(ws.of("balance")[3]).toEqual({ t: "balance", topic: "account", seq: 4, balance: { cashBalance: 1, lockedCash: 0 } });
    bus.publish({ kind: "account", userId: "u1", event: { t: "balance", balance: { cashBalance: 7, lockedCash: 0 } } });
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(5));
    expect(ws.of("balance")[4].seq).toBe(5);
    expect(made.hub.stats().snapshotRaces).toBe(1); // 重订阅那次没被穿插,不再计
  });

  it("snapshotRaces 按连接计:同一用户两条连接并在一次查询上、一起因竞态放弃 → +2,每条连接各收一次 resync", async () => {
    let bus: ReturnType<typeof createBus> | null = null;
    const source = vi.fn(async (userId: string): Promise<AccountEvent[]> => {
      bus!.publish({ kind: "account", userId, event: { t: "balance", balance: { cashBalance: 9, lockedCash: 0 } } });
      return [{ t: "balance", balance: { cashBalance: 1, lockedCash: 0 } }];
    });
    const made = makeHub({ accountSnapshot: source });
    bus = made.bus;
    const a = await connected(made.hub, "u1");
    const b = await connected(made.hub, "u1");
    a.message({ op: "subscribe", topics: ["account"] });
    b.message({ op: "subscribe", topics: ["account"] }); // 同步进来:并进 a 起的那次查询
    await vi.waitFor(() => expect(a.of("resync")).toHaveLength(1));
    await vi.waitFor(() => expect(b.of("resync")).toHaveLength(1));
    expect(source).toHaveBeenCalledTimes(3);
    expect(made.hub.stats().snapshotRaces).toBe(2);
  });

  it("查询期间在背压下重订阅过(account 记为欠快照)→ 返回的这份快照不发(扫描会发 resync,客户端重订阅时再查)", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = vi
      .fn<(userId: string) => Promise<AccountEvent[]>>()
      .mockImplementationOnce(async () => {
        await gate;
        return [{ t: "balance", balance: { cashBalance: 1, lockedCash: 0 } }];
      })
      .mockImplementation(async () => [{ t: "balance", balance: { cashBalance: 2, lockedCash: 0 } }]);
    const { hub } = makeHub({ accountSnapshot: source, backpressureScanMs: 60_000 });
    const ws = await subscribed(hub, ["account"], "u1");
    ws.bufferedAmount = 300 * 1024;
    ws.message({ op: "subscribe", topics: ["account"] }); // 背压下重订阅:只回 subscribed,account 记 owed
    await vi.waitFor(() => expect(ws.of("subscribed")).toHaveLength(2));
    release!();
    await sleep(30);
    expect(source).toHaveBeenCalledTimes(1);
    expect(ws.of("balance")).toHaveLength(0);
  });

  it("同一用户的快照查询在跑时,重复订阅与该用户的其它连接都并进这一次(钩子只调一次、各发一份);别的用户不并;查完再订才重新查", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = vi
      .fn<(userId: string) => Promise<AccountEvent[]>>()
      .mockImplementationOnce(async () => {
        await gate;
        return [{ t: "balance", balance: { cashBalance: 1, lockedCash: 0 } }];
      })
      .mockImplementation(async () => [{ t: "balance", balance: { cashBalance: 2, lockedCash: 0 } }]);
    const { hub } = makeHub({ accountSnapshot: source, accountSnapshotCooldownMs: 20 }); // 冷却调短,见下面「查完再订」
    const a = await subscribed(hub, ["account"], "u1");
    a.message({ op: "subscribe", topics: ["account"] });
    a.message({ op: "subscribe", topics: ["account"] });
    const b = await subscribed(hub, ["account"], "u1");
    const gone = await subscribed(hub, ["account"], "u1");
    gone.message({ op: "unsubscribe", topics: ["account"] });
    const other = await subscribed(hub, ["account"], "u2");
    await vi.waitFor(() => expect(a.of("subscribed")).toHaveLength(3));
    await vi.waitFor(() => expect(gone.of("unsubscribed")).toHaveLength(1));
    await vi.waitFor(() => expect(other.of("balance")).toHaveLength(1)); // u2 自己查了一次
    expect(source.mock.calls.map(([userId]) => userId)).toEqual(["u1", "u2"]); // u1 的 5 次订阅只起了一次查询
    release!();
    await vi.waitFor(() => expect(b.of("balance")).toHaveLength(1));
    await sleep(20);
    const snapshot = { t: "balance", topic: "account", seq: 0, balance: { cashBalance: 1, lockedCash: 0 } };
    expect(a.of("balance")).toEqual([snapshot]); // 三次订阅、一份快照(三条 subscribed 之后)
    expect(b.of("balance")).toEqual([snapshot]);
    expect(gone.of("balance")).toHaveLength(0); // 等的时候退订了
    expect(source).toHaveBeenCalledTimes(2);
    // 查询结束(且过了冷却)后再订:重新查
    await sleep(30);
    a.message({ op: "subscribe", topics: ["account"] });
    await vi.waitFor(() => expect(a.of("balance")).toHaveLength(2));
    expect(source).toHaveBeenCalledTimes(3);
    expect(a.of("balance")[1].balance.cashBalance).toBe(2);
  });

  it("快照查询失败 → 记日志、不发;并在一起等的订阅不会卡住,下一次订阅照常重新查", async () => {
    const logs: string[] = [];
    const source = vi
      .fn<(userId: string) => Promise<AccountEvent[]>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementation(async () => [{ t: "balance", balance: { cashBalance: 3, lockedCash: 0 } }]);
    const { hub } = makeHub({ accountSnapshot: source, log: (line) => logs.push(line), accountSnapshotCooldownMs: 20 });
    const ws = await subscribed(hub, ["account"], "u1");
    await vi.waitFor(() => expect(logs.some((l) => l.includes("account snapshot failed for u1: db down"))).toBe(true));
    expect(ws.of("balance")).toHaveLength(0);
    ws.message({ op: "subscribe", topics: ["account"] });
    await vi.waitFor(() => expect(ws.of("balance")).toHaveLength(1));
    expect(source).toHaveBeenCalledTimes(2);
  });
});

describe("createHub · presence、退订、统计", () => {
  it("subscribe / unsubscribe / close 增减 __carbadiaPresence 与 stats.subscriptions", async () => {
    const { hub } = makeHub();
    const presence = globalThis.__carbadiaPresence!;
    const a = await subscribed(hub, ["book:X", "account"], "u1");
    const b = await subscribed(hub, ["book:X"]);
    expect(presence.topics.get("book:X")).toBe(2);
    expect(presence.topics.get("account")).toBe(1);
    expect(presence.users.get("u1")).toBe(1);
    expect(hub.stats().subscriptions).toBe(3);
    a.message({ op: "unsubscribe", topics: ["book:X", "ticker:X"] });
    await vi.waitFor(() => expect(a.of("unsubscribed")).toHaveLength(2));
    expect(a.of("unsubscribed").map((e) => e.topic)).toEqual(["book:X", "ticker:X"]);
    expect(presence.topics.get("book:X")).toBe(1);
    expect(hub.stats().subscriptions).toBe(2);
    a.close(1000, "bye");
    await vi.waitFor(() => expect(hub.stats().connections).toBe(1));
    expect(presence.topics.has("account")).toBe(false);
    expect(presence.users.has("u1")).toBe(false);
    b.close(1000, "bye");
    await vi.waitFor(() => expect(hub.stats().connections).toBe(0));
    expect(presence.topics.size).toBe(0);
    expect(hub.stats().subscriptions).toBe(0);
  });

  it("每 statsIntervalMs 打一行 {src:ws, ev:stats, …} JSON 日志", async () => {
    const log = vi.fn<(line: string) => void>();
    const { hub } = makeHub({ log, statsIntervalMs: 5 });
    await connected(hub);
    await vi.waitFor(() => expect(log).toHaveBeenCalled());
    const parsed = JSON.parse(log.mock.calls[0][0]);
    expect(parsed).toMatchObject({ src: "ws", ev: "stats", enabled: true, connections: 1 });
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining(Object.keys(zeroWsStats(true))));
  });

  it("总线上的坏消息不抛(kind 未知 / 非对象)", () => {
    const { hub } = makeHub();
    expect(() => hub.publish({ kind: "nope" } as unknown as BusMessage)).not.toThrow();
    expect(() => hub.publish(null as unknown as BusMessage)).not.toThrow();
  });
});

// ---- 背压、心跳、关闭:假时钟 ----
// 合帧、背压扫描、心跳与关闭宽限全由测试用 advanceTimersByTimeAsync 显式推进,createHub 默认的 now = Date.now 也是假时钟:
// 与事件循环快慢无关,不靠 sleep 的毫秒余量,也不靠放宽余量(这套测试是 Docker 构建门禁,卡顿的构建机不能让它翻车)。
// 扫描间隔与「> 2 MB 持续」都用生产值(1 s / 10 s);合帧 5 ms,flush() 远不到下一轮扫描。
const FAKE_BATCH_MS = 5;
const FAKE_SCAN_MS = 1_000;

/** 在 describe 里登记:每个用例前装假时钟,用例后先于文件级 afterEach(关 hub)换回真时钟(vitest 的 afterEach 由内向外执行) */
function useFakeClock() {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

function fakeClockHub(opts: Parameters<typeof createHub>[0] = {}) {
  const { hub, bus } = makeHub({ batchMs: FAKE_BATCH_MS, backpressureScanMs: FAKE_SCAN_MS, ...opts });
  const t0 = Date.now();
  /** 只冲合帧(远不到下一轮扫描) */
  const flush = () => vi.advanceTimersByTimeAsync(FAKE_BATCH_MS);
  /** 恰好推进过下一轮背压扫描,再把扫描排进队的事件冲出去 */
  const scan = async () => {
    await vi.advanceTimersByTimeAsync(FAKE_SCAN_MS - ((Date.now() - t0) % FAKE_SCAN_MS));
    await flush();
  };
  /** 推进到 hub 创建后的第 ms 毫秒 */
  const at = (ms: number) => vi.advanceTimersByTimeAsync(t0 + ms - Date.now());
  const connect = async (userId: string | null = null) => {
    const ws = new FakeWs();
    hub.accept(ws, { userId, ip: "local" });
    await flush();
    expect(ws.of("hello")).toHaveLength(1);
    return ws;
  };
  /** 客户端发一帧,并把服务端的回应冲出来 */
  const op = async (ws: FakeWs, data: unknown) => {
    ws.message(data);
    await flush();
  };
  return { hub, bus, flush, scan, at, connect, op };
}

describe("createHub · 背压与心跳", () => {
  useFakeClock();

  it("bufferedAmount > 256 KB:跳过 delta、topic 标 stale、droppedDeltas++;降到 < 64 KB 后下一轮扫描发 resync;已退订的不发", async () => {
    const { hub, bus, scan, connect, op } = fakeClockHub();
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["book:X", "trades:X"] });
    expect(ws.of("subscribed")).toHaveLength(2);
    ws.bufferedAmount = 300 * 1024;
    bus.publish(bookMsg("X", true));
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 1)] });
    await scan();
    expect(ws.of("book.delta")).toHaveLength(0);
    expect(ws.of("trades").filter((e) => e.seq > 0)).toHaveLength(0);
    expect(hub.stats().droppedDeltas).toBe(2);
    expect(ws.of("resync")).toHaveLength(0); // 缓冲还没降下来
    ws.bufferedAmount = 10 * 1024;
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["book:X", "trades:X"]);
    expect(ws.of("resync").every((e) => e.reason === "backpressure")).toBe(true);
    expect(hub.stats().resyncs).toBe(2);
    // 已退订的 topic 不发 resync
    ws.bufferedAmount = 300 * 1024;
    bus.publish(bookMsg("X", true));
    await op(ws, { op: "unsubscribe", topics: ["book:X"] });
    ws.bufferedAmount = 0;
    await scan();
    await scan();
    expect(ws.of("resync")).toHaveLength(2);
    expect(hub.stats().resyncs).toBe(2);
  });

  it("订阅快照被扣住后缓冲落在 64–256 KB:该 topic 的事件一律不发(否则与 subscribed 的 seq 连续,客户端会叠到空簿上);只发一次 resync,重订阅拿到快照后恢复", async () => {
    const { hub, bus, flush, scan, connect, op } = fakeClockHub();
    const ws = await connect();
    ws.bufferedAmount = 300 * 1024;
    await op(ws, { op: "subscribe", topics: ["book:X", "trades:X", "ticker:*"] });
    expect(ws.events().map((e) => e.t)).toEqual(["hello", "subscribed", "subscribed", "subscribed"]);
    await scan();
    expect(ws.of("resync")).toHaveLength(0); // 缓冲仍 > 256 KB:重订阅也会被限流,先不发
    ws.bufferedAmount = 100 * 1024; // 低于跳过线(256 KB)、高于普通 stale 的 resync 线(64 KB)
    bus.publish(bookMsg("X", true));
    bus.publish(bookMsg("X", true));
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 1)] });
    bus.publish({ kind: "ticker", symbol: "X", ticker: { symbol: "X", ts: 1, lastPrice: 100 } });
    await flush();
    // 修复前这里是 [hello, subscribed ×3, book.delta seq 1, book.delta seq 2, trades seq 1, ticker seq 1]:seq 连续、没有快照
    expect(ws.events().map((e) => e.t)).toEqual(["hello", "subscribed", "subscribed", "subscribed"]);
    expect(hub.stats().droppedDeltas).toBe(3 + 4); // 3 份扣住的快照 + 4 条跳过的事件
    // 欠快照的 topic 在 ≤ 256 KB 时就发 resync:这时的重订阅不受限流,快照发得出去(P1-11b;只等 < 64 KB 的话,
    // 连接长期停在 64–256 KB 时这些 topic 永远是空盘口 / 空成交带)
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["book:X", "ticker:*", "trades:X"]);
    // resync 发出后、客户端重订阅前:照旧不发该 topic 的事件,也不每轮重发 resync
    bus.publish(bookMsg("X", true));
    await scan();
    await scan();
    expect(ws.of("book.delta")).toHaveLength(0);
    expect(ws.of("resync")).toHaveLength(3);
    expect(hub.stats().resyncs).toBe(3);
    // 客户端按 resync 重订阅 book:X(缓冲仍在 100 KB):拿到当前 seq 的快照,之后的 delta 与之连续
    await op(ws, { op: "subscribe", topics: ["book:X"] });
    expect(ws.of("book.snapshot")).toEqual([expect.objectContaining({ topic: "book:X", seq: 3, bids: snapshot("X").bids })]);
    bus.publish(bookMsg("X", true));
    await flush();
    expect(ws.of("book.delta").map((e) => e.seq)).toEqual([4]);
    // 还没重订阅的 trades:X 照旧扣着
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 2)] });
    await flush();
    expect(ws.of("trades")).toHaveLength(0);
    expect(hub.stats().droppedDeltas).toBe(3 + 4 + 2);
    await scan();
    expect(ws.of("resync")).toHaveLength(3);
  });

  it("64–256 KB 带内:欠快照的 topic 收到 resync、重订阅拿到快照;只跳过了 delta 的 stale topic 仍等 < 64 KB 才 resync", async () => {
    const { hub, bus, flush, scan, connect, op } = fakeClockHub();
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["book:Y"] });
    bus.publish(bookMsg("Y", false)); // book:Y 有人订阅:缓存并推整份快照(seq 1)
    await flush();
    ws.bufferedAmount = 300 * 1024;
    bus.publish(bookMsg("Y", true)); // seq 2 被跳过:book:Y 只是 stale,不欠快照
    await op(ws, { op: "subscribe", topics: ["book:X", "trades:X"] }); // 限流:两份快照扣住,欠着
    bus.publish(bookMsg("X", false)); // 欠快照期间照样进缓存(有人订阅),只是不发给这条连接
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 1)] });
    ws.bufferedAmount = 100 * 1024;
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["book:X", "trades:X"]);
    // 客户端按 §3.3 重订阅:book 走 unsubscribe + subscribe,trades 带 since(它手里是 subscribed 的 0 → 不带)
    await op(ws, { op: "unsubscribe", topics: ["book:X"] });
    await op(ws, { op: "subscribe", topics: ["book:X", "trades:X"] });
    // book:X 退订那一下归零、缓存被淘汰:没有缓存就请发布器刷新(这里没挂钩子),于是只回 subscribed;trades 环照常给整份
    expect(ws.of("trades")).toEqual([expect.objectContaining({ topic: "trades:X", seq: 1, trades: [trade("X", 1)] })]);
    bus.publish(bookMsg("X", false)); // 发布器的整份快照
    await flush();
    expect(ws.of("book.snapshot").filter((e) => e.topic === "book:X")).toEqual([expect.objectContaining({ seq: 2, bids: snapshot("X").bids })]);
    // stale 的 book:Y 在 64–256 KB 带内不发 resync(它的快照没被扣住,缺的只是 delta)
    await scan();
    expect(ws.of("resync").filter((e) => e.topic === "book:Y")).toHaveLength(0);
    ws.bufferedAmount = 10 * 1024;
    await scan();
    expect(ws.of("resync").filter((e) => e.topic === "book:Y")).toHaveLength(1);
    expect(hub.stats().resyncs).toBe(3);
  });

  it("回应 resync 的重订阅多给 64 KB 余量:扫描在 250 KB 发 resync、往返里缓冲涨到 300 KB,重订阅仍拿到快照;别的订阅照常按 256 KB 限流;余量只用一次", async () => {
    const { hub, bus, scan, connect, op } = fakeClockHub();
    const warm = await connect(); // 另一条连接一直订着:book:X 的缓存不会因 ws 的 unsubscribe 被淘汰
    await op(warm, { op: "subscribe", topics: ["book:X", "trades:X"] });
    bus.publish(bookMsg("X", false));
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 1)] });
    const ws = await connect();
    ws.bufferedAmount = 300 * 1024;
    await op(ws, { op: "subscribe", topics: ["book:X", "trades:X"] }); // 限流:两份快照欠着
    ws.bufferedAmount = 250 * 1024; // 慢消费者:缓冲围着 256 KB 上下
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["book:X", "trades:X"]);
    ws.bufferedAmount = 300 * 1024; // 客户端重订阅前缓冲又涨了 50 KB
    // 客户端按 §3.3 重订阅:book 走 unsubscribe + subscribe,trades 手里的基线是 subscribed 的 0 → 不带 since
    await op(ws, { op: "unsubscribe", topics: ["book:X"] });
    await op(ws, { op: "subscribe", topics: ["book:X", "trades:X"] });
    expect(ws.of("book.snapshot")).toEqual([expect.objectContaining({ topic: "book:X", seq: 1 })]);
    expect(ws.of("trades")).toEqual([expect.objectContaining({ topic: "trades:X", seq: 1, trades: [trade("X", 1)] })]);
    const dropped = hub.stats().droppedDeltas;
    // 不是回应 resync 的订阅:300 KB 照常限流
    await op(ws, { op: "subscribe", topics: ["ticker:*"] });
    expect(hub.stats().droppedDeltas).toBe(dropped + 1);
    // 余量只用一次:同一 topic 再订(没有新的 resync)照常限流
    await op(ws, { op: "subscribe", topics: ["book:X"] });
    expect(ws.of("book.snapshot")).toHaveLength(1);
    expect(hub.stats().droppedDeltas).toBe(dropped + 2);
  });

  it("没有第二条连接:唯一订阅者回应 resync 的 unsubscribe + subscribe 落在同一合帧窗口,book / ticker 缓存不淘汰、不请刷新,64 KB 余量照样生效", async () => {
    const bookRefresh = vi.fn();
    const { hub, bus, flush, scan, connect } = fakeClockHub({ bookRefresh });
    const ws = await connect();
    ws.bufferedAmount = 300 * 1024;
    ws.message({ op: "subscribe", topics: ["book:X", "ticker:X"] }); // 限流:两份快照欠着;它是这两个 topic 唯一的订阅者
    await flush();
    bus.publish(bookMsg("X", false)); // 有人订阅(发布器在喂):进缓存,对这条连接不发(欠快照)
    bus.publish({ kind: "ticker", symbol: "X", ticker: { symbol: "X", ts: 1, lastPrice: 100 } });
    ws.bufferedAmount = 250 * 1024; // 慢消费者:缓冲围着 256 KB 上下
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["book:X", "ticker:X"]);
    ws.bufferedAmount = 300 * 1024; // 客户端重订阅前缓冲又涨了 50 KB
    // ws-client 对 book / ticker 的 resync:unsubscribe + subscribe,两帧紧挨着到(同一合帧窗口)
    for (const topic of ["book:X", "ticker:X"] as const) {
      ws.message({ op: "unsubscribe", topics: [topic] });
      ws.message({ op: "subscribe", topics: [topic] });
    }
    await flush();
    // 修复前:退订把订阅数降到 0、立即淘汰缓存,重订阅成了等整份快照的连接(请一次 50 档刷新),
    // 刷新回来时按 256 KB 判(没有余量)又被扣住:owed → resync → owed,盘口一直空着
    expect(ws.of("book.snapshot")).toEqual([expect.objectContaining({ topic: "book:X", seq: 1, bids: snapshot("X").bids })]);
    expect(ws.of("ticker")).toEqual([{ t: "ticker", topic: "ticker:X", seq: 1, symbol: "X", ticker: { symbol: "X", ts: 1, lastPrice: 100 } }]);
    expect(bookRefresh).not.toHaveBeenCalled();
    const dropped = hub.stats().droppedDeltas;
    ws.bufferedAmount = 0;
    bus.publish(bookMsg("X", true));
    await flush();
    expect(ws.of("book.delta").map((e) => e.seq)).toEqual([2]);
    await scan();
    expect(ws.of("resync")).toHaveLength(2);
    expect(hub.stats().droppedDeltas).toBe(dropped);
  });

  it("订阅数归零的 book / ticker:退订那条连接的合帧窗口结束才淘汰;窗口里 presence 仍计 1(发布器照常喂)、总线上的盘口照常进缓存,别人这时来订直接拿缓存", async () => {
    const bookRefresh = vi.fn();
    const { bus, flush, connect, op } = fakeClockHub({ bookRefresh });
    const presence = globalThis.__carbadiaPresence!;
    const a = await connect();
    const b = await connect();
    await op(a, { op: "subscribe", topics: ["book:X"] });
    bus.publish(bookMsg("X", false)); // 刷新的整份快照(seq 1)
    await flush();
    expect(bookRefresh).toHaveBeenCalledTimes(1);
    a.message({ op: "unsubscribe", topics: ["book:X"] });
    expect(presence.topics.get("book:X")).toBe(1); // a 的窗口还没结束:发布器照常算 book:X 的差分
    bus.publish({ kind: "book", symbol: "X", snapshot: { ...snapshot("X"), bids: [{ price: 6_805, quantity: 3, orders: 1 }] }, delta: { symbol: "X", bids: [{ price: 6_805, quantity: 3, orders: 1 }], asks: [], ts: 1 } });
    b.message({ op: "subscribe", topics: ["book:X"] }); // 同一窗口里别的连接来订:接过这一个名额,直接拿缓存(seq 2 的整本)
    await flush();
    expect(b.of("book.snapshot")).toEqual([expect.objectContaining({ seq: 2, bids: [{ price: 6_805, quantity: 3, orders: 1 }] })]);
    expect(bookRefresh).toHaveBeenCalledTimes(1);
    expect(presence.topics.get("book:X")).toBe(1);
    // b 退订、窗口结束仍无人订:淘汰;之后晚到的一条不进缓存,下一位订阅者等刷新
    await op(b, { op: "unsubscribe", topics: ["book:X"] });
    expect(presence.topics.has("book:X")).toBe(false);
    bus.publish(bookMsg("X", false));
    const c = await connect();
    await op(c, { op: "subscribe", topics: ["book:X"] });
    expect(c.of("book.snapshot")).toHaveLength(0);
    // 退订后窗口还没结束连接就断了:名额立即释放
    const d = await connect();
    await op(d, { op: "subscribe", topics: ["ticker:X"] });
    expect(presence.topics.get("ticker:X")).toBe(1);
    d.message({ op: "unsubscribe", topics: ["ticker:X"] });
    expect(presence.topics.get("ticker:X")).toBe(1);
    d.emit("close", 1006, "");
    expect(presence.topics.has("ticker:X")).toBe(false);
  });

  it("跳过 delta 后客户端凭 seq 缺口先重订阅:快照即恢复,扫描不再补多余的 resync", async () => {
    const { bus, flush, scan, connect, op } = fakeClockHub();
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["book:X"] });
    bus.publish(bookMsg("X", false)); // seq 1:整份快照,客户端有了簿(订阅时 hub 还没有这本簿,不发空快照)
    await flush();
    ws.bufferedAmount = 300 * 1024;
    bus.publish(bookMsg("X", true)); // seq 2:跳过,book:X 标 stale
    ws.bufferedAmount = 100 * 1024;
    bus.publish(bookMsg("X", true)); // seq 3:放行,客户端看到 1 → 3 的缺口
    await flush();
    expect(ws.of("book.delta").map((e) => e.seq)).toEqual([3]);
    await op(ws, { op: "subscribe", topics: ["book:X"] }); // 客户端按缺口重订阅
    expect(ws.of("book.snapshot").map((e) => e.seq)).toEqual([1, 3]);
    ws.bufferedAmount = 0;
    await scan();
    await scan();
    expect(ws.of("resync")).toHaveLength(0);
    bus.publish(bookMsg("X", true));
    await flush();
    expect(ws.of("book.delta").map((e) => e.seq)).toEqual([3, 4]);
  });

  it("等整份快照的连接(订阅时 hub 没有簿)收到盘口消息时正在背压:按欠快照处理,之后的 delta 不发,≤ 256 KB 时 resync,重订阅后拿到整份快照", async () => {
    const { hub, bus, flush, scan, connect, op } = fakeClockHub();
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["book:X"] }); // 没有簿:只回 subscribed{0},等下一条盘口消息
    ws.bufferedAmount = 300 * 1024;
    bus.publish(bookMsg("X", true)); // seq 1:本该对它以整份快照发出,被背压扣住
    ws.bufferedAmount = 100 * 1024;
    bus.publish(bookMsg("X", true)); // seq 2:只标 stale 的话会放行,客户端(基线 0)把它当基线、看不出缺口,手里却没有簿
    await flush();
    expect(ws.of("book.snapshot")).toHaveLength(0);
    expect(ws.of("book.delta")).toHaveLength(0);
    expect(hub.stats().droppedDeltas).toBe(2);
    await scan();
    expect(ws.of("resync").map((e) => e.topic)).toEqual(["book:X"]);
    await op(ws, { op: "unsubscribe", topics: ["book:X"] });
    await op(ws, { op: "subscribe", topics: ["book:X"] });
    bus.publish(bookMsg("X", false)); // 退订那一下归零、缓存已淘汰:重订阅后又在等,下一条盘口消息给整份快照
    await flush();
    expect(ws.of("book.snapshot").map((e) => e.seq)).toEqual([3]);
  });

  it("bufferedAmount > 2 MB 持续 10 s → close 1013,closedByBackpressure 只计一次;宽限内的扫描不重复关,宽限到期 terminate", async () => {
    const { hub, scan, connect } = fakeClockHub({ closeGraceMs: 2_500 });
    const ws = await connect();
    const close = vi.fn();
    ws.close = close; // 不读的对端:close 帧排在几 MB 缓冲后面,回不来
    ws.bufferedAmount = 3 * 1024 * 1024;
    for (let i = 1; i <= 10; i += 1) await scan(); // 第 1 轮开始计时,第 10 轮时持续 9 s
    expect(close).not.toHaveBeenCalled();
    await scan(); // 第 11 轮:持续 10 s
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1013, "backpressure");
    await scan();
    await scan(); // 宽限 2.5 s 内的两轮扫描
    expect(close).toHaveBeenCalledTimes(1);
    expect(ws.terminated).toBe(false);
    await scan(); // 宽限到期
    expect(ws.terminated).toBe(true);
    expect(hub.stats().connections).toBe(0);
    expect(hub.stats().closedByBackpressure).toBe(1);
  });

  it("超 2 MB 后又降下来:计时归零,不关", async () => {
    const { scan, connect } = fakeClockHub();
    const ws = await connect();
    ws.bufferedAmount = 3 * 1024 * 1024;
    for (let i = 1; i <= 5; i += 1) await scan(); // 第 1 轮开始计时
    ws.bufferedAmount = 0;
    await scan(); // 归零
    ws.bufferedAmount = 3 * 1024 * 1024;
    for (let i = 1; i <= 10; i += 1) await scan(); // 重新计时,第 10 轮时持续 9 s;若没归零,距第一次超限已 15 s,早该关了
    expect(ws.closedWith).toBeNull();
    await scan();
    expect(ws.closedWith).toEqual({ code: 1013, reason: "backpressure" });
  });

  it("bufferedAmount > 8 MB:不等持续时长,下一轮扫描立即 1013;对端不回 close 帧则 closeGraceMs 后 terminate,只计一次", async () => {
    const { hub, scan, at, connect } = fakeClockHub({ closeGraceMs: 300 });
    const ws = await connect();
    const close = vi.fn();
    ws.close = close;
    ws.bufferedAmount = 9 * 1024 * 1024;
    await scan(); // 第 1 轮扫描(t = 1 000)
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(1013, "backpressure");
    await at(1_299);
    expect(ws.terminated).toBe(false);
    await at(1_300);
    expect(ws.terminated).toBe(true);
    expect(hub.stats().connections).toBe(0);
    expect(hub.stats().closedByBackpressure).toBe(1);
  });

  it("心跳:每 heartbeatMs 发 ws 层 ping;pongTimeoutMs 内无 pong → terminate;等 pong 期间不重复 ping;有 pong 的连接不受影响", async () => {
    const { hub, at, connect } = fakeClockHub({ heartbeatMs: 1_000, pongTimeoutMs: 1_500 });
    const good = await connect();
    const dead = await connect();
    dead.answersPing = false;
    await at(1_000); // 第一轮 ping
    expect([good.pings, dead.pings]).toEqual([1, 1]);
    await at(2_000); // 第二轮:good 再 ping;dead 还在等 pong(2 500 到期),不重复 ping
    expect([good.pings, dead.pings]).toEqual([2, 1]);
    await at(2_499);
    expect(dead.terminated).toBe(false);
    await at(2_500);
    expect(dead.terminated).toBe(true);
    expect(good.terminated).toBe(false);
    expect(hub.stats().connections).toBe(1);
  });
});

describe("createHub · 订阅去重与背压下的快照", () => {
  useFakeClock();

  it("同一 op 里 200 个重复 book topic:每个不同 topic 只回一次 subscribed;缓冲 > 256 KB 时不发快照,降下来后 resync", async () => {
    const refreshed: string[] = [];
    const { hub, bus, scan, connect, op } = fakeClockHub({ bookRefresh: (symbol) => void refreshed.push(symbol) });
    const ws = await connect();
    ws.bufferedAmount = 300 * 1024;
    const topics = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? "book:X" : "book:Y") as Topic);
    await op(ws, { op: "subscribe", topics });
    expect(ws.of("subscribed").map((e) => e.topic)).toEqual(["book:X", "book:Y"]);
    expect(ws.of("book.snapshot")).toHaveLength(0);
    expect(hub.stats().subscriptions).toBe(2);
    expect(hub.stats().droppedDeltas).toBe(2);
    await scan();
    expect(ws.of("resync")).toHaveLength(0); // 缓冲还没降下来
    ws.bufferedAmount = 0;
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["book:X", "book:Y"]);
    expect(hub.stats().resyncs).toBe(2);
    expect(refreshed).toEqual([]); // 扣住快照时不请发布器刷新
    // 客户端照 resync 对 book 重订阅(unsubscribe + subscribe):这次缓冲正常;hub 没有这本簿 → 请发布器刷新,它的整份快照随后到
    await op(ws, { op: "unsubscribe", topics: ["book:X"] });
    await op(ws, { op: "subscribe", topics: ["book:X"] });
    expect(refreshed).toEqual(["X"]);
    bus.publish(bookMsg("X", false));
    await scan();
    expect(ws.of("book.snapshot")).toEqual([expect.objectContaining({ topic: "book:X", seq: 1 })]);
  });

  it("缓冲 > 256 KB 时 trades 回 subscribed{seq: since}(客户端真实的基线,不是 current);之后带 since 重订阅也补整份快照(客户端手里没有 tape),补过即恢复回放语义", async () => {
    const { bus, scan, connect, op } = fakeClockHub();
    for (let i = 1; i <= 70; i += 1) bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", i)] });
    const ws = await connect();
    ws.bufferedAmount = 300 * 1024;
    await op(ws, { op: "subscribe", topics: ["trades:X"], since: { "trades:X": 66 } }); // 缓冲正常时本可回放 4 笔
    // 修复前回 seq 70:ws-client 把它当 lastSeq,跨非 1012 重连以 since = 70 重订阅,hub 当它已追平,67–70 永远缺了
    expect(ws.of("subscribed")).toEqual([{ t: "subscribed", topic: "trades:X", seq: 66 }]);
    expect(ws.of("trades")).toHaveLength(0);
    ws.bufferedAmount = 0;
    await scan();
    expect(ws.of("resync")).toEqual([{ t: "resync", topic: "trades:X", reason: "backpressure" }]);
    // 客户端按 §3.3 对 trades 带 since = last(66)重订阅:本可回放 4 笔,但快照被扣住过 → 补整份
    await op(ws, { op: "subscribe", topics: ["trades:X"], since: { "trades:X": 66 } });
    expect(ws.of("subscribed")[1]).toEqual({ t: "subscribed", topic: "trades:X", seq: 70 });
    expect(ws.of("trades")).toHaveLength(1);
    expect(ws.of("trades")[0].seq).toBe(70);
    expect(ws.of("trades")[0].trades.map((e) => e.id)).toEqual(Array.from({ length: 64 }, (_, i) => `t${i + 7}`));
    await op(ws, { op: "subscribe", topics: ["trades:X"], since: { "trades:X": 68 } });
    expect(ws.of("trades").slice(1).map((e) => e.seq)).toEqual([69, 70]);
  });

  it("缓冲 > 256 KB 时 trades 的新订阅(无 since)与 since 不合法(在未来 / 0)都回 subscribed{seq: 0}:ws-client 把 0 当「无基线」", async () => {
    const { bus, connect, op } = fakeClockHub();
    for (let i = 1; i <= 70; i += 1) bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", i)] });
    const cases = [undefined, { "trades:X": 99 }, { "trades:X": 0 }] as const;
    for (const since of cases) {
      const ws = await connect();
      ws.bufferedAmount = 300 * 1024;
      await op(ws, since ? { op: "subscribe", topics: ["trades:X"], since } : { op: "subscribe", topics: ["trades:X"] });
      expect(ws.of("subscribed")).toEqual([{ t: "subscribed", topic: "trades:X", seq: 0 }]);
      expect(ws.of("trades")).toHaveLength(0);
    }
  });

  it("缓冲 > 256 KB 时 ticker:* 与 account 的订阅快照同样扣住;candles 本就无快照,不标 stale", async () => {
    const { hub, bus, scan, connect, op } = fakeClockHub({ accountSnapshot: () => [{ t: "balance", balance: { cashBalance: 1, lockedCash: 0 } }] });
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 1, lastPrice: 100 } });
    const ws = await connect("u1");
    ws.bufferedAmount = 300 * 1024;
    await op(ws, { op: "subscribe", topics: ["ticker:*", "account", "candles:A:1m"] });
    expect(ws.of("subscribed")).toHaveLength(3);
    expect(ws.of("ticker")).toHaveLength(0);
    expect(ws.of("balance")).toHaveLength(0);
    expect(hub.stats().droppedDeltas).toBe(2);
    ws.bufferedAmount = 0;
    await scan();
    expect(ws.of("resync").map((e) => e.topic).sort()).toEqual(["account", "ticker:*"]);
  });

  it("快照来自 globalThis.__carbadiaAccountSnapshot 钩子时同样受背压:扣住快照(钩子不调)、account 事件一律不发,直到不受背压的重订阅把快照发出", async () => {
    const hook = vi.fn(async (userId: string) => ({
      balance: { cashBalance: userId.length, lockedCash: 0 },
      orders: [order("o1")],
      positions: [],
    }));
    globalThis.__carbadiaAccountSnapshot = hook; // 生产路径:不注入 accountSnapshot 选项,由发布器挂钩子
    const { hub, bus, flush, scan, connect, op } = fakeClockHub();
    const accountEvents = (ws: FakeWs) => ws.events().filter((e) => e.t === "balance" || e.t === "order" || e.t === "position");
    const ws = await connect("u1");
    ws.bufferedAmount = 300 * 1024;
    await op(ws, { op: "subscribe", topics: ["account"] });
    expect(ws.of("subscribed")).toEqual([{ t: "subscribed", topic: "account", seq: 0 }]);
    expect(hook).not.toHaveBeenCalled(); // 扣住时连查询都不发
    expect(hub.stats().droppedDeltas).toBe(1);
    // 缓冲落在 64–256 KB:没扣住的话这两条会以 seq 1、2 放行,与 subscribed{seq: 0} 连续,客户端会叠到空账户上
    ws.bufferedAmount = 100 * 1024;
    bus.publish({ kind: "account", userId: "u1", event: { t: "balance", balance: { cashBalance: 9, lockedCash: 0 } } });
    bus.publish({ kind: "account", userId: "u1", event: { t: "order", order: order("o2") } });
    await flush();
    expect(accountEvents(ws)).toHaveLength(0);
    expect(hub.stats().droppedDeltas).toBe(1 + 2);
    // ≤ 256 KB:欠快照的 topic 只发一次 resync;之后、重订阅之前的事件照旧不发,也不每轮重发 resync
    await scan();
    expect(ws.of("resync")).toEqual([{ t: "resync", topic: "account", reason: "backpressure" }]);
    ws.bufferedAmount = 10 * 1024;
    bus.publish({ kind: "account", userId: "u1", event: { t: "position", position: position("a1") } });
    await scan();
    await scan();
    expect(accountEvents(ws)).toHaveLength(0);
    expect(ws.of("resync")).toHaveLength(1);
    expect(hub.stats().droppedDeltas).toBe(1 + 2 + 1);
    expect(hook).not.toHaveBeenCalled();
    // 客户端按 resync 重订阅(缓冲正常):这时才查钩子,快照带当前 seq(3 条事件之后 = 3),之后的事件与之连续
    await op(ws, { op: "subscribe", topics: ["account"] });
    await flush(); // 钩子是异步的:快照可能晚于 subscribed 的那一帧
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith("u1");
    expect(ws.of("subscribed")[1]).toEqual({ t: "subscribed", topic: "account", seq: 3 });
    expect(accountEvents(ws)).toEqual([
      { t: "balance", topic: "account", seq: 3, balance: { cashBalance: 2, lockedCash: 0 } },
      expect.objectContaining({ t: "order", topic: "account", seq: 3, order: expect.objectContaining({ id: "o1" }) }),
    ]);
    bus.publish({ kind: "account", userId: "u1", event: { t: "balance", balance: { cashBalance: 7, lockedCash: 0 } } });
    await flush();
    expect(ws.of("balance").map((e) => e.seq)).toEqual([3, 4]);
    await scan();
    expect(ws.of("resync")).toHaveLength(1);
    expect(hub.stats().droppedDeltas).toBe(1 + 2 + 1);
  });
});

/** 发布器刷新钩子(globalThis.__carbadiaBookRefresh / createHub 的 bookRefresh)的形状 */
type RefreshHook = (symbol: string) => Promise<{ found: boolean }>;

// ---- 真实尺寸的数据:待发字节估计(approxBytes)按它们量过 ----
// Prisma 的 cuid 是 25 个字符(Trade.id、Order.id、Asset.id 都是),auditRef = SIM-TRD-<cuid>;库里最长的 symbol 14 个字符(CCER-SCEN-2026);
// 价格按 7 位分(十万美元以下)、数量按 6 位吨取上沿
const REAL_SYMBOLS = [
  "VCS-FOR-2021", "VCS-FOR-2022", "VCS-FOR-2023", "CCER-SOL-2022", "CCER-SOL-2023", "GS-WIND-2022", "GS-WIND-2023",
  "GS-MANG-2022", "GS-MANG-2023", "VCS-COOK-2020", "VCS-COOK-2021", "CDM-METH-2019", "CCER-SCEN-2026", "CCER-SCEN-2027",
];
/** 25 字符、形如 Prisma cuid 的 id */
const cuid = (n: number) => `cm${n.toString(36).padStart(8, "0")}000dwv7rvhea0fp`;
const TS = 1_790_000_000_000;
function realTrade(symbol: string, i: number): TapeEntry {
  const id = cuid(i);
  return { id, symbol, price: 1_234_500 + i, quantity: 100_000, takerSide: "SELL", ts: TS + i, auditRef: auditRefOf(id) };
}
function realBook(symbol: string): OrderBookSnapshot {
  const side = (base: number, dir: 1 | -1) => Array.from({ length: 50 }, (_, i) => ({ price: base + dir * i, quantity: 100_000 + i, orders: 12 }));
  return { symbol, bids: side(1_234_500, -1), asks: side(1_234_600, 1), ts: TS };
}

describe("createHub · account 快照冷却与每用户状态回收(终审 P1-25a)", () => {
  useFakeClock();
  /** 冷却的默认值(server/ws-hub.mjs ACCOUNT_SNAPSHOT_COOLDOWN_MS) */
  const COOLDOWN_MS = 2_000;
  const balance = (cashBalance: number): AccountEvent => ({ t: "balance", balance: { cashBalance, lockedCash: 0 } });

  it("同一用户的快照查询之间至少隔 2 s:冷却里的订阅(重复订阅、别的连接)并成冷却结束时的一次查询,各发一份;没人等就不查", async () => {
    // 修复前:每次 subscribe 都在上一次查完之后另起一次全账本读取,一个 demo 登录 20 op/s × 8 条连接可以让它不停地跑
    let n = 0;
    const source = vi.fn<(userId: string) => Promise<AccountEvent[]>>(async () => [balance(++n)]);
    const { connect, op, flush } = fakeClockHub({ accountSnapshot: source });
    const a = await connect("u1");
    await op(a, { op: "subscribe", topics: ["account"] });
    expect(source).toHaveBeenCalledTimes(1);
    expect(a.of("balance").map((e) => e.balance.cashBalance)).toEqual([1]);
    for (let i = 0; i < 5; i += 1) await op(a, { op: "subscribe", topics: ["account"] });
    const b = await connect("u1");
    await op(b, { op: "subscribe", topics: ["account"] });
    const other = await connect("u2");
    await op(other, { op: "subscribe", topics: ["account"] }); // 别的用户各算各的
    expect(source.mock.calls.map(([userId]) => userId)).toEqual(["u1", "u2"]);
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS - 100);
    expect(source).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(source.mock.calls.map(([userId]) => userId)).toEqual(["u1", "u2", "u1"]); // 冷却结束:一次查询服务全部等着的
    expect(a.of("balance").map((e) => e.balance.cashBalance)).toEqual([1, 3]);
    expect(b.of("balance").map((e) => e.balance.cashBalance)).toEqual([3]);
    await vi.advanceTimersByTimeAsync(3 * COOLDOWN_MS);
    expect(source).toHaveBeenCalledTimes(3); // 没人再等:不查
  });

  it("冷却里等着的连接断开或退订了:冷却结束时不为它查", async () => {
    const source = vi.fn(async (): Promise<AccountEvent[]> => [balance(1)]);
    const { connect, op } = fakeClockHub({ accountSnapshot: source });
    const a = await connect("u1");
    await op(a, { op: "subscribe", topics: ["account"] });
    await op(a, { op: "subscribe", topics: ["account"] });
    await op(a, { op: "unsubscribe", topics: ["account"] });
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS * 2);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("查询失败也进冷却:读库出错时不被订阅循环反复触发", async () => {
    const source = vi.fn<(userId: string) => Promise<AccountEvent[]>>().mockRejectedValueOnce(new Error("db down")).mockResolvedValue([balance(2)]);
    const { connect, op, flush } = fakeClockHub({ accountSnapshot: source });
    const a = await connect("u1");
    await op(a, { op: "subscribe", topics: ["account"] });
    await op(a, { op: "subscribe", topics: ["account"] });
    expect(source).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
    await flush();
    expect(source).toHaveBeenCalledTimes(2);
    expect(a.of("balance").map((e) => e.balance.cashBalance)).toEqual([2]);
  });

  it("用户最后一条 account 订阅离开即回收它的 seq:之后该用户的事件不发也不记 seq,重订阅从 0 起;长时间运行下每用户的状态有界", async () => {
    const { bus, connect, op } = fakeClockHub();
    // 1000 个用户各来一次:订阅、收两条事件、断开
    for (let i = 0; i < 1_000; i += 1) {
      const ws = await connect(`user_${i}`);
      await op(ws, { op: "subscribe", topics: ["account"] });
      bus.publish({ kind: "account", userId: `user_${i}`, event: balance(1) });
      bus.publish({ kind: "account", userId: `user_${i}`, event: balance(2) });
      if (i % 2 === 0) await op(ws, { op: "unsubscribe", topics: ["account"] });
      ws.close(1000);
      await vi.advanceTimersByTimeAsync(0);
    }
    // 离线用户的事件(发布器判定在线之后、发布之前他走了)不占 seq
    bus.publish({ kind: "account", userId: "user_7", event: balance(3) });
    const back = await connect("user_7");
    await op(back, { op: "subscribe", topics: ["account"] });
    expect(back.of("subscribed")).toEqual([{ t: "subscribed", topic: "account", seq: 0 }]); // 修复前:3(旧进程内的计数一直留着)
    bus.publish({ kind: "account", userId: "user_7", event: balance(4) });
    await vi.advanceTimersByTimeAsync(FAKE_BATCH_MS);
    expect(back.of("balance")).toEqual([{ t: "balance", topic: "account", seq: 1, balance: { cashBalance: 4, lockedCash: 0 } }]);
    expect(globalThis.__carbadiaPresence?.users.size).toBe(1);
  });

  it("同一用户还有别的连接订着 account:一条退订不回收,seq 照常连续", async () => {
    const { bus, connect, op, flush } = fakeClockHub();
    const a = await connect("u1");
    const b = await connect("u1");
    await op(a, { op: "subscribe", topics: ["account"] });
    await op(b, { op: "subscribe", topics: ["account"] });
    bus.publish({ kind: "account", userId: "u1", event: balance(1) });
    await op(a, { op: "unsubscribe", topics: ["account"] });
    bus.publish({ kind: "account", userId: "u1", event: balance(2) });
    await flush();
    expect(b.of("balance").map((e) => e.seq)).toEqual([1, 2]);
    await op(a, { op: "subscribe", topics: ["account"] });
    expect(a.of("subscribed").at(-1)).toEqual({ t: "subscribed", topic: "account", seq: 2 });
  });
});

describe("createHub · 成交环没满时预读最近 64 笔(终审 P1-25a,同 D21 的 book 刷新写法)", () => {
  useFakeClock();
  const history = (n: number, base = -1_000) =>
    Array.from({ length: n }, (_, i): TapeEntry => ({ ...trade("X", base + i), id: `h${i + 1}`, auditRef: auditRefOf(`h${i + 1}`), ts: 1_700_000_000_000 + base + i }));
  /** 可控的预读钩子:每次调用排一个待决的 Promise,由测试 resolve / reject */
  function controllablePreload() {
    const pending: { symbol: string; resolve: (v: { found: boolean; trades: TapeEntry[] }) => void; reject: (e: Error) => void }[] = [];
    const recentTrades = vi.fn(
      (symbol: string) =>
        new Promise<{ found: boolean; trades: TapeEntry[] }>((resolve, reject) => {
          pending.push({ symbol, resolve, reject });
        }),
    );
    return { recentTrades, pending };
  }

  it("重启后环是空的:第一次订阅只回 subscribed{seq: 0}、经钩子预读;回来后发整份快照(时间升序);之后照常增量;预读只做一次", async () => {
    // 修复前:重启后成交带是空的,直到有新成交(客户端 WS 模式下不拉 REST 成交)
    const { recentTrades, pending } = controllablePreload();
    const { bus, connect, op, flush } = fakeClockHub({ recentTrades });
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["trades:X"] });
    expect(a.of("subscribed")).toEqual([{ t: "subscribed", topic: "trades:X", seq: 0 }]);
    expect(a.of("trades")).toHaveLength(0);
    expect(recentTrades.mock.calls).toEqual([["X"]]);
    pending[0].resolve({ found: true, trades: history(3) });
    await flush();
    expect(a.of("trades")).toEqual([{ t: "trades", topic: "trades:X", seq: 0, symbol: "X", trades: history(3) }]);
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 1)] });
    await flush();
    expect(a.of("trades").at(-1)).toMatchObject({ seq: 1, trades: [{ id: "t1" }] });
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["trades:X"] });
    expect(b.of("subscribed")).toEqual([{ t: "subscribed", topic: "trades:X", seq: 1 }]);
    expect(b.of("trades")[0].trades.map((e) => e.id)).toEqual(["h1", "h2", "h3", "t1"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recentTrades).toHaveBeenCalledTimes(1);
  });

  it("预读在途时:同一 symbol 的订阅并进这一次;期间的成交不单独发给等着的连接,并进快照(不在等的连接照常收增量);since 回放看得到历史之后的每一笔", async () => {
    const { recentTrades, pending } = controllablePreload();
    const { bus, connect, op, flush } = fakeClockHub({ recentTrades });
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["trades:X"] });
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["trades:X"] });
    const live = await connect();
    await op(live, { op: "subscribe", topics: ["trades:X"], since: { "trades:X": 0 } }); // 带合法 since(= current):回放路径,不等
    expect(recentTrades).toHaveBeenCalledTimes(1);
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 1)] });
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 2)] });
    await flush();
    expect(a.of("trades")).toHaveLength(0);
    expect(live.of("trades").map((e) => e.seq)).toEqual([1, 2]);
    // 历史里含一笔已经作为增量到过环里的成交(t1,按 id 去重)与一笔更新的(不该插到前面,丢掉)
    pending[0].resolve({ found: true, trades: [...history(2), { ...trade("X", 1) }, { ...trade("X", 9), ts: 1_700_000_000_999 }] });
    await flush();
    for (const ws of [a, b]) {
      expect(ws.of("trades")).toHaveLength(1);
      expect(ws.of("trades")[0]).toMatchObject({ seq: 2 });
      expect(ws.of("trades")[0].trades.map((e) => e.id)).toEqual(["h1", "h2", "t1", "t2"]);
    }
    bus.publish({ kind: "trades", symbol: "X", trades: [trade("X", 3)] });
    await flush();
    expect(a.of("trades").at(-1)).toMatchObject({ seq: 3 });
    const late = await connect();
    await op(late, { op: "subscribe", topics: ["trades:X"], since: { "trades:X": 1 } });
    expect(late.of("subscribed")).toEqual([{ t: "subscribed", topic: "trades:X", seq: 1 }]);
    expect(late.of("trades").map((e) => e.seq)).toEqual([2, 3]);
  });

  it("环已满(64 笔)不预读;查无此 symbol、钩子失败或超时:等着的连接立即拿到环里现有的,冷却 1 s 内不再预读;失败记日志", async () => {
    const lines: string[] = [];
    const { recentTrades, pending } = controllablePreload();
    const { bus, connect, op, flush } = fakeClockHub({ recentTrades, log: (line) => lines.push(line) });
    for (let i = 1; i <= 64; i += 1) bus.publish({ kind: "trades", symbol: "FULL", trades: [trade("FULL", i)] });
    const full = await connect();
    await op(full, { op: "subscribe", topics: ["trades:FULL"] });
    expect(full.of("trades")[0].trades).toHaveLength(64);
    expect(recentTrades).not.toHaveBeenCalled();

    const a = await connect();
    await op(a, { op: "subscribe", topics: ["trades:X"] });
    pending[0].resolve({ found: false, trades: [] });
    await flush();
    expect(a.of("trades")).toEqual([{ t: "trades", topic: "trades:X", seq: 0, symbol: "X", trades: [] }]);
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["trades:X"] }); // 冷却里:直接拿环
    expect(b.of("trades")).toHaveLength(1);
    expect(recentTrades).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    const c = await connect();
    await op(c, { op: "subscribe", topics: ["trades:X"] });
    pending[1].reject(new Error("db down"));
    await flush();
    expect(c.of("trades")).toHaveLength(1);
    expect(lines.some((l) => l.includes("[ws] trades preload failed for X: db down"))).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    const d = await connect();
    await op(d, { op: "subscribe", topics: ["trades:X"] }); // 钩子一直不回:3 s 后放行
    expect(recentTrades).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(d.of("trades")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(d.of("trades")).toHaveLength(1);
  });

  it("没挂钩子(发布器还没被任何 bundle 加载):与修复前一样立即发环里现有的", async () => {
    const { connect, op } = fakeClockHub();
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["trades:X"] });
    expect(ws.of("trades")).toEqual([{ t: "trades", topic: "trades:X", seq: 0, symbol: "X", trades: [] }]);
  });

  it("等着的连接退订了:预读回来时不发给它", async () => {
    const { recentTrades, pending } = controllablePreload();
    const { connect, op, flush } = fakeClockHub({ recentTrades });
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["trades:X"] });
    await op(ws, { op: "unsubscribe", topics: ["trades:X"] });
    pending[0].resolve({ found: true, trades: history(2) });
    await flush();
    expect(ws.of("trades")).toHaveLength(0);
  });
});

describe("approxBytes · 待发事件的字节估计不低于真实 JSON", () => {
  it("cuid 长度的 id / auditRef、14 字符的 symbol、7 位价格:每种事件的估计 ≥ 序列化字节 + 帧里的逗号", () => {
    const SYM = "CCER-SCEN-2026";
    const order: Order = {
      id: cuid(1), clientOrderId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f", assetId: cuid(2), symbol: SYM, side: "BUY", type: "LIMIT", price: 1_234_567,
      quantity: 100_000, filledQuantity: 99_999, status: "PARTIAL", avgFillPrice: 1_234_567, cancelReason: "MARKET_REMAINDER", createdAt: TS, updatedAt: TS,
    };
    const events: ServerEvent[] = [
      { t: "trades", topic: `trades:${SYM}`, seq: 1_234_567, symbol: SYM, trades: [realTrade(SYM, 1)] },
      { t: "trades", topic: `trades:${SYM}`, seq: 1_234_567, symbol: SYM, trades: Array.from({ length: 64 }, (_, i) => realTrade(SYM, i)) },
      { t: "book.snapshot", topic: `book:${SYM}`, seq: 1_234_567, ...realBook(SYM) },
      { t: "book.delta", topic: `book:${SYM}`, seq: 1_234_567, symbol: SYM, bids: [{ price: 1_234_567, quantity: 100_000, orders: 12 }], asks: [], ts: TS },
      {
        t: "ticker", topic: "ticker:*", seq: 1_234_567, symbol: SYM,
        ticker: { symbol: SYM, ts: TS, lastPrice: 1_234_567, change24h: -12.345678901234567, high24h: 1_234_567, low24h: 1_234_567, volume24h: 123_456_789, bestBid: 1_234_567, bestAsk: 1_234_567 },
      },
      // 按标的订阅的 ticker:topic 多出 symbol 长度;change24h 取小幅度、位数最长的浮点(-0.00008100005913004316,23 字符)
      {
        t: "ticker", topic: `ticker:${SYM}`, seq: 1_234_567, symbol: SYM,
        ticker: { symbol: SYM, ts: TS, lastPrice: 1_234_567, change24h: -((1 / 1_234_567) * 100), high24h: 1_234_567, low24h: 1_234_567, volume24h: 12_345_678_901, bestBid: 1_234_567, bestAsk: 1_234_567 },
      },
      { t: "candle", topic: `candles:${SYM}:15m`, seq: 1_234_567, symbol: SYM, interval: "15m", candle: { t: TS, o: 1_234_567, h: 1_234_567, l: 1_234_567, c: 1_234_567, v: 123_456_789 } },
      { t: "order", topic: "account", seq: 1_234_567, order },
      {
        t: "fill", topic: "account", seq: 1_234_567,
        fill: {
          id: cuid(1), orderId: cuid(2), symbol: SYM, side: "BUY", role: "TAKER", price: 1_234_567, quantity: 100_000, notional: 123_456_700_000, feeCents: 0, ts: TS,
          auditRef: auditRefOf(cuid(1)), ledgerRefs: [cuid(3), cuid(4), cuid(5), cuid(6)],
        },
      },
      {
        t: "position", topic: "account", seq: 1_234_567,
        position: {
          ...position(cuid(1)), symbol: SYM, quantity: 100_000, locked: 100_000, available: 100_000, retired: 100_000, lastPrice: 1_234_567, marketValue: 123_456_700_000,
          averagePurchasePrice: 1_234_567, unrealisedPnl: -123_456_700_000,
        },
      },
      { t: "balance", topic: "account", seq: 1_234_567, balance: { cashBalance: 123_456_789_012, lockedCash: 123_456_789_012 } },
      { t: "subscribed", topic: `candles:${SYM}:15m`, seq: 1_234_567 },
      { t: "unsubscribed", topic: `candles:${SYM}:15m` },
      { t: "resync", topic: `candles:${SYM}:15m`, reason: "backpressure" },
      { t: "error", code: "too_many_topics", message: "At most 64 topics per connection", topic: `candles:${SYM}:15m` },
      { t: "hello", v: 1, serverTime: TS, heartbeatMs: 25_000, userId: cuid(7), maxTopics: 64 },
      { t: "pong", t0: TS, serverTime: TS },
    ];
    serverFrameSchema.parse(events);
    for (const event of events) {
      const actual = Buffer.byteLength(JSON.stringify(event)) + 1;
      expect({ t: event.t, estimate: approxBytes(event) >= actual ? "ok" : `${approxBytes(event)} < ${actual}` }).toEqual({ t: event.t, estimate: "ok" });
    }
  });
});

describe("createHub · 同一合帧窗口里的突发订阅", () => {
  useFakeClock();

  // 审查复现的形状:14 个标的、50 档盘口、满 64 条的成交环、ticker:* 全量;bufferedAmount 在 50 ms 合帧之前一直是 0,
  // 只看它的话同一窗口里 20 个重复订阅 op 会排出 20 份快照(审查实测单帧 3.1 MB)。
  // 数据用真实尺寸(cuid 长度的 id 与 auditRef、真实长度的 symbol、7 位价格):量出来的单帧上界才是真实帧的上界
  const SYMBOLS = REAL_SYMBOLS;
  const allTopics = (): Topic[] => [...SYMBOLS.flatMap((s) => [`book:${s}`, `trades:${s}`] as Topic[]), "ticker:*"];
  const frameBytes = (frame: ServerEvent[]) => Buffer.byteLength(JSON.stringify(frame));
  /**
   * 限流管的是订阅快照(盘口、成交带、最后值);subscribed / unsubscribed 回执是控制事件,总要送达,只受每秒 20 个 op 约束。
   * 估计不低于真实字节时:已在缓冲里的 + 本帧快照的真实字节 ≤ 256 KB + 最后排进去的那一份(不超过帧里最大的一份)
   */
  function snapshotBudget(frame: ServerEvent[], buffered = 0) {
    const data = frame.filter((e) => e.t === "book.snapshot" || e.t === "trades" || e.t === "ticker");
    return { used: buffered + frameBytes(data), limit: 256 * 1024 + Math.max(...data.map((e) => frameBytes([e]))) };
  }
  /** 一条「热」连接先订上全部 topic(hub 只在有人订阅时缓存盘口 / ticker),再把盘口、成交环、ticker 铺满 */
  async function warmHub() {
    const made = fakeClockHub();
    const warm = await made.connect();
    await made.op(warm, { op: "subscribe", topics: allTopics() });
    for (const s of SYMBOLS) {
      made.bus.publish({ kind: "book", symbol: s, snapshot: realBook(s), delta: null });
      for (let i = 1; i <= 64; i += 1) made.bus.publish({ kind: "trades", symbol: s, trades: [realTrade(s, i)] });
      made.bus.publish({
        kind: "ticker",
        symbol: s,
        ticker: { symbol: s, ts: TS, lastPrice: 1_234_567, change24h: 1.2345678901234567, high24h: 1_234_567, low24h: 1_234_500, volume24h: 123_456, bestBid: 1_234_500, bestAsk: 1_234_600 },
      });
    }
    await made.flush();
    return made;
  }

  it("20 个重复订阅 op 落在同一窗口:每个 topic 只排一份快照,单帧与只订一次同量级(多出来的只有 subscribed 回执)", async () => {
    const { connect, flush, op } = await warmHub();
    const once = await connect();
    await op(once, { op: "subscribe", topics: allTopics() });
    const oneFrame = once.frames.at(-1)!;
    const ws = await connect();
    for (let i = 0; i < 20; i += 1) ws.message({ op: "subscribe", topics: allTopics() });
    await flush();
    expect(ws.frames).toHaveLength(2); // hello + 这一窗口的一帧
    const frame = ws.frames[1];
    serverFrameSchema.parse(frame);
    expect(frame.filter((e) => e.t === "subscribed")).toHaveLength(20 * allTopics().length);
    expect(frame.filter((e) => e.t === "book.snapshot")).toHaveLength(SYMBOLS.length);
    expect(frame.filter((e) => e.t === "trades")).toHaveLength(SYMBOLS.length);
    expect(frame.filter((e) => e.t === "ticker")).toHaveLength(SYMBOLS.length);
    // 修复前约为 oneFrame 的 20 倍(审查实测 3.1 MB)
    const ackBytes = frameBytes(frame.filter((e) => e.t === "subscribed")) - frameBytes(oneFrame.filter((e) => e.t === "subscribed"));
    expect(frameBytes(frame)).toBe(frameBytes(oneFrame) + ackBytes);
    expect(frameBytes(frame)).toBeLessThan(1.5 * frameBytes(oneFrame));
    // 重复的回执带当前 seq,与已排的快照 + 其后的流事件连续
    const acks = frame.filter((e): e is Extract<ServerEvent, { t: "subscribed" }> => e.t === "subscribed" && e.topic === `trades:${SYMBOLS[0]}`);
    expect(new Set(acks.map((e) => e.seq))).toEqual(new Set([64]));
  });

  it("缓冲里已有 100 KB 时一个 op 订全部 topic:排进来的快照按真实字节算,bufferedAmount + 单帧不超过 256 KB 加一份快照", async () => {
    const { connect, flush } = await warmHub();
    const ws = await connect();
    ws.bufferedAmount = 100 * 1024;
    ws.message({ op: "subscribe", topics: allTopics() });
    await flush();
    const frame = ws.frames[1];
    serverFrameSchema.parse(frame);
    expect(frame.filter((e) => e.t === "trades" || e.t === "book.snapshot").length).toBeLessThan(2 * SYMBOLS.length); // 确实被限流了
    // 估计若低于真实字节(修复前:成交带条目 160 < 实测约 180、档位 44 < 实测约 48),排进来的比 256 KB 多出一截(修复前 284 717 > 273 626)
    const { used, limit } = snapshotBudget(frame, ws.bufferedAmount);
    expect(used).toBeLessThanOrEqual(limit);
    expect(ws.bufferedAmount + frameBytes(frame)).toBeLessThanOrEqual(limit + 4 * 1024); // 连同 29 条回执
  });

  it("限流看 bufferedAmount + 本连接尚未 flush 的待发字节:同一窗口里订阅 / 退订来回切,单帧不超过 256 KB 加一份快照;超出的 topic 欠快照,随后 resync、重订阅补上", async () => {
    const { hub, connect, flush, scan, op } = await warmHub();
    const ws = await connect();
    // 19 个 op(限速 20 op/s 以内):订 → 退 → 订 … → 订
    for (let i = 0; i < 10; i += 1) {
      ws.message({ op: "subscribe", topics: allTopics() });
      if (i < 9) ws.message({ op: "unsubscribe", topics: allTopics() });
    }
    await flush();
    expect(ws.frames).toHaveLength(2);
    const frame = ws.frames[1];
    serverFrameSchema.parse(frame);
    // 快照部分不超过 256 KB 加一份(估计按真实尺寸:修复前的常数在这组数据上排出 312 568 字节的帧)
    const { used, limit } = snapshotBudget(frame);
    expect(used).toBeLessThanOrEqual(limit);
    // 整帧另含约 550 条回执(19 个 op × 29 个 topic);修复前约 10 份全量快照(> 1.5 MB)
    expect(frameBytes(frame)).toBeLessThan(limit + 32 * 1024);
    expect(ws.of("error")).toHaveLength(0);
    expect(hub.stats().droppedDeltas).toBeGreaterThan(0); // 被推迟的订阅快照照 §9.2 D16 计入
    // FakeWs 的 bufferedAmount 恒 0:下一轮扫描对欠快照的 topic 发 resync,客户端重订阅(新窗口)即补上快照
    await scan();
    const owed = ws.of("resync").map((e) => e.topic);
    expect(owed.length).toBeGreaterThan(0);
    const before = ws.frames.length;
    await op(ws, { op: "subscribe", topics: owed });
    const refill = ws.frames.slice(before).flat();
    const owedBooks = owed.filter((t) => t.startsWith("book:"));
    const owedTrades = owed.filter((t) => t.startsWith("trades:"));
    expect(refill.filter((e) => e.t === "book.snapshot").map((e) => (e as { topic: Topic }).topic).sort()).toEqual(owedBooks.sort());
    expect(refill.filter((e) => e.t === "trades").map((e) => (e as { topic: Topic }).topic).sort()).toEqual(owedTrades.sort());
  });
});

describe("createHub · 无人订阅的 topic 淘汰快照缓存", () => {
  it("ticker:订阅 → 退订 → 总线上晚到的一条不进缓存,下一位订阅者只收到 subscribed(客户端保留 REST 值,下一笔成交再推)", async () => {
    const { hub, bus } = makeHub();
    const a = await subscribed(hub, ["ticker:A", "ticker:*"]);
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 1, lastPrice: 100 } });
    await vi.waitFor(() => expect(a.of("ticker")).toHaveLength(2));
    a.message({ op: "unsubscribe", topics: ["ticker:A", "ticker:*"] });
    await vi.waitFor(() => expect(a.of("unsubscribed")).toHaveLength(2));
    // 无人订阅期间发布器不再喂 ticker(门控 ②);在途的一条晚到,也不当成下一位订阅者的快照
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 2, lastPrice: 90 } });
    const b = await subscribed(hub, ["ticker:A", "ticker:*"]);
    await sleep(20);
    expect(b.of("ticker")).toHaveLength(0);
    // 有人订阅之后的更新照常推送并重新进缓存
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 3, lastPrice: 95 } });
    await vi.waitFor(() => expect(b.of("ticker")).toHaveLength(2));
    const c = await subscribed(hub, ["ticker:A"]);
    await vi.waitFor(() => expect(c.of("ticker")).toHaveLength(1));
    expect(c.of("ticker")[0]).toEqual({ t: "ticker", topic: "ticker:A", seq: 3, symbol: "A", ticker: { symbol: "A", ts: 3, lastPrice: 95 } });
  });

  it("ticker:SYM 归零但 ticker:* 还有人订(发布器照样喂):缓存保留;ticker:* 归零时淘汰没有 ticker:SYM 订阅的全部标的", async () => {
    const { hub, bus } = makeHub();
    const star = await subscribed(hub, ["ticker:*"]);
    const onlyB = await subscribed(hub, ["ticker:B"]);
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 1, lastPrice: 100 } });
    bus.publish({ kind: "ticker", symbol: "B", ticker: { symbol: "B", ts: 1, lastPrice: 200 } });
    const a = await subscribed(hub, ["ticker:A"]);
    await vi.waitFor(() => expect(a.of("ticker")).toHaveLength(1));
    a.message({ op: "unsubscribe", topics: ["ticker:A"] });
    await vi.waitFor(() => expect(a.of("unsubscribed")).toHaveLength(1));
    const a2 = await subscribed(hub, ["ticker:A"]);
    await vi.waitFor(() => expect(a2.of("ticker")).toHaveLength(1)); // ticker:* 还有人订:A 的缓存没被淘汰
    a2.message({ op: "unsubscribe", topics: ["ticker:A"] });
    star.message({ op: "unsubscribe", topics: ["ticker:*"] });
    await vi.waitFor(() => expect(star.of("unsubscribed")).toHaveLength(1));
    await vi.waitFor(() => expect(a2.of("unsubscribed")).toHaveLength(1));
    const late = await subscribed(hub, ["ticker:*"]);
    await sleep(20);
    // A 已无人喂 → 淘汰;B 仍有 ticker:B 的订阅者(发布器照样喂)→ 保留
    expect(late.of("ticker").map((e) => e.symbol)).toEqual(["B"]);
    expect(onlyB.of("unsubscribed")).toHaveLength(0);
  });

  it("book:SYM 归零时 ticker 缓存里的书顶(bestBid / bestAsk)一并丢掉:发布器只在有人订盘口时才算书顶", async () => {
    const { hub, bus } = makeHub();
    const w = await subscribed(hub, ["ticker:*", "book:A"]);
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 1, lastPrice: 100, bestBid: 99, bestAsk: 101 } });
    await vi.waitFor(() => expect(w.of("ticker")).toHaveLength(1));
    w.message({ op: "unsubscribe", topics: ["book:A"] });
    await vi.waitFor(() => expect(w.of("unsubscribed")).toHaveLength(1));
    // 书顶停在这一刻;之后晚到的书顶也不进缓存(ticker:* 的订阅者照常实时收到)
    bus.publish({ kind: "ticker", symbol: "A", ticker: { symbol: "A", ts: 2, bestBid: 98, bestAsk: 102 } });
    await vi.waitFor(() => expect(w.of("ticker")).toHaveLength(2));
    const n = await subscribed(hub, ["ticker:*"]);
    await vi.waitFor(() => expect(n.of("ticker")).toHaveLength(1));
    expect(n.of("ticker")[0].ticker).toEqual({ symbol: "A", ts: 2, lastPrice: 100 });
  });

  it("book:没有缓存时订阅只回 subscribed 并请发布器全量刷新一次(刷新回来前同一 symbol 不重复请);刷新发来的整份快照带下一个 seq;有缓存时不请", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const bookRefresh = vi.fn<(symbol: string) => Promise<void>>(() => gate);
    const { hub, bus } = makeHub({ bookRefresh });
    const a = await subscribed(hub, ["book:X"]);
    const b = await subscribed(hub, ["book:X"]);
    await sleep(20);
    expect(a.of("book.snapshot")).toHaveLength(0);
    expect(bookRefresh.mock.calls).toEqual([["X"]]);
    bus.publish(bookMsg("X", false)); // 发布器的刷新:整份快照(delta null)
    await vi.waitFor(() => expect(b.of("book.snapshot")).toHaveLength(1));
    expect(a.of("book.snapshot")[0]).toMatchObject({ topic: "book:X", seq: 1, bids: snapshot("X").bids });
    release();
    const c = await subscribed(hub, ["book:X"]);
    await vi.waitFor(() => expect(c.of("book.snapshot")).toHaveLength(1)); // 有缓存:直接发
    expect(c.of("book.snapshot")[0].seq).toBe(1);
    expect(bookRefresh).toHaveBeenCalledTimes(1);
  });

});

describe("createHub · book 全量刷新限频与等整份快照的连接", () => {
  useFakeClock();
  /** 刷新冷却的默认值(server/ws-hub.mjs BOOK_REFRESH_COOLDOWN_MS) */
  const COOLDOWN_MS = 1_000;

  it("订阅 → 全部退订 → 总线上晚到的一条不进缓存;下一位订阅者拿不到旧簿:冷却内不再读库,冷却结束补一次刷新,它的整份快照给这位订阅者", async () => {
    const bookRefresh = vi.fn<(symbol: string) => void>();
    const { bus, flush, connect, op } = fakeClockHub({ bookRefresh });
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["book:X"] });
    expect(bookRefresh.mock.calls).toEqual([["X"]]);
    bus.publish(bookMsg("X", false)); // 刷新发来的整份快照
    await flush();
    expect(a.of("book.snapshot").map((e) => e.seq)).toEqual([1]);
    await op(a, { op: "unsubscribe", topics: ["book:X"] });
    // 发布器在兴趣消失前发出的读取,晚到:不进缓存
    bus.publish({ kind: "book", symbol: "X", snapshot: { ...snapshot("X"), ts: 1 }, delta: null });
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["book:X"] });
    expect(b.of("book.snapshot")).toHaveLength(0);
    expect(bookRefresh).toHaveBeenCalledTimes(1); // 还在冷却里
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
    expect(bookRefresh).toHaveBeenCalledTimes(2); // 尾随的一次:b 还在等
    bus.publish(bookMsg("X", false));
    await flush();
    expect(b.of("book.snapshot")).toEqual([expect.objectContaining({ topic: "book:X", seq: 3, bids: snapshot("X").bids })]);
    await vi.advanceTimersByTimeAsync(3 * COOLDOWN_MS);
    expect(bookRefresh).toHaveBeenCalledTimes(2); // 没人在等了:冷却到期不再请
  });

  it("一条匿名连接在限速内对 14 个标的订阅 / 退订 10 个来回:每个标的至多读两次库(修复前 140 次),最后一次订阅照样拿到整份快照", async () => {
    const SYMBOLS = Array.from({ length: 14 }, (_, i) => `S${String(i).padStart(2, "0")}`);
    const topics = SYMBOLS.map((s) => `book:${s}` as Topic);
    const calls = new Map<string, number>();
    // 模拟发布器:读库(一个微任务)后把整份快照发回总线
    const bookRefresh = async (symbol: string) => {
      calls.set(symbol, (calls.get(symbol) ?? 0) + 1);
      await Promise.resolve();
      made.bus.publish(bookMsg(symbol, false));
    };
    const made = fakeClockHub({ bookRefresh });
    const ws = await made.connect();
    for (let i = 0; i < 10; i += 1) {
      await made.op(ws, { op: "subscribe", topics });
      if (i < 9) await made.op(ws, { op: "unsubscribe", topics });
    }
    expect(ws.of("error")).toHaveLength(0); // 19 个 op,没触发限速
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS); // 冷却结束:最后一次订阅还在等,补一次
    await made.flush();
    for (const s of SYMBOLS) expect(calls.get(s)).toBe(2);
    // 每个标的:最后一次 subscribed 之后收到的是整份快照(不是 delta,也不是旧簿)
    const events = ws.events();
    for (const topic of topics) {
      const lastAck = events.findLastIndex((e) => e.t === "subscribed" && e.topic === topic);
      const after = events.slice(lastAck + 1).filter((e) => "topic" in e && e.topic === topic);
      expect(after.map((e) => e.t)).toEqual(["book.snapshot"]);
    }
    await vi.advanceTimersByTimeAsync(5 * COOLDOWN_MS);
    expect([...calls.values()].reduce((n, c) => n + c, 0)).toBe(2 * SYMBOLS.length);
  });

  it("进程刚起、从没有过标的列表时放行的 symbol 按连接限流:匿名连接 10 次(订阅 64 个随机 book 主题 + 退订)只引出每秒至多 8 次刷新,其余回 rate_limited(终审 P1-25a)", async () => {
    // 修复前同样的 20 个 op 引出 640 次 bookRefresh(每次一条 asset.findUnique),与 matching 和 bot 抢同一个 SQLite
    const refreshed: string[] = [];
    const made = fakeClockHub({ isKnownSymbol: undefined, bookRefresh: (symbol) => void refreshed.push(symbol) });
    const ws = await made.connect();
    const round = (i: number) => Array.from({ length: 64 }, (_, j) => `book:R${i}x${j}` as Topic);
    for (let i = 0; i < 10; i += 1) {
      // 第一轮顺带订已放行的 R0x0 的 trades / ticker:同一窗口里已放行的 symbol 的其它 topic 不另占名额
      const extra: Topic[] = i === 0 ? ["trades:R0x0", "ticker:R0x0"] : [];
      await made.op(ws, { op: "subscribe", topics: [...round(i), ...extra] });
      await made.op(ws, { op: "unsubscribe", topics: [...round(i), ...extra] });
    }
    expect(ws.of("error").filter((e) => e.code === "rate_limited" && e.topic === undefined)).toHaveLength(0); // 20 个 op,没触发 op 限速
    expect(refreshed).toHaveLength(8);
    expect(ws.of("subscribed").map((e) => e.topic).filter((t) => !t.startsWith("book:"))).toEqual(["trades:R0x0", "ticker:R0x0"]);
    expect(ws.of("subscribed")).toHaveLength(8 + 2);
    const limited = ws.of("error");
    expect(limited).toHaveLength(640 - 8);
    expect(limited.every((e) => e.code === "rate_limited" && e.topic?.startsWith("book:"))).toBe(true);
    // 下一秒又有 8 个
    await vi.advanceTimersByTimeAsync(1_000);
    await made.op(ws, { op: "subscribe", topics: round(99) });
    expect(refreshed).toHaveLength(16);
    await made.op(ws, { op: "unsubscribe", topics: round(99) }); // 没人在等了:冷却到期不补刷新
    // 标的列表一出现就按列表判断,不再走限流
    globalThis.__carbadiaInstrumentsCache = {
      at: Date.now(),
      value: { instruments: [{ instrument: { symbol: "LISTED" } } as never], feeSchedule: { makerBps: 0, takerBps: 0, minFeeCents: 0, demo: true }, serverTime: 0 },
    };
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      const before = ws.of("error").length;
      await made.op(ws, { op: "subscribe", topics: [...round(100), "book:LISTED"] });
      const fresh = ws.of("error").slice(before);
      expect(fresh).toHaveLength(64);
      expect(fresh.every((e) => e.code === "unknown_topic")).toBe(true);
      expect(refreshed.at(-1)).toBe("LISTED");
      expect(refreshed).toHaveLength(17);
    } finally {
      globalThis.__carbadiaInstrumentsCache = undefined;
    }
  });

  it("没法核实的 symbol 另有全 hub 共享的额度(每秒 10 个不同的 symbol):多条连接合起来也只引出 10 次刷新;别的连接订同一个已放行的 symbol 不占额度(P1-25e)", async () => {
    // 按连接每秒 8 个挡不住多条连接:未受信 IP 桶 16 条连接、每个 Cloudflare IP 8 条,各自 8 个 / 秒,合起来每秒上百次查库
    const refreshed: string[] = [];
    const made = fakeClockHub({ isKnownSymbol: undefined, bookRefresh: (symbol) => void refreshed.push(symbol) });
    const conns = [await made.connect(), await made.connect(), await made.connect()];
    for (const [i, ws] of conns.entries()) {
      await made.op(ws, { op: "subscribe", topics: Array.from({ length: 8 }, (_, j) => `book:H${i}x${j}` as Topic) });
    }
    expect(refreshed).toHaveLength(10); // 8 + 2,第三条一个都没放行
    const hubLimited = conns.flatMap((ws) => ws.of("error")).filter((e) => /across the server/.test(e.message));
    expect(hubLimited).toHaveLength(6 + 8); // 第二条 6 个 + 第三条 8 个
    expect(hubLimited.every((e) => e.code === "rate_limited" && e.topic?.startsWith("book:"))).toBe(true);
    // 同一秒里别的连接订已放行的 symbol:不占额度,照常订上
    const late = await made.connect();
    await made.op(late, { op: "subscribe", topics: ["book:H0x0", "trades:H1x1"] });
    expect(late.of("error")).toHaveLength(0);
    expect(late.of("subscribed").map((e) => e.topic)).toEqual(["book:H0x0", "trades:H1x1"]);
    // 下一秒额度回满(10 个),不会攒到更多
    await vi.advanceTimersByTimeAsync(3_000);
    const before = refreshed.length;
    await made.op(conns[2], { op: "subscribe", topics: Array.from({ length: 8 }, (_, j) => `book:N${j}` as Topic) });
    await made.op(late, { op: "subscribe", topics: Array.from({ length: 8 }, (_, j) => `book:M${j}` as Topic) });
    expect(refreshed.length - before).toBe(10);
  });

  it("等整份快照的连接:先到的盘口消息(比如别的读取算出的 delta)对它以整份快照发出、同一 seq;之后照常 delta;不再补刷新", async () => {
    const bookRefresh = vi.fn<(symbol: string) => Promise<void>>(() => new Promise<void>(() => {})); // 在途,一直不返回
    const { bus, flush, connect, op } = fakeClockHub({ bookRefresh });
    const ws = await connect();
    await op(ws, { op: "subscribe", topics: ["book:X"] });
    expect(ws.of("subscribed")).toEqual([{ t: "subscribed", topic: "book:X", seq: 0 }]);
    bus.publish(bookMsg("X", true));
    bus.publish(bookMsg("X", true));
    await flush();
    expect(ws.events().filter((e) => e.t.startsWith("book.")).map((e) => [e.t, (e as { seq: number }).seq])).toEqual([
      ["book.snapshot", 1],
      ["book.delta", 2],
    ]);
    expect(ws.of("book.snapshot")[0]).toMatchObject({ bids: snapshot("X").bids, asks: snapshot("X").asks });
    await vi.advanceTimersByTimeAsync(3 * COOLDOWN_MS);
    expect(bookRefresh).toHaveBeenCalledTimes(1);
  });

  it("没注入选项时读 globalThis.__carbadiaBookRefresh(发布器挂的钩子);钩子拒绝 / 同步抛错 → 记日志,还在等的订阅者不必重订阅,冷却结束自动再请", async () => {
    const logs: string[] = [];
    const { bus, flush, connect, op } = fakeClockHub({ log: (line) => logs.push(line) });
    const hook = vi
      .fn<RefreshHook>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockImplementationOnce(() => {
        throw new Error("sync boom");
      })
      .mockResolvedValue({ found: true }); // 第三次返回了,但盘口消息还没到(发布器判定无兴趣之类)
    globalThis.__carbadiaBookRefresh = hook;
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["book:X"] });
    expect(logs.filter((l) => l.includes("book refresh failed for X: db down"))).toHaveLength(1);
    expect(hook).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
    expect(hook).toHaveBeenCalledTimes(2);
    // 同一 symbol 一分钟内的第二次失败不另起一行(被抑制的次数记在下一行里,见下面的日志用例)
    expect(logs.filter((l) => l.includes("book refresh failed for X"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(COOLDOWN_MS);
    expect(hook).toHaveBeenCalledTimes(3);
    bus.publish(bookMsg("X", false));
    await flush();
    expect(a.of("book.snapshot")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * COOLDOWN_MS);
    expect(hook).toHaveBeenCalledTimes(3);
  });

  it("发布器查无此 symbol(found: false):不再请刷新,推进 10 s 钩子仍只调一次;下一次订阅再查一次(冷却里来的并进尾随的那一次);等着的连接留着,之后真来了盘口消息照样给整份快照", async () => {
    const bookRefresh = vi.fn<RefreshHook>(async () => ({ found: false }));
    const { bus, flush, connect, op } = fakeClockHub({ bookRefresh });
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["book:GHOST"] });
    expect(bookRefresh.mock.calls).toEqual([["GHOST"]]);
    // 修复前:冷却每到期一次、只要还有人在等就再请一次(每秒一次 prisma.asset.findUnique,没有尽头)
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bookRefresh).toHaveBeenCalledTimes(1);
    // 下一次订阅(冷却已过):再查一次,之后同样停
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["book:GHOST"] });
    expect(bookRefresh).toHaveBeenCalledTimes(2);
    // 冷却里又来两位订阅者:并进冷却到期时的那一次(尾随),不是各查各的
    const c = await connect();
    const d = await connect();
    await op(c, { op: "subscribe", topics: ["book:GHOST"] });
    await op(d, { op: "subscribe", topics: ["book:GHOST"] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bookRefresh).toHaveBeenCalledTimes(3);
    bus.publish(bookMsg("GHOST", true));
    await flush();
    for (const ws of [a, b, c, d]) {
      expect(ws.of("book.snapshot").map((e) => e.seq)).toEqual([1]);
      expect(ws.of("book.delta")).toHaveLength(0);
    }
    expect(bookRefresh).toHaveBeenCalledTimes(3);
  });

  it("等待者全部退订后次数闸作废:之后的订阅者照常请刷新,拿到整份快照", async () => {
    const bookRefresh = vi.fn<RefreshHook>(async () => ({ found: true })); // 返回了却没发盘口(发布器判定无兴趣之类)
    const { bus, flush, connect, op } = fakeClockHub({ bookRefresh });
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["book:X"] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bookRefresh).toHaveBeenCalledTimes(3); // 次数闸满
    await op(a, { op: "unsubscribe", topics: ["book:X"] });
    await vi.advanceTimersByTimeAsync(10_000);
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["book:X"] });
    expect(bookRefresh).toHaveBeenCalledTimes(4);
    bus.publish(bookMsg("X", false));
    await flush();
    expect(b.of("book.snapshot").map((e) => e.seq)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bookRefresh).toHaveBeenCalledTimes(4); // 等来了:不再请
  });

  it("连续 3 次刷新都没等来盘口消息(钩子返回 found 但没发):停,直到下一次订阅;盘口消息一到,等着的连接都拿到整份快照", async () => {
    const bookRefresh = vi.fn<RefreshHook>(async () => ({ found: true }));
    const { bus, flush, connect, op } = fakeClockHub({ bookRefresh });
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["book:X"] });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bookRefresh).toHaveBeenCalledTimes(3); // 修复前 11 次(每个冷却一次)
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["book:X"] }); // 下一次订阅重新计数
    expect(bookRefresh).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bookRefresh).toHaveBeenCalledTimes(6);
    bus.publish(bookMsg("X", true));
    await flush();
    expect(a.of("book.snapshot").map((e) => e.seq)).toEqual([1]);
    expect(b.of("book.snapshot").map((e) => e.seq)).toEqual([1]);
  });

  it("刷新持续失败:每个 symbol 的 [ws] book refresh failed 至多每分钟一行,带上被抑制的次数;失败停了、还有没报的次数,统计定时器补一行汇总", async () => {
    const logs: string[] = [];
    const bookRefresh = vi.fn<RefreshHook>(async () => {
      throw new Error("db down");
    });
    const { connect, flush } = fakeClockHub({ bookRefresh, log: (line) => logs.push(line) });
    const ws = await connect();
    const topics: Topic[] = ["book:X", "book:Y"];
    ws.message({ op: "subscribe", topics });
    // 每秒重订一次(每次订阅重新计数;冷却 1 s 内每个 symbol 至多请一次):两分钟多里每个 symbol 失败一百多次
    for (let s = 0; s < 125; s += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      ws.message({ op: "unsubscribe", topics });
      ws.message({ op: "subscribe", topics });
    }
    await flush();
    const lines = (symbol: string) => logs.filter((l) => l.startsWith(`[ws] book refresh failed for ${symbol}:`));
    const suppressed = (line: string) => Number(/(\d+) (?:earlier )?failures? suppressed/.exec(line)?.[1] ?? 0);
    const calls = (symbol: string) => bookRefresh.mock.calls.filter(([s]) => s === symbol).length;
    expect(calls("X")).toBeGreaterThan(120);
    // 修复前:每次失败一行
    expect(lines("X")).toHaveLength(3); // 第 0、60、120 秒
    expect(lines("X")[0]).toBe("[ws] book refresh failed for X: db down");
    expect(suppressed(lines("X")[1])).toBeGreaterThanOrEqual(55);
    expect(lines("Y")).toHaveLength(3); // 按 symbol 各自限
    // 停止之后:下一轮统计定时器把最后一分钟被抑制的次数补成一行,之后不再有
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(lines("X")).toHaveLength(4);
    expect(lines("X")[3]).toMatch(/^\[ws\] book refresh failed for X: \d+ failures suppressed since the last report \(last error: db down\)$/);
    // 每次失败都有交代:出现在某一行里,或计在某一行的被抑制次数里
    const accounted = lines("X").filter((l) => !l.includes("since the last report")).length + lines("X").reduce((n, l) => n + suppressed(l), 0);
    expect(accounted).toBe(calls("X"));
  });
});

describe("createHub · close", () => {
  useFakeClock();

  it("close(1012) 向所有连接广播 1012,对端回 close 帧即 resolve(不等宽限),清空计数;之后 accept 的连接立即被以 1012 关掉", async () => {
    const { hub, bus, connect, op } = fakeClockHub();
    const a = await connect();
    await op(a, { op: "subscribe", topics: ["book:X"] });
    const b = await connect();
    await op(b, { op: "subscribe", topics: ["trades:X"] });
    let resolved = false;
    void hub.close(1012, "server restarting").then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(5); // FakeWs 在微任务里回 close;close() 每 5 ms 查一次
    expect(resolved).toBe(true);
    expect(a.closedWith).toEqual({ code: 1012, reason: "server restarting" });
    expect(b.closedWith).toEqual({ code: 1012, reason: "server restarting" });
    expect([a.terminated, b.terminated]).toEqual([false, false]);
    expect(hub.stats().connections).toBe(0);
    expect(hub.stats().subscriptions).toBe(0);
    expect(globalThis.__carbadiaPresence?.topics.size).toBe(0);
    const late = new FakeWs();
    hub.accept(late, { userId: null, ip: "local" });
    expect(late.closedWith).toEqual({ code: 1012, reason: expect.any(String) });
    expect(bus.hasSubscribers()).toBe(false); // 已退订总线
  });

  it("客户端不回 close 帧:close() 的截止与逐连接宽限同为 closeGraceMs,到期才 terminate 并 resolve(调大到 2.5 s 不会在 1 s 被截断)", async () => {
    const { hub, connect } = fakeClockHub({ closeGraceMs: 2_500 });
    const ws = await connect();
    ws.close = vi.fn(); // 永不 emit close
    let resolved = false;
    void hub.close(1012, "restart").then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(ws.terminated).toBe(false);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.terminated).toBe(true);
    expect(resolved).toBe(true);
    expect(hub.stats().connections).toBe(0);
  });
});

describe("Origin 与 WsStats 形状", () => {
  it("parseAllowedOrigins:默认 https://cbda.trade,非生产加 http://localhost:*,WS_ALLOWED_ORIGINS 覆盖默认", () => {
    expect(parseAllowedOrigins({}, false)).toEqual(["https://cbda.trade"]);
    expect(parseAllowedOrigins({}, true)).toEqual(["https://cbda.trade", "http://localhost:*"]);
    expect(parseAllowedOrigins({ WS_ALLOWED_ORIGINS: "https://a.example, https://b.example" }, false)).toEqual(["https://a.example", "https://b.example"]);
    expect(parseAllowedOrigins({ WS_ALLOWED_ORIGINS: "https://a.example" }, true)).toEqual(["https://a.example", "http://localhost:*"]);
  });

  it("originAllowed:精确匹配;`:*` 匹配任意端口与无端口;大小写不敏感;前缀相似的域名不放行", () => {
    const allowed = ["https://cbda.trade", "http://localhost:*"];
    expect(originAllowed("https://cbda.trade", allowed)).toBe(true);
    expect(originAllowed("HTTPS://CBDA.TRADE", allowed)).toBe(true);
    expect(originAllowed("https://cbda.trade.evil.example", allowed)).toBe(false);
    expect(originAllowed("http://cbda.trade", allowed)).toBe(false);
    expect(originAllowed("http://localhost:3940", allowed)).toBe(true);
    expect(originAllowed("http://localhost", allowed)).toBe(true);
    expect(originAllowed("http://localhost.evil.example", allowed)).toBe(false);
    expect(originAllowed("http://127.0.0.1:3940", allowed)).toBe(false);
    expect(originAllowed("null", allowed)).toBe(false);
  });

  it("zeroWsStats(false) 与 WsStats 同形、计数全零", () => {
    expect(zeroWsStats(false, 123)).toEqual({
      enabled: false,
      connections: 0,
      subscriptions: 0,
      framesOut: 0,
      bytesOut: 0,
      droppedDeltas: 0,
      resyncs: 0,
      rejected: 0,
      closedByBackpressure: 0,
      snapshotRaces: 0,
      startedAt: 123,
    });
  });
});
