import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOp, ConnectionState, ServerEvent, Topic } from "@/shared";
import { auditRefOf } from "@/shared";
import {
  ACCOUNT_SNAPSHOT_WATCH_MAX,
  WS_BACKOFF_MAX_MS,
  WS_CONNECT_TIMEOUT_MS,
  WS_HIDDEN_GRACE_MS,
  WS_OVERLOAD_MIN_MS,
  WS_PING_INTERVAL_MS,
  WS_RESTART_WAIT_MS,
  WS_RESYNC_TIMEOUT_MS,
  backoffDelay,
  createWsClient,
  jitter,
  type WsClientEvent,
} from "./ws-client";

// 假 WebSocket + vitest 假定时器(不引 jsdom):socket 的 open / message / close 由测试驱动,
// client 发出的 op 落在 sent 里按 JSON 读回;close() 同步触发 onclose(浏览器是异步的,client 对两种时序都安全)。

const SYM = "VCS-FOR-2021";
const BOOK: Topic = `book:${SYM}`;
const TRADES: Topic = `trades:${SYM}`;
const TICKER_ALL: Topic = "ticker:*";

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  url: string;
  sent: string[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("send on non-open socket");
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" } as CloseEvent);
  }
  // ---- 测试助手 ----
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  frame(events: ServerEvent[]) {
    this.onmessage?.({ data: JSON.stringify(events) } as MessageEvent);
  }
  raw(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  hello(userId: string | null = null, bootId?: string) {
    this.open();
    this.frame([{ t: "hello", v: 1, serverTime: Date.now(), heartbeatMs: 25_000, userId, maxTopics: 64, ...(bootId ? { bootId } : {}) }]);
  }
  /** 半开连接:close() 发出关闭帧,但浏览器迟迟不触发 close 事件(死掉的 TCP 路径要等握手超时) */
  hangOnClose() {
    this.close = (code?: number, reason?: string) => {
      this.closeCalls.push({ code, reason });
      this.readyState = 2;
    };
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  /** 连不上:error 后 close 1006 */
  fail() {
    this.readyState = 3;
    this.onerror?.({} as Event);
    this.onclose?.({ code: 1006, reason: "" } as CloseEvent);
  }
  ops(): ClientOp[] {
    return this.sent.map((s) => JSON.parse(s) as ClientOp);
  }
  /** 只看 subscribe / unsubscribe */
  subOps(): ClientOp[] {
    return this.ops().filter((op) => op.op !== "ping");
  }
  /** 取走并清空(不含 ping) */
  takeOps(): ClientOp[] {
    const ops = this.subOps();
    this.sent = [];
    return ops;
  }
}
const wsImpl = FakeSocket as unknown as typeof WebSocket;
const last = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1];

function fakeVisibility(initialHidden = false) {
  let hidden = initialHidden;
  const listeners = new Set<() => void>();
  return {
    visibility: {
      hidden: () => hidden,
      onChange: (l: () => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
    },
    set(value: boolean) {
      hidden = value;
      listeners.forEach((l) => l());
    },
    size: () => listeners.size,
  };
}

function setup(over: Partial<Parameters<typeof createWsClient>[0]> = {}) {
  const onFrame = vi.fn<(f: ServerEvent[]) => void>();
  const onState = vi.fn<(s: ConnectionState) => void>();
  const onEvent = vi.fn<(e: WsClientEvent) => void>();
  const client = createWsClient({ url: "ws://test/ws", onFrame, onState, onEvent, wsImpl, random: () => 0.5, ...over });
  return { client, onFrame, onState, onEvent };
}

const ACCOUNT: Topic = "account";
const CANDLES: Topic = `candles:${SYM}:1m`;
const subscribed = (topic: Topic, seq: number): ServerEvent => ({ t: "subscribed", topic, seq });
const balance = (seq: number): ServerEvent => ({ t: "balance", topic: ACCOUNT, seq, balance: { cashBalance: 100, lockedCash: 0 } });
const fill = (seq: number): ServerEvent => ({
  t: "fill",
  topic: ACCOUNT,
  seq,
  fill: { id: `f${seq}`, orderId: "o1", symbol: SYM, side: "BUY", role: "TAKER", price: 100, quantity: 1, notional: 100, feeCents: 0, ts: seq, auditRef: auditRefOf(`f${seq}`), ledgerRefs: [] },
});
const accountOrder = (seq: number, id: string, status: "OPEN" | "FILLED" = "OPEN"): ServerEvent => ({
  t: "order",
  topic: ACCOUNT,
  seq,
  order: { id, clientOrderId: null, assetId: "a1", symbol: SYM, side: "BUY", type: "LIMIT", price: 100, quantity: 1, filledQuantity: 0, status, avgFillPrice: null, cancelReason: null, createdAt: 1, updatedAt: 1 },
});
const accountPosition = (seq: number, assetId: string, quantity = 5): ServerEvent => ({
  t: "position",
  topic: ACCOUNT,
  seq,
  position: { assetId, symbol: SYM, quantity, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: quantity, retired: 0, lastPrice: 100, marketValue: quantity * 100, averagePurchasePrice: null, unrealisedPnl: null, costBasisStatus: "incomplete_ledger", isScenario: false },
});
const accountTrigger = (seq: number, id = `t${seq}`): ServerEvent => ({
  t: "trigger",
  topic: ACCOUNT,
  seq,
  trigger: {
    id, kind: "ALERT", assetId: "a1", symbol: SYM, direction: "ABOVE", triggerPrice: 100, side: null, orderType: null, limitPrice: null, quantity: null,
    ocoGroupId: null, status: "PENDING", reason: null, orderId: null, firedPrice: null, createdAt: seq, updatedAt: seq, firedAt: null,
  },
});
const accountNotice = (seq: number): ServerEvent => ({
  t: "notice",
  topic: ACCOUNT,
  seq,
  unread: 1,
  notice: { id: `n${seq}`, createdAt: seq, readAt: null, kind: "price_alert", triggerId: "t1", symbol: SYM, direction: "ABOVE", triggerPrice: 100, firedPrice: 101 },
});
const tickerAll = (seq: number): ServerEvent => ({ t: "ticker", topic: TICKER_ALL, seq, symbol: SYM, ticker: { symbol: SYM, lastPrice: 1, ts: seq } });
const accountSnapshotEvents = (onEvent: ReturnType<typeof vi.fn>) =>
  onEvent.mock.calls.map((c) => c[0] as WsClientEvent).filter((e): e is Extract<WsClientEvent, { type: "account-snapshot" }> => e.type === "account-snapshot");
/** onEvent 里的 account-snapshot,集合转成排好序的数组便于比较(挂单与持仓) */
const snapshotsOf = (onEvent: ReturnType<typeof vi.fn>) => accountSnapshotEvents(onEvent).map((e) => ({ orderIds: [...e.orderIds].sort(), assetIds: [...e.assetIds].sort() }));
/** 同上,只取快照里的未完结条件单 id */
const snapshotTriggerIdsOf = (onEvent: ReturnType<typeof vi.fn>) => accountSnapshotEvents(onEvent).map((e) => [...e.triggerIds].sort());
/** onFrame 与 account-snapshot 按调用先后排成一条交付序列:帧写成事件类型数组,快照写成 "snapshot" */
const deliveriesOf = (onFrame: ReturnType<typeof vi.fn>, onEvent: ReturnType<typeof vi.fn>) =>
  [
    ...onFrame.mock.calls.map((c, i) => ({ at: onFrame.mock.invocationCallOrder[i], v: (c[0] as ServerEvent[]).map((e) => e.t) as string[] | string })),
    ...onEvent.mock.calls.flatMap((c, i) => ((c[0] as WsClientEvent).type === "account-snapshot" ? [{ at: onEvent.mock.invocationCallOrder[i], v: "snapshot" }] : [])),
  ]
    .sort((a, b) => a.at - b.at)
    .map((d) => d.v);
const candle = (seq: number): ServerEvent => ({ t: "candle", topic: CANDLES, seq, symbol: SYM, interval: "1m", candle: { t: 60_000, o: 1, h: 1, l: 1, c: 1, v: seq } });
const delta = (seq: number): ServerEvent => ({ t: "book.delta", topic: BOOK, seq, symbol: SYM, bids: [], asks: [], ts: seq });
const snapshot = (seq: number): ServerEvent => ({ t: "book.snapshot", topic: BOOK, seq, symbol: SYM, bids: [], asks: [], ts: seq });
const trades = (seq: number, id = `t${seq}`): ServerEvent => ({
  t: "trades",
  topic: TRADES,
  seq,
  symbol: SYM,
  trades: [{ id, symbol: SYM, price: 100, quantity: 1, takerSide: "BUY", ts: seq, auditRef: auditRefOf(id) }],
});
const states = (onState: ReturnType<typeof vi.fn>) => onState.mock.calls.map((c) => `${(c[0] as ConnectionState).transport}/${(c[0] as ConnectionState).state}`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay / jitter", () => {
  it("1 s → 30 s ×2 封顶;抖动 ±30%", () => {
    const mid = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    expect(backoffDelay(0, () => 0)).toBe(700);
    expect(backoffDelay(0, () => 1)).toBe(1300);
    expect(backoffDelay(9, () => 1)).toBe(Math.round(WS_BACKOFF_MAX_MS * 1.3));
    expect(jitter(1000, () => 0.5)).toBe(1000);
  });
  it("floorMs(1013 之后)抬高下限:抖动向下也不低于它,只向上散开", () => {
    expect(backoffDelay(0, () => 0.5, WS_OVERLOAD_MIN_MS)).toBe(10_000);
    expect(backoffDelay(0, () => 0, WS_OVERLOAD_MIN_MS)).toBe(WS_OVERLOAD_MIN_MS); // 之前是 7 s
    expect(backoffDelay(0, () => 1, WS_OVERLOAD_MIN_MS)).toBe(13_000);
    expect(backoffDelay(5, () => 0.5, WS_OVERLOAD_MIN_MS)).toBe(30_000);
    expect(backoffDelay(5, () => 0, WS_OVERLOAD_MIN_MS)).toBe(21_000); // 基数已高于下限:普通抖动
  });
});

describe("连接与退避", () => {
  it("start 建连并报 connecting;hello 才报 open 并上报 open 事件", () => {
    const { client, onState, onEvent } = setup();
    client.start();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(last().url).toBe("ws://test/ws");
    expect(states(onState)).toEqual(["ws/connecting"]);
    last().open();
    expect(states(onState)).toEqual(["ws/connecting"]);
    last().hello();
    expect(states(onState)).toEqual(["ws/connecting", "ws/open"]);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "open" });
  });

  it("连不上:退避序列 1 s、2 s、4 s…(random 0.5 无抖动),每次上报 connect-failed 的次数", () => {
    const { client, onEvent } = setup();
    client.start();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.instances.length;
      last().fail();
      expect(onEvent).toHaveBeenLastCalledWith({ type: "connect-failed", attempt: i + 1 });
      const t0 = Date.now();
      // 一直推进到新 socket 出现
      while (FakeSocket.instances.length === before) vi.advanceTimersByTime(100);
      delays.push(Date.now() - t0);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
  });

  it("抖动落在 ±30% 内:random 0 → 700 ms,random 1 → 1300 ms", () => {
    for (const [r, expected] of [
      [0, 700],
      [1, 1300],
    ] as const) {
      FakeSocket.instances = [];
      const { client } = setup({ random: () => r });
      client.start();
      last().fail();
      vi.advanceTimersByTime(expected - 1);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);
      client.stop();
    }
  });

  it("hello 归零退避:断开后第一次重连等 1 s", () => {
    const { client } = setup();
    client.start();
    last().fail();
    vi.advanceTimersByTime(1000);
    last().fail();
    vi.advanceTimersByTime(2000);
    last().hello();
    last().serverClose(1006);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it("连接超时(10 s 无 hello)按连不上处理", () => {
    const { client, onEvent } = setup();
    client.start();
    last().open();
    vi.advanceTimersByTime(WS_CONNECT_TIMEOUT_MS);
    expect(last().closeCalls).toHaveLength(1);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "connect-failed", attempt: 1 });
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("没有 WebSocket 实现:每次尝试都算连不上,照常退避", () => {
    // 强制走「无实现」分支:node 22 有全局 WebSocket,先屏蔽再创建 client(构造器在创建时解析)
    const saved = globalThis.WebSocket;
    Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
    const { client, onEvent } = setup({ wsImpl: undefined });
    try {
      client.start();
      expect(onEvent).toHaveBeenCalledWith({ type: "connect-failed", attempt: 1 });
      vi.advanceTimersByTime(1000);
      expect(onEvent).toHaveBeenCalledWith({ type: "connect-failed", attempt: 2 });
    } finally {
      Object.defineProperty(globalThis, "WebSocket", { value: saved, configurable: true, writable: true });
      client.stop();
    }
  });

  it("非 JSON / 非数组的帧忽略,不崩", () => {
    const { client, onFrame } = setup();
    client.start();
    last().hello();
    last().raw("not json");
    last().raw(JSON.stringify({ t: "hello" }));
    expect(onFrame).toHaveBeenCalledTimes(1); // 只有 hello 那一帧
  });
});

describe("订阅与 hello 重订阅", () => {
  it("hello 前订阅只记在集合里;hello 后一次 subscribe 发出全部 topic,无 since", () => {
    const { client } = setup();
    client.subscribe(BOOK);
    client.subscribe(TRADES);
    client.subscribe(TICKER_ALL);
    client.start();
    expect(last().sent).toHaveLength(0);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK, TRADES, TICKER_ALL] }]);
  });

  it("已连上时 subscribe / unsubscribe 立即发送;重复订阅不重复发", () => {
    const { client } = setup();
    client.start();
    last().hello();
    client.subscribe(BOOK);
    client.subscribe(BOOK);
    client.unsubscribe(BOOK);
    client.unsubscribe(BOOK);
    expect(last().subOps()).toEqual([
      { op: "subscribe", topics: [BOOK] },
      { op: "unsubscribe", topics: [BOOK] },
    ]);
  });

  it("重连后的 hello 全量重订阅:trades 带 since = 已收最大 seq,其它不带;subscribed 重设基线", () => {
    const { client, onFrame } = setup();
    client.subscribe(BOOK);
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 3), snapshot(3), subscribed(TRADES, 7), trades(7)]);
    last().frame([delta(4), trades(8)]);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK, TRADES], since: { [TRADES]: 8 } }]);
    // 基线已清空:hub 回放从 subscribed{ seq } 起算;更小的 seq 不再因旧基线被丢
    onFrame.mockClear();
    last().frame([subscribed(TRADES, 8), trades(9), subscribed(BOOK, 2), snapshot(2)]);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["subscribed", "trades", "subscribed", "book.snapshot"]);
  });

  it("stop 清空 seq 表:再 start 的 hello 不带 since(轮询切回 WS 的路径)", () => {
    const { client } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().frame([subscribed(TRADES, 5), trades(5)]);
    client.stop();
    expect(last().closeCalls[0]).toEqual({ code: 1000, reason: "stop" });
    client.start();
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES] }]);
  });
});

describe("序号与缺口", () => {
  it("相等 / +1 应用,更小丢弃;缺口:本条不应用,book 走 unsubscribe + subscribe,回 subscribed + 快照后恢复", () => {
    const { client, onFrame, onEvent } = setup();
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 10), snapshot(10)]);
    last().takeOps();
    onFrame.mockClear();
    last().frame([delta(11), delta(11), delta(9)]); // 11 应用两次(幂等),9 丢弃
    expect(onFrame.mock.calls[0][0].map((e) => (e as { seq: number }).seq)).toEqual([11, 11]);
    onFrame.mockClear();
    last().frame([delta(13), delta(14)]); // 12 缺失
    expect(onFrame).not.toHaveBeenCalled();
    expect(last().takeOps()).toEqual([
      { op: "unsubscribe", topics: [BOOK] },
      { op: "subscribe", topics: [BOOK] },
    ]);
    last().frame([delta(15)]); // pending 期间继续丢,不重复发
    expect(onFrame).not.toHaveBeenCalled();
    expect(last().takeOps()).toEqual([]);
    last().frame([{ t: "unsubscribed", topic: BOOK }, subscribed(BOOK, 15), snapshot(15), delta(16)]);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["unsubscribed", "subscribed", "book.snapshot", "book.delta"]);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "resync", topic: BOOK, ok: true });
  });

  it("trades 缺口带 since = last 重订阅;hub 回放 last+1… 逐条应用", () => {
    const { client, onFrame } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().frame([subscribed(TRADES, 5), trades(5)]);
    last().takeOps();
    onFrame.mockClear();
    last().frame([trades(8)]);
    expect(onFrame).not.toHaveBeenCalled();
    expect(last().takeOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 5 } }]);
    last().frame([subscribed(TRADES, 5), trades(6), trades(7), trades(8), trades(9)]);
    expect(onFrame.mock.calls[0][0].map((e) => (e as { seq: number }).seq)).toEqual([5, 6, 7, 8, 9]);
  });

  it("seq === 0 的事件从不触发缺口检测(轮询 / 无 hub 的 seq 语义)", () => {
    const { client, onFrame } = setup();
    client.subscribe(BOOK);
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().takeOps();
    onFrame.mockClear();
    last().frame([subscribed(BOOK, 0), snapshot(0), delta(0), trades(0), trades(0, "x"), delta(0)]);
    expect(onFrame.mock.calls[0][0]).toHaveLength(6);
    expect(last().takeOps()).toEqual([]);
    // 之后 hub 从 1 起编号:0 之后的 1 是首个基线,不算缺口
    last().frame([delta(1), delta(2)]);
    expect(last().takeOps()).toEqual([]);
    expect(onFrame.mock.calls[1][0]).toHaveLength(2);
  });

  it("hub 在背压下回 subscribed{trades, seq: 0}(新订阅,无基线):resync 走 unsubscribe + subscribe,跨非 1012 重连的 hello 也不带 since", () => {
    const { client } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().takeOps();
    last().frame([subscribed(TRADES, 0)]); // 快照被扣住(hub 记欠快照)
    last().frame([{ t: "resync", topic: TRADES, reason: "backpressure" }]);
    expect(last().takeOps()).toEqual([
      { op: "unsubscribe", topics: [TRADES] },
      { op: "subscribe", topics: [TRADES] },
    ]);
    last().frame([subscribed(TRADES, 0)]); // 又被限流
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES] }]); // 不带 since → hub 给整份快照
  });

  it("hub 在背压下回 subscribed{trades, seq: since}(客户端带来的基线):基线保留,resync 与跨非 1012 重连都带这个 since(hub 回放缺的成交)", () => {
    const { client } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().frame([subscribed(TRADES, 5), trades(5), trades(6), trades(7)]);
    last().takeOps();
    last().frame([{ t: "resync", topic: TRADES, reason: "backpressure" }]);
    expect(last().takeOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 7 } }]);
    // hub 仍在背压:回 subscribed{seq: 7}(不是 current——当成 lastSeq 带着重连,hub 会以为已追平)
    last().frame([subscribed(TRADES, 7)]);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 7 } }]);
  });

  it("服务端 resync{ topic } → 重订阅(trades 带 since);5 s 无 subscribed 上报 resync 失败", () => {
    const { client, onEvent } = setup();
    client.subscribe(BOOK);
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 1), subscribed(TRADES, 4)]);
    last().takeOps();
    last().frame([
      { t: "resync", topic: BOOK, reason: "backpressure" },
      { t: "resync", topic: TRADES, reason: "backpressure" },
    ]);
    expect(last().takeOps()).toEqual([
      { op: "unsubscribe", topics: [BOOK] },
      { op: "subscribe", topics: [BOOK] },
      { op: "subscribe", topics: [TRADES], since: { [TRADES]: 4 } },
    ]);
    last().frame([subscribed(BOOK, 9), snapshot(9)]);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "resync", topic: BOOK, ok: true });
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "resync", topic: TRADES, ok: false });
  });

  it("error{ topic } 结束该 topic 的重订阅等待并计失败;不持有的 topic 的 resync 忽略", () => {
    const { client, onEvent } = setup();
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 1)]);
    last().takeOps();
    last().frame([{ t: "resync", topic: `book:OTHER`, reason: "restart" }]);
    expect(last().takeOps()).toEqual([]);
    last().frame([{ t: "resync", topic: BOOK, reason: "backpressure" }]);
    expect(last().takeOps()).toHaveLength(2);
    last().frame([{ t: "error", code: "unknown_topic", message: "x", topic: BOOK }]);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "resync", topic: BOOK, ok: false });
  });

  it("unsubscribe 后同 topic 的旧事件不再当缺口;断开时 pending 清空不上报", () => {
    const { client, onEvent } = setup();
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 1)]);
    last().frame([delta(5)]); // 缺口 → pending
    client.unsubscribe(BOOK);
    last().serverClose(1006);
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS);
    expect(onEvent.mock.calls.some((c) => c[0].type === "resync")).toBe(false);
  });

  it("account 缺口:仍重订阅一次,但缺口那条与其后的 fill / order 照常到 onFrame(hub 不回放 account,扣住就丢了)", () => {
    const { client, onFrame, onEvent } = setup();
    client.subscribe(ACCOUNT);
    client.start();
    last().hello();
    last().frame([subscribed(ACCOUNT, 3), balance(3)]);
    last().takeOps();
    onFrame.mockClear();
    last().frame([fill(6)]); // 4、5 缺失:这条 fill 之后不会再来
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["fill"]);
    expect(last().takeOps()).toEqual([
      { op: "unsubscribe", topics: [ACCOUNT] },
      { op: "subscribe", topics: [ACCOUNT] },
    ]);
    onFrame.mockClear();
    last().frame([fill(7), fill(5)]); // pending 期间:+1 应用、更小丢弃、不重复发
    expect(onFrame.mock.calls[0][0].map((e) => (e as { seq: number }).seq)).toEqual([7]);
    expect(last().takeOps()).toEqual([]);
    onFrame.mockClear();
    onEvent.mockClear();
    last().frame([{ t: "unsubscribed", topic: ACCOUNT }, subscribed(ACCOUNT, 9), balance(9), fill(10)]);
    expect(onEvent).toHaveBeenCalledWith({ type: "resync", topic: ACCOUNT, ok: true });
    // 重订阅回来的快照同样被识别为边界(这里快照只有 balance:没有挂单也没有持仓),帧在快照末尾切开
    expect(onEvent).toHaveBeenLastCalledWith({ type: "account-snapshot", orderIds: new Set(), assetIds: new Set(), triggerIds: new Set() });
    expect(deliveriesOf(onFrame, onEvent)).toEqual([["unsubscribed", "subscribed", "balance"], "snapshot", ["fill"]]);
  });

  it("candles 缺口:照常应用(按 t upsert 幂等)并重订阅;book 仍扣到 subscribed 为止", () => {
    const { client, onFrame } = setup();
    client.subscribe(CANDLES);
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(CANDLES, 1), subscribed(BOOK, 1), candle(1), snapshot(1)]);
    last().takeOps();
    onFrame.mockClear();
    last().frame([candle(4), delta(4)]); // 两个 topic 各缺 2、3
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["candle"]);
    expect(last().takeOps()).toEqual([
      { op: "unsubscribe", topics: [CANDLES] },
      { op: "subscribe", topics: [CANDLES] },
      { op: "unsubscribe", topics: [BOOK] },
      { op: "subscribe", topics: [BOOK] },
    ]);
  });
});

describe("缺口 / resync 的重订阅:subscribed 之后还要等到该 topic 的快照", () => {
  // hub 在背压下回应重订阅只回 subscribed、快照欠着(再次 owed);只看 subscribed 的话这次重订阅算成功,
  // 连接一直停在 256 KB 附近时就是 owed → resync → 重订阅 → owed 的循环,transport 永远攒不到 2 次失败去降级
  const TICKER: Topic = `ticker:${SYM}`;
  const ticker = (seq: number): ServerEvent => ({ t: "ticker", topic: TICKER, seq, symbol: SYM, ticker: { symbol: SYM, lastPrice: 1, ts: seq } });
  const resync = (topic: Topic): ServerEvent => ({ t: "resync", topic, reason: "backpressure" });
  const unsubscribed = (topic: Topic): ServerEvent => ({ t: "unsubscribed", topic });
  const resyncsOf = (onEvent: ReturnType<typeof vi.fn>) =>
    onEvent.mock.calls.map((c) => c[0] as WsClientEvent).filter((e) => e.type === "resync");
  const resubscribeOps = (topic: Topic): ClientOp[] => [
    { op: "unsubscribe", topics: [topic] },
    { op: "subscribe", topics: [topic] },
  ];

  it("hub 只回 subscribed(限流,快照欠着):不报成功;subscribed 之后 5 s 内没等到快照按一次 resync 失败上报", () => {
    const { client, onEvent } = setup();
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 1), snapshot(1)]);
    last().takeOps();
    last().frame([resync(BOOK)]);
    expect(last().takeOps()).toEqual(resubscribeOps(BOOK));
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS - 1);
    last().frame([unsubscribed(BOOK), subscribed(BOOK, 3)]); // 回执压着 5 s 线到:等快照另起 5 s
    expect(resyncsOf(onEvent)).toEqual([]); // 修复前:这里就报 ok: true
    last().frame([delta(4)]); // 连号的 delta 不是快照(hub 对欠快照的 topic 本不该发,发了也不算恢复)
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS - 1);
    expect(resyncsOf(onEvent)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(resyncsOf(onEvent)).toEqual([{ type: "resync", topic: BOOK, ok: false }]);
    expect(last().takeOps()).toEqual([]); // 超时只上报,不自己再订:等 hub 的下一个 resync(或 transport 降级)
  });

  it("各 topic 的快照形态到了才报成功:book.snapshot、trades(回放的第一条或整份)、ticker、与 subscribed 同 seq 的 balance;candles 没有订阅快照,subscribed 即成功", () => {
    const { client, onEvent } = setup();
    const topics = [BOOK, TRADES, TICKER, ACCOUNT, CANDLES];
    for (const topic of topics) client.subscribe(topic);
    client.start();
    last().hello("u1");
    last().frame([subscribed(BOOK, 1), snapshot(1), subscribed(TRADES, 1), trades(1), subscribed(TICKER, 1), ticker(1), subscribed(ACCOUNT, 1), balance(1), subscribed(CANDLES, 1), candle(1)]);
    last().takeOps();
    last().frame(topics.map(resync));
    expect(last().takeOps()).toEqual([...resubscribeOps(BOOK), { op: "subscribe", topics: [TRADES], since: { [TRADES]: 1 } }, ...resubscribeOps(TICKER), ...resubscribeOps(ACCOUNT), ...resubscribeOps(CANDLES)]);
    last().frame([unsubscribed(BOOK), subscribed(BOOK, 5), subscribed(TRADES, 1), unsubscribed(TICKER), subscribed(TICKER, 5), unsubscribed(ACCOUNT), subscribed(ACCOUNT, 5), unsubscribed(CANDLES), subscribed(CANDLES, 5)]);
    expect(resyncsOf(onEvent)).toEqual([{ type: "resync", topic: CANDLES, ok: true }]);
    last().frame([balance(6)]); // 推进序号的 balance 是增量,不是快照
    expect(resyncsOf(onEvent)).toHaveLength(1);
    last().frame([snapshot(5), trades(2), ticker(5), balance(6)]); // 快照不推进序号:balance 与刚到的基线同 seq
    expect(resyncsOf(onEvent)).toEqual([
      { type: "resync", topic: CANDLES, ok: true },
      { type: "resync", topic: BOOK, ok: true },
      { type: "resync", topic: TRADES, ok: true },
      { type: "resync", topic: TICKER, ok: true },
      { type: "resync", topic: ACCOUNT, ok: true },
    ]);
    vi.advanceTimersByTime(2 * WS_RESYNC_TIMEOUT_MS); // 定时器都已清掉
    expect(resyncsOf(onEvent)).toHaveLength(5);
  });

  it("快照没来之前 hub 又对该 topic 发 resync(重订阅又被限流、topic 又欠下):立即按一次失败上报并再重订阅,不等 5 s", () => {
    const { client, onEvent } = setup();
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(BOOK, 1), snapshot(1)]);
    last().takeOps();
    last().frame([resync(BOOK)]);
    last().takeOps();
    last().frame([unsubscribed(BOOK), subscribed(BOOK, 3)]);
    last().frame([resync(BOOK)]);
    expect(resyncsOf(onEvent)).toEqual([{ type: "resync", topic: BOOK, ok: false }]);
    expect(last().takeOps()).toEqual(resubscribeOps(BOOK));
    last().frame([unsubscribed(BOOK), subscribed(BOOK, 3), snapshot(3)]);
    expect(resyncsOf(onEvent)).toEqual([
      { type: "resync", topic: BOOK, ok: false },
      { type: "resync", topic: BOOK, ok: true },
    ]);
  });

  it("等快照时出现序号缺口(trades 回放不连号):按一次失败上报,带 since 再订", () => {
    const { client, onEvent } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello();
    last().frame([subscribed(TRADES, 4), trades(4)]);
    last().takeOps();
    last().frame([resync(TRADES)]);
    expect(last().takeOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 4 } }]);
    last().frame([subscribed(TRADES, 4), trades(7)]); // 5、6 缺
    expect(resyncsOf(onEvent)).toEqual([{ type: "resync", topic: TRADES, ok: false }]);
    expect(last().takeOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 4 } }]);
  });

  it("首次订阅(hello 后、不是重订阅)只回 subscribed 不算失败:没有在等的重订阅就不上报", () => {
    const { client, onEvent } = setup();
    client.subscribe(TICKER);
    client.start();
    last().hello();
    last().frame([subscribed(TICKER, 0)]); // hub 没有这个标的的最后值:只回 subscribed,客户端保留 REST 值
    vi.advanceTimersByTime(2 * WS_RESYNC_TIMEOUT_MS);
    expect(resyncsOf(onEvent)).toEqual([]);
  });
});

describe("account 订阅快照的边界(account-snapshot 事件)", () => {
  function connected() {
    const ctx = setup();
    ctx.client.subscribe(ACCOUNT);
    ctx.client.subscribe(TICKER_ALL);
    ctx.client.start();
    last().hello("u1");
    last().takeOps();
    ctx.onFrame.mockClear();
    ctx.onEvent.mockClear();
    return ctx;
  }

  it("subscribed 之后同 seq 的 balance → order… → position… 是快照;帧交给 onFrame 之后上报快照里的 id", () => {
    const { onFrame, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), accountOrder(3, "o2"), accountPosition(3, "a1")]);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["subscribed", "balance", "order", "order", "position"]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1", "o2"], assetIds: ["a1"] }]);
    const snapshotCall = onEvent.mock.calls.findIndex((c) => (c[0] as WsClientEvent).type === "account-snapshot");
    expect(onFrame.mock.invocationCallOrder[0]).toBeLessThan(onEvent.mock.invocationCallOrder[snapshotCall]);
  });

  it("快照晚于 subscribed 一帧或几帧到(hub 异步查询)也能识别;seq 为 0(该用户进程启动以来没有事件)同样", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 0)]);
    last().frame([tickerAll(1)]);
    expect(snapshotsOf(onEvent)).toEqual([]);
    last().frame([balance(0), accountOrder(0, "o1")]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: [] }]);
  });

  it("快照之前的增量碰过的 id 不并入收口集合:快照比它们新(hub 查询期间有该用户的事件就重查),快照里没有就是已经没了", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3)]);
    last().frame([accountOrder(4, "o-new"), balance(5), accountPosition(6, "a-new")]); // 增量:每条推进序号,不是快照
    expect(snapshotsOf(onEvent)).toEqual([]);
    last().frame([balance(6), accountOrder(6, "o1"), accountPosition(6, "a1")]); // 快照带最新的 seq 6,不推进
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: ["a1"] }]);
  });

  it("跨 bundle 逆序送达的持仓(先到 qty 0、后到更旧的 qty 5):快照里没有 a1,收口集合也没有,旧值不会被留下", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3)]);
    last().frame([accountPosition(4, "a1", 0), accountPosition(5, "a1", 5)]);
    last().frame([balance(5), accountOrder(5, "o1")]); // 快照读在卖光之后:只含 quantity > 0 的持仓,没有 a1
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: [] }]);
  });

  it("窗口里已终结(FILLED)的单不进收口集合:快照的查询早于成交、仍把它当挂单时,收口会把它移除", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3)]);
    last().frame([accountOrder(4, "o-done", "FILLED"), accountOrder(5, "o-open")]);
    last().frame([balance(5), accountOrder(5, "o-done"), accountOrder(5, "o-open"), accountOrder(5, "o1")]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o-open", "o1"], assetIds: [] }]);
  });

  it("快照未到就又收到 subscribed{account}(缺口 / resync 重订阅):沿用已开的窗口,之前记下的已终结挂单不丢", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), accountOrder(4, "o-new"), accountOrder(5, "o-gone", "FILLED")]);
    last().frame([subscribed(ACCOUNT, 5)]);
    last().frame([balance(5), accountOrder(5, "o-gone"), accountOrder(5, "o1")]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: [] }]);
  });

  it("快照的最后一段是同 seq 的 trigger(未完结的条件单,hub 排在持仓之后):它们属于快照,id 进 triggerIds,帧交给 onFrame 之后才上报", () => {
    const { onFrame, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), accountPosition(3, "a1"), accountTrigger(3, "t-a"), accountTrigger(3, "t-b")]);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["subscribed", "balance", "order", "position", "trigger", "trigger"]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: ["a1"] }]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([["t-a", "t-b"]]);
    expect(deliveriesOf(onFrame, onEvent)).toEqual([["subscribed", "balance", "order", "position", "trigger", "trigger"], "snapshot"]);
  });

  it("没有未完结条件单的快照:triggerIds 是空集合(收口会把本地的条件单清掉);只有 balance 的快照同样", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1")]);
    last().frame([subscribed(ACCOUNT, 4), balance(4)]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([[], []]);
  });

  it("没有订单与持仓、只有条件单的快照也认(balance → trigger…)", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountTrigger(3, "t-a")]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: [], assetIds: [] }]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([["t-a"]]);
  });

  it("推进序号的 trigger 是增量:不进 triggerIds,把快照结束,快照之后同一帧里的 order 与它一起在上报之后才交出;序号照常推进(没有缺口、不重订阅)", () => {
    const { onFrame, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), accountTrigger(3, "t-snap"), accountTrigger(4, "t-live"), accountOrder(5, "o-later")]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([["t-snap"]]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: [] }]);
    expect(deliveriesOf(onFrame, onEvent)).toEqual([["subscribed", "balance", "order", "trigger"], "snapshot", ["trigger", "order"]]);
    last().frame([accountTrigger(6, "t-next")]);
    expect(onFrame.mock.calls.at(-1)?.[0].map((e) => e.t)).toEqual(["trigger"]);
    expect(last().takeOps()).toEqual([]);
  });

  it("订阅之后、快照之前到达的条件单增量(比快照旧)不并入 triggerIds:快照里没有就是已经没了", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3)]);
    last().frame([accountTrigger(4, "t-seen-before"), accountTrigger(5, "t-also")]);
    expect(snapshotsOf(onEvent)).toEqual([]);
    last().frame([balance(5), accountOrder(5, "o1"), accountTrigger(5, "t-a")]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([["t-a"]]);
  });

  it("notice 不是快照的行(通知不进快照):出现处快照结束;它与增量一样按序号放行并推进序号", () => {
    const { onFrame, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), accountNotice(4), accountTrigger(5, "t-live"), accountOrder(6, "o-later")]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: [] }]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([[]]);
    expect(deliveriesOf(onFrame, onEvent)).toEqual([["subscribed", "balance", "order"], "snapshot", ["notice", "trigger", "order"]]);
    last().frame([accountNotice(7)]);
    expect(onFrame.mock.calls.at(-1)?.[0].map((e) => e.t)).toEqual(["notice"]);
    expect(last().takeOps()).toEqual([]);
  });

  it("同一帧里两份快照各带各的条件单:各自的 triggerIds,不串", () => {
    const { onEvent } = connected();
    last().frame([
      subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), accountTrigger(3, "t-1"),
      { t: "unsubscribed", topic: ACCOUNT },
      subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o2"), accountTrigger(3, "t-2"), accountTrigger(3, "t-3"),
    ]);
    expect(snapshotTriggerIdsOf(onEvent)).toEqual([["t-1"], ["t-2", "t-3"]]);
  });

  it("快照在第一条不属于它的事件处结束,帧在那里切开:快照及之前的部分交给 onFrame → 上报快照 → 其余部分再交给 onFrame", () => {
    // 同一合帧里跟在快照后面的增量(比快照新,如 o-later)不进收口集合,但要等收口之后才交给 batcher:
    // MarketProvider 收口前会 flush batcher,若整帧一起交出去,o-later 会先落进 store 再被这次收口删掉
    const { onFrame, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), fill(4), accountOrder(4, "o-later")]);
    last().frame([subscribed(ACCOUNT, 4), balance(4), accountOrder(4, "o2"), tickerAll(1), accountOrder(4, "o-after-ticker")]);
    expect(snapshotsOf(onEvent)).toEqual([
      { orderIds: ["o1"], assetIds: [] },
      { orderIds: ["o2"], assetIds: [] },
    ]);
    expect(deliveriesOf(onFrame, onEvent)).toEqual([
      ["subscribed", "balance", "order"],
      "snapshot",
      ["fill", "order"],
      ["subscribed", "balance", "order"],
      "snapshot",
      ["ticker", "order"],
    ]);
  });

  it("同一帧里两份快照(首次订阅的与 resync 重订阅的):按各自的末尾切成三段,每份快照紧跟在自己那段之后上报", () => {
    const { onFrame, onEvent } = connected();
    last().frame([
      subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1"), accountPosition(3, "a1"),
      { t: "unsubscribed", topic: ACCOUNT },
      subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o2"), accountPosition(3, "a2"),
      fill(4),
    ]);
    expect(snapshotsOf(onEvent)).toEqual([
      { orderIds: ["o1"], assetIds: ["a1"] },
      { orderIds: ["o2"], assetIds: ["a2"] },
    ]);
    expect(deliveriesOf(onFrame, onEvent)).toEqual([
      ["subscribed", "balance", "order", "position"],
      "snapshot",
      ["unsubscribed", "subscribed", "balance", "order", "position"],
      "snapshot",
      ["fill"],
    ]);
  });

  it("快照在帧尾结束时整帧一次交出(不切出空段)", () => {
    const { onFrame, onEvent } = connected();
    last().frame([tickerAll(1), subscribed(ACCOUNT, 3), balance(3), accountOrder(3, "o1")]);
    expect(deliveriesOf(onFrame, onEvent)).toEqual([["ticker", "subscribed", "balance", "order"], "snapshot"]);
  });

  it("没有 subscribed{account} 在前就不认快照:推进序号的 balance 增量、hub 不发快照时的后续事件都不上报", () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3)]); // hub 没有快照来源:只有 subscribed
    last().frame([balance(4), accountOrder(5, "o1"), balance(6)]);
    expect(snapshotsOf(onEvent)).toEqual([]);
  });

  it("快照被当旧事件丢掉时(seq 小于已收的增量)不上报,也不交给 onFrame", () => {
    const { onFrame, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), accountOrder(4, "o-new")]);
    onFrame.mockClear();
    last().frame([balance(3), accountOrder(3, "o1")]);
    expect(onFrame).not.toHaveBeenCalled();
    expect(snapshotsOf(onEvent)).toEqual([]);
  });

  it("每次 subscribed{account} 只认一份快照;客户端退订 account 后不再认", () => {
    const { client, onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 3), balance(3)]);
    last().frame([balance(3)]); // 同 seq 的重复:窗口已关闭
    expect(snapshotsOf(onEvent)).toHaveLength(1);
    last().frame([subscribed(ACCOUNT, 3)]);
    client.unsubscribe(ACCOUNT);
    last().frame([balance(3)]);
    expect(snapshotsOf(onEvent)).toHaveLength(1);
  });

  it(`快照迟迟不来、记下的已终结挂单超过 ${ACCOUNT_SNAPSHOT_WATCH_MAX} 个:放弃这次收口(不上报),不无限记账`, () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 0)]);
    last().frame(Array.from({ length: ACCOUNT_SNAPSHOT_WATCH_MAX + 1 }, (_, i) => accountOrder(i + 1, `o${i}`, "FILLED")));
    last().frame([balance(ACCOUNT_SNAPSHOT_WATCH_MAX + 1), accountOrder(ACCOUNT_SNAPSHOT_WATCH_MAX + 1, "o1")]);
    expect(snapshotsOf(onEvent)).toEqual([]);
  });

  it(`窗口里开着的单与持仓不记账:超过 ${ACCOUNT_SNAPSHOT_WATCH_MAX} 条也照常识别快照`, () => {
    const { onEvent } = connected();
    last().frame([subscribed(ACCOUNT, 0)]);
    last().frame(Array.from({ length: ACCOUNT_SNAPSHOT_WATCH_MAX + 1 }, (_, i) => (i % 2 ? accountOrder(i + 1, `o${i}`) : accountPosition(i + 1, `a${i}`))));
    last().frame([balance(ACCOUNT_SNAPSHOT_WATCH_MAX + 1), accountOrder(ACCOUNT_SNAPSHOT_WATCH_MAX + 1, "o1")]);
    expect(snapshotsOf(onEvent)).toEqual([{ orderIds: ["o1"], assetIds: [] }]);
  });
});

describe("关闭码", () => {
  it("1008 不重连:报 offline 与 policy,没有新 socket", () => {
    const { client, onState, onEvent } = setup();
    client.start();
    last().hello();
    last().serverClose(1008, "policy");
    expect(onEvent).toHaveBeenLastCalledWith({ type: "policy", code: 1008, reason: "policy" });
    expect(states(onState).at(-1)).toBe("ws/offline");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("1009(帧过大)按 1008 处理", () => {
    const { client, onEvent } = setup();
    client.start();
    last().hello();
    last().serverClose(1009);
    expect(onEvent).toHaveBeenLastCalledWith({ type: "policy", code: 1009, reason: "" });
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("1012 服务重启:等 2–5 s(random 0 → 2 s,random 1 → 5 s)再连,不计失败", () => {
    for (const [r, expected] of [
      [0, WS_RESTART_WAIT_MS[0]],
      [1, WS_RESTART_WAIT_MS[1]],
    ] as const) {
      FakeSocket.instances = [];
      const { client, onEvent } = setup({ random: () => r });
      client.start();
      last().hello();
      last().serverClose(1012);
      vi.advanceTimersByTime(expected - 1);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);
      expect(onEvent.mock.calls.some((c) => c[0].type === "connect-failed")).toBe(false);
      client.stop();
    }
  });

  it("1012 清空 seq 表:重连后的 hello 不带 since(重启后 seq 归零);从小 seq 起的事件不会被当旧的丢掉", () => {
    const { client, onFrame } = setup({ random: () => 0 });
    client.subscribe(TRADES);
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().frame([subscribed(TRADES, 5), trades(5), trades(6), subscribed(BOOK, 9), snapshot(9)]);
    last().serverClose(1012);
    vi.advanceTimersByTime(WS_RESTART_WAIT_MS[0]);
    expect(FakeSocket.instances).toHaveLength(2);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES, BOOK] }]);
    onFrame.mockClear();
    last().frame([subscribed(TRADES, 1), trades(1, "r1"), subscribed(BOOK, 1), snapshot(1)]);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["subscribed", "trades", "subscribed", "book.snapshot"]);
  });

  it("1013 过载:退避从 10 s 起(random 0 的向下抖动也不缩短),之后连不上继续 ≥ 10 s", () => {
    const { client } = setup({ random: () => 0 });
    client.start();
    last().hello();
    last().serverClose(1013);
    vi.advanceTimersByTime(WS_OVERLOAD_MIN_MS - 1);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    last().fail();
    vi.advanceTimersByTime(WS_OVERLOAD_MIN_MS - 1);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it("1000 / 1006 等其它关闭:普通退避重连,状态为 connecting", () => {
    const { client, onState } = setup();
    client.start();
    last().hello();
    last().serverClose(1000);
    expect(states(onState).at(-1)).toBe("ws/connecting");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe("心跳", () => {
  it("hello 后每 20 s 发 ping{ t0 };pong 记 rttMs", () => {
    const { client, onState } = setup();
    client.start();
    last().hello();
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS - 1);
    expect(last().ops().filter((op) => op.op === "ping")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const ping = last().ops().find((op) => op.op === "ping") as { op: "ping"; t0: number };
    expect(ping.t0).toBe(Date.now());
    vi.advanceTimersByTime(37);
    last().frame([{ t: "pong", t0: ping.t0, serverTime: Date.now() }]);
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ transport: "ws", state: "open", rttMs: 37 });
  });

  it("连续 2 次无 pong 主动 close 并重连;有 pong 则继续", () => {
    const { client } = setup();
    client.start();
    last().hello();
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS); // ping 1
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS); // 无 pong → missed 1,ping 2
    expect(last().closeCalls).toHaveLength(0);
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS); // 无 pong → missed 2 → close
    expect(last().closeCalls).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    last().hello();
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS);
    const ping = last().ops().find((op) => op.op === "ping") as { op: "ping"; t0: number };
    last().frame([{ t: "pong", t0: ping.t0, serverTime: Date.now() }]);
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS * 2);
    expect(last().closeCalls).toHaveLength(0);
  });

  it("半开连接:看门狗不等浏览器的 close 事件 —— 立刻离开 open(徽标不再显示 Live)、按退避重连,旧 socket 迟到的 close 被忽略", () => {
    const { client, onState } = setup();
    client.subscribe(BOOK);
    client.start();
    last().hello();
    const dead = last();
    dead.hangOnClose();
    vi.advanceTimersByTime(WS_PING_INTERVAL_MS * 3); // ping 1、无 pong ×2 → 看门狗
    expect(dead.closeCalls).toHaveLength(1);
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ transport: "ws", state: "connecting", rttMs: null });
    expect(dead.onmessage).toBeNull(); // 旧 socket 的帧不再进来
    vi.advanceTimersByTime(1000); // 退避 1 s(random 0.5 无抖动)
    expect(FakeSocket.instances).toHaveLength(2);
    const fresh = last();
    fresh.hello();
    expect(fresh.subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
    // 60 s 后旧 socket 的 close 事件终于到了:不影响新连接
    dead.onclose?.({ code: 1006, reason: "" } as CloseEvent);
    vi.advanceTimersByTime(5_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(onState.mock.calls.at(-1)?.[0]).toMatchObject({ transport: "ws", state: "open" });
  });

  it("lastMessageAt 每帧更新,但对外每秒最多通知一次", () => {
    const { client, onState } = setup();
    client.start();
    last().hello();
    const n = onState.mock.calls.length;
    last().frame([delta(0)]);
    last().frame([delta(0)]);
    vi.advanceTimersByTime(999);
    expect(onState.mock.calls.length).toBe(n);
    vi.advanceTimersByTime(1);
    expect(onState.mock.calls.length).toBe(n + 1);
    expect(onState.mock.calls.at(-1)?.[0].lastMessageAt).toBe(Date.now() - 1000);
  });
});

describe("身份:hello.userId 与账户 store 不一致、account 被拒", () => {
  const mismatches = (onEvent: ReturnType<typeof vi.fn>) =>
    onEvent.mock.calls.map((c) => c[0] as WsClientEvent).filter((e) => e.type === "identity-mismatch");

  it("hello 的身份与 store 的已知身份不同(别的标签页换了人,本页重连时 cookie 已是 B):不订 account、上报一次;其它 topic 照订", () => {
    const { client, onEvent } = setup({ expectedUserId: () => "u-a" });
    client.subscribe(BOOK);
    client.subscribe(ACCOUNT);
    client.start();
    last().hello("u-b");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
    expect(mismatches(onEvent)).toEqual([{ type: "identity-mismatch", userId: "u-b", reason: "hello" }]);
    // 这条连接上再订 account 也不发(B 的账户数据不能落进 A 的 store),也不重复上报
    client.unsubscribe(ACCOUNT);
    client.subscribe(ACCOUNT);
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
    expect(mismatches(onEvent)).toHaveLength(1);
  });

  it("store 换成 B 之后(hydrate → 重连)hello 一致:account 照常订上", () => {
    let expected: string | null | undefined = "u-a";
    const { client, onEvent } = setup({ expectedUserId: () => expected });
    client.subscribe(ACCOUNT);
    client.start();
    last().hello("u-b");
    expected = "u-b";
    client.reconnect();
    last().hello("u-b");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [ACCOUNT] }]);
    expect(mismatches(onEvent)).toHaveLength(1);
  });

  it("别的标签页登出:本页的 store 还是 A、重连的 hello 是匿名 → 上报;store 是确认的 anon、hello 是 B(别处登录了)→ 同样上报", () => {
    const a = setup({ expectedUserId: () => "u-a" });
    a.client.subscribe(ACCOUNT);
    a.client.start();
    last().hello(null);
    expect(last().subOps()).toEqual([]);
    expect(mismatches(a.onEvent)).toEqual([{ type: "identity-mismatch", userId: null, reason: "hello" }]);
    const b = setup({ expectedUserId: () => null });
    b.client.subscribe(BOOK);
    b.client.start();
    last().hello("u-b");
    expect(mismatches(b.onEvent)).toEqual([{ type: "identity-mismatch", userId: "u-b", reason: "hello" }]);
  });

  it("身份未知(store 还在 idle / loading)或没接 expectedUserId:不比对、不上报,照旧订阅", () => {
    const unknown = setup({ expectedUserId: () => undefined });
    unknown.client.subscribe(ACCOUNT);
    unknown.client.start();
    last().hello("u-b");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [ACCOUNT] }]);
    expect(mismatches(unknown.onEvent)).toEqual([]);
    const plain = setup();
    plain.client.subscribe(ACCOUNT);
    plain.client.start();
    last().hello("u-b");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [ACCOUNT] }]);
    expect(mismatches(plain.onEvent)).toEqual([]);
  });

  it("hello 之后才就绪的身份与连接的身份不同:订 account 时比对,不发并上报", () => {
    const store: { id: string | null | undefined } = { id: undefined };
    const { client, onEvent } = setup({ expectedUserId: () => store.id });
    client.start();
    last().hello("u-b");
    store.id = "u-a"; // hydrate 在 hello 之后才回来
    client.subscribe(ACCOUNT);
    expect(last().subOps()).toEqual([]);
    expect(mismatches(onEvent)).toEqual([{ type: "identity-mismatch", userId: "u-b", reason: "hello" }]);
  });

  it("终端里登录后重连、旧连接的 close 事件还没到时订 account:只记下,不拿旧连接(匿名)的身份比对、不上报;新连接 hello 一致后照常订上(P1-25c 复审)", () => {
    const store: { id: string | null | undefined } = { id: null };
    const { client, onEvent } = setup({ expectedUserId: () => store.id });
    client.start();
    const old = last();
    old.hello(null);
    old.hangOnClose(); // 关闭握手要一会儿:close() 发出了,close 事件还没来
    store.id = "u1"; // LoginGate 的 demo 登录 → hydrate 就绪
    client.reconnect(); // becomeReady 请求重连
    client.subscribe(ACCOUNT); // 随后 MarketProvider 的 meId effect
    expect(mismatches(onEvent)).toEqual([]); // 修复前:u1 ≠ 旧连接的 null → 假的 identity-mismatch → 多一次 /api/auth/me
    expect(old.subOps()).toEqual([]);
    old.serverClose(1000);
    expect(FakeSocket.instances.at(-1)).not.toBe(old); // 旧连接关掉才连新的
    last().hello("u1");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [ACCOUNT] }]);
    expect(mismatches(onEvent)).toEqual([]);
  });

  it("account 收到 error unauthorized(连接是匿名的):上报,关掉快照观察窗口;别的 topic 的 unauthorized 不算", () => {
    const { client, onEvent } = setup();
    client.subscribe(ACCOUNT);
    client.start();
    last().hello(null);
    last().frame([{ t: "error", code: "unauthorized", message: "login required", topic: ACCOUNT }]);
    expect(mismatches(onEvent)).toEqual([{ type: "identity-mismatch", userId: null, reason: "unauthorized" }]);
    last().frame([{ t: "error", code: "unauthorized", message: "x", topic: BOOK }]);
    expect(mismatches(onEvent)).toHaveLength(1);
  });
});

describe("hello.bootId:服务端重启过(不一定先发了 1012,例如进程崩溃)", () => {
  it("与上一次连接的 bootId 不同:清掉全部 lastSeq,重订阅不带 since;相同则照常带", () => {
    const { client, onFrame } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello(null, "boot-1");
    last().frame([subscribed(TRADES, 40), trades(40)]);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello(null, "boot-1");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 40 } }]);
    last().frame([subscribed(TRADES, 41), trades(41)]);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello(null, "boot-2");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES] }]);
    // 重启后 seq 从 1 起:不会被当旧事件丢掉
    onFrame.mockClear();
    last().frame([subscribed(TRADES, 1), trades(1)]);
    expect(onFrame.mock.calls[0][0].map((e) => e.t)).toEqual(["subscribed", "trades"]);
  });

  it("旧 hub 不带 bootId(或第一次连接):无从比较,沿用原来的 since 规则", () => {
    const { client } = setup();
    client.subscribe(TRADES);
    client.start();
    last().hello(null);
    last().frame([subscribed(TRADES, 9), trades(9)]);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello(null, "boot-9");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [TRADES], since: { [TRADES]: 9 } }]);
  });
});

describe("可见性", () => {
  it("hidden 超过 30 s 退订市场 topic(account 保留),回前台重订阅;30 s 内回来什么都不发", () => {
    const vis = fakeVisibility();
    const { client } = setup({ visibility: vis.visibility });
    client.subscribe(BOOK);
    client.subscribe(TRADES);
    client.subscribe("account");
    client.start();
    last().hello();
    last().takeOps();
    vis.set(true);
    vi.advanceTimersByTime(WS_HIDDEN_GRACE_MS - 1);
    vis.set(false);
    expect(last().takeOps()).toEqual([]);
    vis.set(true);
    vi.advanceTimersByTime(WS_HIDDEN_GRACE_MS);
    expect(last().takeOps()).toEqual([{ op: "unsubscribe", topics: [BOOK, TRADES] }]);
    // 暂停期间新订阅的市场 topic 只记不发;account 照发
    client.subscribe(TICKER_ALL);
    client.subscribe("account");
    expect(last().takeOps()).toEqual([]);
    vis.set(false);
    expect(last().takeOps()).toEqual([{ op: "subscribe", topics: [BOOK, TRADES, TICKER_ALL] }]);
  });

  it("暂停期间断线重连:hello 只订 account,回前台再订市场 topic", () => {
    const vis = fakeVisibility();
    const { client } = setup({ visibility: vis.visibility });
    client.subscribe(BOOK);
    client.subscribe("account");
    client.start();
    last().hello();
    vis.set(true);
    vi.advanceTimersByTime(WS_HIDDEN_GRACE_MS);
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: ["account"] }]);
    vis.set(false);
    expect(last().subOps().at(-1)).toEqual({ op: "subscribe", topics: [BOOK] });
  });

  it("start 时已在后台也计时;stop 解除可见性监听", () => {
    const vis = fakeVisibility(true);
    const { client } = setup({ visibility: vis.visibility });
    client.subscribe(BOOK);
    client.start();
    last().hello();
    last().takeOps();
    vi.advanceTimersByTime(WS_HIDDEN_GRACE_MS);
    expect(last().takeOps()).toEqual([{ op: "unsubscribe", topics: [BOOK] }]);
    expect(vis.size()).toBe(1);
    client.stop();
    expect(vis.size()).toBe(0);
  });
});

describe("stop / reconnect", () => {
  it("stop 关 1000、报 none/offline、取消重连定时器;之后 subscribe 不抛", () => {
    const { client, onState } = setup();
    client.start();
    last().fail();
    client.stop();
    expect(states(onState).at(-1)).toBe("none/offline");
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(() => client.subscribe(BOOK)).not.toThrow();
    client.stop(); // 幂等
  });

  it("reconnect 关 1000 并立即新建连接,订阅集保留;未 start 时等于 start", () => {
    const { client } = setup();
    client.subscribe(BOOK);
    client.reconnect();
    expect(FakeSocket.instances).toHaveLength(1);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
    client.reconnect();
    expect(FakeSocket.instances[0].closeCalls[0]).toEqual({ code: 1000, reason: "reconnect" });
    expect(FakeSocket.instances).toHaveLength(2);
    last().hello("u1");
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
  });

  it("等待退避期间 reconnect 立即建连", () => {
    const { client } = setup();
    client.start();
    last().fail();
    client.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
  });
});
