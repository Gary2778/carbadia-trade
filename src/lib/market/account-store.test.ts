import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Balance, Fill, Me, Order, Position, ServerEvent } from "@/shared";
import { auditRefOf } from "@/shared";
import { ApiError } from "@/lib/http/client";
import {
  OPEN_ORDERS_MAX_PAGES,
  applyAccountEvents as bridgeApplyAccountEvents,
  readKnownMeId,
  readListsVersion,
  readMeId,
  registerTransportReconnect,
  requestAccountLists,
  requestAccountRefresh,
  retainOpenOrders as bridgeRetainOpenOrders,
  retainPositions as bridgeRetainPositions,
  subscribeAccount,
} from "./account-bridge";
import { readOpenOrders as leafReadOpenOrders } from "./open-orders-source";
import { readOpenOrders } from "./selectors";
import {
  AUTH_NAVIGATE_WAIT_MS,
  CLOSED_ORDERS_MAX,
  HYDRATE_RETRY_BASE_MS,
  HYDRATE_RETRY_MAX_MS,
  HYDRATE_TIMEOUT_MS,
  MAX_RECENT_FILLS,
  NAV_REFRESH_MIN_MS,
  accountActions,
  applyAccountEvent,
  applyAccountEvents,
  createInitialAccountState,
  hydrate,
  hydrateForNavigation,
  loadAccountLists,
  logout,
  openOrdersOf,
  positionsOf,
  reduceAccountEvents,
  refresh,
  refreshOnNavigation,
  retainOpenOrders,
  retainPositions,
  retryHydrateIfUnverified,
  setMe,
  useAccountStore,
  watchHydrateRetry,
  type AccountEvent,
  type FetchJson,
} from "./account-store";

// 账户 store 的行为测试(node 环境,不引 jsdom;hook 只是 useShallow 薄包装,不测):
// hydrate 三请求合并、401 / null → anon、hydrate 的超时与认证页的「hydrate 后跳转」、未确认 anon 的自愈与退避、
// 账户事件的状态迁移、logout 清空、登录 / 登出后经 account-bridge 请求传输层重连、
// 两条接缝(account-bridge、open-orders-source)已接上、以及本文件不把市场 store 拖进根布局 bundle 的依赖纪律。

const ME_URL = "/api/auth/me";
const POSITIONS_URL = "/api/account/positions";
/** 开放委托按 nextCursor 翻页,每页 100 */
const OPEN_ORDERS_URL = "/api/account/orders?status=open&limit=100";
const openOrdersPage = (cursor: string) => `${OPEN_ORDERS_URL}&cursor=${cursor}`;
const LOGOUT_URL = "/api/auth/logout";

const alice: NonNullable<Me> = { id: "u-alice", email: "alice@example.com", name: "Alice", cashBalance: 100_000_00, lockedCash: 5_000_00 };
const bob: NonNullable<Me> = { id: "u-bob", email: "bob@example.com", name: "Bob", cashBalance: 50_000_00, lockedCash: 0 };

const order = (id: string, partial: Partial<Order> = {}): Order => ({
  id,
  clientOrderId: null,
  assetId: "a-vcs",
  symbol: "VCS-FOR-2021",
  side: "BUY",
  type: "LIMIT",
  price: 7000,
  quantity: 10,
  filledQuantity: 0,
  status: "OPEN",
  avgFillPrice: null,
  cancelReason: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  ...partial,
});
const position = (assetId: string, partial: Partial<Position> = {}): Position => ({
  assetId,
  symbol: assetId === "a-vcs" ? "VCS-FOR-2021" : "GS-REN-2020",
  quantity: 20,
  locked: 5,
  available: 15,
  retired: 0,
  lastPrice: 7000,
  marketValue: 140_000,
  averagePurchasePrice: null,
  unrealisedPnl: null,
  costBasisStatus: "incomplete_ledger",
  isScenario: false,
  ...partial,
});
const fill = (id: string, ts: number): Fill => ({
  id,
  orderId: "o-1",
  symbol: "VCS-FOR-2021",
  side: "BUY",
  role: "TAKER",
  price: 7000,
  quantity: 1,
  notional: 7000,
  feeCents: 0,
  ts,
  auditRef: auditRefOf(id),
  ledgerRefs: [],
});

const orderEvent = (o: Order, seq = 1): AccountEvent => ({ t: "order", topic: "account", seq, order: o });
const fillEvent = (f: Fill, seq = 1): AccountEvent => ({ t: "fill", topic: "account", seq, fill: f });
const balanceEvent = (balance: Balance, seq = 1): AccountEvent => ({ t: "balance", topic: "account", seq, balance });
const positionEvent = (p: Position, seq = 1): AccountEvent => ({ t: "position", topic: "account", seq, position: p });

/** 按 URL 应答的假 fetchJson:值可以是数据、Error(抛出)或 Promise(测试自己决定何时回)。不理会 init.signal —— 超时要靠 hydrate 自己结束 */
type Responder = unknown | Error | (() => Promise<unknown>);
function fakeFetch(routes: Record<string, Responder>) {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const fetchJson: FetchJson = async <T,>(url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return (await (r as () => Promise<unknown>)()) as T;
    return r as T;
  };
  return { fetchJson, calls, inits };
}
/** 连接接受了但永远不回 */
const never = (): Promise<never> => new Promise<never>(() => {});
/** 事件监听 / 定时器里发起的 hydrate 不返回 promise:排空微任务(假定时器不接管微任务) */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const loggedIn = (me: NonNullable<Me>, extra: Record<string, Responder> = {}) =>
  fakeFetch({
    [ME_URL]: me,
    [POSITIONS_URL]: { positions: [position("a-vcs"), position("a-gs")], balance: { cashBalance: me.cashBalance - 100, lockedCash: me.lockedCash + 100 } },
    [OPEN_ORDERS_URL]: { orders: [order("o-1"), order("o-2", { symbol: "GS-REN-2020", assetId: "a-gs", createdAt: 2_000, updatedAt: 2_000 })], nextCursor: null },
    ...extra,
  });

/** 把 store 设成已登录的 alice(不经网络) */
function seedAlice() {
  useAccountStore.setState({
    me: { ...alice },
    balance: { cashBalance: alice.cashBalance, lockedCash: alice.lockedCash },
    openOrders: new Map([["o-1", order("o-1")]]),
    positions: new Map([["a-vcs", position("a-vcs")]]),
    recentFills: [fill("f-0", 10)],
    status: "ready",
  });
}

beforeEach(() => {
  useAccountStore.setState(createInitialAccountState(), true);
  registerTransportReconnect(null);
});

describe("hydrate", () => {
  it("merges /api/auth/me + positions + open orders into one ready state with exactly three requests", async () => {
    const { fetchJson, calls } = loggedIn(alice);
    const p = hydrate(fetchJson);
    expect(useAccountStore.getState().status).toBe("loading");
    await p;
    const s = useAccountStore.getState();
    expect(calls).toEqual([ME_URL, POSITIONS_URL, OPEN_ORDERS_URL]);
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-alice");
    // 余额以 positions 快照为准(与持仓同一事务读出),并镜像进 me
    expect(s.balance).toEqual({ cashBalance: alice.cashBalance - 100, lockedCash: alice.lockedCash + 100 });
    expect(s.me?.cashBalance).toBe(alice.cashBalance - 100);
    expect([...s.openOrders.keys()]).toEqual(["o-1", "o-2"]);
    expect(s.openOrders.get("o-2")?.symbol).toBe("GS-REN-2020");
    expect([...s.positions.keys()]).toEqual(["a-vcs", "a-gs"]);
    expect(s.recentFills).toEqual([]);
  });

  it("treats a null /api/auth/me as anonymous and does not touch the account endpoints", async () => {
    const { fetchJson, calls } = fakeFetch({ [ME_URL]: null });
    await hydrate(fetchJson);
    const s = useAccountStore.getState();
    expect(calls).toEqual([ME_URL]);
    expect(s.status).toBe("anon");
    expect(s.me).toBeNull();
    expect(s.balance).toBeNull();
    expect(s.openOrders.size).toBe(0);
    expect(s.positions.size).toBe(0);
  });

  it("treats a 401 (or, on the first hydrate, a network failure) on /api/auth/me as anonymous", async () => {
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Not logged in", 401) }).fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Failed to fetch", 0) }).fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
    expect(useAccountStore.getState().me).toBeNull();
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Service unavailable", 503) }).fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
  });

  it("503 / network failure on /api/auth/me keeps an already-ready user ready and does not reconnect", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    seedAlice();
    const before = useAccountStore.getState();
    for (const err of [new ApiError("Service unavailable", 503), new ApiError("Failed to fetch", 0), new ApiError("Failed to parse response", 502)]) {
      const { fetchJson, calls } = fakeFetch({ [ME_URL]: err });
      await hydrate(fetchJson);
      expect(calls).toEqual([ME_URL]);
      // 整个状态对象原样保留:挂单 / 持仓 / 成交 / 余额不清空,status 不闪
      expect(useAccountStore.getState()).toBe(before);
    }
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("an anonymous visitor whose re-hydrate (only done after login / register / demo) fails transiently stays anonymous on screen but unverified, so it retries later (no reconnect)", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Service unavailable", 503) }).fetchJson);
    const s = useAccountStore.getState();
    expect(s.status).toBe("anon");
    expect(s.me).toBeNull();
    expect(s.unverified?.attempts).toBe(1);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("a 401 on /api/auth/me for an already-ready user logs out locally and reconnects once", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    seedAlice();
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Not logged in", 401) }).fetchJson);
    const s = useAccountStore.getState();
    expect(s.status).toBe("anon");
    expect(s.me).toBeNull();
    expect(s.openOrders.size).toBe(0);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("falls back to anonymous when an account endpoint answers 401 (session expired between calls)", async () => {
    const { fetchJson } = loggedIn(alice, { [OPEN_ORDERS_URL]: new ApiError("Not logged in", 401) });
    await hydrate(fetchJson);
    const s = useAccountStore.getState();
    expect(s.status).toBe("anon");
    expect(s.me).toBeNull();
    expect(s.positions.size).toBe(0);
  });

  it("keeps the login and balance from /api/auth/me when an account endpoint fails for another reason", async () => {
    seedAlice();
    const before = useAccountStore.getState();
    const { fetchJson } = loggedIn(alice, { [POSITIONS_URL]: new ApiError("Service unavailable", 503) });
    await hydrate(fetchJson);
    const s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-alice");
    expect(s.balance).toEqual({ cashBalance: alice.cashBalance, lockedCash: alice.lockedCash });
    // 持仓 / 挂单保留现状,等下一次 hydrate 或轮询补上
    expect(s.openOrders).toBe(before.openOrders);
    expect(s.positions).toBe(before.positions);
  });

  it("does not drop to loading when re-hydrating an already known state (no flicker in Nav)", async () => {
    seedAlice();
    const { fetchJson } = loggedIn(alice);
    const p = hydrate(fetchJson);
    expect(useAccountStore.getState().status).toBe("ready");
    await p;
    expect(useAccountStore.getState().status).toBe("ready");
  });

  it("discards a stale in-flight response once a newer hydrate or a logout has happened", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = fakeFetch({ [ME_URL]: () => gate.then(() => alice) });
    const first = hydrate(slow.fetchJson);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
    release();
    await first;
    expect(useAccountStore.getState().status).toBe("anon");
    expect(useAccountStore.getState().me).toBeNull();
    expect(slow.calls).toEqual([ME_URL]);
  });

  it("is exposed on accountActions with the same behaviour", async () => {
    await accountActions.hydrate(loggedIn(bob).fetchJson);
    expect(useAccountStore.getState().me?.id).toBe("u-bob");
  });
});

describe("hydrate: open orders beyond the first page", () => {
  it("follows nextCursor to the last page and replaces openOrders with the union of all pages", async () => {
    seedAlice();
    applyAccountEvent(orderEvent(order("o-gone", { createdAt: 500 }))); // 已不在服务端挂单里:整体替换时移除
    const { fetchJson, calls } = loggedIn(alice, {
      [OPEN_ORDERS_URL]: { orders: [order("o-1")], nextCursor: "c1" },
      [openOrdersPage("c1")]: { orders: [order("o-51")], nextCursor: "c2" },
      [openOrdersPage("c2")]: { orders: [order("o-101")], nextCursor: null },
    });
    await hydrate(fetchJson);
    expect(calls).toEqual([ME_URL, POSITIONS_URL, OPEN_ORDERS_URL, openOrdersPage("c1"), openOrdersPage("c2")]);
    expect([...useAccountStore.getState().openOrders.keys()].sort()).toEqual(["o-1", "o-101", "o-51"]);
  });

  it(`stops after ${OPEN_ORDERS_MAX_PAGES} pages and then only upserts what it got (no replace: the rest may still be open)`, async () => {
    seedAlice();
    applyAccountEvent(orderEvent(order("o-kept", { createdAt: 500 })));
    const routes: Record<string, Responder> = {};
    for (let i = 0; i < OPEN_ORDERS_MAX_PAGES + 5; i++) {
      routes[i === 0 ? OPEN_ORDERS_URL : openOrdersPage(`c${i}`)] = { orders: [order(`o-p${i}`)], nextCursor: `c${i + 1}` };
    }
    const { fetchJson, calls } = loggedIn(alice, routes);
    await hydrate(fetchJson);
    const ids = [...useAccountStore.getState().openOrders.keys()];
    expect(calls.filter((u) => u.startsWith(OPEN_ORDERS_URL))).toHaveLength(OPEN_ORDERS_MAX_PAGES);
    expect(ids).toContain("o-kept");
    expect(ids).toContain("o-1");
    expect(ids).toContain(`o-p${OPEN_ORDERS_MAX_PAGES - 1}`);
    expect(ids).not.toContain(`o-p${OPEN_ORDERS_MAX_PAGES}`);
  });

  it("a failure on a later page keeps openOrders (and positions) as they were; still ready with the balance from /api/auth/me", async () => {
    seedAlice();
    const before = useAccountStore.getState();
    const { fetchJson } = loggedIn(alice, {
      [OPEN_ORDERS_URL]: { orders: [order("o-9")], nextCursor: "c1" },
      [openOrdersPage("c1")]: new ApiError("Service unavailable", 503),
    });
    await hydrate(fetchJson);
    const s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.openOrders).toBe(before.openOrders);
    expect(s.positions).toBe(before.positions);
  });

  it("a 401 on a later page means the session expired: anonymous", async () => {
    seedAlice();
    const { fetchJson } = loggedIn(alice, {
      [OPEN_ORDERS_URL]: { orders: [order("o-9")], nextCursor: "c1" },
      [openOrdersPage("c1")]: new ApiError("Not logged in", 401),
    });
    await hydrate(fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
  });
});

describe("light hydrate (\"me\"): Nav, the auth pages and the self-heal need identity and balance only", () => {
  it("requests only /api/auth/me; balance comes from it; a same-user refresh keeps the lists, another user's clears them", async () => {
    seedAlice();
    const before = useAccountStore.getState();
    const { fetchJson, calls } = loggedIn({ ...alice, cashBalance: 12_300, lockedCash: 45 });
    const p = hydrate(fetchJson, "me");
    expect(useAccountStore.getState().status).toBe("ready"); // 已知状态重刷不闪
    await p;
    expect(calls).toEqual([ME_URL]);
    const s = useAccountStore.getState();
    expect(s.balance).toEqual({ cashBalance: 12_300, lockedCash: 45 });
    expect(s.me?.cashBalance).toBe(12_300);
    expect(s.openOrders).toBe(before.openOrders);
    expect(s.positions).toBe(before.positions);
    expect(s.recentFills).toBe(before.recentFills);
    await hydrate(loggedIn(bob).fetchJson, "me");
    expect(useAccountStore.getState().me?.id).toBe("u-bob");
    expect(useAccountStore.getState().openOrders.size).toBe(0);
    expect(useAccountStore.getState().positions.size).toBe(0);
  });

  it("from idle: loading, then ready with empty lists (the terminal loads them itself); null / 401 → anon", async () => {
    const { fetchJson, calls } = loggedIn(alice);
    const p = hydrate(fetchJson, "me");
    expect(useAccountStore.getState().status).toBe("loading");
    await p;
    expect(calls).toEqual([ME_URL]);
    expect(useAccountStore.getState()).toMatchObject({ status: "ready", balance: { cashBalance: alice.cashBalance, lockedCash: alice.lockedCash } });
    expect(useAccountStore.getState().openOrders.size).toBe(0);
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Not logged in", 401) }).fetchJson, "me");
    expect(useAccountStore.getState().status).toBe("anon");
  });

  it("hydrateForNavigation (login / register / demo) and the self-heal retry are light too", async () => {
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    const nav = loggedIn(alice);
    await hydrateForNavigation(nav.fetchJson);
    expect(nav.calls).toEqual([ME_URL]);
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Failed to fetch", 0) }).fetchJson);
    const retry = loggedIn(alice);
    await retryHydrateIfUnverified(retry.fetchJson);
    expect(retry.calls).toEqual([ME_URL]);
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
  });
});

describe("refreshOnNavigation (Nav's path effect): keeps cash and login fresh outside the terminal, like main's per-path /me", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a ready user moving to a non-/trade path: /api/auth/me is fetched and the new cashBalance lands in the store", async () => {
    await hydrate(loggedIn(alice).fetchJson, "me"); // Nav 挂载那次
    vi.advanceTimersByTime(NAV_REFRESH_MIN_MS);
    const { fetchJson, calls } = loggedIn({ ...alice, cashBalance: alice.cashBalance - 120_00 });
    const p = accountActions.refreshOnNavigation("/portfolio", fetchJson);
    expect(p).not.toBeNull();
    await p;
    expect(calls).toEqual([ME_URL]);
    expect(useAccountStore.getState().balance?.cashBalance).toBe(alice.cashBalance - 120_00);
    expect(useAccountStore.getState().me?.cashBalance).toBe(alice.cashBalance - 120_00);
  });

  it(`throttled to one per ${NAV_REFRESH_MIN_MS / 1000} s (counting any hydrate); never under /trade, where MarketProvider's push / poll owns freshness`, async () => {
    await hydrate(loggedIn(alice).fetchJson, "me");
    const probe = loggedIn(alice);
    vi.advanceTimersByTime(NAV_REFRESH_MIN_MS - 1);
    expect(refreshOnNavigation("/otc", probe.fetchJson)).toBeNull();
    vi.advanceTimersByTime(1);
    for (const path of ["/trade", "/trade/VCS-FOR-2021"]) expect(refreshOnNavigation(path, probe.fetchJson), path).toBeNull();
    expect(probe.calls).toEqual([]);
    const first = refreshOnNavigation("/otc", probe.fetchJson);
    expect(first).not.toBeNull();
    expect(refreshOnNavigation("/portfolio", probe.fetchJson)).toBeNull(); // 在途
    await first;
    expect(refreshOnNavigation("/portfolio", probe.fetchJson)).toBeNull(); // 刚刷过
    expect(probe.calls).toEqual([ME_URL]);
  });

  it("a confirmed anon is refreshed too (a login in another tab shows up on the next navigation); idle / loading are left to the mount hydrate", async () => {
    const probe = loggedIn(alice);
    expect(refreshOnNavigation("/otc", probe.fetchJson)).toBeNull(); // idle
    const mount = hydrate(fakeFetch({ [ME_URL]: null }).fetchJson, "me");
    expect(refreshOnNavigation("/otc", probe.fetchJson)).toBeNull(); // loading
    await mount;
    vi.advanceTimersByTime(NAV_REFRESH_MIN_MS);
    await refreshOnNavigation("/otc", probe.fetchJson);
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
  });

  it("an expired session shows up as signed out on the next navigation (401 → anon, reconnect requested)", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    await hydrate(loggedIn(alice).fetchJson, "me");
    vi.advanceTimersByTime(NAV_REFRESH_MIN_MS);
    await refreshOnNavigation("/", fakeFetch({ [ME_URL]: new ApiError("Not logged in", 401) }).fetchJson);
    expect(useAccountStore.getState()).toMatchObject({ status: "anon", me: null, balance: null });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("an unverified anon still goes through the self-heal retry, on any path (/trade included)", async () => {
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Failed to fetch", 0) }).fetchJson);
    const retry = loggedIn(alice);
    await refreshOnNavigation("/trade/VCS-FOR-2021", retry.fetchJson);
    expect(retry.calls).toEqual([ME_URL]);
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
  });
});

describe("refresh (after a legacy page changed the balance: OTC buy, simple trade, portfolio cancel; or a WS identity mismatch)", () => {
  it("fetches /api/auth/me at once, with no throttle, and supersedes a /me already in flight (it may predate the change)", async () => {
    seedAlice();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stale = hydrate(fakeFetch({ [ME_URL]: () => gate.then(() => alice) }).fetchJson, "me");
    const { fetchJson, calls } = loggedIn({ ...alice, cashBalance: 1 });
    await accountActions.refresh(fetchJson);
    expect(calls).toEqual([ME_URL]);
    expect(useAccountStore.getState().balance?.cashBalance).toBe(1);
    release();
    await stale;
    expect(useAccountStore.getState().balance?.cashBalance).toBe(1);
    expect(accountActions.refresh).toBe(refresh);
  });
});

describe("loadAccountLists (the terminal's own open orders + positions; Nav no longer pays for them)", () => {
  it("a ready user: fetches positions and every open-order page, and applies them with the balance read in the same transaction", async () => {
    await hydrate(loggedIn(alice).fetchJson, "me");
    const { fetchJson, calls } = loggedIn(alice);
    await loadAccountLists(fetchJson);
    expect(calls.sort()).toEqual([OPEN_ORDERS_URL, POSITIONS_URL].sort());
    const s = useAccountStore.getState();
    expect([...s.openOrders.keys()]).toEqual(["o-1", "o-2"]);
    expect([...s.positions.keys()]).toEqual(["a-vcs", "a-gs"]);
    expect(s.balance).toEqual({ cashBalance: alice.cashBalance - 100, lockedCash: alice.lockedCash + 100 });
    expect(s.me?.cashBalance).toBe(alice.cashBalance - 100);
  });

  it("not ready (idle, loading, anon): no request", () => {
    const probe = loggedIn(alice);
    expect(loadAccountLists(probe.fetchJson)).toBeNull();
    useAccountStore.setState({ me: null, status: "anon" });
    expect(loadAccountLists(probe.fetchJson)).toBeNull();
    expect(probe.calls).toEqual([]);
  });

  it("discarded when the lists were written while it was in flight (the WS account snapshot or a local order got there first: they are newer)", async () => {
    seedAlice();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetchJson } = loggedIn(alice, { [POSITIONS_URL]: () => gate.then(() => ({ positions: [], balance: { cashBalance: 1, lockedCash: 0 } })) });
    const p = loadAccountLists(fetchJson);
    applyAccountEvent(orderEvent(order("o-ws", { createdAt: 9_000 }))); // WS 快照 / 本地下单先落地
    const afterWs = useAccountStore.getState();
    release();
    await p;
    expect(useAccountStore.getState()).toBe(afterWs);
  });

  it("discarded when the identity changed meanwhile; a 401 settles the identity through a light hydrate", async () => {
    seedAlice();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const p = loadAccountLists(loggedIn(alice, { [POSITIONS_URL]: () => gate.then(() => ({ positions: [position("a-gs")], balance: { cashBalance: 1, lockedCash: 0 } })) }).fetchJson);
    setMe(bob);
    release();
    await p;
    expect(useAccountStore.getState().positions.size).toBe(0);
    const expired = fakeFetch({ [POSITIONS_URL]: new ApiError("Not logged in", 401), [OPEN_ORDERS_URL]: new ApiError("Not logged in", 401), [ME_URL]: new ApiError("Not logged in", 401) });
    await loadAccountLists(expired.fetchJson);
    await settle();
    expect(expired.calls).toContain(ME_URL);
    expect(useAccountStore.getState().status).toBe("anon");
  });

  it("orders already finished locally are not brought back by the snapshot", async () => {
    seedAlice();
    applyAccountEvent(orderEvent(order("o-2", { status: "CANCELLED" })));
    await loadAccountLists(loggedIn(alice).fetchJson);
    expect([...useAccountStore.getState().openOrders.keys()]).toEqual(["o-1"]);
  });
});

describe("hydrate timeout (a request the server accepted but never answers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("gives up after HYDRATE_TIMEOUT_MS when /api/auth/me hangs: aborts the request and lands on an unverified anon (due for a retry at once)", async () => {
    const { fetchJson, calls, inits } = fakeFetch({ [ME_URL]: never });
    let done = false;
    void hydrate(fetchJson).then(() => (done = true));
    await settle();
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS - 1);
    await settle();
    expect(done).toBe(false);
    expect(useAccountStore.getState().status).toBe("loading");
    expect(inits[0]?.signal?.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    await settle();
    expect(done).toBe(true);
    expect(calls).toEqual([ME_URL]);
    expect(inits[0]?.signal?.aborted).toBe(true);
    const s = useAccountStore.getState();
    expect(s.status).toBe("anon");
    expect(s.me).toBeNull();
    expect(s.unverified).toEqual({ attempts: 1, retryAt: Date.now() });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("one deadline covers the whole hydrate: a hang on a later open-orders page ends in ready with the balance from /api/auth/me; a ready user whose /me hangs stays ready", async () => {
    seedAlice();
    const before = useAccountStore.getState();
    const { fetchJson, inits } = loggedIn(alice, {
      [OPEN_ORDERS_URL]: { orders: [order("o-9")], nextCursor: "c1" },
      [openOrdersPage("c1")]: never,
    });
    const p = hydrate(fetchJson);
    await settle(); // 第二页已发出、挂住
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS);
    await p;
    let s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.balance).toEqual({ cashBalance: alice.cashBalance, lockedCash: alice.lockedCash });
    expect(s.openOrders).toBe(before.openOrders);
    expect(s.positions).toBe(before.positions);
    // 每个请求都带同一个 signal,超时时一起 abort
    expect(inits).toHaveLength(4);
    expect(new Set(inits.map((i) => i?.signal)).size).toBe(1);
    expect(inits[0]?.signal?.aborted).toBe(true);

    const ready = useAccountStore.getState();
    const hung = hydrate(fakeFetch({ [ME_URL]: never }).fetchJson);
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS);
    await hung;
    s = useAccountStore.getState();
    expect(s).toBe(ready);
  });

  it("the default http client gets the signal, so the real fetch is aborted too (fetch stubbed to hang until aborted)", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) return never();
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    });
    const p = hydrate();
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS);
    await p;
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(true);
    expect(useAccountStore.getState().unverified?.attempts).toBe(1);
  });

  it("clears its deadline once the hydrate settles (no timer left behind)", async () => {
    await hydrate(loggedIn(alice).fetchJson);
    expect(useAccountStore.getState().status).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the requests an early Promise.all rejection leaves behind (positions 500 while the open orders still page): aborted when the hydrate settles, no further page", async () => {
    let answerFirstPage!: (page: unknown) => void;
    const { fetchJson, calls, inits } = loggedIn(alice, {
      [POSITIONS_URL]: new ApiError("Internal error", 500),
      [OPEN_ORDERS_URL]: () => new Promise((resolve) => (answerFirstPage = resolve)),
      [openOrdersPage("c1")]: { orders: [], nextCursor: null },
    });
    await hydrate(fetchJson);
    // 持仓 500:仍按 me 标记 ready(持仓 / 挂单保留现状)
    expect(useAccountStore.getState().status).toBe("ready");
    const ordersInit = inits[calls.indexOf(OPEN_ORDERS_URL)];
    expect(ordersInit?.signal?.aborted).toBe(true); // hydrate 结束即取消,不再无期限地挂着
    expect(vi.getTimerCount()).toBe(0);
    // 那一页之后才回来(不理会 signal 的请求函数):也不会再去翻下一页
    answerFirstPage({ orders: [order("o-9")], nextCursor: "c1" });
    await settle();
    expect(calls).not.toContain(openOrdersPage("c1"));
    expect(useAccountStore.getState().openOrders.has("o-9")).toBe(false);
  });
});

describe("hydrateForNavigation (login / register / demo: refresh the store, then router.push)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves as soon as the hydrate settles, with the new identity already in the store, and leaves no timer behind", async () => {
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    await hydrateForNavigation(loggedIn(alice).fetchJson);
    expect(useAccountStore.getState().status).toBe("ready");
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never holds the navigation longer than AUTH_NAVIGATE_WAIT_MS; the hydrate carries on, times out into an unverified anon and watchHydrateRetry heals it", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson); // Nav 挂载时:未登录的访客
    // 登录成功后那一次 /api/auth/me 挂住,之后正常
    let meCalls = 0;
    const { fetchJson, calls } = loggedIn(alice, { [ME_URL]: () => (++meCalls === 1 ? never() : Promise.resolve(alice)) });
    onTestFinished(watchHydrateRetry({ target: win, document: doc, fetchJson }));

    let navigated = false;
    void hydrateForNavigation(fetchJson).then(() => (navigated = true));
    vi.advanceTimersByTime(AUTH_NAVIGATE_WAIT_MS - 1);
    await settle();
    expect(navigated).toBe(false);
    vi.advanceTimersByTime(1);
    await settle();
    expect(navigated).toBe(true); // 登录页不再停在忙碌态:router.push 照常发生

    // 跳转后的路径变化:hydrate 还在途、仍是确认的 anon,空操作
    expect(retryHydrateIfUnverified(fetchJson)).toBeNull();
    expect(useAccountStore.getState().me).toBeNull();

    // hydrate 自己的超时到点 → unverified(非重试来源,从 1 计,立即到期)→ watchHydrateRetry 的定时器重试 → 找回用户
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS - AUTH_NAVIGATE_WAIT_MS);
    await settle();
    vi.advanceTimersByTime(0);
    await settle();
    const s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-alice");
    expect(s.unverified).toBeNull();
    expect(calls.filter((u) => u === ME_URL)).toHaveLength(2);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("is exposed on accountActions", () => {
    expect(accountActions.hydrateForNavigation).toBe(hydrateForNavigation);
  });
});

describe("unverified anonymous state (/api/auth/me failed transiently while not ready)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const transient = () => fakeFetch({ [ME_URL]: new ApiError("Failed to fetch", 0) });

  it("marks the anon as unverified, due for its first retry at once; 401 and null are confirmed anonymous", async () => {
    await hydrate(transient().fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: 1_000_000 });
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Not logged in", 401) }).fetchJson);
    expect(useAccountStore.getState().unverified).toBeNull();
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    expect(useAccountStore.getState().unverified).toBeNull();
  });

  it("ready never becomes unverified on a blip; a confirmed anon that fails to re-confirm (the hydrate after login) does", async () => {
    seedAlice();
    await hydrate(transient().fetchJson);
    expect(useAccountStore.getState().status).toBe("ready");
    expect(useAccountStore.getState().unverified).toBeNull();
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    expect(useAccountStore.getState().unverified).toBeNull();
    await hydrate(transient().fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: 1_000_000 });
  });

  it("login whose follow-up hydrate blips: the path change right after router.push retries /me exactly once, finds the user and reconnects once (the socket may be anonymous)", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    // /api/auth/me:登录页那次撞上瞬时故障,之后正常
    let meCalls = 0;
    const { fetchJson, calls } = loggedIn(alice, { [ME_URL]: () => (++meCalls === 1 ? Promise.reject(new ApiError("Failed to fetch", 0)) : Promise.resolve(alice)) });
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson); // Nav 挂载时:未登录的访客
    const stop = watchHydrateRetry({ target: win, document: doc, fetchJson });
    await hydrate(fetchJson); // 登录成功后 login 页的 hydrate
    expect(useAccountStore.getState().me).toBeNull();
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: Date.now() });

    const retried = retryHydrateIfUnverified(fetchJson); // router.push(returnTo) → Nav 的路径 effect,不等退避
    expect(retried).not.toBeNull();
    expect(retryHydrateIfUnverified(fetchJson)).toBeNull(); // 同一拍的其它触发
    vi.advanceTimersByTime(0); // watchHydrateRetry 的定时器也到点了:重试在途,不再发
    win.dispatchEvent(new Event("online"));
    await retried;
    const s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-alice");
    expect(s.unverified).toBeNull();
    expect(calls.filter((u) => u === ME_URL)).toHaveLength(2); // 登录页那次 + 恰好一次重试
    expect(reconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HYDRATE_RETRY_MAX_MS);
    expect(calls.filter((u) => u === ME_URL)).toHaveLength(2);
    stop();
  });

  it("a first-load blip on a page the user never leaves heals by watchHydrateRetry's timer alone (no path change, online or visibility event)", async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    let meCalls = 0;
    const { fetchJson, calls } = loggedIn(alice, { [ME_URL]: () => (++meCalls <= 2 ? Promise.reject(new ApiError("Service unavailable", 503)) : Promise.resolve(alice)) });
    const stop = watchHydrateRetry({ target: win, document: doc, fetchJson });
    await hydrate(fetchJson); // Nav 挂载时的首次 hydrate:503
    vi.advanceTimersByTime(0); // 第一次重试立即到点:又 503
    await settle();
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 2, retryAt: Date.now() + HYDRATE_RETRY_BASE_MS });
    vi.advanceTimersByTime(HYDRATE_RETRY_BASE_MS); // 2 s 后:成功
    await settle();
    const s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-alice");
    expect(s.unverified).toBeNull();
    expect(calls.filter((u) => u === ME_URL)).toHaveLength(3);
    vi.advanceTimersByTime(HYDRATE_RETRY_MAX_MS);
    expect(calls.filter((u) => u === ME_URL)).toHaveLength(3);
    stop();
  });

  it("retryHydrateIfUnverified is a no-op unless the anon is unverified and its retry is due", async () => {
    // idle / ready / 确认的 anon:不发请求
    const probe = loggedIn(alice);
    expect(retryHydrateIfUnverified(probe.fetchJson)).toBeNull();
    seedAlice();
    expect(retryHydrateIfUnverified(probe.fetchJson)).toBeNull();
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    expect(retryHydrateIfUnverified(probe.fetchJson)).toBeNull();
    expect(probe.calls).toEqual([]);

    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(transient().fetchJson);
    await retryHydrateIfUnverified(transient().fetchJson); // 第一次重试立即可发;又失败 → 退避 2 s
    // 退避未到:路径变化 / online / 可见都不拉
    vi.advanceTimersByTime(HYDRATE_RETRY_BASE_MS - 1);
    expect(retryHydrateIfUnverified(probe.fetchJson)).toBeNull();
    expect(probe.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    const due = retryHydrateIfUnverified(probe.fetchJson);
    expect(due).not.toBeNull();
    await due;
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
  });

  it("self-heals: one request even if several triggers fire together; reconnects once (unverified anon counts as a known null identity)", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    await hydrate(transient().fetchJson);
    const { fetchJson, calls } = loggedIn(alice);
    const first = retryHydrateIfUnverified(fetchJson);
    expect(first).not.toBeNull();
    expect(retryHydrateIfUnverified(fetchJson)).toBeNull(); // online + visibilitychange 同一拍
    await first;
    const s = useAccountStore.getState();
    expect(calls.filter((u) => u === ME_URL)).toHaveLength(1);
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-alice");
    expect(s.unverified).toBeNull();
    // 客户端分不清「cookie 一直有效、只是 /me 抖了」与「当时确实未登录、之后登录了」,后者的 socket 是匿名建的:重连一次
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("a retry in flight blocks further retries only until it times out (HYDRATE_TIMEOUT_MS, a failure on the retry chain); a newer hydrate (the login page's) takes over at once", async () => {
    await hydrate(transient().fetchJson);
    const hang = fakeFetch({ [ME_URL]: never });
    const hanging = retryHydrateIfUnverified(hang.fetchJson);
    expect(hanging).not.toBeNull();
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS - 1);
    expect(retryHydrateIfUnverified(hang.fetchJson)).toBeNull();
    expect(hang.calls).toEqual([ME_URL]);
    vi.advanceTimersByTime(1);
    await hanging;
    // 超时 = 重试链上的又一次失败:次数累加,按退避再试
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 2, retryAt: Date.now() + HYDRATE_RETRY_BASE_MS });
    vi.advanceTimersByTime(HYDRATE_RETRY_BASE_MS);
    const again = retryHydrateIfUnverified(hang.fetchJson);
    expect(again).not.toBeNull();
    expect(hang.calls).toEqual([ME_URL, ME_URL]);

    await hydrate(transient().fetchJson); // 登录页的 hydrate 取代了在途的重试(又抖了一次):不是重试链,从 1 计
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: Date.now() });
    const next = retryHydrateIfUnverified(loggedIn(alice).fetchJson);
    expect(next).not.toBeNull();
    await next;
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS);
    await again; // 过期的结果(超时)丢弃
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
    expect(useAccountStore.getState().unverified).toBeNull();
  });

  it("attempts accumulate only along the retry chain: after a long run of failed retries, a failed hydrate after login starts again at 1, so the path change right after router.push retries at once", async () => {
    await hydrate(transient().fetchJson); // 首屏(Nav 挂载)失败:1
    for (let attempt = 2; attempt <= 7; attempt++) {
      vi.setSystemTime(useAccountStore.getState().unverified!.retryAt);
      await retryHydrateIfUnverified(transient().fetchJson);
    }
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 7, retryAt: Date.now() + HYDRATE_RETRY_MAX_MS });

    // 访客随后登录成功,登录页那次 hydrate 的 /api/auth/me 抖了一下
    await hydrate(transient().fetchJson);
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: Date.now() });

    // router.push(returnTo) → Nav 的路径 effect:不用等 60 s
    const retried = retryHydrateIfUnverified(loggedIn(alice).fetchJson);
    expect(retried).not.toBeNull();
    await retried;
    expect(useAccountStore.getState().status).toBe("ready");
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
  });

  it("a retry that comes due while the login page's hydrate is still in flight waits for it instead of superseding it (the pre-login attempt count is never carried over)", async () => {
    await hydrate(transient().fetchJson); // 访客期:首屏失败,1
    for (let attempt = 2; attempt <= 7; attempt++) {
      vi.setSystemTime(useAccountStore.getState().unverified!.retryAt);
      await retryHydrateIfUnverified(transient().fetchJson);
    }
    const chain = useAccountStore.getState().unverified!;
    expect(chain).toEqual({ attempts: 7, retryAt: Date.now() + HYDRATE_RETRY_MAX_MS });

    // 登录成功,登录页的 hydrate 发出 /api/auth/me,响应迟迟不回
    let failMe!: (err: Error) => void;
    const login = hydrate(fakeFetch({ [ME_URL]: () => new Promise((_resolve, reject) => (failMe = reject)) }).fetchJson);
    // 访客期那条链的 retryAt 到了(watchHydrateRetry 的定时器 / 路径变化):登录页那次还在途,不插队、不发请求
    vi.setSystemTime(chain.retryAt);
    const probe = transient();
    expect(retryHydrateIfUnverified(probe.fetchJson)).toBeNull();
    expect(probe.calls).toEqual([]);

    // 登录页那次的 /me 抖了:它是非重试来源,从 1 计、立即可重试 —— 不是 7 → 8 的 60 s 退避
    failMe(new ApiError("Failed to fetch", 0));
    await login;
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: Date.now() });
    // router.push(returnTo) 之后的路径变化:立刻重试,找回用户
    const retried = retryHydrateIfUnverified(loggedIn(alice).fetchJson);
    expect(retried).not.toBeNull();
    await retried;
    expect(useAccountStore.getState().status).toBe("ready");
    expect(useAccountStore.getState().me?.id).toBe("u-alice");
  });

  it("the same wait when the in-flight login hydrate succeeds: the blocked retry never ran, so nothing overwrites the logged-in state", async () => {
    await hydrate(transient().fetchJson);
    let answerMe!: (me: unknown) => void;
    const { fetchJson } = loggedIn(alice, { [ME_URL]: () => new Promise((resolve) => (answerMe = resolve)) });
    const login = hydrate(fetchJson);
    const probe = transient();
    expect(retryHydrateIfUnverified(probe.fetchJson)).toBeNull(); // 第一次失败后本来「立即可重试」,但最新的 hydrate 在途
    answerMe(alice);
    await login;
    await settle();
    expect(probe.calls).toEqual([]);
    expect(useAccountStore.getState().status).toBe("ready");
    expect(useAccountStore.getState().unverified).toBeNull();
  });

  it("a failed mount hydrate also starts at 1, whatever an earlier chain had reached", async () => {
    useAccountStore.setState({ me: null, status: "anon", unverified: { attempts: 9, retryAt: Date.now() + HYDRATE_RETRY_MAX_MS } });
    await hydrate(fakeFetch({ [ME_URL]: new ApiError("Service unavailable", 503) }).fetchJson);
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: Date.now() });
  });

  it("backs off: at once after the first failure, then 2 s, 4 s … capped at HYDRATE_RETRY_MAX_MS; a 401 then confirms the anon", async () => {
    await hydrate(transient().fetchJson);
    let expected = 0;
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 1, retryAt: Date.now() + expected });
    for (let attempt = 2; attempt <= 8; attempt++) {
      vi.advanceTimersByTime(expected);
      await retryHydrateIfUnverified(transient().fetchJson);
      expected = Math.min(HYDRATE_RETRY_BASE_MS * 2 ** (attempt - 2), HYDRATE_RETRY_MAX_MS);
      expect(useAccountStore.getState().unverified).toEqual({ attempts: attempt, retryAt: Date.now() + expected });
    }
    expect(expected).toBe(HYDRATE_RETRY_MAX_MS);
    vi.advanceTimersByTime(expected);
    await retryHydrateIfUnverified(fakeFetch({ [ME_URL]: new ApiError("Not logged in", 401) }).fetchJson);
    expect(useAccountStore.getState().status).toBe("anon");
    expect(useAccountStore.getState().unverified).toBeNull();
  });

  it("watchHydrateRetry: its timer retries at each retryAt; online and becoming visible retry too; a hidden page waits for visibilitychange; cleanup removes the listeners and the pending timer", async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    const { fetchJson, calls } = fakeFetch({ [ME_URL]: new ApiError("Failed to fetch", 0) });
    const stop = watchHydrateRetry({ target: win, document: doc, fetchJson });
    await hydrate(fetchJson);
    expect(calls).toHaveLength(1);

    // 定时器:第一次失败后立即,之后按退避到点
    vi.advanceTimersByTime(0);
    expect(calls).toHaveLength(2);
    await settle();
    expect(useAccountStore.getState().unverified).toEqual({ attempts: 2, retryAt: Date.now() + HYDRATE_RETRY_BASE_MS });
    vi.advanceTimersByTime(HYDRATE_RETRY_BASE_MS - 1);
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(3);
    await settle();
    expect(useAccountStore.getState().unverified?.attempts).toBe(3);

    // 后台:到点不拉,变为 hidden 的 visibilitychange 也不拉;回到前台补上
    doc.visibilityState = "hidden";
    vi.advanceTimersByTime(2 * HYDRATE_RETRY_BASE_MS);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(3);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(4);
    await settle();
    expect(useAccountStore.getState().unverified?.attempts).toBe(4);

    // online(页面在后台、定时器到点不拉时,只有它能触发)
    doc.visibilityState = "hidden";
    vi.advanceTimersByTime(4 * HYDRATE_RETRY_BASE_MS);
    expect(calls).toHaveLength(4);
    win.dispatchEvent(new Event("online"));
    expect(calls).toHaveLength(5);
    await settle();
    expect(useAccountStore.getState().unverified?.attempts).toBe(5);

    stop();
    doc.visibilityState = "visible";
    vi.advanceTimersByTime(HYDRATE_RETRY_MAX_MS);
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(5);
  });

  it("is exposed on accountActions", () => {
    expect(accountActions.retryHydrateIfUnverified).toBe(retryHydrateIfUnverified);
  });
});

describe("transport reconnect after login / logout", () => {
  it("does not reconnect on the very first hydrate (the socket was already authenticated by the cookie)", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    await hydrate(loggedIn(alice).fetchJson);
    expect(reconnect).not.toHaveBeenCalled();
    useAccountStore.setState(createInitialAccountState(), true);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it("reconnects once when the identity changes: anon → user, user → other user, user → anon; not on same-user refresh", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    await hydrate(loggedIn(alice).fetchJson);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await hydrate(loggedIn(alice).fetchJson);
    expect(reconnect).toHaveBeenCalledTimes(1);
    applyAccountEvent({ t: "fill", topic: "account", seq: 1, fill: fill("f-1", 1) });
    await hydrate(loggedIn(bob).fetchJson);
    expect(reconnect).toHaveBeenCalledTimes(2);
    // 换用户:上一位的成交不能留在列表里
    expect(useAccountStore.getState().recentFills).toEqual([]);
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson);
    expect(reconnect).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when nothing is registered", async () => {
    seedAlice();
    await expect(logout(fakeFetch({ [LOGOUT_URL]: { loggedOut: true } }).fetchJson)).resolves.toBeUndefined();
  });
});

describe("applyAccountEvent", () => {
  beforeEach(seedAlice);

  it("moves orders in and out of openOrders by status", () => {
    applyAccountEvent(orderEvent(order("o-2", { createdAt: 2_000 })));
    expect([...useAccountStore.getState().openOrders.keys()]).toEqual(["o-1", "o-2"]);
    applyAccountEvent(orderEvent(order("o-2", { status: "PARTIAL", filledQuantity: 3, createdAt: 2_000 })));
    expect(useAccountStore.getState().openOrders.get("o-2")?.filledQuantity).toBe(3);
    applyAccountEvent(orderEvent(order("o-2", { status: "FILLED", filledQuantity: 10, createdAt: 2_000 })));
    expect(useAccountStore.getState().openOrders.has("o-2")).toBe(false);
    applyAccountEvent(orderEvent(order("o-1", { status: "CANCELLED", cancelReason: "USER" })));
    expect(useAccountStore.getState().openOrders.size).toBe(0);
  });

  it("leaves the openOrders reference alone when a terminal-status order was never open here", () => {
    const before = useAccountStore.getState().openOrders;
    applyAccountEvent(orderEvent(order("o-unknown", { status: "FILLED" })));
    expect(useAccountStore.getState().openOrders).toBe(before);
  });

  it("prepends fills newest-first, dedupes by id and caps at MAX_RECENT_FILLS", () => {
    applyAccountEvent(fillEvent(fill("f-1", 20)));
    applyAccountEvent(fillEvent(fill("f-2", 30)));
    applyAccountEvent(fillEvent(fill("f-1", 20)));
    expect(useAccountStore.getState().recentFills.map((f) => f.id)).toEqual(["f-2", "f-1", "f-0"]);
    for (let i = 0; i < MAX_RECENT_FILLS + 10; i++) applyAccountEvent(fillEvent(fill(`bulk-${i}`, 100 + i)));
    const fills = useAccountStore.getState().recentFills;
    expect(fills).toHaveLength(MAX_RECENT_FILLS);
    expect(fills[0].id).toBe(`bulk-${MAX_RECENT_FILLS + 9}`);
  });

  it("replaces the balance and mirrors it into me (Nav reads either)", () => {
    applyAccountEvent(balanceEvent({ cashBalance: 42, lockedCash: 7 }));
    const s = useAccountStore.getState();
    expect(s.balance).toEqual({ cashBalance: 42, lockedCash: 7 });
    expect(s.me).toMatchObject({ id: "u-alice", name: "Alice", cashBalance: 42, lockedCash: 7 });
  });

  it("upserts positions by assetId and drops a position whose quantity reached zero", () => {
    applyAccountEvent(positionEvent(position("a-gs")));
    expect([...useAccountStore.getState().positions.keys()]).toEqual(["a-vcs", "a-gs"]);
    applyAccountEvent(positionEvent(position("a-vcs", { quantity: 25, available: 20 })));
    expect(useAccountStore.getState().positions.get("a-vcs")?.quantity).toBe(25);
    applyAccountEvent(positionEvent(position("a-gs", { quantity: 0, locked: 0, available: 0 })));
    expect(useAccountStore.getState().positions.has("a-gs")).toBe(false);
  });

  it("ignores account events while nobody is logged in", () => {
    useAccountStore.setState({ me: null, status: "anon", openOrders: new Map(), positions: new Map(), recentFills: [], balance: null });
    const before = useAccountStore.getState();
    applyAccountEvent(orderEvent(order("o-9")));
    applyAccountEvent(balanceEvent({ cashBalance: 1, lockedCash: 0 }));
    expect(useAccountStore.getState()).toBe(before);
  });
});

describe("late or stale order events never bring back a finished order or roll back a newer one", () => {
  beforeEach(seedAlice);
  const openIds = () => [...useAccountStore.getState().openOrders.keys()];

  it("FILLED then a late OPEN (the route bundle's derivation published after the bot's): the order stays gone", () => {
    applyAccountEvent(orderEvent(order("o-1", { status: "FILLED", filledQuantity: 10, updatedAt: 2_000 })));
    expect(openIds()).toEqual([]);
    applyAccountEvent(orderEvent(order("o-1", { status: "OPEN", updatedAt: 1_000 })));
    expect(openIds()).toEqual([]);
    // 同一批里先终结后挂上:同样不回来
    applyAccountEvents([orderEvent(order("o-2", { status: "CANCELLED", updatedAt: 3_000 })), orderEvent(order("o-2", { updatedAt: 2_500 }))]);
    expect(openIds()).toEqual([]);
  });

  it("remembers a finished order even when it was never open here (FILLED overtook its OPEN), without a set()", () => {
    const listener = vi.fn();
    const unsub = useAccountStore.subscribe(listener);
    expect(applyAccountEvents([orderEvent(order("o-new", { status: "FILLED", filledQuantity: 10, updatedAt: 5_000 }))])).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    applyAccountEvent(orderEvent(order("o-new", { updatedAt: 4_000 })));
    expect(openIds()).toEqual(["o-1"]);
    unsub();
  });

  it("the REST cancel response (OpenOrdersTab) followed by an in-flight PARTIAL from a bot fill: stays cancelled", () => {
    accountActions.applyAccountEvent(orderEvent(order("o-1", { status: "CANCELLED", cancelReason: "USER", updatedAt: 3_000 }), 0));
    applyAccountEvent(orderEvent(order("o-1", { status: "PARTIAL", filledQuantity: 2, updatedAt: 2_900 })));
    expect(openIds()).toEqual([]);
  });

  it("an older PARTIAL (smaller filledQuantity or earlier updatedAt) does not overwrite a newer one; an equal or newer one does", () => {
    applyAccountEvent(orderEvent(order("o-1", { status: "PARTIAL", filledQuantity: 4, updatedAt: 4_000 })));
    applyAccountEvent(orderEvent(order("o-1", { status: "PARTIAL", filledQuantity: 2, updatedAt: 3_000 })));
    expect(useAccountStore.getState().openOrders.get("o-1")?.filledQuantity).toBe(4);
    applyAccountEvent(orderEvent(order("o-1", { status: "PARTIAL", filledQuantity: 4, updatedAt: 3_500 })));
    expect(useAccountStore.getState().openOrders.get("o-1")?.updatedAt).toBe(4_000);
    applyAccountEvent(orderEvent(order("o-1", { status: "PARTIAL", filledQuantity: 6, updatedAt: 5_000 })));
    expect(useAccountStore.getState().openOrders.get("o-1")?.filledQuantity).toBe(6);
    // 被跳过的事件不算生效、不 set()
    const before = useAccountStore.getState();
    expect(applyAccountEvents([orderEvent(order("o-1", { status: "OPEN", updatedAt: 1_000 }))])).toBe(0);
    expect(useAccountStore.getState()).toBe(before);
  });

  it("a stale snapshot row for a finished order is dropped too (poll frames, hydrate's open-orders pages)", async () => {
    applyAccountEvent(orderEvent(order("o-1", { status: "CANCELLED", updatedAt: 2_000 })));
    // 撤单之前读出的 /api/account/orders?status=open 还带着 o-1
    await hydrate(loggedIn(alice, { [OPEN_ORDERS_URL]: { orders: [order("o-1"), order("o-3", { createdAt: 3_000, updatedAt: 3_000 })], nextCursor: null } }).fetchJson);
    expect(openIds()).toEqual(["o-3"]);
  });

  it(`the record is bounded (${CLOSED_ORDERS_MAX} ids, oldest forgotten first) and belongs to the signed-in user: sign-out or a switch clears it`, () => {
    applyAccountEvent(orderEvent(order("o-first", { status: "CANCELLED" })));
    for (let i = 0; i < CLOSED_ORDERS_MAX; i++) applyAccountEvent(orderEvent(order(`o-c${i}`, { status: "CANCELLED" })));
    applyAccountEvent(orderEvent(order("o-first")));
    expect(useAccountStore.getState().openOrders.has("o-first")).toBe(true);
    applyAccountEvent(orderEvent(order(`o-c${CLOSED_ORDERS_MAX - 1}`)));
    expect(useAccountStore.getState().openOrders.has(`o-c${CLOSED_ORDERS_MAX - 1}`)).toBe(false);

    applyAccountEvent(orderEvent(order("o-x", { status: "FILLED" })));
    setMe(bob);
    setMe(alice);
    applyAccountEvent(orderEvent(order("o-x")));
    expect(useAccountStore.getState().openOrders.has("o-x")).toBe(true);
  });
});

describe("applyAccountEvents / reduceAccountEvents", () => {
  beforeEach(seedAlice);

  it("applies a whole batch with a single set(), skips market events and shares untouched slices", () => {
    const listener = vi.fn();
    const unsub = useAccountStore.subscribe(listener);
    const before = useAccountStore.getState();
    const n = applyAccountEvents([
      { t: "ticker", topic: "ticker:*", seq: 1, symbol: "VCS-FOR-2021", ticker: { symbol: "VCS-FOR-2021", lastPrice: 1, ts: 1 } },
      orderEvent(order("o-2", { createdAt: 2_000 })),
      balanceEvent({ cashBalance: 9, lockedCash: 1 }),
      { t: "pong", t0: 1, serverTime: 2 } as ServerEvent,
    ]);
    unsub();
    expect(n).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    const after = useAccountStore.getState();
    expect(after.openOrders.size).toBe(2);
    expect(after.balance).toEqual({ cashBalance: 9, lockedCash: 1 });
    expect(after.positions).toBe(before.positions);
    expect(after.recentFills).toBe(before.recentFills);
  });

  it("returns null from the reducer when the batch changes nothing", () => {
    const state = useAccountStore.getState();
    expect(reduceAccountEvents(state, [])).toBeNull();
    expect(reduceAccountEvents(state, [orderEvent(order("o-x", { status: "CANCELLED" }))])).toBeNull();
    // 全是重复的 fill:recentFills 不复制、不换引用
    expect(reduceAccountEvents(state, [fillEvent(fill("f-0", 10))])).toBeNull();
  });

  it("returns the number of events that actually changed the store (0 for a no-op batch, no set())", () => {
    const listener = vi.fn();
    const unsub = useAccountStore.subscribe(listener);
    const before = useAccountStore.getState();
    // 终态单本来不在挂单里、重复的 fill、本来没有的零持仓:都不算
    expect(
      applyAccountEvents([
        orderEvent(order("o-unknown", { status: "FILLED" })),
        fillEvent(fill("f-0", 10)),
        positionEvent(position("a-gs", { quantity: 0, locked: 0, available: 0 })),
      ]),
    ).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    expect(useAccountStore.getState()).toBe(before);
    // 一新一重复的 fill + 一个已有单的撤销:2 条生效
    expect(applyAccountEvents([fillEvent(fill("f-new", 20)), fillEvent(fill("f-0", 10)), orderEvent(order("o-1", { status: "CANCELLED" }))])).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("returns 0 while nobody is logged in, even for a batch full of account events", () => {
    useAccountStore.setState(createInitialAccountState(), true);
    expect(applyAccountEvents([orderEvent(order("o-9")), balanceEvent({ cashBalance: 1, lockedCash: 0 })])).toBe(0);
    useAccountStore.setState({ me: null, status: "anon" });
    expect(applyAccountEvents([fillEvent(fill("f-9", 1))])).toBe(0);
  });
});

describe("retainOpenOrders (poll snapshot reconciliation)", () => {
  it("drops orders that are no longer in the open set and keeps the reference when nothing changes", () => {
    seedAlice();
    applyAccountEvent(orderEvent(order("o-2", { createdAt: 2_000 })));
    retainOpenOrders(new Set(["o-2"]));
    expect([...useAccountStore.getState().openOrders.keys()]).toEqual(["o-2"]);
    const before = useAccountStore.getState().openOrders;
    retainOpenOrders(new Set(["o-2", "o-other"]));
    expect(useAccountStore.getState().openOrders).toBe(before);
  });
});

describe("retainPositions (snapshot reconciliation: fully sold positions never arrive as a zero row in a snapshot)", () => {
  it("drops positions whose assetId is not in the snapshot and keeps the reference when nothing changes", () => {
    seedAlice();
    applyAccountEvent(positionEvent(position("a-gs")));
    const listener = vi.fn();
    const unsub = useAccountStore.subscribe(listener);
    retainPositions(new Set(["a-gs"]));
    expect([...useAccountStore.getState().positions.keys()]).toEqual(["a-gs"]);
    expect(listener).toHaveBeenCalledTimes(1);
    const before = useAccountStore.getState().positions;
    retainPositions(new Set(["a-gs", "a-other"]));
    expect(useAccountStore.getState().positions).toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("is exposed on accountActions", () => {
    expect(accountActions.retainPositions).toBe(retainPositions);
  });
});

describe("setMe / logout", () => {
  it("setMe(user) marks ready with the balance taken from the user; a different user clears the previous slices", () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    seedAlice();
    setMe({ ...alice, cashBalance: 1 });
    expect(useAccountStore.getState().balance).toEqual({ cashBalance: 1, lockedCash: alice.lockedCash });
    expect(useAccountStore.getState().openOrders.size).toBe(1);
    expect(reconnect).not.toHaveBeenCalled();
    setMe(bob);
    const s = useAccountStore.getState();
    expect(s.status).toBe("ready");
    expect(s.me?.id).toBe("u-bob");
    expect(s.openOrders.size).toBe(0);
    expect(s.positions.size).toBe(0);
    expect(s.recentFills).toEqual([]);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("setMe(null) is a local logout", () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    seedAlice();
    setMe(null);
    expect(useAccountStore.getState().status).toBe("anon");
    expect(useAccountStore.getState().me).toBeNull();
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("logout POSTs /api/auth/logout, clears everything, reconnects, and invalidates an in-flight hydrate", async () => {
    const reconnect = vi.fn();
    registerTransportReconnect(reconnect);
    seedAlice();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = hydrate(fakeFetch({ [ME_URL]: () => gate.then(() => alice) }).fetchJson);
    const calls: { url: string; method: string | undefined }[] = [];
    const fetchJson: FetchJson = async <T,>(url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return { loggedOut: true } as T;
    };
    await logout(fetchJson);
    expect(calls).toEqual([{ url: LOGOUT_URL, method: "POST" }]);
    const s = useAccountStore.getState();
    expect(s.status).toBe("anon");
    expect(s.me).toBeNull();
    expect(s.balance).toBeNull();
    expect(s.openOrders.size).toBe(0);
    expect(s.positions.size).toBe(0);
    expect(s.recentFills).toEqual([]);
    expect(reconnect).toHaveBeenCalledTimes(1);
    release();
    await slow;
    expect(useAccountStore.getState().status).toBe("anon");
  });

  it("logout leaves the store untouched when the request fails (the server session is still alive)", async () => {
    seedAlice();
    const before = useAccountStore.getState();
    await expect(logout(fakeFetch({ [LOGOUT_URL]: new ApiError("Failed to fetch", 0) }).fetchJson)).rejects.toBeInstanceOf(ApiError);
    expect(useAccountStore.getState()).toBe(before);
  });
});

describe("seams and pure selectors", () => {
  it("registers itself as the open-orders source (leaf open-orders-source.ts, re-exported by selectors.ts for useBookView's `mine`)", () => {
    expect(readOpenOrders).toBe(leafReadOpenOrders);
    seedAlice();
    expect(readOpenOrders()).toBe(useAccountStore.getState().openOrders);
    applyAccountEvent(orderEvent(order("o-2", { createdAt: 2_000 })));
    expect(readOpenOrders().has("o-2")).toBe(true);
  });

  it("registers itself as the account source of account-bridge.ts (MarketProvider's meId, account events, poll reconciliation)", async () => {
    // idle / loading 期 me 是 undefined(尚未知):bridge 看到的是未登录
    expect(readMeId()).toBeNull();
    const listener = vi.fn();
    const unsub = subscribeAccount(listener);
    await hydrate(loggedIn(alice).fetchJson);
    expect(readMeId()).toBe("u-alice");
    expect(listener).toHaveBeenCalled();

    // batcher 经 bridge 转来的账户事件落进本 store,市场事件跳过
    const n = bridgeApplyAccountEvents([
      { t: "ticker", topic: "ticker:*", seq: 1, symbol: "VCS-FOR-2021", ticker: { symbol: "VCS-FOR-2021", lastPrice: 1, ts: 1 } },
      orderEvent(order("o-3", { createdAt: 3_000 })),
      balanceEvent({ cashBalance: 11, lockedCash: 2 }),
    ]);
    expect(n).toBe(2);
    expect(useAccountStore.getState().openOrders.has("o-3")).toBe(true);
    expect(useAccountStore.getState().balance).toEqual({ cashBalance: 11, lockedCash: 2 });

    // 批量入口:一批 N 条账户事件经 bridge 只触发一次 set()
    const setCount = vi.fn();
    const unsubSet = useAccountStore.subscribe(setCount);
    expect(
      bridgeApplyAccountEvents([
        orderEvent(order("o-4", { createdAt: 4_000 })),
        positionEvent(position("a-new")),
        fillEvent(fill("f-9", 9)),
        { t: "ticker", topic: "ticker:*", seq: 2, symbol: "VCS-FOR-2021", ticker: { symbol: "VCS-FOR-2021", lastPrice: 2, ts: 2 } },
      ]),
    ).toBe(3);
    expect(setCount).toHaveBeenCalledTimes(1);
    unsubSet();

    // 轮询 / WS 快照灌入后的收口:挂单与持仓
    bridgeRetainOpenOrders(new Set(["o-3"]));
    expect([...useAccountStore.getState().openOrders.keys()]).toEqual(["o-3"]);
    bridgeRetainPositions(new Set(["a-new"]));
    expect([...useAccountStore.getState().positions.keys()]).toEqual(["a-new"]);

    // 登出:bridge 立刻看到未登录(MarketProvider 退订 account)
    await logout(fakeFetch({ [LOGOUT_URL]: { loggedOut: true } }).fetchJson);
    expect(readMeId()).toBeNull();
    unsub();
  });

  it("also exposes, through account-bridge: a lists version (poll snapshots check it), the known identity (ws-client's hello check), the lists load and the identity refresh", async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    // idle / loading:身份未知
    expect(readKnownMeId()).toBeUndefined();
    const v0 = readListsVersion();
    await hydrate(fakeFetch({ [ME_URL]: null }).fetchJson, "me");
    expect(readKnownMeId()).toBeNull();
    seedAlice();
    expect(readKnownMeId()).toBe("u-alice");
    const v1 = readListsVersion();
    expect(v1).toBeGreaterThan(v0);
    // 余额、成交不改挂单 / 持仓:版本不动;挂单或持仓一变就 +1
    applyAccountEvent(balanceEvent({ cashBalance: 5, lockedCash: 0 }));
    applyAccountEvent(fillEvent(fill("f-v", 1)));
    expect(readListsVersion()).toBe(v1);
    applyAccountEvent(orderEvent(order("o-v", { createdAt: 5_000 })));
    expect(readListsVersion()).toBe(v1 + 1);
    retainPositions(new Set());
    expect(readListsVersion()).toBe(v1 + 2);

    // requestAccountLists / requestAccountRefresh 走默认的 http client:打桩 fetch,只看发了什么
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return new Promise<never>(() => {});
    });
    onTestFinished(() => void vi.unstubAllGlobals());
    requestAccountLists();
    expect(urls.sort()).toEqual([OPEN_ORDERS_URL, POSITIONS_URL].sort());
    urls.length = 0;
    requestAccountRefresh();
    expect(urls).toEqual([ME_URL]);
    vi.advanceTimersByTime(HYDRATE_TIMEOUT_MS); // 让挂住的请求按期限结束
    await settle();
  });

  it("keeps the market store out of its module graph: only zero-dependency leaves and the http client (Nav is in the root layout)", () => {
    // 运行时导入(不含 `import type` / `export type`):account-store → 白名单;两个叶子 → 无
    const runtimeImports = (file: string): string[] => {
      const src = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      const out: string[] = [];
      // `[^;=(]`:import / export … from 语句里没有 = 与 (,不会从 `export function …` 一路扫进函数体
      for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?[^;=(]*?\bfrom\s+"([^"]+)"/gm)) if (!m[2]) out.push(m[3]);
      for (const m of src.matchAll(/^\s*import\s+"([^"]+)"/gm)) out.push(m[1]);
      return [...new Set(out)].sort();
    };
    expect(runtimeImports("./account-store.ts")).toEqual(["./account-bridge", "./open-orders-source", "@/lib/http/client", "zustand", "zustand/react/shallow"]);
    expect(runtimeImports("./account-bridge.ts")).toEqual([]);
    expect(runtimeImports("./open-orders-source.ts")).toEqual([]);
    expect(runtimeImports("../http/client.ts")).toEqual([]);
  });

  it("openOrdersOf filters by symbol and orders newest first; positionsOf sorts by symbol", () => {
    const orders = new Map<string, Order>([
      ["o-1", order("o-1", { createdAt: 1_000 })],
      ["o-2", order("o-2", { symbol: "GS-REN-2020", assetId: "a-gs", createdAt: 3_000 })],
      ["o-3", order("o-3", { createdAt: 2_000 })],
    ]);
    expect(openOrdersOf(orders).map((o) => o.id)).toEqual(["o-2", "o-3", "o-1"]);
    expect(openOrdersOf(orders, "VCS-FOR-2021").map((o) => o.id)).toEqual(["o-3", "o-1"]);
    expect(openOrdersOf(orders, "NOPE")).toEqual([]);
    const positions = new Map<string, Position>([
      ["a-vcs", position("a-vcs")],
      ["a-gs", position("a-gs")],
    ]);
    expect(positionsOf(positions).map((p) => p.symbol)).toEqual(["GS-REN-2020", "VCS-FOR-2021"]);
  });
});
