import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, Order } from "@/shared";
import { connectionKind, readOpenOrders, registerOpenOrdersSource, selectFeedOffline, subscribeOpenOrders } from "./selectors";
import { createInitialState, type MarketState } from "./store";

// hook 本身不测(无 jsdom,§9.1 第 7 条);这里只测 useBookView 依赖的自家挂单来源注册表:
// 未注册时恒为同一空 Map、注册后读到源的 openOrders、换源 / 注销时已订阅者被通知并改订。

function fakeSource(initial: Map<string, Order> = new Map()) {
  let state = { openOrders: initial as ReadonlyMap<string, Order> };
  const listeners = new Set<() => void>();
  return {
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    getState: () => state,
    set(next: Map<string, Order>) {
      state = { openOrders: next };
      listeners.forEach((l) => l());
    },
    size: () => listeners.size,
  };
}

afterEach(() => registerOpenOrdersSource(null));

describe("open orders source registry", () => {
  it("未注册:readOpenOrders 恒为同一个空 Map(useSyncExternalStore 需要稳定引用)", () => {
    const a = readOpenOrders();
    expect(a.size).toBe(0);
    expect(readOpenOrders()).toBe(a);
  });

  it("注册后读到源的 openOrders;源变化通知订阅者;退订后不再通知", () => {
    const src = fakeSource();
    registerOpenOrdersSource(src);
    const listener = vi.fn();
    const unsub = subscribeOpenOrders(listener);
    expect(src.size()).toBe(1);
    const next = new Map<string, Order>();
    src.set(next);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readOpenOrders()).toBe(next);
    unsub();
    expect(src.size()).toBe(0);
    src.set(new Map());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("先订阅后注册:注册时立即通知并改订到新源;注销后回到空 Map 且不再收源的通知", () => {
    const listener = vi.fn();
    const unsub = subscribeOpenOrders(listener);
    const src = fakeSource(new Map([["o1", { id: "o1" } as Order]]));
    registerOpenOrdersSource(src);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readOpenOrders().has("o1")).toBe(true);
    expect(src.size()).toBe(1);
    registerOpenOrdersSource(null);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readOpenOrders().size).toBe(0);
    expect(src.size()).toBe(0);
    src.set(new Map());
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });
});

describe("connection rule (ConnectionBadge and the panels' offline check share it)", () => {
  const idle = createInitialState().connection;
  const withConn = (connection: ConnectionState): MarketState => ({ ...createInitialState(), connection });

  it("connectionKind: the not-yet-started store is a pending placeholder for the build mode, never offline", () => {
    expect(connectionKind(idle, "ws")).toEqual({ kind: "live", pending: true });
    expect(connectionKind(idle, "poll")).toEqual({ kind: "polling", pending: true });
    expect(connectionKind({ ...idle, transport: "ws", state: "open" }, "ws")).toEqual({ kind: "live", pending: false });
    expect(connectionKind({ ...idle, transport: "poll", state: "open" }, "ws")).toEqual({ kind: "polling", pending: false });
    expect(connectionKind({ ...idle, transport: "ws", state: "degraded" }, "ws")).toEqual({ kind: "reconnecting", pending: false });
    expect(connectionKind({ ...idle, transport: "ws", state: "offline", lastMessageAt: 5 }, "ws")).toEqual({ kind: "offline", pending: false });
    expect(connectionKind({ ...idle, transport: "none", rttMs: 3 }, "poll")).toEqual({ kind: "offline", pending: false });
  });

  it("selectFeedOffline: an error state only when the feed really went offline, never for the not-yet-started store", () => {
    expect(selectFeedOffline(createInitialState())).toBe(false); // SSR / 水合首帧 / 传输层启动前
    expect(selectFeedOffline(withConn({ transport: "ws", state: "offline", lastMessageAt: 5, rttMs: null }))).toBe(true);
    expect(selectFeedOffline(withConn({ transport: "ws", state: "connecting", lastMessageAt: 5, rttMs: null }))).toBe(false);
    expect(selectFeedOffline(withConn({ transport: "poll", state: "degraded", lastMessageAt: null, rttMs: null }))).toBe(false);
    expect(selectFeedOffline(withConn({ transport: "ws", state: "open", lastMessageAt: 5, rttMs: 12 }))).toBe(false);
  });

  it("the offline verdict does not depend on the build mode (only the pending placeholder label does)", () => {
    const states: ConnectionState[] = [
      idle,
      { ...idle, transport: "ws", state: "offline", lastMessageAt: 5 },
      { ...idle, transport: "ws", state: "connecting" },
      { ...idle, transport: "poll", state: "degraded" },
      { ...idle, transport: "none", state: "offline", rttMs: 7 },
    ];
    for (const c of states) {
      const ws = connectionKind(c, "ws");
      const poll = connectionKind(c, "poll");
      expect(ws.kind === "offline" && !ws.pending, JSON.stringify(c)).toBe(poll.kind === "offline" && !poll.pending);
      expect(selectFeedOffline(withConn(c))).toBe(ws.kind === "offline" && !ws.pending);
    }
  });
});
