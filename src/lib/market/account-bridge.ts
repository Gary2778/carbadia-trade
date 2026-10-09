// 账户 store 的接缝(与 selectors.ts 的 registerOpenOrdersSource 同一模式)。
// MarketProvider 需要的东西都来自 account-store.ts(P1-15):当前用户 id(决定订不订 account、pollAccount 的 restartKey)、
// 账户事件入口(batcher 里的 order / fill / balance / position / trigger / notice 事件不属于市场 store;有批量入口时一批一次)、
// 快照灌入后的收口(retainOpenOrders / retainPositions / retainTriggers:轮询快照与 WS 的 account 订阅快照都表达不了「已经没有了」)、
// 以及登录 / 登出后让 transport 重连;另有挂单 / 持仓的版本号(轮询快照判断自己是否过时)、已知身份(ws-client 比对 hello)、
// 只拉列表(终端挂载)与重新确认身份(ws-client 发现身份不一致)。开放委托的翻页(fetchOpenOrders)两边都要用(hydrate 与 pollAccount),也放在这里。
// 本文件不 import account-store,也不 import 传输层,是个零依赖叶子(只有类型导入):account-store / Nav 只引它,
// 不会把 ws-client 拖进全站 bundle。
// 未注册时:meId 恒 null、账户事件丢弃、收口与重连请求空操作;注册时已挂载的订阅者会被通知并改读新源。
import type { AccountOrdersResponse, AccountTriggersResponse, Me, Order, ServerEvent, Trigger } from "@/shared";

/** 未读通知数的重读时机(notice-refresh 的 refreshUnreadNotices):WS 的 account 订阅快照到了 / 标签页回到前台 / 轮询的一轮 / 面板的写回因更新的 notice 事件被丢弃(stale) */
export type NoticeRefreshReason = "subscribed" | "visible" | "poll" | "stale";

export type AccountEvent = Extract<ServerEvent, { t: "order" | "fill" | "balance" | "position" | "trigger" | "notice" }>;

export type AccountSource = {
  subscribe: (listener: () => void) => () => void;
  getState: () => { me: Me };
  applyAccountEvent: (event: AccountEvent) => void;
  /** 批量入口(可选):一批账户事件一次 store 更新;没有时 bridge 逐条调 applyAccountEvent */
  applyAccountEvents?: (events: readonly AccountEvent[]) => unknown;
  /**
   * 快照只能覆盖、不能表达「已不在挂单里」(轮询的 /api/account/orders?status=open 翻完的全量、WS 的 account 订阅快照):
   * 提供时 MarketProvider 在灌入快照时调用它只保留这些 id(已成交 / 已撤的旧单从 openOrders 移除)。
   */
  retainOpenOrders?: (ids: ReadonlySet<string>) => void;
  /**
   * 与 retainOpenOrders 同形:快照(/api/account/positions、WS 订阅快照)只含数量 > 0 的持仓,卖光的那一行不会以 0 出现,
   * 提供时 MarketProvider 在灌入快照时调用它只保留这些 assetId。
   */
  retainPositions?: (assetIds: ReadonlySet<string>) => void;
  /**
   * 与 retainOpenOrders 同形:快照(WS 订阅快照、轮询的 /api/account/triggers?status=open)只含未完结(PENDING / TRIGGERING)的条件单,
   * 断线期间触发 / 撤销 / 被拒的那条不会以终态出现在快照里,提供时 MarketProvider 在灌入快照时调用它只保留这些 id。
   */
  retainTriggers?: (ids: ReadonlySet<string>) => void;
  /**
   * 挂单 / 持仓 / 条件单切片的版本号:任一被替换(事件、快照、收口、本地下单 / 撤单 / 建条件单、登录态变化)就 +1。
   * 轮询快照在请求发出时记下它,响应到了发现变过 —— 请求期间 store 被写过,快照比 store 旧 —— 本轮不收口不灌入(pollAccount)。
   */
  listsVersion?: () => number;
  /** 已知身份:ready → 用户 id,anon(含未确认的)→ null,idle / loading → undefined(还不知道,ws-client 不据此比对) */
  knownMeId?: () => string | null | undefined;
  /** 只拉挂单与持仓(终端挂载或登录后,transport 还没把它们送来时;见 MarketProvider) */
  loadLists?: () => void;
  /** 重新确认身份(只拉 /api/auth/me):ws-client 发现 hello 的身份与本 store 不一致、或 account 被拒(unauthorized)时 */
  refresh?: () => void;
};

let source: AccountSource | null = null;
const listeners = new Set<() => void>();
const sourceUnsubs = new Map<() => void, () => void>();
let reconnectHandler: (() => void) | null = null;

export function registerAccountSource(next: AccountSource | null): void {
  if (next === source) return;
  for (const unsub of sourceUnsubs.values()) unsub();
  sourceUnsubs.clear();
  source = next;
  for (const listener of listeners) {
    if (source) sourceUnsubs.set(listener, source.subscribe(listener));
    listener();
  }
}

/** useSyncExternalStore 的 subscribe:源换了也会通知 */
export function subscribeAccount(listener: () => void): () => void {
  listeners.add(listener);
  if (source) sourceUnsubs.set(listener, source.subscribe(listener));
  return () => {
    listeners.delete(listener);
    sourceUnsubs.get(listener)?.();
    sourceUnsubs.delete(listener);
  };
}

export function readMeId(): string | null {
  return source?.getState().me?.id ?? null;
}
/** 服务端 / 水合快照:恒未登录 */
export const readServerMeId = (): null => null;

export const isAccountEvent = (ev: ServerEvent): ev is AccountEvent =>
  ev.t === "order" || ev.t === "fill" || ev.t === "balance" || ev.t === "position" || ev.t === "trigger" || ev.t === "notice";

/**
 * batcher 的 apply 回调用:把一批事件里的账户事件(原序)转给账户 store —— 源有批量入口时整批一次(N 条事件一次 set()),
 * 否则逐条;一批里没有账户事件时不调用。返回转交条数(未注册时 0)。
 */
export function applyAccountEvents(events: readonly ServerEvent[]): number {
  if (!source) return 0;
  let batch: AccountEvent[] | null = null;
  for (const ev of events) if (isAccountEvent(ev)) (batch ??= []).push(ev);
  if (!batch) return 0;
  if (source.applyAccountEvents) source.applyAccountEvents(batch);
  else for (const ev of batch) source.applyAccountEvent(ev);
  return batch.length;
}

export function retainOpenOrders(ids: ReadonlySet<string>): void {
  source?.retainOpenOrders?.(ids);
}

export function retainPositions(assetIds: ReadonlySet<string>): void {
  source?.retainPositions?.(assetIds);
}

export function retainTriggers(ids: ReadonlySet<string>): void {
  source?.retainTriggers?.(ids);
}

/** 挂单 / 持仓 / 条件单的版本号(见 AccountSource.listsVersion);未注册或源不提供时恒 0(轮询快照照旧收口) */
export function readListsVersion(): number {
  return source?.listsVersion?.() ?? 0;
}

/** 已知身份(见 AccountSource.knownMeId);未注册时 undefined(不比对) */
export function readKnownMeId(): string | null | undefined {
  return source?.knownMeId?.();
}

export function requestAccountLists(): void {
  source?.loadLists?.();
}

export function requestAccountRefresh(): void {
  source?.refresh?.();
}

// 未读通知数的重读(WS 断开期间写进库的通知不会补发:订阅快照到了 / 轮询时校正铃铛的角标)。实现在 notice-refresh.ts —— 它不在每页的 floor 包里,
// 只随终端 / 资产页的 NoticeToaster 一起加载,加载时在这里登记;没登记(别的页面、测试)时请求是空操作。
let noticeRefresher: ((reason: NoticeRefreshReason) => void) | null = null;

export function registerNoticeRefresher(refresher: ((reason: NoticeRefreshReason) => void) | null): void {
  noticeRefresher = refresher;
}

export function requestNoticeRefresh(reason: NoticeRefreshReason): void {
  noticeRefresher?.(reason);
}

// ---- 开放委托翻页(hydrate 与 pollAccount 共用)----
export const OPEN_ORDERS_URL = "/api/account/orders?status=open";
/** 每页条数:路由的上限(src/lib/server/cursor.ts MAX_PAGE_LIMIT) */
export const OPEN_ORDERS_PAGE_LIMIT = 100;
/**
 * 页数上限:20 页 × 100 = 2000 张挂单。演示账户正常远达不到;真到了(或游标出错一直有下一页)就停,
 * 返回 complete: false —— 调用方此时不能把拿到的部分当全量:不 retain、不整体替换,只 upsert。
 */
export const OPEN_ORDERS_MAX_PAGES = 20;

export type OpenOrdersPages = { orders: Order[]; complete: boolean };

/**
 * 按 nextCursor 翻完 GET /api/account/orders?status=open(键集分页,createdAt desc, id desc)。
 * 任一页失败整体 reject(不返回半截结果:调用方本轮不 retain、不替换,保留现状);fetchJson 由调用方注入(@/lib/http/client 的 api 或测试替身),
 * 本文件因此仍无运行时依赖。
 */
export async function fetchOpenOrders(fetchJson: <T>(url: string) => Promise<T>): Promise<OpenOrdersPages> {
  const orders: Order[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < OPEN_ORDERS_MAX_PAGES; page++) {
    const url: string = `${OPEN_ORDERS_URL}&limit=${OPEN_ORDERS_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res: AccountOrdersResponse = await fetchJson<AccountOrdersResponse>(url);
    for (const order of res.orders) orders.push(order);
    cursor = res.nextCursor;
    if (!cursor) return { orders, complete: true };
  }
  return { orders, complete: false };
}

// ---- 未完结条件单(只有 pollAccount 用)----
export const OPEN_TRIGGERS_URL = "/api/account/triggers?status=open";
/** 路由的每页上限(与挂单同一个键集分页);每个用户未完结的条件单与提醒合计 ≤ 50(服务端创建时查),一页装得下 */
export const OPEN_TRIGGERS_PAGE_LIMIT = 100;

export type OpenTriggersPage = { triggers: Trigger[]; complete: boolean };

/**
 * GET /api/account/triggers?status=open 的一页。complete = 没有下一页:服务端的 50 条上限保证它恒为真,
 * 万一不是(上限被改、游标出错),调用方就不能把这一页当全量去 retain(只 upsert),与 fetchOpenOrders 超页数时同一个处理。
 * 失败整体 reject(调用方本轮不 retain、不灌入,保留现状)。
 */
export async function fetchOpenTriggers(fetchJson: <T>(url: string) => Promise<T>): Promise<OpenTriggersPage> {
  const res = await fetchJson<AccountTriggersResponse>(`${OPEN_TRIGGERS_URL}&limit=${OPEN_TRIGGERS_PAGE_LIMIT}`);
  return { triggers: res.triggers, complete: res.nextCursor === null };
}

/** MarketProvider 挂载时注册 transport.reconnect;账户 store 登录 / 登出后调 requestTransportReconnect() */
export function registerTransportReconnect(handler: (() => void) | null): void {
  reconnectHandler = handler;
}
export function requestTransportReconnect(): void {
  reconnectHandler?.();
}
