import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Balance, ConnectionState, Order, Position } from "@/shared";
import { accountSignature, ACCOUNT_REFRESH_DEBOUNCE_MS, onOpenOrdersClosed, onSignOut, watchAccountActivity } from "./account-refresh";
import { applyAccountEvents, createInitialAccountState, retainOpenOrders, useAccountStore } from "./account-store";
import { createInitialState, marketActions, useMarketStore } from "./store";

// 底部 Tab 的「账户变了 → 重读第一页」信号(P1-21 修复轮):node 环境,假定时器;账户事件走真实的 applyAccountEvents,
// 与 MarketProvider 的 batcher 转来的是同一条路。

const ME = { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 100_000, lockedCash: 0, unreadNotices: 0 };

function order(id: string, patch: Partial<Order> = {}): Order {
  return {
    id,
    clientOrderId: null,
    assetId: "asset-VCS",
    symbol: "VCS-FOR-2021",
    side: "BUY",
    type: "LIMIT",
    price: 6800,
    quantity: 10,
    filledQuantity: 0,
    status: "OPEN",
    avgFillPrice: null,
    cancelReason: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function position(patch: Partial<Position> = {}): Position {
  return {
    assetId: "asset-VCS",
    symbol: "VCS-FOR-2021",
    quantity: 20,
    locked: 0,
    lockedBy: { orders: 0, otc: 0 },
    available: 20,
    retired: 0,
    lastPrice: 6800,
    marketValue: 136_000,
    averagePurchasePrice: 6800,
    unrealisedPnl: 0,
    costBasisStatus: "complete",
    isScenario: false,
    ...patch,
  };
}

const balanceEvent = (balance: Balance) => ({ t: "balance" as const, topic: "account" as const, seq: 0, balance });
const orderEvent = (o: Order) => ({ t: "order" as const, topic: "account" as const, seq: 0, order: o });
const positionEvent = (p: Position) => ({ t: "position" as const, topic: "account" as const, seq: 0, position: p });

function signedIn(): void {
  useAccountStore.setState({
    me: ME,
    balance: { cashBalance: ME.cashBalance, lockedCash: 0 },
    openOrders: new Map([["o1", order("o1")]]),
    positions: new Map([["asset-VCS", position()]]),
    status: "ready",
  });
}

function connection(patch: Partial<ConnectionState>): void {
  marketActions.setConnection({ ...useMarketStore.getState().connection, ...patch });
}

beforeEach(() => {
  vi.useFakeTimers();
  useAccountStore.setState(createInitialAccountState(), true);
  useMarketStore.setState(createInitialState(), true);
  signedIn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("accountSignature", () => {
  const base = () => {
    const s = createInitialAccountState();
    s.balance = { cashBalance: 1000, lockedCash: 100 };
    s.positions = new Map([["a1", position({ assetId: "a1" })]]);
    s.openOrders = new Map([["o1", order("o1", { filledQuantity: 10, status: "PARTIAL", quantity: 30 })]]);
    return s;
  };

  it("ignores reference-only changes (a poll that replaces equal data) and sees fills, cancels and balance moves", () => {
    const a = base();
    expect(accountSignature(base())).toBe(accountSignature(a));
    const filled = base();
    filled.openOrders = new Map([["o1", order("o1", { filledQuantity: 20, status: "PARTIAL", quantity: 30 })]]);
    expect(accountSignature(filled)).not.toBe(accountSignature(a));
    const cancelled = base();
    cancelled.openOrders = new Map();
    expect(accountSignature(cancelled)).not.toBe(accountSignature(a));
    const paid = base();
    paid.balance = { cashBalance: 900, lockedCash: 100 };
    expect(accountSignature(paid)).not.toBe(accountSignature(a));
    const retired = base();
    retired.positions = new Map([["a1", position({ assetId: "a1", retired: 5 })]]);
    expect(accountSignature(retired)).not.toBe(accountSignature(a));
  });
});

describe("watchAccountActivity", () => {
  it("polling: fires once per burst of real changes and ignores equal snapshots", () => {
    connection({ transport: "poll", state: "degraded" });
    const onChange = vi.fn();
    const stop = watchAccountActivity(onChange);

    // 一次轮询:引用全换、值不变 → 不触发
    applyAccountEvents([balanceEvent({ cashBalance: ME.cashBalance, lockedCash: 0 }), orderEvent(order("o1")), positionEvent(position())]);
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();

    // 挂单成交:同一拍里挂单、余额、持仓都变 → 合并成一次
    applyAccountEvents([orderEvent(order("o1", { filledQuantity: 10, status: "FILLED" }))]);
    applyAccountEvents([balanceEvent({ cashBalance: ME.cashBalance - 68_000, lockedCash: 0 })]);
    applyAccountEvents([positionEvent(position({ quantity: 30, available: 30 }))]);
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS - 1);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("WS: a zero-fill market order (order CANCELLED + an unchanged balance) still fires; polling does not treat that as activity", () => {
    const zeroFill = [
      orderEvent(order("m1", { type: "MARKET", price: null, status: "CANCELLED", cancelReason: "MARKET_REMAINDER" })),
      balanceEvent({ cashBalance: ME.cashBalance, lockedCash: 0 }),
    ];
    connection({ transport: "ws", state: "open" });
    const onChange = vi.fn();
    const stop = watchAccountActivity(onChange);
    const before = accountSignature(useAccountStore.getState());
    applyAccountEvents(zeroFill);
    expect(accountSignature(useAccountStore.getState())).toBe(before); // 指纹完全不动
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();

    connection({ transport: "poll", state: "degraded" });
    const polled = vi.fn();
    const stopPolled = watchAccountActivity(polled);
    applyAccountEvents(zeroFill);
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS);
    expect(polled).not.toHaveBeenCalled();
    stopPolled();
  });

  it("fires when the connection comes back open (reconnect, deploy 1012, poll → WS), not on every message", () => {
    connection({ transport: "ws", state: "open", lastMessageAt: 1 });
    const onChange = vi.fn();
    const stop = watchAccountActivity(onChange);
    connection({ lastMessageAt: 2, rttMs: 30 });
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS);
    expect(onChange).not.toHaveBeenCalled();

    connection({ state: "connecting" });
    connection({ state: "open" });
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);

    connection({ transport: "poll", state: "degraded" });
    connection({ transport: "ws", state: "open" });
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("the resubscribe snapshot after a gap fires even though it carries no fills", () => {
    connection({ transport: "ws", state: "open" });
    const onChange = vi.fn();
    const stop = watchAccountActivity(onChange);
    // 断线期间挂单被机器人吃掉:快照里没有 fill,只有新的余额与持仓(挂单由 retainOpenOrders 收口)
    applyAccountEvents([balanceEvent({ cashBalance: ME.cashBalance - 68_000, lockedCash: 0 }), positionEvent(position({ quantity: 30, available: 30 }))]);
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stop() unsubscribes and cancels a pending refresh", () => {
    connection({ transport: "poll", state: "degraded" });
    const onChange = vi.fn();
    const stop = watchAccountActivity(onChange);
    applyAccountEvents([balanceEvent({ cashBalance: 1, lockedCash: 0 })]);
    stop();
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS * 2);
    connection({ transport: "ws", state: "open" });
    applyAccountEvents([balanceEvent({ cashBalance: 2, lockedCash: 0 })]);
    vi.advanceTimersByTime(ACCOUNT_REFRESH_DEBOUNCE_MS * 2);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("onSignOut", () => {
  it("fires when the signed-in user goes away or changes, not on first sign-in or balance updates", () => {
    const listener = vi.fn();
    useAccountStore.setState(createInitialAccountState(), true);
    const stop = onSignOut(listener);

    useAccountStore.setState({ status: "loading" });
    useAccountStore.setState({ me: ME, status: "ready" });
    applyAccountEvents([balanceEvent({ cashBalance: 5, lockedCash: 0 })]);
    expect(listener).not.toHaveBeenCalled();

    useAccountStore.setState({ me: { ...ME, id: "u2" } });
    expect(listener).toHaveBeenCalledTimes(1);

    useAccountStore.setState({ me: null, status: "anon" });
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    useAccountStore.setState({ me: ME, status: "ready" });
    useAccountStore.setState({ me: null, status: "anon" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("onOpenOrdersClosed", () => {
  it("reports orders that leave openOrders for the same user (filled, cancelled, dropped by a snapshot), with their last known version", () => {
    useAccountStore.setState({ openOrders: new Map([["o1", order("o1", { createdAt: 10 })], ["o2", order("o2", { createdAt: 20 })], ["o3", order("o3")]]) });
    const listener = vi.fn();
    const stop = onOpenOrdersClosed(listener);

    // 部分成交:还在挂单里,不算
    applyAccountEvents([orderEvent(order("o1", { createdAt: 10, filledQuantity: 4, status: "PARTIAL" }))]);
    expect(listener).not.toHaveBeenCalled();

    // 成交完(WS 的终态 order 事件):移出,报的是离开前那一版
    applyAccountEvents([orderEvent(order("o1", { createdAt: 10, filledQuantity: 10, status: "FILLED" }))]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith("u1", [expect.objectContaining({ id: "o1", createdAt: 10, status: "PARTIAL" })]);

    // 轮询 / 订阅快照收口:不在快照里的旧单
    retainOpenOrders(new Set(["o3"]));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][1].map((o: Order) => o.id)).toEqual(["o2"]);

    // 余额事件不碰挂单
    applyAccountEvents([balanceEvent({ cashBalance: 1, lockedCash: 0 })]);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
  });

  it("does not report the orders cleared by a sign-out or an account switch", () => {
    const listener = vi.fn();
    const stop = onOpenOrdersClosed(listener);
    useAccountStore.setState({ me: null, openOrders: new Map(), status: "anon" });
    useAccountStore.setState({ me: ME, openOrders: new Map([["o9", order("o9")]]), status: "ready" });
    useAccountStore.setState({ me: { ...ME, id: "u2" }, openOrders: new Map() });
    expect(listener).not.toHaveBeenCalled();
    stop();
    useAccountStore.setState({ me: { ...ME, id: "u2" }, openOrders: new Map([["x", order("x")]]) });
    useAccountStore.setState({ openOrders: new Map() });
    expect(listener).not.toHaveBeenCalled();
  });
});
