import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountOrdersResponse, AccountTriggersResponse, Me, Order, ServerEvent, Trigger } from "@/shared";
import {
  OPEN_ORDERS_MAX_PAGES,
  OPEN_ORDERS_PAGE_LIMIT,
  OPEN_ORDERS_URL,
  OPEN_TRIGGERS_PAGE_LIMIT,
  OPEN_TRIGGERS_URL,
  applyAccountEvents,
  fetchOpenOrders,
  fetchOpenTriggers,
  isAccountEvent,
  readMeId,
  readServerMeId,
  registerAccountSource,
  registerTransportReconnect,
  requestTransportReconnect,
  retainOpenOrders,
  retainPositions,
  retainTriggers,
  subscribeAccount,
  type AccountEvent,
} from "./account-bridge";

// 账户 store(P1-15)接上之前的行为:meId 恒 null、账户事件丢弃、重连请求空操作;接上之后逐项生效,换源 / 注销通知订阅者。

function fakeSource(me: Me = null) {
  let state = { me };
  const listeners = new Set<() => void>();
  const applied: AccountEvent[] = [];
  const retained: ReadonlySet<string>[] = [];
  return {
    source: {
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      getState: () => state,
      applyAccountEvent: (ev: AccountEvent) => void applied.push(ev),
      retainOpenOrders: (ids: ReadonlySet<string>) => void retained.push(ids),
    },
    setMe(next: Me) {
      state = { me: next };
      listeners.forEach((l) => l());
    },
    applied,
    retained,
    size: () => listeners.size,
  };
}
const me: Me = { id: "u1", email: "e", name: "n", cashBalance: 0, lockedCash: 0, unreadNotices: 0 };
const balance: ServerEvent = { t: "balance", topic: "account", seq: 0, balance: { cashBalance: 1, lockedCash: 0 } };
const tick: ServerEvent = { t: "ticker", topic: "ticker:*", seq: 0, symbol: "S", ticker: { symbol: "S", ts: 1 } };
const trigger: ServerEvent = {
  t: "trigger", topic: "account", seq: 2,
  trigger: {
    id: "t1", kind: "ALERT", assetId: "a1", symbol: "S", direction: "ABOVE", triggerPrice: 100, side: null, orderType: null, limitPrice: null, quantity: null,
    ocoGroupId: null, status: "PENDING", reason: null, orderId: null, firedPrice: null, createdAt: 1, updatedAt: 1, firedAt: null,
  },
};
const notice: ServerEvent = {
  t: "notice", topic: "account", seq: 3, unread: 1,
  notice: { id: "n1", createdAt: 1, readAt: null, kind: "price_alert", triggerId: "t1", symbol: "S", direction: "ABOVE", triggerPrice: 100, firedPrice: 101 },
};

afterEach(() => {
  registerAccountSource(null);
  registerTransportReconnect(null);
});

describe("account bridge", () => {
  it("未注册:meId null、事件丢弃、retain / reconnect 空操作", () => {
    expect(readMeId()).toBeNull();
    expect(readServerMeId()).toBeNull();
    expect(applyAccountEvents([balance, tick])).toBe(0);
    expect(() => retainOpenOrders(new Set(["x"]))).not.toThrow();
    expect(() => requestTransportReconnect()).not.toThrow();
  });

  it("注册后读到 me.id,只有账户事件被转交,retain 透传", () => {
    const f = fakeSource(me);
    registerAccountSource(f.source);
    expect(readMeId()).toBe("u1");
    expect(applyAccountEvents([tick, balance, { t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: null, maxTopics: 64 }])).toBe(1);
    expect(f.applied).toEqual([balance]);
    retainOpenOrders(new Set(["o1"]));
    expect([...f.retained[0]]).toEqual(["o1"]);
    expect(isAccountEvent(tick)).toBe(false);
    expect(isAccountEvent(balance)).toBe(true);
  });

  it("trigger / notice 也是账户事件:isAccountEvent 放行,按原序与 order / balance 一起转交", () => {
    expect(isAccountEvent(trigger)).toBe(true);
    expect(isAccountEvent(notice)).toBe(true);
    const f = fakeSource(me);
    registerAccountSource(f.source);
    expect(applyAccountEvents([tick, trigger, balance, notice])).toBe(3);
    expect(f.applied).toEqual([trigger, balance, notice]);
  });

  it("订阅者:源变化通知;先订阅后注册也被通知并改读新源;注销通知并回 null", () => {
    const listener = vi.fn();
    const unsub = subscribeAccount(listener);
    const f = fakeSource(null);
    registerAccountSource(f.source);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.size()).toBe(1);
    f.setMe(me);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readMeId()).toBe("u1");
    registerAccountSource(f.source); // 同源不重复通知
    expect(listener).toHaveBeenCalledTimes(2);
    registerAccountSource(null);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(readMeId()).toBeNull();
    expect(f.size()).toBe(0);
    unsub();
    registerAccountSource(f.source);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("transport 重连钩子:注册后 requestTransportReconnect 调到它", () => {
    const fn = vi.fn();
    registerTransportReconnect(fn);
    requestTransportReconnect();
    expect(fn).toHaveBeenCalledTimes(1);
    registerTransportReconnect(null);
    requestTransportReconnect();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("批量入口:源提供 applyAccountEvents 时整批一次转交(只含账户事件,原序),不再逐条;返回转交条数", () => {
    const f = fakeSource(me);
    const batches: (readonly AccountEvent[])[] = [];
    registerAccountSource({ ...f.source, applyAccountEvents: (events: readonly AccountEvent[]) => void batches.push(events) });
    const order: ServerEvent = { t: "order", topic: "account", seq: 1, order: { id: "o1", clientOrderId: null, assetId: "a", symbol: "S", side: "BUY", type: "LIMIT", price: 1, quantity: 1, filledQuantity: 0, status: "OPEN", avgFillPrice: null, cancelReason: null, createdAt: 1, updatedAt: 1 } };
    expect(applyAccountEvents([tick, balance, tick, order])).toBe(2);
    expect(batches).toEqual([[balance, order]]);
    expect(f.applied).toEqual([]);
    // 一批里没有账户事件:不调用
    expect(applyAccountEvents([tick])).toBe(0);
    expect(batches).toHaveLength(1);
  });

  it("retainPositions 透传;源没提供或未注册时空操作", () => {
    expect(() => retainPositions(new Set(["a"]))).not.toThrow();
    const f = fakeSource(me);
    registerAccountSource(f.source);
    expect(() => retainPositions(new Set(["a"]))).not.toThrow();
    const kept: ReadonlySet<string>[] = [];
    registerAccountSource({ ...f.source, retainPositions: (ids: ReadonlySet<string>) => void kept.push(ids) });
    retainPositions(new Set(["a-vcs"]));
    expect(kept.map((s) => [...s])).toEqual([["a-vcs"]]);
  });
});

describe("retainTriggers", () => {
  it("透传给源;源没提供或未注册时空操作", () => {
    expect(() => retainTriggers(new Set(["t"]))).not.toThrow();
    const f = fakeSource(me);
    registerAccountSource(f.source);
    expect(() => retainTriggers(new Set(["t"]))).not.toThrow();
    const kept: ReadonlySet<string>[] = [];
    registerAccountSource({ ...f.source, retainTriggers: (ids: ReadonlySet<string>) => void kept.push(ids) });
    retainTriggers(new Set(["t-1", "t-2"]));
    expect(kept.map((s) => [...s])).toEqual([["t-1", "t-2"]]);
  });
});

describe("fetchOpenTriggers(未完结条件单,只有轮询用)", () => {
  const openTrigger = (id: string): Trigger => ({
    id, kind: "ALERT", assetId: "a", symbol: "S", direction: "ABOVE", triggerPrice: 100, side: null, orderType: null, limitPrice: null, quantity: null,
    ocoGroupId: null, status: "PENDING", reason: null, orderId: null, firedPrice: null, createdAt: 1, updatedAt: 1, firedAt: null,
  });
  const fetchOf = (body: AccountTriggersResponse) => {
    const calls: string[] = [];
    const fetchJson = async <T,>(u: string): Promise<T> => {
      calls.push(u);
      return body as T;
    };
    return { fetchJson, calls };
  };

  it("一个请求(?status=open&limit=100);没有下一页 → complete = true", async () => {
    const { fetchJson, calls } = fetchOf({ triggers: [openTrigger("t1"), openTrigger("t2")], nextCursor: null });
    expect(await fetchOpenTriggers(fetchJson)).toEqual({ triggers: [openTrigger("t1"), openTrigger("t2")], complete: true });
    expect(calls).toEqual([`${OPEN_TRIGGERS_URL}&limit=${OPEN_TRIGGERS_PAGE_LIMIT}`]);
    expect(calls[0]).toBe("/api/account/triggers?status=open&limit=100");
  });

  it("服务端说还有下一页(50 条上限被改了、游标出错):complete = false,调用方据此不 retain", async () => {
    const { fetchJson } = fetchOf({ triggers: [openTrigger("t1")], nextCursor: "c1" });
    expect(await fetchOpenTriggers(fetchJson)).toEqual({ triggers: [openTrigger("t1")], complete: false });
  });

  it("请求失败:整体 reject", async () => {
    const fetchJson = async <T,>(): Promise<T> => {
      throw new Error("Service unavailable");
    };
    await expect(fetchOpenTriggers(fetchJson)).rejects.toThrow("Service unavailable");
  });
});

describe("fetchOpenOrders(开放委托翻页)", () => {
  const openOrder = (id: string): Order => ({ id, clientOrderId: null, assetId: "a", symbol: "S", side: "BUY", type: "LIMIT", price: 1, quantity: 1, filledQuantity: 0, status: "OPEN", avgFillPrice: null, cancelReason: null, createdAt: 1, updatedAt: 1 });
  const url = (cursor?: string) => `${OPEN_ORDERS_URL}&limit=${OPEN_ORDERS_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  /** pages[i] 是第 i 页;第 i 页的 nextCursor = `c${i + 1}`(最后一页 null) */
  function pagedFetch(pages: string[][], opts: { failAt?: number; endless?: boolean } = {}) {
    const calls: string[] = [];
    const fetchJson = async <T,>(u: string): Promise<T> => {
      calls.push(u);
      const i = calls.length - 1;
      if (opts.failAt === i) throw new Error("Service unavailable");
      const ids = opts.endless ? [`o${i}`] : pages[i];
      const more = opts.endless || i < pages.length - 1;
      const body: AccountOrdersResponse = { orders: ids.map(openOrder), nextCursor: more ? `c${i + 1}` : null };
      return body as T;
    };
    return { fetchJson, calls };
  }

  it("按 nextCursor 翻完:limit = 100,游标 URL 编码,顺序拼接,complete = true", async () => {
    const { fetchJson, calls } = pagedFetch([["o1", "o2"], ["o3"], ["o4"]]);
    const r = await fetchOpenOrders(fetchJson);
    expect(calls).toEqual([url(), url("c1"), url("c2")]);
    expect(r.complete).toBe(true);
    expect(r.orders.map((o) => o.id)).toEqual(["o1", "o2", "o3", "o4"]);
  });

  it("一页就完:只发一个请求", async () => {
    const { fetchJson, calls } = pagedFetch([["o1"]]);
    const r = await fetchOpenOrders(fetchJson);
    expect(calls).toEqual([url()]);
    expect(r).toEqual({ orders: [openOrder("o1")], complete: true });
  });

  it(`超过 ${OPEN_ORDERS_MAX_PAGES} 页即停:complete = false(调用方据此不 retain、不整体替换)`, async () => {
    const { fetchJson, calls } = pagedFetch([], { endless: true });
    const r = await fetchOpenOrders(fetchJson);
    expect(calls).toHaveLength(OPEN_ORDERS_MAX_PAGES);
    expect(r.complete).toBe(false);
    expect(r.orders).toHaveLength(OPEN_ORDERS_MAX_PAGES);
  });

  it("翻页中途失败:整体 reject(调用方保留现状),不返回半截结果", async () => {
    const { fetchJson, calls } = pagedFetch([["o1"], ["o2"], ["o3"]], { failAt: 1 });
    await expect(fetchOpenOrders(fetchJson)).rejects.toThrow("Service unavailable");
    expect(calls).toHaveLength(2);
  });
});
