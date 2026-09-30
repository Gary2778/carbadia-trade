"use client";
// 账户 store(计划 §3.6、§3.2「登录态」):zustand 5 模块级单例,登录态一处维护,Nav / 终端 / 下单面板共用。
//
// SSR 规则同 store.ts:服务端渲染与客户端水合期只见 createInitialAccountState()(me 未知、status idle),
// 所以 Nav 的账户区在 SSR 与水合首帧不画(与旧版 `!loaded` 一致,无水合不一致);hydrate 只在挂载后的 effect 与事件回调里调用
// (Nav 挂载时一次;终端之外换路径时节流刷新(refreshOnNavigation);登录 / 注册 / demo 成功后由那几个页面各调一次;
// 旧页面改了余额之后(refresh);/api/auth/me 瞬时失败后的自愈重试 —— 定时器与几个事件触发,见 unverified),
// 渲染期不读写本 store 的 action。
// 两种 hydrate:"me" 只拉 /api/auth/me(身份与余额,Nav 与旧页面只要这些,首屏只多这一个请求 —— 与 main 的 Nav 同价);
// "full" 再拉持仓与全部挂单页。挂单 / 持仓列表只有终端要:MarketProvider 的 account 订阅快照 / 轮询,
// 以及挂载时 transport 还没送来之前的 loadAccountLists。
//
// 写入纪律:所有写入都经本文件的 action(accountActions),applyAccountEvents 一批一次 set()(account-bridge 经批量入口转来,
// batcher 一次 flush 里的 N 条账户事件也是一次);结构共享 —— 只替换被触碰的切片,
// 未触碰的 Map / 数组引用不变(selectors 的 useShallow 与 book-view 的 minePricesOf 靠引用判断)。
// 金额整数分、数量整数吨、时间 unix ms。
//
// 依赖纪律:Nav 在根布局里 import 本文件,所以这里只引零依赖叶子(account-bridge.ts、open-orders-source.ts)与 http client,
// 绝不引 ./selectors、./store 或传输层 —— 否则市场 store / book-view / ws-client 会进每个页面的 floor bundle(计划 §7.1)。
// 账户 hooks(useMe / useBalance / …)也因此放在本文件而不是 selectors.ts(selectors 引 store.ts);下游从 @/lib/market/account-store 导入。
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Balance, Fill, Me, Order, Position, PositionsResponse, ServerEvent } from "@/shared";
import { ApiError, api } from "@/lib/http/client";
import { fetchOpenOrders, registerAccountSource, requestTransportReconnect, type AccountEvent, type AccountSource, type OpenOrdersPages } from "./account-bridge";
import { registerOpenOrdersSource } from "./open-orders-source";

/** account topic 的四种事件与判别函数:定义在 account-bridge.ts(P1-14),这里再导出,不重复定义 */
export type { AccountEvent } from "./account-bridge";
export { isAccountEvent } from "./account-bridge";

export type AccountStatus = "idle" | "loading" | "ready" | "anon";
/** 可注入的请求函数(默认 @/lib/http/client 的 api):测试用假实现按 URL 应答 */
export type FetchJson = <T>(url: string, init?: RequestInit) => Promise<T>;

export type AccountState = {
  /** undefined = 尚未知(idle / loading);null = 未登录;对象 = 已登录(cashBalance / lockedCash 与 balance 同步) */
  me: Me | undefined;
  balance: Balance | null;
  /** 当前挂单(OPEN / PARTIAL)按 id;只整体替换、从不就地修改 */
  openOrders: Map<string, Order>;
  /** 持仓按 assetId;quantity 归零即移除 */
  positions: Map<string, Position>;
  /** 新 → 旧,≤ MAX_RECENT_FILLS;hydrate 不拉历史(FillsTab 自己分页 /api/account/fills),只收 fill 事件 */
  recentFills: Fill[];
  status: AccountStatus;
  /**
   * 非 null = 这个 anon 没有经过确认:不是 ready 时 /api/auth/me 瞬时失败(网络 status 0、5xx、响应不可解析、HYDRATE_TIMEOUT_MS 超时;首次 hydrate,
   * 或登录后的那次 hydrate),按旧 Nav 的 catch → null 先显示成未登录,但要能自愈 —— retryHydrateIfUnverified 由 watchHydrateRetry
   * 的定时器在 retryAt 到点时调用,另外在路径变化、online、页面重新可见时也调用;失败 attempts 次后下次可重试的时刻是 retryAt(unix ms)。
   * 401 与 me === null 是确认的 anon,恒为 null。
   */
  unverified: { attempts: number; retryAt: number } | null;
};

export const MAX_RECENT_FILLS = 200;
/**
 * 未确认 anon 的重试节奏:第一次失败后立即可重试(登录后那一拍 /me 抖动,紧接着的 router.push 就能重拉,不用等退避),
 * 之后每次失败退避 2 s、4 s、8 s … 封顶 60 s。次数只沿重试链累加(retryHydrateIfUnverified 发起的 hydrate 失败);
 * 其它来源(Nav 挂载、登录 / 注册 / demo 之后)的 hydrate 失败从 1 计 —— 刚登录的人不该背着之前访客期攒下的退避。
 */
export const HYDRATE_RETRY_BASE_MS = 2_000;
export const HYDRATE_RETRY_MAX_MS = 60_000;
const hydrateRetryDelay = (attempts: number): number => (attempts <= 1 ? 0 : Math.min(HYDRATE_RETRY_BASE_MS * 2 ** (attempts - 2), HYDRATE_RETRY_MAX_MS));
/**
 * 一次 hydrate 的总期限(覆盖 /api/auth/me、持仓与全部挂单页):到点 abort 所有在途请求,按 status 0 的 ApiError 处理 ——
 * 不是 ready 时落进 unverified(随后由重试修复),ready 原样保留。连接被接受却永远不回时,hydrate 也会结束,
 * 认证页的跳转与自愈重试的在途保护都不会被它挂住。hydrate 提前结束(例如持仓 500 让 Promise.all 先 reject)时,
 * 被丢下的请求(还在翻的挂单页)同样在结束那一刻 abort,之后也不再发新页 —— 没有脱离期限、永远挂着的请求。
 */
export const HYDRATE_TIMEOUT_MS = 10_000;
/**
 * 登录 / 注册 / demo 成功后,跳转前最多等 hydrate 这么久(hydrateForNavigation);正常情况下 hydrate 几百毫秒就回,
 * 新身份在跳转前已进 store。等不到就先跳,hydrate 在后台继续,结果照常落进 store。
 */
export const AUTH_NAVIGATE_WAIT_MS = 3_000;

/** 终端之外换路径时,两次身份 / 余额刷新之间至少隔这么久(计入任何一次 hydrate) */
export const NAV_REFRESH_MIN_MS = 10_000;

const ME_URL = "/api/auth/me";
const POSITIONS_URL = "/api/account/positions";
const LOGOUT_URL = "/api/auth/logout";

export function createInitialAccountState(): AccountState {
  return { me: undefined, balance: null, openOrders: new Map(), positions: new Map(), recentFills: [], status: "idle", unverified: null };
}

/** 模块级单例。不含 action:写入一律走下面的函数 / accountActions */
export const useAccountStore = create<AccountState>()(() => createInitialAccountState());

const isOpenStatus = (status: Order["status"]): boolean => status === "OPEN" || status === "PARTIAL";

/**
 * 已终结(FILLED / CANCELLED)挂单 id 的有界记录(插入序,满 CLOSED_ORDERS_MAX 丢最早记下的)。终结不可逆,之后同一 id 的
 * OPEN / PARTIAL 一律丢弃:跨 bundle 的发布器可能把路由那份「挂上」排在机器人那份「成交」之后送到(market-publisher 的文件头),
 * OpenOrdersTab 先落了 REST 撤单响应、之后才到一条撤单前的 PARTIAL,轮询 / hydrate 的快照读在撤单之前 —— 不挡的话这张单会以
 * 幽灵挂单留在 Open Orders 与盘口的自家档上,直到下一次快照,撤它还会被服务端拒绝。
 * 不管这张单在不在本地挂单里都记(「成交」先于「挂上」到达时它还不在)。不放进 state:记一个 id 不改任何可见状态,
 * 对本地没有的单,这条事件仍算无变化、不 set()。属于当前用户:me.id 变化(登出、换人、store 重置)即清空(模块末尾的 subscribe)。
 * 完整快照替换挂单时不清:快照若带着记录里的单,那是终结之前读出的旧行,同样该丢(openOrdersFrom)。
 */
export const CLOSED_ORDERS_MAX = 256;
let closedOrders = new Set<string>();
function rememberClosed(ids: readonly string[]): void {
  for (const id of ids) {
    closedOrders.delete(id); // 重新记一次挪到最新
    closedOrders.add(id);
  }
  for (const id of closedOrders) {
    if (closedOrders.size <= CLOSED_ORDERS_MAX) break;
    closedOrders.delete(id);
  }
}

/**
 * 迟到的旧行:已存的版本成交更多或更新得更晚(与 order-submit.ts 的 supersededByPush 同一判据)。
 * 同一张单的 PARTIAL(2) 晚于 PARTIAL(4) 到达时不回退;相等(快照重发同一行)照常覆盖。
 */
const olderThan = (incoming: Order, existing: Order): boolean => existing.filledQuantity > incoming.filledQuantity || existing.updatedAt > incoming.updatedAt;

/**
 * 归约本体:patch 只含被触碰的切片(无变化为 null);applied = 真正改了状态的账户事件条数
 * (终态单本来不在挂单里、重复的 fill、本来没有的零持仓、被判为旧的 / 已终结的 OPEN·PARTIAL 都不算;未登录时恒为 0);
 * closed = 本批里终结的挂单 id(调用方记进 closedOrders;纯归约本身不写模块状态)。
 */
function foldAccountEvents(
  state: AccountState,
  events: readonly ServerEvent[],
  closed: ReadonlySet<string>,
): { patch: Partial<AccountState> | null; applied: number; closed: string[] } {
  const newlyClosed: string[] = [];
  if (!state.me) return { patch: null, applied: 0, closed: newlyClosed };
  let openOrders: Map<string, Order> | null = null;
  let positions: Map<string, Position> | null = null;
  let recentFills: Fill[] | null = null;
  let fillIds: Set<string> | null = null;
  let balance: Balance | undefined;
  let applied = 0;

  for (const ev of events) {
    switch (ev.t) {
      case "order": {
        const { order } = ev;
        if (isOpenStatus(order.status)) {
          if (closed.has(order.id) || newlyClosed.includes(order.id)) break; // 已终结:终结不可逆
          const existing = (openOrders ?? state.openOrders).get(order.id);
          if (existing && olderThan(order, existing)) break;
          openOrders ??= new Map(state.openOrders);
          openOrders.set(order.id, order);
          applied++;
        } else {
          newlyClosed.push(order.id);
          if (!(openOrders ?? state.openOrders).has(order.id)) break;
          openOrders ??= new Map(state.openOrders);
          openOrders.delete(order.id);
          applied++;
        }
        break;
      }
      case "fill": {
        // 重复的 fill 不复制数组:整批都是重复时 recentFills 引用不变
        fillIds ??= new Set(state.recentFills.map((f) => f.id));
        if (fillIds.has(ev.fill.id)) break;
        fillIds.add(ev.fill.id);
        recentFills ??= state.recentFills.slice();
        recentFills.unshift(ev.fill);
        if (recentFills.length > MAX_RECENT_FILLS) recentFills.length = MAX_RECENT_FILLS;
        applied++;
        break;
      }
      case "balance": {
        balance = ev.balance;
        applied++;
        break;
      }
      case "position": {
        const { position } = ev;
        if (position.quantity > 0) {
          positions ??= new Map(state.positions);
          positions.set(position.assetId, position);
          applied++;
        } else if ((positions ?? state.positions).has(position.assetId)) {
          positions ??= new Map(state.positions);
          positions.delete(position.assetId);
          applied++;
        }
        break;
      }
      default:
        // hello / subscribed / … / book / trades / ticker / candle:属于市场 store
        break;
    }
  }

  const patch: Partial<AccountState> = {};
  let changed = false;
  if (openOrders) {
    patch.openOrders = openOrders;
    changed = true;
  }
  if (positions) {
    patch.positions = positions;
    changed = true;
  }
  if (recentFills) {
    patch.recentFills = recentFills;
    changed = true;
  }
  if (balance) {
    patch.balance = balance;
    patch.me = { ...state.me, cashBalance: balance.cashBalance, lockedCash: balance.lockedCash };
    changed = true;
  }
  return { patch: changed ? patch : null, applied, closed: newlyClosed };
}

/**
 * 纯归约:把一批服务端事件折成账户 store 的 patch(只含被触碰的切片;无变化返回 null)。
 * order:OPEN / PARTIAL 写入 openOrders(比已存的旧 —— 成交更少或更新得更早 —— 或已终结的单跳过),FILLED / CANCELLED 移出;
 * fill:前插 recentFills、按 id 去重、上限 MAX_RECENT_FILLS;balance:整体替换并镜像进 me;position:按 assetId upsert,quantity 归零即移除。
 * 未登录(me 为空)时一律忽略:没有身份就没有 account 订阅,迟到的事件不该复活状态。市场事件与协议事件不改本 store。
 * 读 closedOrders(已终结挂单的记录)但不写它:记录由 applyAccountEvents 落。
 */
export function reduceAccountEvents(state: AccountState, events: readonly ServerEvent[]): Partial<AccountState> | null {
  return foldAccountEvents(state, events, closedOrders).patch;
}

/**
 * 一批事件一次 set();返回真正改了状态的账户事件条数(未登录、整批无变化 —— 补丁为空 —— 时为 0,且不 set())。
 * MarketProvider 的 batcher 经 account-bridge 的批量入口调到这里:一次 flush 里的 N 条账户事件只触发一次 store 更新。
 * 本批终结的挂单记进 closedOrders(补丁为空时也记)。
 */
export function applyAccountEvents(events: readonly ServerEvent[]): number {
  const { patch, applied, closed } = foldAccountEvents(useAccountStore.getState(), events, closedOrders);
  if (patch) useAccountStore.setState(patch);
  rememberClosed(closed);
  return patch ? applied : 0;
}

export function applyAccountEvent(ev: AccountEvent): void {
  applyAccountEvents([ev]);
}

/** 只保留 keep 里的键;无变化时返回 null(调用方不 set,引用不变) */
function retainKeys<V>(map: Map<string, V>, keep: ReadonlySet<string>): Map<string, V> | null {
  let next: Map<string, V> | null = null;
  for (const key of map.keys()) {
    if (keep.has(key)) continue;
    next ??= new Map(map);
    next.delete(key);
  }
  return next;
}

/**
 * 快照(轮询翻完的 /api/account/orders?status=open、WS 的 account 订阅快照)只能覆盖、不能表达「已不在挂单里」:
 * MarketProvider 灌入快照时调用它,只保留这些 id(已成交 / 已撤的旧单移除);无变化时引用不变。
 */
export function retainOpenOrders(ids: ReadonlySet<string>): void {
  const next = retainKeys(useAccountStore.getState().openOrders, ids);
  if (next) useAccountStore.setState({ openOrders: next });
}

/**
 * 同形:/api/account/positions 与 WS 订阅快照只含数量 > 0 的持仓,卖光的持仓不会以 0 出现在快照里,
 * 只靠 position 事件删不掉(轮询期间与断线期间卖光的就一直留着)。只保留这些 assetId;无变化时引用不变。
 */
export function retainPositions(assetIds: ReadonlySet<string>): void {
  const next = retainKeys(useAccountStore.getState().positions, assetIds);
  if (next) useAccountStore.setState({ positions: next });
}

// ---- 登录态迁移 ----
// 身份 = me?.id;「已知」指 status 为 ready / anon。只有从已知身份变到另一个身份才请求传输层重连:
// 首次 hydrate(idle → 任意)不重连,因为 WS 在 upgrade 时已带同一份 cookie 验过签。
// 未确认的 anon 也按 null 计:它变成 ready 时照样重连一次。自愈重试成功时 cookie 其实没变、这次重连是多余的(一次短暂断开),
// 但同一状态也可能是「真的未登录 → 在这之后登录了」,那时 socket 是匿名建的,不重连就订不上 account;两者在客户端分不开,取稳妥的一边。
const knownIdentity = (state: AccountState): string | null | undefined => (state.status === "ready" || state.status === "anon" ? (state.me?.id ?? null) : undefined);

const EMPTY_ORDERS: Map<string, Order> = new Map();
const EMPTY_POSITIONS: Map<string, Position> = new Map();
const NO_FILLS: Fill[] = [];

/** 每次显式的登录态变化(hydrate 开始、setMe、logout)领一张票;在途的 hydrate 回来后票不对就丢弃 */
let hydrateTicket = 0;

/** 确认的 anon(401、me === null、登出) */
function becomeAnon(): void {
  const prev = useAccountStore.getState();
  const wasKnown = knownIdentity(prev);
  if (prev.status === "anon" && prev.me === null && !prev.unverified) return;
  useAccountStore.setState({ me: null, balance: null, openOrders: EMPTY_ORDERS, positions: EMPTY_POSITIONS, recentFills: NO_FILLS, status: "anon", unverified: null });
  if (wasKnown !== undefined && wasKnown !== null) requestTransportReconnect();
}

/**
 * 不是 ready 时 /api/auth/me 瞬时失败(身份尚未知的首次 hydrate,或 anon 再次 hydrate —— 只有登录 / 注册 / demo 之后才会这样做,
 * cookie 可能刚换过):先显示成未登录,记一次失败并定下次可重试的时刻(第一次失败是立即,见 hydrateRetryDelay;
 * watchHydrateRetry 的定时器对准它)。fromRetry(重试链上的失败)沿用并累加次数,否则从 1 计。
 * 不重连:身份在 knownIdentity 眼里不变(未知或 null)。
 */
function becomeUnverifiedAnon(fromRetry: boolean): void {
  const attempts = (fromRetry ? (useAccountStore.getState().unverified?.attempts ?? 0) : 0) + 1;
  useAccountStore.setState({
    me: null,
    balance: null,
    openOrders: EMPTY_ORDERS,
    positions: EMPTY_POSITIONS,
    recentFills: NO_FILLS,
    status: "anon",
    unverified: { attempts, retryAt: Date.now() + hydrateRetryDelay(attempts) },
  });
}

/**
 * 挂单快照 → openOrders:翻完了(complete)整体替换;超过页数上限(截断)只在现有基础上 upsert 拿到的部分、不删 ——
 * 拿不到的那部分可能还挂着,不能当成已成交 / 已撤。
 */
function openOrdersFrom(pages: OpenOrdersPages, base: Map<string, Order>): Map<string, Order> {
  const next = pages.complete ? new Map<string, Order>() : new Map(base);
  // 已终结的单:快照读在终结之前(本地已落了撤单响应 / 终态推送),不让它回来
  for (const order of pages.orders) if (!closedOrders.has(order.id)) next.set(order.id, order);
  return next;
}

/**
 * 登录态就绪:me 与 balance 同步(balance 以 positions 快照为准,与持仓同一事务读出;没有快照时取 me 自带的余额);
 * positions / orders 传 null 表示「保留现状」(账户端点暂时失败、翻页中途失败、setMe 未拉列表);换用户时上一位的挂单 / 持仓 / 成交一律清空。
 */
function becomeReady(me: NonNullable<Me>, positions: PositionsResponse | null, orders: OpenOrdersPages | null): void {
  const prev = useAccountStore.getState();
  const wasKnown = knownIdentity(prev);
  const sameUser = prev.me?.id === me.id;
  const prevOrders = sameUser ? prev.openOrders : EMPTY_ORDERS;
  const balance: Balance = positions ? positions.balance : { cashBalance: me.cashBalance, lockedCash: me.lockedCash };
  useAccountStore.setState({
    me: { ...me, cashBalance: balance.cashBalance, lockedCash: balance.lockedCash },
    balance,
    openOrders: orders ? openOrdersFrom(orders, prevOrders) : prevOrders,
    positions: positions ? new Map(positions.positions.map((p) => [p.assetId, p])) : sameUser ? prev.positions : EMPTY_POSITIONS,
    recentFills: sameUser ? prev.recentFills : NO_FILLS,
    status: "ready",
    unverified: null,
  });
  if (wasKnown !== undefined && wasKnown !== me.id) requestTransportReconnect();
}

const isUnauthorized = (err: unknown): boolean => err instanceof ApiError && err.status === 401;

type Deadline = { signal: AbortSignal; expired: Promise<never>; settle: () => void };

/**
 * 一次 hydrate 的期限:到点 abort signal 并让 expired 以 status 0 的 ApiError reject。
 * hydrate 结束时 settle():清定时器,并以同样的方式 abort / reject 一次 —— 结果已定,还在途的请求(Promise.all 提前 reject 后
 * 被丢下的挂单翻页)一律取消,不再受任何期限约束地挂着;成功路径上请求都已完成,这一步无副作用。
 */
function createDeadline(ms: number): Deadline {
  const controller = new AbortController();
  let expire!: (err: ApiError) => void;
  const expired = new Promise<never>((_resolve, reject) => (expire = reject));
  expired.catch(() => {}); // 期限到时可能已没有请求在等它:不算未处理的 rejection
  const end = (message: string): void => {
    if (controller.signal.aborted) return;
    const err = new ApiError(message, 0);
    controller.abort(err);
    expire(err);
  };
  const timer = setTimeout(() => end("Request timed out"), ms);
  return {
    signal: controller.signal,
    expired,
    settle: () => {
      clearTimeout(timer);
      end("Hydrate settled");
    },
  };
}

/**
 * 给每个请求套上期限:signal 经 init 交给 fetchJson(默认的 api 客户端透传给 fetch,到点真的断开连接);
 * 同时与 expired 赛跑,不理会 signal 的 fetchJson(测试替身等)也会在到点时结束。期限已到或 hydrate 已结束时不再发出新请求。
 */
function withDeadline(fetchJson: FetchJson, deadline: Deadline): FetchJson {
  return <T,>(url: string, init?: RequestInit): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (deadline.signal.aborted) {
        reject(deadline.signal.reason);
        return;
      }
      deadline.expired.catch(reject);
      fetchJson<T>(url, { ...init, signal: deadline.signal }).then(resolve, reject);
    });
}

/**
 * mode "full"(默认):合并 /api/auth/me + /api/account/positions + /api/account/orders?status=open(按 nextCursor 翻完,见 fetchOpenOrders)
 * 为一次登录态刷新;mode "me":只拉 /api/auth/me(Nav、认证页、自愈重试、旧页面的刷新 —— 它们只要身份与余额)。
 * /api/auth/me 回 null 或 401 → 确认的 anon(计划 §3.6);其它失败(网络 status 0、5xx、响应不可解析、超时):ready 原样保留、不重连 ——
 * 一次瞬时故障不该把已登录用户显示成登出、清掉终端共用的挂单 / 持仓并断开 account 订阅;其余状态(idle / loading / anon)按旧 Nav 的
 * catch → null 语义落到 anon,并记为 unverified 以便自愈(retryHydrateIfUnverified)。anon 也算在内,因为 anon 只在登录 / 注册 / demo
 * 之后才会再 hydrate:那一拍的 /api/auth/me 失败若按「确认的 anon」原样保留,刚登录的人会一直显示成未登录。
 * 账户端点(含任一页挂单)401(两次请求之间会话失效)→ anon;其它失败(含超时)→ 仍按 me 标记 ready、余额取 me,持仓 / 挂单保留现状。
 * 挂单超过页数上限时只 upsert 不替换(openOrdersFrom)。status 只在 idle 时才进 loading(重刷不闪)。
 * 全部请求共用一个 HYDRATE_TIMEOUT_MS 的期限,所以 hydrate 总会在期限内结束;结束时仍在途的请求一并取消。
 */
export type HydrateMode = "full" | "me";

export function hydrate(fetchJson: FetchJson = api, mode: HydrateMode = "full"): Promise<void> {
  return runHydrate(fetchJson, false, mode);
}

/**
 * 正在跑的那次 hydrate 的票(没有在跑的为 null)。它等于 hydrateTicket = 最新的一次 hydrate 还在途(没被 setMe / logout /
 * 更新的 hydrate 取代):retryHydrateIfUnverified 此时不发起重试 —— 否则重试会领新票、让在途的(例如登录页那次)结果作废,
 * 还把登录前访客期攒下的失败次数带过来。每次 hydrate 都在 HYDRATE_TIMEOUT_MS 内结束,所以最多挡这么久。
 */
let runningTicket: number | null = null;

/** 最近一次 hydrate 开始的时刻(unix ms);refreshOnNavigation 据此节流 */
let lastHydrateAt = Number.NEGATIVE_INFINITY;

/**
 * fromRetry:由 retryHydrateIfUnverified 发起(重试链),/api/auth/me 失败时沿用并累加失败次数。
 * mode "me":/api/auth/me 成功即 becomeReady(me, null, null) —— 同一用户保留挂单 / 持仓 / 成交,换了用户清空;失败语义与 full 相同。
 */
async function runHydrate(fetchJson: FetchJson, fromRetry: boolean, mode: HydrateMode): Promise<void> {
  const ticket = ++hydrateTicket;
  runningTicket = ticket;
  lastHydrateAt = Date.now();
  const fresh = (): boolean => ticket === hydrateTicket;
  if (useAccountStore.getState().status === "idle") useAccountStore.setState({ status: "loading" });
  const deadline = createDeadline(HYDRATE_TIMEOUT_MS);
  const timed = withDeadline(fetchJson, deadline);

  try {
    let me: Me;
    try {
      me = await timed<Me>(ME_URL);
    } catch (err) {
      if (!fresh()) return;
      if (isUnauthorized(err)) becomeAnon();
      else if (useAccountStore.getState().status !== "ready") becomeUnverifiedAnon(fromRetry);
      return;
    }
    if (!fresh()) return;
    if (!me) {
      becomeAnon();
      return;
    }
    if (mode === "me") {
      becomeReady(me, null, null);
      return;
    }
    try {
      const [positions, orders] = await Promise.all([timed<PositionsResponse>(POSITIONS_URL), fetchOpenOrders(timed)]);
      if (!fresh()) return;
      becomeReady(me, positions, orders);
    } catch (err) {
      if (!fresh()) return;
      if (isUnauthorized(err)) becomeAnon();
      else becomeReady(me, null, null);
    }
  } finally {
    deadline.settle();
    if (runningTicket === ticket) runningTicket = null;
  }
}

/**
 * 登录 / 注册 / demo 成功后、router.push 之前调用:发起一次 hydrate,等到它结束或等满 maxWaitMs,先到者为准;从不 reject。
 * 正常情况下新身份在跳转前已进 store;等满时先跳,hydrate 在后台继续 —— 票号照旧处理迟到的结果,失败或超时落进 unverified,
 * 由 watchHydrateRetry 的定时器修复。认证页的忙碌态因此不会被挂起的请求卡住。
 */
export function hydrateForNavigation(fetchJson: FetchJson = api, maxWaitMs: number = AUTH_NAVIGATE_WAIT_MS): Promise<void> {
  // 只要身份:跳去终端的话,挂单 / 持仓由 MarketProvider(登录引起的重连 + account 订阅快照,或 loadAccountLists)补上
  const run = hydrate(fetchJson, "me");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs);
  });
  return Promise.race([run, waited]).finally(() => clearTimeout(timer));
}

/** 直接写入登录态(登录流程拿到用户对象时用;null = 本地登出)。不拉列表:挂单 / 持仓由随后的 account 订阅快照或 hydrate 补上 */
export function setMe(me: Me): void {
  hydrateTicket++;
  if (me) becomeReady(me, null, null);
  else becomeAnon();
}

/** POST /api/auth/logout 成功后清空并请求重连;请求失败则原样抛出、store 不动(服务端会话仍在) */
export async function logout(fetchJson: FetchJson = api): Promise<void> {
  await fetchJson(LOGOUT_URL, { method: "POST" });
  hydrateTicket++;
  becomeAnon();
}

/**
 * 未确认 anon 的自愈:只有 unverified、到了 retryAt、且最新的一次 hydrate 不在途时才重拉一次(watchHydrateRetry 的定时器到点时、
 * 以及 Nav 的路径变化、online、页面重新可见时调用);确认的状态(ready、401 / null 的 anon)、idle / loading、退避未到都是空操作。
 * 在途判定按票(runningTicket === hydrateTicket),不分来源:几个触发同一拍到达只发一次;登录 / 注册 / demo 之后那次 hydrate
 * 还在途时也不插队(它的结果不会被作废,访客期的失败次数也不会被带过去,见 runningTicket);在途的被取代后不再挡路,
 * 挂住时最多挡 HYDRATE_TIMEOUT_MS —— 它结束时要么解决问题,要么换一个新的 unverified,watchHydrateRetry 随之重新对准。
 * 这里发起的 hydrate 是重试链:失败时次数累加、退避加长。返回发起的 hydrate(没发起为 null)。
 */
export function retryHydrateIfUnverified(fetchJson: FetchJson = api): Promise<void> | null {
  const { unverified } = useAccountStore.getState();
  if (!unverified || runningTicket === hydrateTicket || Date.now() < unverified.retryAt) return null;
  return runHydrate(fetchJson, true, "me");
}

/**
 * Nav 的路径 effect(计划 §4.1 把 Nav 改成读 store 之后,终端之外没有别的东西刷新它 —— main 的 Nav 每次换路径都拉 /api/auth/me):
 *   - 未确认的 anon:照旧走自愈重试(retryHydrateIfUnverified,任何路径);
 *   - 已确认的状态(ready,以及确认的 anon —— 别的标签页登录 / 登出、会话过期也要在下一次导航时反映出来),路径不以 /trade 开头:
 *     只拉 /api/auth/me(mode "me"),距上一次任何 hydrate 开始不足 NAV_REFRESH_MIN_MS、或有 hydrate 在途时不拉;
 *   - /trade 下不拉:那里 MarketProvider 的推送 / 轮询在维护余额,REST 结果可能比刚到的推送旧;
 *   - idle / loading:挂载那次还没回,不插队。
 * 票号照旧丢弃过期结果;ready 重刷不闪(status 只在 idle 时进 loading)。返回发起的 hydrate(没发起为 null)。
 */
export function refreshOnNavigation(pathname: string, fetchJson: FetchJson = api): Promise<void> | null {
  const { status, unverified } = useAccountStore.getState();
  if (unverified) return retryHydrateIfUnverified(fetchJson);
  if (status !== "ready" && status !== "anon") return null;
  if (pathname.startsWith("/trade") || runningTicket === hydrateTicket) return null;
  const since = Date.now() - lastHydrateAt;
  if (since >= 0 && since < NAV_REFRESH_MIN_MS) return null; // 时钟被往回调过(since < 0)时不算刚刷过
  return runHydrate(fetchJson, false, "me");
}

/**
 * 立即重拉 /api/auth/me(mode "me"),不节流,取代在途的 hydrate(它可能读在变化之前):
 * 旧页面改了余额之后(OTC 买入、简易交易下单、资产页撤单)、会话在旧页面上被判失效(401)时、
 * 以及 ws-client 发现 hello 的身份与本 store 不一致或 account 被拒时(经 account-bridge 的 requestAccountRefresh)。
 */
export function refresh(fetchJson: FetchJson = api): Promise<void> {
  return runHydrate(fetchJson, false, "me");
}

/**
 * 只拉挂单与持仓(终端挂载、登录后:Nav 不再替终端拉它们)。只对 ready 的用户发起,否则返回 null。
 * 结果只在请求期间什么都没变时才落:挂单 / 持仓被写过(account 订阅快照、推送、本地下单 / 撤单 —— 都比这份 REST 新)、
 * 或身份变了(换人、登出、又一次 hydrate)就整份丢弃;余额(与持仓同一事务读出)另看:期间余额被写过就不用它的。
 * 挂单翻完(complete)整体替换,截断时只 upsert;已终结的单不回来(openOrdersFrom)。401 → 会话已失效,refresh 定身份;
 * 其它失败不动 store(推送 / 轮询随后补上)。共用 hydrate 的期限。
 */
export function loadAccountLists(fetchJson: FetchJson = api): Promise<void> | null {
  const start = useAccountStore.getState();
  if (start.status !== "ready" || !start.me) return null;
  const userId = start.me.id;
  const identity = hydrateTicket;
  const version = listsVersion;
  const deadline = createDeadline(HYDRATE_TIMEOUT_MS);
  const timed = withDeadline(fetchJson, deadline);
  return (async () => {
    try {
      const [positions, orders] = await Promise.all([timed<PositionsResponse>(POSITIONS_URL), fetchOpenOrders(timed)]);
      const now = useAccountStore.getState();
      if (identity !== hydrateTicket || version !== listsVersion || now.status !== "ready" || now.me?.id !== userId) return;
      const patch: Partial<AccountState> = {
        openOrders: openOrdersFrom(orders, now.openOrders),
        positions: new Map(positions.positions.map((p) => [p.assetId, p])),
      };
      if (now.balance === start.balance && now.me) {
        patch.balance = positions.balance;
        patch.me = { ...now.me, cashBalance: positions.balance.cashBalance, lockedCash: positions.balance.lockedCash };
      }
      useAccountStore.setState(patch);
    } catch (err) {
      if (isUnauthorized(err) && identity === hydrateTicket) void refresh(fetchJson);
    } finally {
      deadline.settle();
    }
  })();
}

type RetryEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * 给 retryHydrateIfUnverified 挂三个触发,返回解除函数:
 *   - 定时器:unverified 每变一次就对准新的 retryAt 重设(第一次失败后是立即),到点自己重试 —— 用户停在原页、网络一直在线、
 *     页面一直可见时也能自愈,不靠用户操作;页面在后台时到点不拉,等回到前台的 visibilitychange;
 *   - window 的 online、document 的 visibilitychange(变为 visible 时)。
 * Nav 挂载时调用一次(它在根布局里,认证页也在);解除时一并清掉定时器与 store 订阅。
 * target / document 可注入(测试用 EventTarget),无 window / document(服务端)时空操作。
 */
export function watchHydrateRetry(
  opts: { target?: RetryEventTarget; document?: RetryEventTarget & { visibilityState: DocumentVisibilityState }; fetchJson?: FetchJson } = {},
): () => void {
  const target = opts.target ?? (typeof window !== "undefined" ? window : undefined);
  const doc = opts.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!target && !doc) return () => {};
  const fetchJson = opts.fetchJson ?? api;
  const retry = (): void => void retryHydrateIfUnverified(fetchJson);
  const onVisibility = (): void => {
    if (doc?.visibilityState === "visible") retry();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let armedFor: AccountState["unverified"] = null;
  const arm = (unverified: AccountState["unverified"]): void => {
    if (unverified === armedFor) return;
    armedFor = unverified;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!unverified) return;
    timer = setTimeout(() => {
      timer = null;
      if (doc?.visibilityState === "hidden") return;
      // 系统时钟被往回调过时可能早到:按剩下的时间再对一次,不空转
      if (Date.now() < unverified.retryAt) {
        armedFor = null;
        arm(unverified);
        return;
      }
      retry(); // 失败 → becomeUnverifiedAnon 换了 unverified → 订阅里对准下一个 retryAt;成功 / 确认 anon → null,不再设
    }, Math.max(0, unverified.retryAt - Date.now()));
  };
  const unsubscribeStore = useAccountStore.subscribe((state) => arm(state.unverified));
  arm(useAccountStore.getState().unverified);

  target?.addEventListener("online", retry);
  doc?.addEventListener("visibilitychange", onVisibility);
  return () => {
    unsubscribeStore();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    target?.removeEventListener("online", retry);
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
}

export const accountActions = {
  hydrate,
  hydrateForNavigation,
  refreshOnNavigation,
  refresh,
  loadAccountLists,
  applyAccountEvent,
  applyAccountEvents,
  retainOpenOrders,
  retainPositions,
  setMe,
  logout,
  retryHydrateIfUnverified,
};

/** 挂单 / 持仓切片的版本号:任一引用被替换就 +1(结构共享保证真改了才换引用)。轮询快照与 loadAccountLists 据此判断请求期间 store 有没有被写过 */
let listsVersion = 0;

// 已终结挂单的记录属于当前用户:身份变化(登出、换人、store 重置)即清空
useAccountStore.subscribe((state, prev) => {
  if (state.me?.id !== prev.me?.id) closedOrders = new Set();
  if (state.openOrders !== prev.openOrders || state.positions !== prev.positions) listsVersion++;
});

// ---- 接缝(模块初始化时注册,两个都是零依赖叶子)----
// P1-13:useBookView 的自家档(mine)从这里读 openOrders;useAccountStore 的 subscribe / getState 结构上就是 OpenOrdersSource。
registerOpenOrdersSource(useAccountStore);
// P1-14:MarketProvider 经 account-bridge 读当前用户 id(决定订不订 account、pollAccount 的 restartKey)、转发 batcher 里的账户事件
// (批量入口,一批一次 set())、快照灌入时收口挂单与持仓(轮询快照、WS 的 account 订阅快照)。
// bridge 的 me 是 Me(null = 未登录),本 store 的 me 在 idle / loading 期是 undefined(尚未知),故 ?? null。
// 反方向:登录 / 登出(已知身份变化)后本 store 调 bridge 的 requestTransportReconnect(),MarketProvider 挂载时在那里注册了
// transport.reconnect;新连接在 upgrade 时重新验签 cookie,account topic 随之可订 / 不可订(§3.2)。
/** 本 store 注册给 account-bridge 的源(导出供测试在 registerAccountSource(null) 之后接回) */
export const accountSource: AccountSource = {
  subscribe: useAccountStore.subscribe,
  getState: () => ({ me: useAccountStore.getState().me ?? null }),
  applyAccountEvent,
  applyAccountEvents,
  retainOpenOrders,
  retainPositions,
  listsVersion: () => listsVersion,
  knownMeId: () => knownIdentity(useAccountStore.getState()),
  loadLists: () => void loadAccountLists(),
  refresh: () => void refresh(),
};
registerAccountSource(accountSource);

// ---- 纯选择函数(hook 的计算部分,可在 node 环境测试)----
const byNewest = (a: Order, b: Order): number => b.createdAt - a.createdAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
/** 当前挂单,新 → 旧;symbol 传入时只取该标的 */
export function openOrdersOf(openOrders: ReadonlyMap<string, Order>, symbol?: string): Order[] {
  const out: Order[] = [];
  for (const order of openOrders.values()) if (!symbol || order.symbol === symbol) out.push(order);
  return out.sort(byNewest);
}
/** 持仓按 symbol 升序(与 /api/account/positions 同序) */
export function positionsOf(positions: ReadonlyMap<string, Position>): Position[] {
  return [...positions.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
}

// ---- selectors(全部 useShallow;SSR / 水合期读到的是初始状态:me undefined、status idle)----
export function useMe(): Me | undefined {
  return useAccountStore(useShallow((s) => s.me));
}
export function useBalance(): Balance | null {
  return useAccountStore(useShallow((s) => s.balance));
}
export function useAccountStatus(): AccountStatus {
  return useAccountStore((s) => s.status);
}
export function usePosition(assetId: string): Position | undefined {
  return useAccountStore(useShallow((s) => s.positions.get(assetId)));
}
export function usePositions(): Position[] {
  return useAccountStore(useShallow((s) => positionsOf(s.positions)));
}
export function useOpenOrders(symbol?: string): Order[] {
  return useAccountStore(useShallow((s) => openOrdersOf(s.openOrders, symbol)));
}
