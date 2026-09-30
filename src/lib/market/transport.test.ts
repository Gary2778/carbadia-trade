import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOp, ConnectionState, ServerEvent, Topic } from "@/shared";
import { WS_CONNECT_FAILURES_TO_POLL, WS_PROBE_INTERVAL_MS, WS_RESYNC_FAILURES_TO_POLL, createTransportManager, resolveWsUrl, transportModeForServer, transportModeForStartMode, transportModeFromEnv } from "./transport";
import { WS_RESYNC_TIMEOUT_MS } from "./ws-client";

// 传输管理器的状态机:3 次连不上 / 2 次 resync 失败 / 1008 → poll;每 30 s 后台试 WS,hello 即切回;
// 探测期间中间态不外露;reconnect 在两种模式下的行为;强制 poll 从不建 socket。假 socket 同 ws-client.test.ts。

const SYM = "VCS-FOR-2021";
const BOOK: Topic = `book:${SYM}`;

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closeCalls: { code?: number; reason?: string }[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor() {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" } as CloseEvent);
  }
  frame(events: ServerEvent[]) {
    this.onmessage?.({ data: JSON.stringify(events) } as MessageEvent);
  }
  hello() {
    this.readyState = 1;
    this.frame([{ t: "hello", v: 1, serverTime: Date.now(), heartbeatMs: 25_000, userId: null, maxTopics: 64 }]);
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  fail() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" } as CloseEvent);
  }
  subOps(): ClientOp[] {
    return this.sent.map((s) => JSON.parse(s) as ClientOp).filter((op) => op.op !== "ping");
  }
}
const wsImpl = FakeSocket as unknown as typeof WebSocket;
const last = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1];
const count = (): number => FakeSocket.instances.length;

function setup(mode: "ws" | "poll" = "ws") {
  const onState = vi.fn<(s: ConnectionState) => void>();
  const onFrame = vi.fn();
  const manager = createTransportManager({ mode, wsUrl: "ws://test/ws", onState, onFrame, ws: { wsImpl, random: () => 0.5 } });
  return { manager, onState, onFrame };
}
const states = (onState: ReturnType<typeof vi.fn>) => onState.mock.calls.map((c) => `${(c[0] as ConnectionState).transport}/${(c[0] as ConnectionState).state}`);

/** 让当前 socket 连不上并推进到下一次尝试出现(或到 maxMs 为止) */
function failAndAdvance(maxMs = 60_000) {
  const before = count();
  last().fail();
  let waited = 0;
  while (count() === before && waited < maxMs) {
    vi.advanceTimersByTime(100);
    waited += 100;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000_000);
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("resolveWsUrl / transportModeFromEnv", () => {
  it("默认同源 /ws,https → wss;NEXT_PUBLIC_WS_URL 覆盖", () => {
    expect(resolveWsUrl(undefined, { protocol: "http:", host: "localhost:3964" })).toBe("ws://localhost:3964/ws");
    expect(resolveWsUrl("", { protocol: "https:", host: "cbda.trade" })).toBe("wss://cbda.trade/ws");
    expect(resolveWsUrl(" wss://mock.local/ws ", { protocol: "http:", host: "x" })).toBe("wss://mock.local/ws");
  });
  it("只有 poll 才是 poll", () => {
    expect(transportModeFromEnv("poll")).toBe("poll");
    expect(transportModeFromEnv("ws")).toBe("ws");
    expect(transportModeFromEnv(undefined)).toBe("ws");
    expect(transportModeFromEnv("POLL")).toBe("ws");
  });
  it("服务端的 START_MODE:next(回滚,next start 没有 /ws)→ poll;缺省、custom 或其它值 → undefined(按构建期模式)", () => {
    expect(transportModeForStartMode("next")).toBe("poll");
    expect(transportModeForStartMode(undefined)).toBeUndefined();
    expect(transportModeForStartMode("custom")).toBeUndefined();
    expect(transportModeForStartMode("")).toBeUndefined();
    expect(transportModeForStartMode("NEXT")).toBeUndefined(); // 与 docker-entrypoint.sh 的 [ "$START_MODE" = "next" ] 同一判断
  });
  it("页面的服务端提示:START_MODE=next、本进程没有 hub(start:plain / dev:plain)或 hub 关着(WS_DISABLED)→ poll;hub 开着 → undefined;/ws 指到别处时只看 START_MODE", () => {
    const on = { enabled: true };
    const off = { enabled: false };
    expect(transportModeForServer({ startMode: "next", hub: null, wsUrlOverride: undefined })).toBe("poll");
    expect(transportModeForServer({ startMode: "next", hub: on, wsUrlOverride: undefined })).toBe("poll");
    expect(transportModeForServer({ startMode: "custom", hub: on, wsUrlOverride: undefined })).toBeUndefined();
    expect(transportModeForServer({ startMode: undefined, hub: on, wsUrlOverride: undefined })).toBeUndefined();
    expect(transportModeForServer({ startMode: undefined, hub: null, wsUrlOverride: undefined })).toBe("poll");
    expect(transportModeForServer({ startMode: "custom", hub: off, wsUrlOverride: undefined })).toBe("poll");
    expect(transportModeForServer({ startMode: undefined, hub: null, wsUrlOverride: "wss://push.example.test/ws" })).toBeUndefined();
    expect(transportModeForServer({ startMode: undefined, hub: off, wsUrlOverride: "wss://push.example.test/ws" })).toBeUndefined();
    expect(transportModeForServer({ startMode: undefined, hub: null, wsUrlOverride: "  " })).toBe("poll"); // 空白覆盖 = 没覆盖(与 resolveWsUrl 一致)
    expect(transportModeForServer({ startMode: "next", hub: null, wsUrlOverride: "wss://push.example.test/ws" })).toBe("poll");
  });
});

describe("降级到轮询", () => {
  it("连续 3 次连不上 → kind poll、报 poll/degraded、ws 停掉,退避定时器不再建连", () => {
    const { manager, onState } = setup();
    manager.subscribe(BOOK);
    manager.start();
    expect(manager.kind).toBe("ws");
    for (let i = 0; i < WS_CONNECT_FAILURES_TO_POLL - 1; i++) failAndAdvance();
    expect(manager.kind).toBe("ws");
    expect(count()).toBe(WS_CONNECT_FAILURES_TO_POLL);
    last().fail();
    expect(manager.kind).toBe("poll");
    expect(states(onState).at(-1)).toBe("poll/degraded");
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS - 1);
    expect(count()).toBe(WS_CONNECT_FAILURES_TO_POLL);
  });

  it("hello 归零计数:两次失败、一次成功、再两次失败不降级", () => {
    const { manager } = setup();
    manager.start();
    failAndAdvance();
    failAndAdvance();
    last().hello();
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    failAndAdvance();
    failAndAdvance();
    expect(manager.kind).toBe("ws");
  });

  it("2 次 resync 失败(重订阅无 subscribed)→ poll;成功一次归零", () => {
    const { manager, onState } = setup();
    manager.subscribe(BOOK);
    manager.start();
    last().hello();
    last().frame([{ t: "subscribed", topic: BOOK, seq: 1 }]);
    const resync = () => last().frame([{ t: "resync", topic: BOOK, reason: "backpressure" }]);
    resync();
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS); // 失败 1
    expect(manager.kind).toBe("ws");
    resync();
    last().frame([
      { t: "subscribed", topic: BOOK, seq: 9 },
      { t: "book.snapshot", topic: BOOK, seq: 9, symbol: SYM, bids: [], asks: [], ts: 9 },
    ]); // subscribed + 快照:成功 → 归零
    resync();
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS); // 失败 1
    expect(manager.kind).toBe("ws");
    resync();
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS); // 失败 2
    expect(manager.kind).toBe("poll");
    expect(states(onState).at(-1)).toBe("poll/degraded");
    expect(WS_RESYNC_FAILURES_TO_POLL).toBe(2);
  });

  it("hub 连着两次把重订阅扣住(只回 subscribed、快照欠着,随后又发 resync)→ poll;只看 subscribed 的话永远不降级", () => {
    const { manager, onState } = setup();
    manager.subscribe(BOOK);
    manager.start();
    last().hello();
    last().frame([{ t: "subscribed", topic: BOOK, seq: 1 }]);
    const resync = () => last().frame([{ t: "resync", topic: BOOK, reason: "backpressure" }]);
    const throttledAnswer = () => last().frame([{ t: "unsubscribed", topic: BOOK }, { t: "subscribed", topic: BOOK, seq: 1 }]);
    resync();
    throttledAnswer();
    resync(); // 快照没来又 resync:失败 1
    expect(manager.kind).toBe("ws");
    throttledAnswer();
    vi.advanceTimersByTime(WS_RESYNC_TIMEOUT_MS); // 快照 5 s 没来:失败 2
    expect(manager.kind).toBe("poll");
    expect(states(onState).at(-1)).toBe("poll/degraded");
  });

  it("1008 policy → poll(不重连,但 30 s 后照常探测)", () => {
    const { manager, onState } = setup();
    manager.start();
    last().hello();
    last().serverClose(1008, "unauthorized");
    expect(manager.kind).toBe("poll");
    expect(states(onState).at(-1)).toBe("poll/degraded");
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS);
    expect(count()).toBe(2);
  });
});

describe("后台探测与恢复", () => {
  function degrade() {
    const s = setup();
    s.manager.subscribe(BOOK);
    s.manager.start();
    for (let i = 0; i < WS_CONNECT_FAILURES_TO_POLL - 1; i++) failAndAdvance();
    last().fail();
    expect(s.manager.kind).toBe("poll");
    s.onState.mockClear();
    return s;
  }

  it("30 s 后建一个 socket 探测;失败即停、不外露状态、再等 30 s;hello 才切回 ws 并报 open", () => {
    const { manager, onState } = degrade();
    const base = count();
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS);
    expect(count()).toBe(base + 1);
    last().fail();
    expect(onState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS - 1);
    expect(count()).toBe(base + 1); // ws-client 自己的退避被 stop 掉,不多建
    vi.advanceTimersByTime(1);
    expect(count()).toBe(base + 2);
    expect(onState).not.toHaveBeenCalled(); // connecting 不外露
    last().hello();
    expect(manager.kind).toBe("ws");
    expect(states(onState)).toEqual(["ws/open"]);
    // 切回后按当前订阅集全量重订阅,不带 since(stop 已清 seq 表)
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
  });

  it("轮询期间的 subscribe / unsubscribe 记在集合里,切回 WS 时一并订上", () => {
    const { manager } = degrade();
    manager.subscribe(`trades:${SYM}`);
    manager.subscribe("ticker:*");
    manager.unsubscribe(BOOK);
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [`trades:${SYM}`, "ticker:*"] }]);
  });

  it("探测时 hello 之后又断开:回到普通 ws 退避,而不是 30 s 探测", () => {
    const { manager, onState } = degrade();
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS);
    last().hello();
    expect(manager.kind).toBe("ws");
    const n = count();
    last().serverClose(1006);
    expect(states(onState).at(-1)).toBe("ws/connecting");
    vi.advanceTimersByTime(1000);
    expect(count()).toBe(n + 1);
  });

  it("切回 ws 后再连续失败 3 次会再次降级(计数已归零)", () => {
    const { manager } = degrade();
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS);
    last().hello();
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    failAndAdvance();
    failAndAdvance();
    expect(manager.kind).toBe("ws");
    last().fail();
    expect(manager.kind).toBe("poll");
  });
});

describe("reconnect / stop", () => {
  it("ws 模式 reconnect:关 1000 并立即新建连接", () => {
    const { manager } = setup();
    manager.start();
    last().hello();
    manager.reconnect();
    expect(FakeSocket.instances[0].closeCalls[0]).toEqual({ code: 1000, reason: "reconnect" });
    expect(count()).toBe(2);
  });

  it("轮询模式 reconnect(如登录后):不等 30 s 立即探测;探测失败照常回到 30 s 节奏", () => {
    const { manager } = setup();
    manager.start();
    for (let i = 0; i < WS_CONNECT_FAILURES_TO_POLL - 1; i++) failAndAdvance();
    last().fail();
    const base = count();
    manager.reconnect();
    expect(count()).toBe(base + 1);
    last().fail();
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS);
    expect(count()).toBe(base + 2);
    last().hello();
    expect(manager.kind).toBe("ws");
  });

  it("未 start 时 reconnect 空操作;stop 报 none/offline、取消探测、kind 回到构建期模式", () => {
    const { manager, onState } = setup();
    manager.reconnect();
    expect(count()).toBe(0);
    manager.start();
    for (let i = 0; i < WS_CONNECT_FAILURES_TO_POLL - 1; i++) failAndAdvance();
    last().fail();
    expect(manager.kind).toBe("poll");
    manager.stop();
    expect(states(onState).at(-1)).toBe("none/offline");
    expect(manager.kind).toBe("ws");
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS * 2);
    expect(count()).toBe(WS_CONNECT_FAILURES_TO_POLL);
    manager.stop(); // 幂等
  });

  it("强制 poll:start 报 poll/degraded,永不建 socket;stop 报 offline", () => {
    const { manager, onState } = setup("poll");
    manager.start();
    manager.subscribe(BOOK);
    manager.reconnect();
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS * 3);
    expect(count()).toBe(0);
    expect(manager.kind).toBe("poll");
    expect(states(onState)).toEqual(["poll/degraded"]);
    manager.stop();
    expect(states(onState).at(-1)).toBe("none/offline");
  });

  it("start(\"poll\")(服务端说没有 /ws,START_MODE=next):首帧就报 poll/degraded,从不建 socket —— 不探测,登录后的 reconnect 也不试 /ws", () => {
    const { manager, onState } = setup("ws");
    manager.subscribe(BOOK);
    manager.start("poll");
    expect(states(onState)).toEqual(["poll/degraded"]); // 没有 ws/connecting 这一段(回滚演练里曾经是 31–35 s)
    expect(manager.kind).toBe("poll");
    manager.reconnect(); // 终端里登录 → becomeReady → requestTransportReconnect
    vi.advanceTimersByTime(WS_PROBE_INTERVAL_MS * 5);
    expect(count()).toBe(0);
    expect(states(onState)).toEqual(["poll/degraded"]);
    // stop 之后按构建期模式重来:下一次不带提示的 start 照常连 WS(离开终端再回来,服务端可能已经恢复 custom)
    manager.stop();
    expect(manager.kind).toBe("ws");
    manager.start();
    expect(count()).toBe(1);
    last().hello();
    expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]); // 轮询期间记下的订阅集照常带上
    expect(states(onState).slice(-2)).toEqual(["ws/connecting", "ws/open"]);
  });

  it("start() / start(\"ws\") 行为不变:按构建期模式连 WS", () => {
    const { manager, onState } = setup("ws");
    manager.start("ws");
    expect(count()).toBe(1);
    expect(states(onState)).toEqual(["ws/connecting"]);
  });

  it("帧透传:ws 模式下 hello 与数据帧到 onFrame", () => {
    const { manager, onFrame } = setup();
    manager.start();
    last().hello();
    last().frame([{ t: "ticker", topic: "ticker:*", seq: 0, symbol: SYM, ticker: { symbol: SYM, ts: 1, lastPrice: 100 } }]);
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls[1][0][0].t).toBe("ticker");
  });

  it("身份比对经 ws 选项接到 ws-client(expectedUserId);identity-mismatch 透传给 onEvent,不算连接或 resync 失败(不降级)", () => {
    const onEvent = vi.fn();
    const onState = vi.fn<(s: ConnectionState) => void>();
    const manager = createTransportManager({ mode: "ws", wsUrl: "ws://test/ws", onState, onFrame: vi.fn(), onEvent, ws: { wsImpl, random: () => 0.5, expectedUserId: () => "u-a" } });
    manager.subscribe("account");
    manager.subscribe(BOOK);
    manager.start();
    for (let i = 0; i < WS_CONNECT_FAILURES_TO_POLL + 1; i++) {
      last().readyState = 1;
      last().frame([{ t: "hello", v: 1, serverTime: Date.now(), heartbeatMs: 25_000, userId: "u-b", maxTopics: 64 }]);
      expect(last().subOps()).toEqual([{ op: "subscribe", topics: [BOOK] }]);
      manager.reconnect();
    }
    expect(onEvent.mock.calls.map((c) => c[0]).filter((e) => e.type === "identity-mismatch")).toHaveLength(WS_CONNECT_FAILURES_TO_POLL + 1);
    expect(manager.kind).toBe("ws");
    expect(states(onState)).not.toContain("poll/degraded");
  });
});
