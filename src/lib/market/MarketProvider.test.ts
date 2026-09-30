import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountOrdersResponse, Balance, BookResponse, CandleBar, CandlesResponse, ConnectionState, InstrumentsResponse, Me, Order, Position, PositionsResponse, ServerEvent, TradesResponse } from "@/shared";
import { DEFAULT_FEE_SCHEDULE, auditRefOf } from "@/shared";
import { OPEN_ORDERS_MAX_PAGES, applyAccountEvents as applyAccountEventsViaBridge, readKnownMeId, registerAccountSource } from "./account-bridge";
import {
  accountActions,
  accountSource,
  applyAccountEvent as storeApplyAccountEvent,
  applyAccountEvents as storeApplyAccountEvents,
  createInitialAccountState,
  retainOpenOrders as storeRetainOpenOrders,
  retainPositions as storeRetainPositions,
  useAccountStore,
} from "./account-store";
import { createBatcher, type Batcher } from "./batcher";
import {
  calibrateCandles,
  candlesUrl,
  dropStaleLastBar,
  fetchCandles,
  onTransportEvent,
  pollAccount,
  pollMarket,
  reconcileAccountSnapshot,
  ACCOUNT_LISTS_GRACE_MS,
  accountListsPlan,
  loadAccountListsUnlessStreamed,
  type MarketRuntime,
} from "./MarketProvider";
import { candleKey, createInitialState, marketActions, useMarketStore } from "./store";
import { createTransportManager, type MarketTransport } from "./transport";

// MarketProvider 组件本身不测(无 jsdom,§9.1 第 7 条);这里测它导出的三个轮询任务与纯函数:
// fetch 用可控的 stub(每个请求挂起,测试决定何时回),transport 状态走真 store,
// 断言「响应到达时已切回 WS / 已登出 → 丢弃」与「REST 最后一根比 store 旧 → 不用」。

const SYM = "VCS-FOR-2021";
const POLL: ConnectionState = { transport: "poll", state: "degraded", lastMessageAt: null, rttMs: null };
const WS_OPEN: ConnectionState = { transport: "ws", state: "open", lastMessageAt: null, rttMs: null };

type Pending = { url: string; resolve: (res: Response) => void };
let inflight: Pending[] = [];
const okResponse = (data: unknown): Response => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) }) as unknown as Response;
const errorResponse = (status: number): Response => ({ ok: false, status, json: async () => ({ ok: false, error: `HTTP ${status}` }) }) as unknown as Response;
function take(match: string): Pending {
  const i = inflight.findIndex((p) => p.url.includes(match));
  if (i < 0) throw new Error(`no request for ${match}; inflight: ${inflight.map((p) => p.url).join(", ")}`);
  return inflight.splice(i, 1)[0];
}
/** 回掉 URL 含 match 的那个请求 */
function answer(match: string, data: unknown): void {
  take(match).resolve(okResponse(data));
}
function answerError(match: string, status: number): void {
  take(match).resolve(errorResponse(status));
}
/** 下一页请求在上一页的响应解析之后才发出:等它出现在 inflight 里 */
const requested = (match: string) => vi.waitFor(() => expect(inflight.some((p) => p.url.includes(match))).toBe(true));

function fakeRuntime() {
  const push = vi.fn<Batcher["push"]>();
  const flush = vi.fn<Batcher["flush"]>();
  const batcher = { push, flush, dispose: vi.fn(), stats: vi.fn() } as unknown as Batcher;
  const transport = { start() {}, stop() {}, subscribe() {}, unsubscribe() {}, reconnect() {}, kind: "poll" } as MarketTransport;
  const rt: MarketRuntime = { transport, batcher };
  return { rt, push, flush };
}

function fakeAccount(me: Me) {
  const retain = vi.fn<(ids: ReadonlySet<string>) => void>();
  const retainPos = vi.fn<(assetIds: ReadonlySet<string>) => void>();
  const apply = vi.fn();
  registerAccountSource({ subscribe: () => () => {}, getState: () => ({ me }), applyAccountEvent: apply, retainOpenOrders: retain, retainPositions: retainPos });
  return { retain, retainPos, apply };
}

const bookResp: BookResponse = { symbol: SYM, bids: [{ price: 1230, quantity: 3, orders: 1 }], asks: [], ts: 5, seq: 0 };
const tradesResp: TradesResponse = { trades: [{ id: "t1", symbol: SYM, price: 1234, quantity: 1, takerSide: "BUY", ts: 4, auditRef: auditRefOf("t1") }], seq: 0 };
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
const balance: Balance = { cashBalance: 1000, lockedCash: 0 };
const order = (id: string): Order => ({ id, clientOrderId: null, assetId: "a1", symbol: SYM, side: "BUY", type: "LIMIT", price: 1200, quantity: 5, filledQuantity: 0, status: "OPEN", avgFillPrice: null, cancelReason: null, createdAt: 1, updatedAt: 1 });
const position = (assetId: string): Position => ({ assetId, symbol: SYM, quantity: 3, locked: 0, available: 3, retired: 0, lastPrice: 1234, marketValue: 3702, averagePurchasePrice: null, unrealisedPnl: null, costBasisStatus: "incomplete_ledger", isScenario: false });
const positionsResp: PositionsResponse = { positions: [position("a1")], balance };
const ordersResp: AccountOrdersResponse = { orders: [order("o1")], nextCursor: null };
const me: Me = { id: "u1", email: "u@x", name: "u", cashBalance: 1000, lockedCash: 0 };
const bar = (t: number, v: number, c = 1): CandleBar => ({ t, o: 1, h: 1, l: 1, c, v });
const tradeAt = (id: string, ts: number) => ({ id, symbol: SYM, price: 1234, quantity: 1, takerSide: "BUY" as const, ts, auditRef: auditRefOf(id) });

beforeEach(() => {
  inflight = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => new Promise<Response>((resolve) => inflight.push({ url, resolve }))),
  );
  useMarketStore.setState(createInitialState(), true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  registerAccountSource(null);
});

describe("pollMarket", () => {
  it("轮询中:三个端点并发,一次 push 三种快照帧,标的元数据 onlyIfEmpty 灌入", async () => {
    const { rt, push } = fakeRuntime();
    marketActions.setConnection(POLL);
    const done = pollMarket(SYM, rt);
    expect(inflight.map((p) => p.url)).toEqual([`/api/market/${SYM}/book?depth=50`, `/api/market/${SYM}/trades?limit=100`, "/api/market/instruments"]);
    answer("/book", bookResp);
    answer("/trades", tradesResp);
    answer("/instruments", instrumentsResp);
    await done;
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].map((e) => e.t)).toEqual(["book.snapshot", "trades", "ticker"]);
    expect(useMarketStore.getState().instruments[SYM]?.symbol).toBe(SYM);
  });

  it("请求在途时切回 WS:迟到的响应丢弃,不 push、不灌标的", async () => {
    const { rt, push } = fakeRuntime();
    marketActions.setConnection(POLL);
    const done = pollMarket(SYM, rt);
    expect(inflight).toHaveLength(3);
    marketActions.setConnection(WS_OPEN); // 探测的 hello 到了
    answer("/book", bookResp);
    answer("/trades", tradesResp);
    answer("/instruments", instrumentsResp);
    await done;
    expect(push).not.toHaveBeenCalled();
    expect(useMarketStore.getState().instruments).toEqual({});
  });

  it("三个请求都绕过浏览器的 HTTP 缓存(cache: no-store):公开端点带 max-age=1 + stale-while-revalidate=2,2 s 一轮的轮询若走浏览器缓存,拿到的是上一轮的旧响应,另有一条后台重验证请求(回滚演练实测每轮 2 次)", async () => {
    const { rt } = fakeRuntime();
    marketActions.setConnection(POLL);
    const done = pollMarket(SYM, rt);
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [string, RequestInit | undefined][];
    expect(calls.map(([url, init]) => [url, init?.cache])).toEqual([
      [`/api/market/${SYM}/book?depth=50`, "no-store"],
      [`/api/market/${SYM}/trades?limit=100`, "no-store"],
      ["/api/market/instruments", "no-store"],
    ]);
    answer("/book", bookResp);
    answer("/trades", tradesResp);
    answer("/instruments", instrumentsResp);
    await done;
  });

  it("不在轮询时连请求都不发", async () => {
    const { rt, push } = fakeRuntime();
    marketActions.setConnection(WS_OPEN);
    await pollMarket(SYM, rt);
    expect(inflight).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("pollAccount", () => {
  it("轮询中且仍是同一用户:先 retainOpenOrders / retainPositions 收口挂单与持仓集合,再 push 账户快照帧", async () => {
    const { rt, push } = fakeRuntime();
    const { retain, retainPos } = fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    expect(inflight.map((p) => p.url)).toEqual(["/api/account/positions", "/api/account/orders?status=open&limit=100"]);
    answer("/positions", positionsResp);
    answer("/orders", ordersResp);
    await done;
    expect(retain).toHaveBeenCalledTimes(1);
    expect([...retain.mock.calls[0][0]]).toEqual(["o1"]);
    expect(retainPos).toHaveBeenCalledTimes(1);
    expect([...retainPos.mock.calls[0][0]]).toEqual(["a1"]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].map((e) => e.t)).toEqual(["balance", "order", "position"]);
    expect(retain.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
    expect(retainPos.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
  });

  it("持仓清空(全部卖出):快照里没有的 assetId 经 retainPositions 移除(空集合也要调)", async () => {
    const { rt } = fakeRuntime();
    const { retainPos } = fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    answer("/positions", { positions: [], balance });
    answer("/orders", ordersResp);
    await done;
    expect(retainPos).toHaveBeenCalledTimes(1);
    expect(retainPos.mock.calls[0][0].size).toBe(0);
  });

  it("开放委托超过一页:按 nextCursor 翻完,retain 用全部页的 id,帧里是全部挂单", async () => {
    const { rt, push } = fakeRuntime();
    const { retain } = fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    answer("/positions", positionsResp);
    answer("/orders", { orders: [order("o1")], nextCursor: "c1" });
    await requested("cursor=c1");
    expect(inflight.map((p) => p.url)).toEqual(["/api/account/orders?status=open&limit=100&cursor=c1"]);
    answer("cursor=c1", { orders: [order("o51")], nextCursor: null });
    await done;
    expect([...retain.mock.calls[0][0]]).toEqual(["o1", "o51"]);
    expect(push.mock.calls[0][0].filter((e) => e.t === "order")).toHaveLength(2);
  });

  it(`超过 ${OPEN_ORDERS_MAX_PAGES} 页(截断):不 retainOpenOrders(拿不到的部分可能还挂着),持仓照常收口,拿到的挂单照常 push`, async () => {
    const { rt, push } = fakeRuntime();
    const { retain, retainPos } = fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    answer("/positions", positionsResp);
    for (let i = 0; i < OPEN_ORDERS_MAX_PAGES; i++) {
      const match = i === 0 ? "/orders" : `cursor=c${i}`;
      await requested(match);
      answer(match, { orders: [order(`o-p${i}`)], nextCursor: `c${i + 1}` });
    }
    await done;
    expect(inflight).toHaveLength(0);
    expect(retain).not.toHaveBeenCalled();
    expect(retainPos).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].filter((e) => e.t === "order")).toHaveLength(OPEN_ORDERS_MAX_PAGES);
  });

  it("翻页中途失败:reject(usePolling 退避),本轮不 retain、不 push,保留现状", async () => {
    const { rt, push } = fakeRuntime();
    const { retain, retainPos } = fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    answer("/positions", positionsResp);
    answer("/orders", { orders: [order("o1")], nextCursor: "c1" });
    await requested("cursor=c1");
    answerError("cursor=c1", 503);
    await expect(done).rejects.toThrow("HTTP 503");
    expect(retain).not.toHaveBeenCalled();
    expect(retainPos).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("请求在途时切回 WS:不 retain、不 push(否则快照里的 OPEN 单会救回 WS 刚删掉的已成交单)", async () => {
    const { rt, push } = fakeRuntime();
    const { retain, retainPos } = fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    marketActions.setConnection(WS_OPEN);
    answer("/positions", positionsResp);
    answer("/orders", ordersResp);
    await done;
    expect(retain).not.toHaveBeenCalled();
    expect(retainPos).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("请求在途时登出(me 变了):同样丢弃", async () => {
    const { rt, push } = fakeRuntime();
    fakeAccount(me);
    marketActions.setConnection(POLL);
    const done = pollAccount("u1", rt);
    const { retain } = fakeAccount(null);
    answer("/positions", positionsResp);
    answer("/orders", ordersResp);
    await done;
    expect(retain).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("pollAccount:请求期间 store 被写过(本地下单 / 撤单等)→ 快照比 store 旧,本轮不收口也不灌入", () => {
  it("假源:版本号在请求期间变了 → 不 retain、不 push;没变 → 照常", async () => {
    const { rt, push } = fakeRuntime();
    let version = 7;
    const retain = vi.fn();
    const retainPos = vi.fn();
    registerAccountSource({ subscribe: () => () => {}, getState: () => ({ me }), applyAccountEvent: vi.fn(), retainOpenOrders: retain, retainPositions: retainPos, listsVersion: () => version });
    marketActions.setConnection(POLL);
    const stale = pollAccount("u1", rt);
    version++; // 请求发出之后,OrderPanel 落了一张新单
    answer("/positions", positionsResp);
    answer("/orders", ordersResp);
    await stale;
    expect(retain).not.toHaveBeenCalled();
    expect(retainPos).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const fresh = pollAccount("u1", rt);
    answer("/positions", positionsResp);
    answer("/orders", ordersResp);
    await fresh;
    expect(retain).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });

  describe("端到端(真账户 store + 真 batcher)", () => {
    function wireStore(openOrders: Order[]) {
      registerAccountSource(accountSource); // 接回真 store(本文件的 afterEach 会注销)
      useAccountStore.setState({ ...createInitialAccountState(), me, balance, status: "ready", openOrders: new Map(openOrders.map((o) => [o.id, o])) }, true);
      return createBatcher((events) => applyAccountEventsViaBridge(events), { hidden: () => false });
    }
    const ids = () => [...useAccountStore.getState().openOrders.keys()].sort();

    it("T0 发出轮询,T0+100 ms 下单 X(OrderPanel 直接写 store),T0+300 ms 不含 X 的快照到达:X 还在", async () => {
      const batcher = wireStore([order("o1")]);
      const rt: MarketRuntime = { transport: fakeRuntime().rt.transport, batcher };
      try {
        marketActions.setConnection(POLL);
        const done = pollAccount("u1", rt);
        accountActions.applyAccountEvents([{ t: "order", topic: "account", seq: 0, order: order("o-x") }]);
        answer("/positions", positionsResp);
        answer("/orders", ordersResp); // 只有 o1
        await done;
        batcher.flush();
        expect(ids()).toEqual(["o-x", "o1"]);
      } finally {
        batcher.dispose();
        useAccountStore.setState(createInitialAccountState(), true);
      }
    });

    it("反过来:请求在途时撤掉 o1(OpenOrdersTab 落了 CANCELLED),快照还带着 o1 OPEN:o1 不回来", async () => {
      const batcher = wireStore([order("o1")]);
      const rt: MarketRuntime = { transport: fakeRuntime().rt.transport, batcher };
      try {
        marketActions.setConnection(POLL);
        const done = pollAccount("u1", rt);
        accountActions.applyAccountEvent({ t: "order", topic: "account", seq: 0, order: { ...order("o1"), status: "CANCELLED", cancelReason: "USER", updatedAt: 2 } });
        answer("/positions", positionsResp);
        answer("/orders", ordersResp);
        await done;
        batcher.flush();
        expect(ids()).toEqual([]);
        // 下一轮(撤单之后读出的快照)照常收口
        const next = pollAccount("u1", rt);
        answer("/positions", positionsResp);
        answer("/orders", { orders: [], nextCursor: null });
        await next;
        batcher.flush();
        expect(ids()).toEqual([]);
      } finally {
        batcher.dispose();
        useAccountStore.setState(createInitialAccountState(), true);
      }
    });
  });
});

describe("onTransportEvent(transport 的生命周期事件)", () => {
  it("account-snapshot → flush 后收口;identity-mismatch → 账户 store 重新确认身份(经 bridge 的 requestAccountRefresh);其它事件不管", () => {
    const { flush } = fakeRuntime();
    const refresh = vi.fn();
    const retain = vi.fn();
    registerAccountSource({ subscribe: () => () => {}, getState: () => ({ me }), applyAccountEvent: vi.fn(), retainOpenOrders: retain, refresh });
    onTransportEvent({ type: "account-snapshot", orderIds: new Set(["o1"]), assetIds: new Set() }, { flush });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledTimes(1);
    onTransportEvent({ type: "identity-mismatch", userId: "u2", reason: "hello" }, { flush });
    onTransportEvent({ type: "identity-mismatch", userId: null, reason: "unauthorized" }, { flush });
    expect(refresh).toHaveBeenCalledTimes(2);
    onTransportEvent({ type: "open" }, { flush });
    onTransportEvent({ type: "resync", topic: "account", ok: false }, { flush });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

describe("accountListsPlan(终端挂载 / 登录后要不要自己拉挂单与持仓)", () => {
  it("WS 已连上(account 订阅快照马上就到)或已在轮询(pollAccount 立即跑):不拉;还在连:等一会儿;离线、未启动:立刻拉", () => {
    expect(accountListsPlan(WS_OPEN)).toBe("skip");
    expect(accountListsPlan(POLL)).toBe("skip");
    expect(accountListsPlan({ transport: "ws", state: "connecting", lastMessageAt: null, rttMs: null })).toBe("defer");
    expect(accountListsPlan({ transport: "ws", state: "offline", lastMessageAt: null, rttMs: null })).toBe("now");
    expect(accountListsPlan({ transport: "none", state: "offline", lastMessageAt: null, rttMs: null })).toBe("now");
  });
});

describe("loadAccountListsUnlessStreamed(硬刷新 /trade:Nav 的 /api/auth/me 先于 WS 的 hello 回来,P1-25c 复审)", () => {
  const CONNECTING: ConnectionState = { transport: "ws", state: "connecting", lastMessageAt: null, rttMs: null };
  let loadLists: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    loadLists = vi.fn<() => void>();
    registerAccountSource({ subscribe: () => () => {}, getState: () => ({ me }), applyAccountEvent: vi.fn(), loadLists });
    useMarketStore.setState({ connection: CONNECTING });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const snapshotEvent = { type: "account-snapshot", orderIds: new Set<string>(), assetIds: new Set<string>() } as const;

  it("还在连:先不拉;宽限期内 account 订阅快照到了 → 一直不拉(列表只读一遍)", () => {
    expect(ACCOUNT_LISTS_GRACE_MS).toBe(3_000);
    loadAccountListsUnlessStreamed(CONNECTING);
    expect(loadLists).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    useMarketStore.setState({ connection: WS_OPEN });
    onTransportEvent({ type: "open" }, { flush: vi.fn() });
    onTransportEvent(snapshotEvent, { flush: vi.fn() });
    vi.advanceTimersByTime(10 * ACCOUNT_LISTS_GRACE_MS);
    expect(loadLists).not.toHaveBeenCalled();
  });

  it("还在连、随后连不上(connect-failed):立刻拉一次,宽限到点不再拉第二次", () => {
    loadAccountListsUnlessStreamed(CONNECTING);
    onTransportEvent({ type: "connect-failed", attempt: 1 }, { flush: vi.fn() });
    expect(loadLists).toHaveBeenCalledTimes(1);
    onTransportEvent({ type: "connect-failed", attempt: 2 }, { flush: vi.fn() });
    vi.advanceTimersByTime(10 * ACCOUNT_LISTS_GRACE_MS);
    expect(loadLists).toHaveBeenCalledTimes(1);
  });

  it("宽限到点还没有订阅快照(连上了但身份不一致没订 account、快照被背压扣着……):自己拉一次;已转轮询则交给 pollAccount", () => {
    loadAccountListsUnlessStreamed(CONNECTING);
    vi.advanceTimersByTime(ACCOUNT_LISTS_GRACE_MS - 1);
    expect(loadLists).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(loadLists).toHaveBeenCalledTimes(1);
    loadLists.mockClear();
    loadAccountListsUnlessStreamed(CONNECTING);
    useMarketStore.setState({ connection: POLL });
    vi.advanceTimersByTime(ACCOUNT_LISTS_GRACE_MS);
    expect(loadLists).not.toHaveBeenCalled();
  });

  it("effect 清理(登出、换人、离开终端)取消等待;WS 已连上 / 在轮询不拉;离线立刻拉", () => {
    const cancel = loadAccountListsUnlessStreamed(CONNECTING);
    cancel();
    onTransportEvent({ type: "connect-failed", attempt: 1 }, { flush: vi.fn() });
    vi.advanceTimersByTime(10 * ACCOUNT_LISTS_GRACE_MS);
    expect(loadLists).not.toHaveBeenCalled();
    loadAccountListsUnlessStreamed(WS_OPEN);
    loadAccountListsUnlessStreamed(POLL);
    vi.advanceTimersByTime(10 * ACCOUNT_LISTS_GRACE_MS);
    expect(loadLists).not.toHaveBeenCalled();
    loadAccountListsUnlessStreamed({ transport: "ws", state: "offline", lastMessageAt: null, rttMs: null });
    expect(loadLists).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileAccountSnapshot(WS 的 account 订阅快照边界)", () => {
  it("先 flush batcher(快照帧已 push、尚未应用),再用快照里的 id 收口挂单与持仓", () => {
    const { rt, flush } = fakeRuntime();
    const { retain, retainPos } = fakeAccount(me);
    reconcileAccountSnapshot({ type: "account-snapshot", orderIds: new Set(["o1"]), assetIds: new Set(["a1"]) }, rt.batcher);
    expect(flush).toHaveBeenCalledTimes(1);
    expect([...retain.mock.calls[0][0]]).toEqual(["o1"]);
    expect([...retainPos.mock.calls[0][0]]).toEqual(["a1"]);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(retain.mock.invocationCallOrder[0]);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(retainPos.mock.invocationCallOrder[0]);
  });

  it("端到端(真 batcher):快照前 push 的旧单与已清空持仓在快照应用后移除,快照里的保留", () => {
    const orders = new Map<string, Order>([["o-stale", order("o-stale")]]);
    const positions = new Map<string, Position>([["a-sold", position("a-sold")]]);
    registerAccountSource({
      subscribe: () => () => {},
      getState: () => ({ me }),
      applyAccountEvent: (ev) => {
        if (ev.t === "order") orders.set(ev.order.id, ev.order);
        if (ev.t === "position") positions.set(ev.position.assetId, ev.position);
      },
      retainOpenOrders: (ids) => [...orders.keys()].forEach((id) => ids.has(id) || orders.delete(id)),
      retainPositions: (ids) => [...positions.keys()].forEach((id) => ids.has(id) || positions.delete(id)),
    });
    const batcher = createBatcher((events) => applyAccountEventsViaBridge(events), { hidden: () => false });
    try {
      batcher.push([
        { t: "balance", topic: "account", seq: 4, balance },
        { t: "order", topic: "account", seq: 4, order: order("o-live") },
        { t: "position", topic: "account", seq: 4, position: position("a-live") },
      ]);
      reconcileAccountSnapshot({ type: "account-snapshot", orderIds: new Set(["o-live"]), assetIds: new Set(["a-live"]) }, batcher);
      expect([...orders.keys()]).toEqual(["o-live"]);
      expect([...positions.keys()]).toEqual(["a-live"]);
    } finally {
      batcher.dispose();
    }
  });

  describe("端到端(真 transport 管理器 + ws-client + batcher + 账户 store,接线同 getMarketRuntime)", () => {
    /** 最小假 WebSocket:测试驱动 open / message;close 同步触发 onclose */
    class FakeSocket {
      static last: FakeSocket | null = null;
      readyState = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      constructor(readonly url: string) {
        FakeSocket.last = this;
      }
      send() {}
      close(code?: number, reason?: string) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.onclose?.({ code: code ?? 1005, reason: reason ?? "" } as CloseEvent);
      }
      frame(events: ServerEvent[]) {
        this.onmessage?.({ data: JSON.stringify(events) } as MessageEvent);
      }
    }
    const ev = {
      subscribed: (seq: number): ServerEvent => ({ t: "subscribed", topic: "account", seq }),
      balance: (seq: number): ServerEvent => ({ t: "balance", topic: "account", seq, balance }),
      order: (seq: number, id: string): ServerEvent => ({ t: "order", topic: "account", seq, order: order(id) }),
      position: (seq: number, assetId: string, quantity = 3): ServerEvent => ({
        t: "position",
        topic: "account",
        seq,
        position: { ...position(assetId), quantity, available: quantity, marketValue: quantity * 1234 },
      }),
    };

    function wire() {
      // 真账户 store 接回 bridge(本文件的 afterEach 会注销;接法与 account-store 模块初始化时一致)
      registerAccountSource({
        subscribe: useAccountStore.subscribe,
        getState: () => ({ me: useAccountStore.getState().me ?? null }),
        applyAccountEvent: storeApplyAccountEvent,
        applyAccountEvents: storeApplyAccountEvents,
        retainOpenOrders: storeRetainOpenOrders,
        retainPositions: storeRetainPositions,
      });
      useAccountStore.setState(
        {
          ...createInitialAccountState(),
          me,
          balance,
          status: "ready",
          // 断线前的旧状态:断线期间已成交的单、卖光的持仓 —— 快照里没有,收口应删掉
          openOrders: new Map([["o-stale", order("o-stale")]]),
          positions: new Map([["a-sold", position("a-sold")]]),
        },
        true,
      );
      const batcher = createBatcher((events) => applyAccountEventsViaBridge(events), { hidden: () => false });
      const transport = createTransportManager({
        mode: "ws",
        wsUrl: "ws://test/ws",
        onFrame: (frame) => batcher.push(frame),
        onState: () => {},
        onEvent: (event) => {
          if (event.type === "account-snapshot") reconcileAccountSnapshot(event, batcher);
        },
        ws: { wsImpl: FakeSocket as unknown as typeof WebSocket, random: () => 0.5 },
      });
      transport.subscribe("account");
      transport.start();
      const socket = FakeSocket.last!;
      socket.readyState = 1;
      socket.frame([{ t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: me!.id, maxTopics: 64 }]);
      return { batcher, transport, socket };
    }
    const openOrderIds = () => [...useAccountStore.getState().openOrders.keys()].sort();
    const positionIds = () => [...useAccountStore.getState().positions.keys()].sort();

    it("hub 把快照与其后的增量合在同一帧:快照之后新开的 OPEN 单与新持仓不被这次收口删掉,旧单 / 卖光的持仓删掉", () => {
      const { batcher, transport, socket } = wire();
      try {
        socket.frame([ev.subscribed(3), ev.balance(3), ev.order(3, "o-snap"), ev.order(4, "o-new"), ev.position(5, "a-new")]);
        batcher.flush(); // 下一个 rAF
        expect(openOrderIds()).toEqual(["o-new", "o-snap"]);
        expect(positionIds()).toEqual(["a-new"]);
      } finally {
        transport.stop();
        batcher.dispose();
        useAccountStore.setState(createInitialAccountState(), true);
      }
    });

    it("快照之前逆序送达的持仓(先到 qty 0、后到更旧的 qty 5):快照里没有 a1,收口后 store 里也没有(旧值不会一直留着)", () => {
      const { batcher, transport, socket } = wire();
      try {
        socket.frame([ev.subscribed(3)]);
        socket.frame([ev.position(4, "a1", 0), ev.position(5, "a1", 5)]); // 两个 bundle 的派生逆序上总线
        batcher.flush();
        expect(positionIds()).toEqual(["a-sold", "a1"]);
        socket.frame([ev.balance(5), ev.order(5, "o-snap")]); // 快照读在卖光之后:没有 a1
        batcher.flush();
        expect(positionIds()).toEqual([]);
        expect(openOrderIds()).toEqual(["o-snap"]);
      } finally {
        transport.stop();
        batcher.dispose();
        useAccountStore.setState(createInitialAccountState(), true);
      }
    });

    it("别的标签页换了人:重连的 hello 是 u2、store 还是 u1 → 不订 account(u2 的数据不落进 u1 的 store),账户 store 重新拉 /api/auth/me", async () => {
      registerAccountSource(accountSource); // 真 store 的完整接缝(含 knownMeId / refresh)
      useAccountStore.setState({ ...createInitialAccountState(), me, balance, status: "ready" }, true);
      const batcher = createBatcher((events) => applyAccountEventsViaBridge(events), { hidden: () => false });
      const transport = createTransportManager({
        mode: "ws",
        wsUrl: "ws://test/ws",
        onFrame: (frame) => batcher.push(frame),
        onState: () => {},
        onEvent: (event) => onTransportEvent(event, batcher),
        ws: { wsImpl: FakeSocket as unknown as typeof WebSocket, random: () => 0.5, expectedUserId: readKnownMeId },
      });
      try {
        transport.subscribe("account");
        transport.start();
        const socket = FakeSocket.last!;
        const send = vi.spyOn(socket, "send");
        socket.readyState = 1;
        socket.frame([{ t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: "u2", maxTopics: 64 }]);
        expect(send).not.toHaveBeenCalled(); // account 没订
        expect(inflight.map((p) => p.url)).toEqual(["/api/auth/me"]);
        // /me 说是 u2:store 换人(清掉 u1 的列表)并请求重连 —— 这里 transport 没注册成 reconnect 目标,只看 store
        answer("/api/auth/me", { ...me, id: "u2" });
        await vi.waitFor(() => expect(useAccountStore.getState().me?.id).toBe("u2"));
      } finally {
        transport.stop();
        batcher.dispose();
        useAccountStore.setState(createInitialAccountState(), true);
      }
    });

    it("同一帧里两份快照(首次订阅 + resync 重订阅):各自在自己的边界收口,第二份不会被第一份的 id 删掉", () => {
      const { batcher, transport, socket } = wire();
      try {
        socket.frame([
          ev.subscribed(3), ev.balance(3), ev.order(3, "o1"), ev.position(3, "a1"),
          { t: "unsubscribed", topic: "account" },
          ev.subscribed(3), ev.balance(3), ev.order(3, "o2"), ev.position(3, "a2"),
        ]);
        batcher.flush();
        expect(openOrderIds()).toEqual(["o2"]);
        expect(positionIds()).toEqual(["a2"]);
      } finally {
        transport.stop();
        batcher.dispose();
        useAccountStore.setState(createInitialAccountState(), true);
      }
    });
  });
});

describe("dropStaleLastBar", () => {
  const rest = [bar(60_000, 3), bar(120_000, 4)];
  it("store 为空 / REST 为空:原样(同一数组)", () => {
    expect(dropStaleLastBar(rest, undefined)).toBe(rest);
    expect(dropStaleLastBar(rest, [])).toBe(rest);
    expect(dropStaleLastBar([], [bar(120_000, 9)])).toEqual([]);
  });
  it("store 里同一 t 的 bar 成交量更大(本地更新)→ 去掉 REST 最后一根;相等或更小 → 照用", () => {
    expect(dropStaleLastBar(rest, [bar(60_000, 3), bar(120_000, 5)])).toEqual([bar(60_000, 3)]);
    expect(dropStaleLastBar(rest, [bar(60_000, 3), bar(120_000, 4)])).toBe(rest);
    expect(dropStaleLastBar(rest, [bar(60_000, 3), bar(120_000, 2)])).toBe(rest); // 后台漏了事件,REST 更新
  });
  it("响应在路上时跨了桶:REST 最后一根对应 store 倒数第二根,同样按 v 比;store 里没有这根 → 照用", () => {
    expect(dropStaleLastBar(rest, [bar(120_000, 6), bar(180_000, 1)])).toEqual([bar(60_000, 3)]);
    expect(dropStaleLastBar(rest, [bar(120_000, 4), bar(180_000, 1)])).toBe(rest);
    expect(dropStaleLastBar(rest, [bar(180_000, 1)])).toBe(rest);
    expect(dropStaleLastBar(rest, [bar(0, 9), bar(60_000, 9)])).toBe(rest);
  });
  it("不改原数组", () => {
    const copy = rest.slice();
    dropStaleLastBar(rest, [bar(120_000, 9)]);
    expect(rest).toEqual(copy);
  });
});

describe("calibrateCandles", () => {
  const key = candleKey(SYM, "1m");
  const seed = (bars: CandleBar[]) => useMarketStore.setState({ candles: { [key]: bars } });
  const resp: CandlesResponse = { interval: "1m", candles: [bar(60_000, 3), bar(120_000, 4)] };

  it("WS 模式:比较前先 flush batcher;store 的最后一根更新(v 更大)时只灌 REST 之前的根", async () => {
    const { rt, push, flush } = fakeRuntime();
    marketActions.setConnection(WS_OPEN);
    seed([bar(60_000, 1), bar(120_000, 5, 7)]);
    const done = calibrateCandles(SYM, "1m", rt);
    expect(inflight.map((p) => p.url)).toEqual([`/api/market/${SYM}/candles?interval=1m&limit=1440`]);
    answer("/candles", resp);
    await done;
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0]);
    expect(push.mock.calls[0][0].map((e) => (e as { candle: CandleBar }).candle)).toEqual([bar(60_000, 3)]);
  });

  it("轮询模式:不与 store 比,REST 两根全灌(store 的最后一根 v 更大也照覆盖)", async () => {
    const { rt, push, flush } = fakeRuntime();
    marketActions.setConnection(POLL);
    seed([bar(60_000, 1), bar(120_000, 5, 7)]);
    const done = calibrateCandles(SYM, "1m", rt);
    answer("/candles", resp);
    await done;
    expect(flush).toHaveBeenCalledTimes(1);
    expect(push.mock.calls[0][0].map((e) => (e as { candle: CandleBar }).candle)).toEqual([bar(60_000, 3), bar(120_000, 4)]);
  });

  it("轮询模式端到端(真 store + 真 batcher):REST 已含的成交被下一次 pollMarket 再折一次,下一次校准把多算的纠回来", async () => {
    // 复现审查场景:tape 最新 ts = 100;校准在成交 X(ts 200)之后算出,REST 那根 v = 2;
    // 下一次 pollMarket 带来 X,store 只知道它比 tape 最新的新,再折一次 → v = 3(多算);
    // 再校准(REST 仍是 v = 2)必须覆盖回 2 —— 若按 v 比,本地 3 > 2 会把 REST 丢掉,多算永远留着
    const batcher = createBatcher((events) => marketActions.applyEvents(events), { hidden: () => false });
    const rt: MarketRuntime = { transport: fakeRuntime().rt.transport, batcher };
    const bucket = candleKey(SYM, "1m");
    const v = () => useMarketStore.getState().candles[bucket]?.[0]?.v;
    try {
      marketActions.setConnection(POLL);
      marketActions.applyEvents([{ t: "trades", topic: `trades:${SYM}`, seq: 0, symbol: SYM, trades: [tradeAt("t0", 100)] }]);
      seed([bar(0, 1)]);

      let done = calibrateCandles(SYM, "1m", rt);
      answer("/candles", { interval: "1m", candles: [bar(0, 2)] });
      await done;
      batcher.flush();
      expect(v()).toBe(2);

      done = pollMarket(SYM, rt);
      answer("/book", bookResp);
      answer("/trades", { trades: [tradeAt("x", 200), tradeAt("t0", 100)], seq: 0 });
      answer("/instruments", instrumentsResp);
      await done;
      batcher.flush();
      expect(v()).toBe(3); // 多算了 X(P1-13 的折算只看 tape 水位)

      done = calibrateCandles(SYM, "1m", rt);
      answer("/candles", { interval: "1m", candles: [bar(0, 2)] });
      await done;
      batcher.flush();
      expect(v()).toBe(2);
    } finally {
      batcher.dispose();
    }
  });

  it("store 为空(首次挂载)或最后一根更旧(后台漏了事件):整段历史灌入", async () => {
    const { rt, push } = fakeRuntime();
    marketActions.setConnection(WS_OPEN);
    let done = calibrateCandles(SYM, "1m", rt);
    answer("/candles", resp);
    await done;
    expect(push.mock.calls[0][0]).toHaveLength(2);
    seed([bar(120_000, 2)]);
    done = calibrateCandles(SYM, "1m", rt);
    answer("/candles", resp);
    await done;
    expect(push.mock.calls[1][0]).toHaveLength(2);
    expect(push.mock.calls[1][0].map((e) => e.t)).toEqual(["candle", "candle"]);
  });
});

describe("fetchCandles(图表历史与 calibrateCandles 共用在途请求)", () => {
  const resp: CandlesResponse = { interval: "1m", candles: [bar(60_000, 3), bar(120_000, 4)] };

  it("candlesUrl:分时 / 1m 取 1440 根,其它 500 根,symbol 编码", () => {
    expect(candlesUrl(SYM, "1m")).toBe(`/api/market/${SYM}/candles?interval=1m&limit=1440`);
    expect(candlesUrl(SYM, "4h")).toBe(`/api/market/${SYM}/candles?interval=4h&limit=500`);
    expect(candlesUrl("A B", "1d")).toBe("/api/market/A%20B/candles?interval=1d&limit=500");
  });

  it("同一 URL 并发两次只发一个请求,两边拿到同一份响应", async () => {
    const a = fetchCandles(SYM, "1m");
    const b = fetchCandles(SYM, "1m");
    expect(inflight.map((p) => p.url)).toEqual([candlesUrl(SYM, "1m")]);
    answer("/candles", resp);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(resp);
    expect(rb).toBe(ra);
  });

  it("换标的首次加载:calibrateCandles 的首轮与 ChartPanel 的历史请求同时发出 → 只有一个请求,两边都用上它", async () => {
    const { rt, push } = fakeRuntime();
    marketActions.setConnection(WS_OPEN);
    const calibrated = calibrateCandles(SYM, "1m", rt);
    const history = fetchCandles(SYM, "1m"); // ChartPanel 的 useChartHistory 走的就是它
    expect(inflight).toHaveLength(1);
    answer("/candles", resp);
    await calibrated;
    expect((await history).candles).toEqual(resp.candles);
    expect(push.mock.calls[0][0].map((e) => (e as { candle: CandleBar }).candle)).toEqual(resp.candles);
    // 共享的响应不被任何一方改写(calibrateCandles 另建对象、不动 candles 数组)
    expect(resp.candles).toEqual([bar(60_000, 3), bar(120_000, 4)]);
  });

  it("响应落地后不缓存:60 s 后的校准照样发新请求;不同 interval / symbol 各发各的", async () => {
    const first = fetchCandles(SYM, "1m");
    answer("/candles", resp);
    await first;
    const again = fetchCandles(SYM, "1m");
    const other = fetchCandles(SYM, "5m");
    const otherSym = fetchCandles("GS-REN-2020", "1m");
    expect(inflight.map((p) => p.url)).toEqual([candlesUrl(SYM, "1m"), candlesUrl(SYM, "5m"), candlesUrl("GS-REN-2020", "1m")]);
    answer("interval=1m&limit=1440", resp);
    answer("interval=5m", { interval: "5m", candles: [] });
    answer("GS-REN-2020", resp);
    await Promise.all([again, other, otherSym]);
  });

  it("失败:在途的等待者都拿到同一个错误;之后再取发新请求(重试不会拿到旧的失败)", async () => {
    const a = fetchCandles(SYM, "1m");
    const b = fetchCandles(SYM, "1m");
    answerError("/candles", 503);
    await expect(a).rejects.toThrow("HTTP 503");
    await expect(b).rejects.toThrow("HTTP 503");
    const retry = fetchCandles(SYM, "1m");
    expect(inflight).toHaveLength(1);
    answer("/candles", resp);
    await expect(retry).resolves.toEqual(resp);
  });
});
