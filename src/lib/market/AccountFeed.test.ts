import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientOp, ConnectionState, InstrumentsResponse, ServerEvent, Topic } from "@/shared";
import { DEFAULT_FEE_SCHEDULE } from "@/shared";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT_FEED_TOPICS, pollTickers, startAccountFeed } from "./AccountFeed";
import type { Batcher } from "./batcher";
import { startFeed, subscribeAccountTopic, type MarketRuntime } from "./MarketProvider";
import { createInitialState, marketActions, useMarketStore } from "./store";
import { createTransportManager, type TransportManager } from "./transport";

// 资产页的行情层(计划 §6.2.3 P2-10):AccountFeed 组件本身不测(无 jsdom,§9.1 第 7 条),这里测它用到的三件事 ——
// 订阅集(startFeed + subscribeAccountTopic:只有 ticker:* 与 account,不含 book / trades / candles),两种传输模式下都是;
// 轮询降级的行情只拉标的列表(pollTickers)。

const SYM = "VCS-FOR-2021";
const POLL: ConnectionState = { transport: "poll", state: "degraded", lastMessageAt: null, rttMs: null };
const WS_OPEN: ConnectionState = { transport: "ws", state: "open", lastMessageAt: null, rttMs: null };
const MARKET_TOPIC = /^(book|trades|candles):/;

const instrumentsResp: InstrumentsResponse = {
  instruments: [
    {
      instrument: { id: "a1", symbol: SYM, name: "n", standard: "VCS", projectType: "FOR", vintage: 2021, country: "BR", registry: "Verra", isScenario: false, projectId: null, methodology: null, verificationStatus: null, tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1, currency: "USD", lastPrice: 1234 },
      ticker: { symbol: SYM, lastPrice: 1234, bestBid: 1230, bestAsk: null, change24h: 0, high24h: 1234, low24h: 1234, volume24h: 1, ts: 4 },
    },
  ],
  feeSchedule: DEFAULT_FEE_SCHEDULE,
  serverTime: 6,
};

/** 记录订阅 / 退订 / 启停的假 transport */
function recordingRuntime() {
  const calls: string[] = [];
  const topics = new Set<Topic>();
  const transport = {
    kind: "ws",
    start: (mode?: string) => calls.push(`start:${mode ?? "default"}`),
    stop: () => calls.push("stop"),
    subscribe: (topic: Topic) => {
      topics.add(topic);
      calls.push(`subscribe:${topic}`);
    },
    unsubscribe: (topic: Topic) => {
      topics.delete(topic);
      calls.push(`unsubscribe:${topic}`);
    },
    reconnect: () => calls.push("reconnect"),
  } as unknown as TransportManager;
  const push = vi.fn<Batcher["push"]>();
  const rt: MarketRuntime = { transport, batcher: { push, flush: vi.fn(), dispose: vi.fn(), stats: vi.fn() } as unknown as Batcher };
  return { rt, calls, topics, push };
}

beforeEach(() => {
  useMarketStore.setState(createInitialState(), true);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AccountFeed subscription set", () => {
  it.each(["ws", "poll"] as const)("transportMode %s: ticker:* while mounted, account once signed in, never a book / trades / candles topic", (mode) => {
    const { rt, calls, topics } = recordingRuntime();
    const stopFeed = startFeed(rt, mode);
    expect([...topics]).toEqual([...ACCOUNT_FEED_TOPICS]);
    expect(calls).toEqual(["subscribe:ticker:*", `start:${mode}`]);
    const stopAccount = subscribeAccountTopic(rt);
    expect([...topics].sort()).toEqual(["account", "ticker:*"]);
    expect([...topics].filter((topic) => MARKET_TOPIC.test(topic))).toEqual([]);
    // 登出 / 离开页面:退订 account;卸载:退订 ticker:* 并停掉 transport
    stopAccount();
    expect([...topics]).toEqual(["ticker:*"]);
    stopFeed();
    expect([...topics]).toEqual([]);
    expect(calls.slice(-3)).toEqual(["unsubscribe:account", "unsubscribe:ticker:*", "stop"]);
  });

  describe("with the real transport manager", () => {
    /** 最小假 WebSocket:记下发出去的每条 op */
    class FakeSocket {
      static last: FakeSocket | null = null;
      readyState = 0;
      sent: ClientOp[] = [];
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
      }
      send(data: string) {
        this.sent.push(JSON.parse(data) as ClientOp);
      }
      close(code?: number) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code: code ?? 1005, reason: "" } as CloseEvent);
      }
      frame(events: ServerEvent[]) {
        this.onmessage?.({ data: JSON.stringify(events) } as MessageEvent);
      }
    }
    const subscribedTopics = (socket: FakeSocket): Topic[] => socket.sent.flatMap((op) => (op.op === "subscribe" ? op.topics : []));

    function runtime(mode: "ws" | "poll") {
      FakeSocket.last = null;
      const push = vi.fn<Batcher["push"]>();
      const transport = createTransportManager({
        mode: "ws",
        wsUrl: "ws://test/ws",
        onFrame: (frame) => push(frame),
        onState: (state) => marketActions.setConnection(state),
        ws: { wsImpl: FakeSocket as unknown as typeof WebSocket, random: () => 0.5 },
      });
      const rt: MarketRuntime = { transport, batcher: { push, flush: vi.fn(), dispose: vi.fn(), stats: vi.fn() } as unknown as Batcher };
      const stopFeed = startFeed(rt, mode);
      const stopAccount = subscribeAccountTopic(rt);
      return { rt, stop: () => (stopAccount(), stopFeed()) };
    }

    it("WS: after hello the socket subscribes to ticker:* and account only", () => {
      const { stop } = runtime("ws");
      const socket = FakeSocket.last!;
      socket.readyState = 1;
      socket.frame([{ t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: "u1", maxTopics: 64 }]);
      expect(subscribedTopics(socket).sort()).toEqual(["account", "ticker:*"]);
      stop();
    });

    it("poll (server hint): no socket at all; the connection reports poll so the REST fallback runs", () => {
      const { stop } = runtime("poll");
      expect(FakeSocket.last).toBeNull();
      expect(useMarketStore.getState().connection.transport).toBe("poll");
      stop();
    });
  });
});

// P2-13(终审 UI-3):未登录的访客打开资产页时只有登录入口,不连 /ws、不订 ticker:*;登录之后才启动
describe("startAccountFeed (signed-in only)", () => {
  it("signed out (meId null): no subscription, no transport start, a no-op cleanup", () => {
    const { rt, calls, topics } = recordingRuntime();
    const stop = startAccountFeed(rt, null, "ws");
    expect(calls).toEqual([]);
    expect([...topics]).toEqual([]);
    stop();
    expect(calls).toEqual([]);
  });

  it.each(["ws", "poll"] as const)("signed in (%s): ticker:* and the transport start; cleanup unsubscribes and stops", (mode) => {
    const { rt, calls, topics } = recordingRuntime();
    const stop = startAccountFeed(rt, "u1", mode);
    expect([...topics]).toEqual([...ACCOUNT_FEED_TOPICS]);
    expect(calls).toEqual(["subscribe:ticker:*", `start:${mode}`]);
    stop();
    expect([...topics]).toEqual([]);
    expect(calls.slice(-2)).toEqual(["unsubscribe:ticker:*", "stop"]);
  });

  it("with the real transport manager: signed out opens no WebSocket at all", () => {
    const opened: string[] = [];
    class NoSocket {
      constructor(url: string) {
        opened.push(url);
      }
    }
    const transport = createTransportManager({
      mode: "ws",
      wsUrl: "ws://test/ws",
      onFrame: () => {},
      onState: (state) => marketActions.setConnection(state),
      ws: { wsImpl: NoSocket as unknown as typeof WebSocket, random: () => 0.5 },
    });
    const rt: MarketRuntime = { transport, batcher: { push: vi.fn(), flush: vi.fn(), dispose: vi.fn(), stats: vi.fn() } as unknown as Batcher };
    startAccountFeed(rt, null, "ws")();
    expect(opened).toEqual([]);
  });

  it("the component keys the feed effect on meId (source check: node tests do not run effects)", () => {
    const code = readFileSync(fileURLToPath(new URL("./AccountFeed.tsx", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    expect(code).toMatch(/return startAccountFeed\(rt, meId, transportMode\);\s*\}, \[meId, transportMode\]\);/);
    // startFeed 只经 startAccountFeed 调用(组件里没有别的地方直接开)
    expect(code.match(/startFeed\(/g)).toHaveLength(1);
  });

  it("the account page polls its account without triggers (it never shows them; source check)", () => {
    const code = readFileSync(fileURLToPath(new URL("./AccountFeed.tsx", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    expect(code).toContain("return pollAccount(meId, rt, { includeTriggers: false });");
    expect(code.match(/pollAccount\(/g)).toHaveLength(1);
  });
});

describe("pollTickers", () => {
  type Pending = { url: string; init?: RequestInit; resolve: (res: Response) => void };
  let inflight: Pending[] = [];
  const okResponse = (data: unknown): Response => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) }) as unknown as Response;
  beforeEach(() => {
    inflight = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => inflight.push({ url, init, resolve }))),
    );
  });

  it("polling: fetches only the instrument list (bypassing the browser cache) and pushes one ticker frame per instrument", async () => {
    const { rt, push } = recordingRuntime();
    marketActions.setConnection(POLL);
    const done = pollTickers(rt);
    expect(inflight.map((p) => p.url)).toEqual(["/api/market/instruments"]);
    expect(inflight[0].init?.cache).toBe("no-store");
    inflight[0].resolve(okResponse(instrumentsResp));
    await done;
    expect(push).toHaveBeenCalledTimes(1);
    const frame = push.mock.calls[0][0];
    expect(frame.map((ev) => ev.t)).toEqual(["ticker"]);
    expect(frame.every((ev) => !("topic" in ev) || !MARKET_TOPIC.test(String(ev.topic)))).toBe(true);
    expect(useMarketStore.getState().instruments[SYM]?.symbol).toBe(SYM);
  });

  it("does nothing on WS, and drops a response that lands after the switch back to WS", async () => {
    const { rt, push } = recordingRuntime();
    marketActions.setConnection(WS_OPEN);
    await pollTickers(rt);
    expect(inflight).toEqual([]);
    marketActions.setConnection(POLL);
    const done = pollTickers(rt);
    marketActions.setConnection(WS_OPEN);
    inflight[0].resolve(okResponse(instrumentsResp));
    await done;
    expect(push).not.toHaveBeenCalled();
  });
});
