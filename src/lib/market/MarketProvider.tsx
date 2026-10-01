"use client";
// MarketProvider(计划 §3.1 组件树、§3.2 客户端 realm 与降级路径、§3.6):终端里唯一挂 transport、batcher 与三个 usePolling 的地方,
// 无渲染输出。transport / batcher 是模块级单例(首次在浏览器里创建,永不随路由重建);组件挂载 / 卸载只 start / stop。
// 资产页 /trade/account 不订阅任何标的,挂的是 ./AccountFeed.tsx:它与这里共用 startFeed(ticker:* + transport 生命周期)、
// subscribeAccountTopic(account)与 pollAccount,两个组件不会同时挂载(不同页面)。
//
//   - 首屏:挂载后的 effect 里 marketActions.setInstruments(initialInstruments, { onlyIfEmpty: true }) 灌入 SSR props —— 这是 store 的
//     唯一初始写入口,不在渲染期写(zustand action 不是 React setState,react-hooks/set-state-in-effect 不触发);
//   - 订阅集以 symbol 为 restartKey:book:S、trades:S 随 symbol,candles:S:<interval> 随 symbol + interval,ticker:* 常驻,
//     account 在登录后;旧 symbol 退订 90 s 后 evictSymbol(来回切换零加载);
//   - 三个 usePolling 始终挂着(hook 顺序稳定):pollMarket 2 s、pollAccount 5 s 只在 connection.transport === "poll" 时打 REST,
//     请求在途时切回了 WS(或登出)则丢弃迟到的响应;calibrateCandles 60 s 两种模式都跑,WS 模式下 REST 的最后一根若比
//     store 里的旧就不用,轮询模式 REST 一律覆盖(本地折算不知道 REST 已算过哪些成交,按 v 比会让多算永远纠不回来);
//     REST 结果经 poll-frames 翻成 ServerFrame 喂同一 batcher;失败 throw 让 usePolling 退避;
//   - batcher 的 apply:marketActions.applyEvents(市场事件)+ applyAccountEvents(order / fill / balance / position 经 bridge 的
//     批量入口转账户 store,一批一次 set());
//   - 账户快照的收口:快照只能覆盖、表达不了「已经没有了」(已成交 / 已撤的单、卖光且没注销过的持仓)。轮询路径在 push 快照帧前
//     retainOpenOrders(挂单翻完才调)+ retainPositions;WS 路径由 ws-client 识别 account 订阅快照的边界(account-snapshot 事件,
//     帧在快照末尾切开交付),这里先 flush batcher 让快照落地,再按快照里的 id 收口(reconcileAccountSnapshot);
//   - 账户列表:Nav 只拉身份与余额,挂单 / 持仓归终端 —— account 订阅快照、轮询,以及身份就绪时 transport 送不来的话
//     自己拉一次(loadAccountListsUnlessStreamed:WS 还在连就先等 ACCOUNT_LISTS_GRACE_MS,快照到了就不拉);轮询快照若在请求期间
//     store 被写过(本地下单 / 撤单)整轮丢弃;
//   - 身份:ws-client 按账户 store 的已知身份比对 hello(expectedUserId),不一致或 account 被拒时 onTransportEvent 让 store 重新 hydrate;
//   - 环境:NEXT_PUBLIC_MARKET_TRANSPORT(默认 ws)、NEXT_PUBLIC_WS_URL(默认同源 /ws,https → wss),构建期内联;
//     运行期另有服务端提示 transportMode(服务端没有 /ws(transportModeForServer:START_MODE=next、本进程没有 hub、或 WS_DISABLED=1) → "poll",page.tsx 读出、经 TerminalShell 传来):回滚模式下首帧就轮询。
import { useEffect, useSyncExternalStore } from "react";
import type { BookResponse, CandleBar, CandleInterval, CandlesResponse, ConnectionState, InstrumentListItem, InstrumentsResponse, PositionsResponse, Topic, TradesResponse } from "@/shared";
import { useWatchlist } from "@/components/exchange/useExchange";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/http/client";
import {
  applyAccountEvents,
  fetchOpenOrders,
  readKnownMeId,
  readListsVersion,
  readMeId,
  readServerMeId,
  registerTransportReconnect,
  requestAccountLists,
  requestAccountRefresh,
  retainOpenOrders,
  retainPositions,
  subscribeAccount,
} from "./account-bridge";
import { createBatcher, type Batcher } from "./batcher";
import { framesFromAccount, framesFromBook, framesFromCandles, framesFromInstruments, framesFromTrades } from "./poll-frames";
import { usePrefs } from "./prefs";
import { candleKey, marketActions, useMarketStore } from "./store";
import { createTransportManager, resolveWsUrl, transportModeFromEnv, type TransportManager, type TransportMode, type WsClientEvent } from "./transport";

export const POLL_MARKET_MS = 2_000;
export const POLL_ACCOUNT_MS = 5_000;
export const CALIBRATE_CANDLES_MS = 60_000;
/** 退订后保留旧 symbol 数据的时长 */
export const EVICT_DELAY_MS = 90_000;
/** 分时(1m)= 24 h,其它 interval 默认 500 根 */
export const candlesLimitFor = (interval: CandleInterval): number => (interval === "1m" ? 1440 : 500);

export type MarketRuntime = { transport: TransportManager; batcher: Batcher };

let runtime: MarketRuntime | null = null;

/** 模块级单例:首次在浏览器里调用时创建,之后永不重建;服务端返回 null(SSR 不碰传输层) */
export function getMarketRuntime(): MarketRuntime | null {
  if (typeof window === "undefined") return null;
  if (!runtime) {
    const batcher = createBatcher((events) => {
      marketActions.applyEvents(events);
      applyAccountEvents(events);
    });
    const transport = createTransportManager({
      mode: transportModeFromEnv(process.env.NEXT_PUBLIC_MARKET_TRANSPORT),
      wsUrl: resolveWsUrl(process.env.NEXT_PUBLIC_WS_URL, window.location),
      onFrame: (frame) => batcher.push(frame),
      onState: (state) => marketActions.setConnection(state),
      onEvent: (event) => onTransportEvent(event, batcher),
      // hello 的身份与账户 store 的已知身份比对(见 ws-client 的 expectedUserId)
      ws: { expectedUserId: readKnownMeId },
    });
    runtime = { transport, batcher };
  }
  return runtime;
}

// ---- 旧 symbol 的延迟淘汰 ----
const evictTimers = new Map<string, ReturnType<typeof setTimeout>>();
function cancelEvict(symbol: string): void {
  const timer = evictTimers.get(symbol);
  if (timer === undefined) return;
  clearTimeout(timer);
  evictTimers.delete(symbol);
}
function scheduleEvict(symbol: string): void {
  cancelEvict(symbol);
  evictTimers.set(
    symbol,
    setTimeout(() => {
      evictTimers.delete(symbol);
      marketActions.evictSymbol(symbol);
    }, EVICT_DELAY_MS),
  );
}

const isPolling = (): boolean => useMarketStore.getState().connection.transport === "poll";
const marketPath = (symbol: string, tail: string): string => `/api/market/${encodeURIComponent(symbol)}/${tail}`;

/** 公开 K 线历史的 URL:calibrateCandles 与 ChartPanel 的图表历史用同一个(fetchCandles 按它合并在途请求) */
export const candlesUrl = (symbol: string, interval: CandleInterval): string =>
  marketPath(symbol, `candles?interval=${interval}&limit=${candlesLimitFor(interval)}`);

// 按 URL 的在途请求;响应落地(成功或失败)即删除 —— 只合并同时发出的请求,不做缓存,60 s 后的校准照常取新数据
const candlesInflight = new Map<string, Promise<CandlesResponse>>();

/**
 * 取 K 线历史,同一 URL 在途时共用那一个请求。换 symbol / interval 时 calibrateCandles 的首轮(usePolling 立即执行)
 * 与 ChartPanel 的历史请求几乎同时发出:公开端点 s-maxage=5 的边缘缓存合并不了两个并发的未命中,
 * 不合并就是每次切换多一次请求。两边拿到同一个响应对象,都只读不改(calibrateCandles 另建对象,图表先 slice 再用)。
 * 失败时在途的等待者拿到同一个错误,条目随之删除,重试发新请求。
 */
export function fetchCandles(symbol: string, interval: CandleInterval): Promise<CandlesResponse> {
  const url = candlesUrl(symbol, interval);
  let pending = candlesInflight.get(url);
  if (!pending) {
    pending = api<CandlesResponse>(url).finally(() => candlesInflight.delete(url));
    candlesInflight.set(url, pending);
  }
  return pending;
}

/** pollMarket 的三个请求绕过浏览器缓存(P1-25e,原因见 pollMarket 的说明) */
const POLL_FETCH: RequestInit = { cache: "no-store" };

/**
 * 轮询降级:盘口 + 成交 + 标的列表(三个公开端点并发),翻成快照帧喂 batcher;失败抛出让 usePolling 退避。
 * 发起前与响应到达后各查一次 transport:请求在途时探测的 hello 到了(切回 WS)的话,这份响应比 hub 刚发的快照旧,
 * 灌进去会用旧簿覆盖新簿、让随后的 delta 叠在旧基线上,所以丢弃。
 * 三个请求都 cache: "no-store"(POLL_FETCH):公开端点的 Cache-Control 是给边缘用的(max-age=1、stale-while-revalidate=2),浏览器同样照办 ——
 * 2 s 一轮的轮询会拿到缓存里上一轮的响应,同时浏览器另发一条后台重验证请求(回滚演练里每轮 2 次请求、盘口慢一轮)。
 * no-store 只绕过浏览器缓存;Worker 的边缘缓存按 URL 匹配、不看请求头,照常命中。
 */
export async function pollMarket(symbol: string, rt: MarketRuntime): Promise<void> {
  if (!isPolling()) return;
  const [book, trades, instruments] = await Promise.all([
    api<BookResponse>(marketPath(symbol, "book?depth=50"), POLL_FETCH),
    api<TradesResponse>(marketPath(symbol, "trades?limit=100"), POLL_FETCH),
    api<InstrumentsResponse>("/api/market/instruments", POLL_FETCH),
  ]);
  if (!isPolling()) return;
  rt.batcher.push([...framesFromBook(symbol, book), ...framesFromTrades(symbol, trades), ...framesFromInstruments(instruments)]);
  // 标的元数据只在 store 还空着时灌(正常由 initialInstruments 灌过);行情走上面的 ticker 帧
  marketActions.setInstruments(instruments.instruments, { onlyIfEmpty: true });
}

/**
 * 轮询降级 + 已登录:持仓 / 余额 + 当前挂单(按 nextCursor 翻完,见 fetchOpenOrders);先按快照收口挂单与持仓集合
 * (已成交 / 已撤的旧单、卖光的持仓移除 —— /api/account/positions 对卖光且没注销过的持仓不返回数量 0 的行),再喂事件。
 * 整仓注销的行(数量 0、retired > 0)是持仓载荷的一部分(计划 §6.2.2 C1):REST 返回它,收口集合里有它,
 * 账户 store 的折叠也保留它(holdsPosition)—— 注销之后这一行在 ≤ 5 s 内变成 quantity 0、retired 增加,而不是消失。
 * 挂单超过页数上限(complete: false)时不 retainOpenOrders:拿到的只是前 2000 张,其余可能还挂着;帧照常 push(只 upsert)。
 * 任一请求(含翻页中途)失败 → reject,usePolling 退避,本轮不 retain、不 push,保留现状。
 * 迟到的响应(在途时切回了 WS,或已登出 / 换了用户)丢弃:快照里的 OPEN 单会把 WS 刚删掉的已成交 / 已撤单救回来,
 * 之后再没有该单的事件来纠正,它会一直留在 openOrders 里。
 * 请求期间 store 的挂单 / 持仓被写过(请求发出时刻与最近一次写入按版本号比,见 account-bridge 的 readListsVersion;
 * 典型是 OrderPanel 刚落了一张新单、OpenOrdersTab 刚落了撤单响应)同样丢弃整轮:这份快照读在那次变更之前,收口会删掉刚下的单,
 * 灌入会把刚撤的单以 OPEN 写回(后者另有账户 store 的已终结记录兜底)。5 s 后的下一轮照常。
 */
export async function pollAccount(meId: string, rt: MarketRuntime): Promise<void> {
  if (!isPolling()) return;
  const version = readListsVersion();
  const [positions, orders] = await Promise.all([api<PositionsResponse>("/api/account/positions"), fetchOpenOrders(api)]);
  if (!isPolling() || readMeId() !== meId || readListsVersion() !== version) return;
  if (orders.complete) retainOpenOrders(new Set(orders.orders.map((o) => o.id)));
  retainPositions(new Set(positions.positions.map((p) => p.assetId)));
  rt.batcher.push(framesFromAccount(orders.orders, positions.positions, positions.balance));
}

/**
 * transport 的生命周期事件:account 订阅快照 → 收口(reconcileAccountSnapshot);身份不一致(hello.userId 与账户 store 不同、
 * 或 account 被拒 unauthorized —— 别的标签页登录 / 登出 / 换人、会话过期)→ 让账户 store 重新拉 /api/auth/me:身份真的变了,
 * store 走 becomeReady / becomeAnon(清掉上一位的列表、请求重连,新连接的 hello 一致后 account 照常订上);没变则什么都不动。
 */
export function onTransportEvent(event: WsClientEvent, batcher: Pick<Batcher, "flush">): void {
  if (event.type === "account-snapshot") {
    settleAccountLists(false); // 列表由快照送到了,不用自己拉
    reconcileAccountSnapshot(event, batcher);
  } else if (event.type === "identity-mismatch") requestAccountRefresh();
  else if (event.type === "connect-failed") settleAccountLists(true); // 在等快照的话:WS 一时来不了,现在就拉
}

/** 身份就绪时 WS 还在连:给它这么久送来 account 订阅快照(hello + 快照通常不到 1 s),到点还没来就自己拉(P1-25c 复审) */
export const ACCOUNT_LISTS_GRACE_MS = 3_000;

/**
 * 身份就绪(终端挂载时已登录、或在终端里登录)时,终端要不要自己拉一次挂单与持仓(accountActions.loadAccountLists,经 bridge):
 * Nav 只拉 /api/auth/me,列表归终端。
 *   - "skip":WS 已连上(account 订阅的快照马上就到),或已在轮询(pollAccount 随 meId 立即跑一轮);
 *   - "defer":WS 还在连 —— 硬刷新 /trade 时 Nav 的 /api/auth/me 往往先于 WS 的 hello 回来(它复用页面的 HTTP 连接,WS 要新建连接、
 *     升级、hello),立刻拉就与随后的订阅快照把同一份数据读两遍。等 ACCOUNT_LISTS_GRACE_MS:期间快照到了就不拉,连不上(connect-failed)
 *     立刻拉,到点还没快照(连上了但身份不一致没订 account、快照被背压扣着)也拉;到点时已在轮询则交给 pollAccount;
 *   - "now":传输层没在跑、离线(1008 之后还没降级的一瞬)。
 * 拉与快照谁先谁后都对:loadAccountLists 发现期间列表被写过就整份丢弃。
 */
export function accountListsPlan(connection: ConnectionState): "now" | "defer" | "skip" {
  if (connection.transport === "poll") return "skip";
  if (connection.transport === "ws" && connection.state === "open") return "skip";
  if (connection.transport === "ws" && connection.state === "connecting") return "defer";
  return "now";
}

// 等快照的宽限计时器(模块级:transport 事件经 onTransportEvent 结束它;同一时刻至多一个)
let accountListsTimer: ReturnType<typeof setTimeout> | null = null;

/** 结束等待;load 为真且此刻不在轮询时自己拉一次。没在等时什么都不做 */
function settleAccountLists(load: boolean): void {
  if (accountListsTimer === null) return;
  clearTimeout(accountListsTimer);
  accountListsTimer = null;
  if (load && !isPolling()) requestAccountLists();
}

/**
 * 身份就绪时按 accountListsPlan 拉列表(MarketProvider 的 meId effect 调用);返回取消函数(effect 清理:登出、换人、离开终端)。
 * connection 缺省读 store 的当前值(测试可传入)。
 */
export function loadAccountListsUnlessStreamed(connection: ConnectionState = useMarketStore.getState().connection): () => void {
  settleAccountLists(false);
  const plan = accountListsPlan(connection);
  if (plan === "now") requestAccountLists();
  else if (plan === "defer") {
    accountListsTimer = setTimeout(() => {
      accountListsTimer = null;
      if (!isPolling()) requestAccountLists();
    }, ACCOUNT_LISTS_GRACE_MS);
  }
  return () => settleAccountLists(false);
}

/**
 * WS 模式下 account 订阅快照(hub 在 subscribe account 时发 balance → 逐条 order → 逐条 position,§3.3)的收口:
 * ws-client 把帧在快照末尾切开:快照及之前的部分交给 batcher 之后上报 account-snapshot(边界识别见 ws-client),此时快照还在 batcher 里没应用;
 * 先 flush 让它(连同之前积压的帧)落进账户 store,再只保留快照里的挂单 id / 持仓 assetId —— 断线期间成交或撤掉的委托、
 * 卖光的持仓不会出现在快照里,不收口就永远留着。快照里的持仓与 REST 同一口径(计划 §6.2.2 C1):整仓注销的行
 *(数量 0、retired > 0)在快照里,所以在收口集合里、不会被收走;卖光且没注销过的不在。ids 只是快照自己的行:订阅之后、快照之前到达的增量都比快照旧
 *(hub 查询期间有该用户的事件就重查,见 ws-client 的 accountWatch),它们碰过、快照里却没有的挂单 / 持仓已经没了;
 * 同一帧里跟在快照后面的增量(比快照新)要等这里返回之后才交给 batcher,所以这次 flush 应用不到、收口也删不到它们。
 * 前提:快照是全量(hub 的快照来源读全部 OPEN / PARTIAL 挂单与全部持仓,不设条数上限)。将来若给快照加上限,
 * 必须同时给出「是否完整」的信号并在这里照 pollAccount 的 complete 处理,否则收口会删掉真实存在的挂单。
 * 一次 account 订阅一次,强制 flush 的代价可以忽略。
 */
export function reconcileAccountSnapshot(snapshot: Extract<WsClientEvent, { type: "account-snapshot" }>, batcher: Pick<Batcher, "flush">): void {
  batcher.flush();
  retainOpenOrders(snapshot.orderIds);
  retainPositions(snapshot.assetIds);
}

/**
 * (只用于 WS 模式)REST 历史的最后一根在服务端算出时还在形成;响应在路上时本地可能已经收到了更新的 candle 事件。
 * hub 的 candle 事件是服务端算好的整根、从不重复计量,一根 bar 内成交量只增不减,所以 store 里同一 t 的 bar 若 v 更大
 * 就是更新的,REST 那根不用(否则 close / volume 会倒退一拍,直到下一条 candle 事件)。v 相等或更小时照用(REST 更新或相同)。
 * 只看最后一根:之前的在请求时已收口,REST 是权威,校准的目的正是修正它们。首次挂载 store 为空,整段历史原样灌入。
 * 轮询模式不比(calibrateCandles 传 live = undefined,原因见那里)。
 */
export function dropStaleLastBar(rest: CandleBar[], live: readonly CandleBar[] | undefined): CandleBar[] {
  if (rest.length === 0 || !live || live.length === 0) return rest;
  const newest = rest[rest.length - 1];
  // live 按 t 升序;REST 的最后一根通常是 live 的最后一根或倒数第二根(响应在路上时跨了桶),从尾部找
  for (let i = live.length - 1; i >= 0; i--) {
    const bar = live[i];
    if (bar.t < newest.t) break;
    if (bar.t === newest.t) return bar.v > newest.v ? rest.slice(0, -1) : rest;
  }
  return rest;
}

/**
 * 两种模式都跑:REST 历史(fetchCandles,与图表历史共用在途请求)按 t upsert 进 store,修正轮询模式的本地折算漂移、补上后台期间漏掉的 candle 事件;
 * 比较前先 flush batcher,拿到的才是含最后一帧事件的 store(否则一帧之内的 candle 事件会被比错)。
 * 只有 WS 模式才拿 store 的最后一根与 REST 比(dropStaleLastBar)。轮询模式 REST 一律覆盖:store 把 tape 里比已知最新成交
 * 更新的成交折进最后一根,不知道 REST 已经算过哪些——校准之后下一次 pollMarket 带来的成交若已含在 REST 那根里会再折一次
 * (v 多算一笔),这时若按 v 比,本地永远「更新」,REST 再也覆盖不了,多算的量在桶关闭前一直累积(5m / 1h / 1d 是几小时,
 * START_MODE=next 回滚时所有人都在轮询);一律覆盖则多算 / 少算都只活到下一次 60 s 校准。
 */
export async function calibrateCandles(symbol: string, interval: CandleInterval, rt: MarketRuntime): Promise<void> {
  const r = await fetchCandles(symbol, interval);
  rt.batcher.flush();
  const state = useMarketStore.getState();
  const live = state.connection.transport === "ws" ? state.candles[candleKey(symbol, interval)] : undefined;
  rt.batcher.push(framesFromCandles(symbol, interval, { ...r, candles: dropStaleLastBar(r.candles, live) }));
}

/**
 * 与标的无关的那一半(终端的 MarketProvider 与资产页的 AccountFeed 共用,P2-10):登记登录 / 登出后的重连钩子、
 * 常驻订阅 ticker:*、按服务端提示启动 transport(transportMode === "poll" 时首帧就轮询、不试 /ws);返回清理函数(effect 的清理)。
 */
export function startFeed(rt: MarketRuntime, transportMode?: TransportMode): () => void {
  registerTransportReconnect(() => rt.transport.reconnect());
  rt.transport.subscribe("ticker:*");
  rt.transport.start(transportMode);
  return () => {
    registerTransportReconnect(null);
    rt.transport.unsubscribe("ticker:*");
    rt.transport.stop();
  };
}

/**
 * 登录后的 account 订阅(两处共用):订阅 account;挂单 / 持仓 transport 送不来(或一时送不来)时自己拉一次
 *(loadAccountListsUnlessStreamed)。返回清理函数:登出、换人、离开页面时取消等待并退订。
 */
export function subscribeAccountTopic(rt: MarketRuntime): () => void {
  rt.transport.subscribe("account");
  const cancelLists = loadAccountListsUnlessStreamed();
  return () => {
    cancelLists();
    rt.transport.unsubscribe("account");
  };
}

export type MarketProviderProps = {
  symbol: string;
  /** 不传时读 usePrefs().interval(服务端与水合首帧为默认 1m) */
  interval?: CandleInterval;
  /** SSR 首屏数据;挂载后灌入 store(onlyIfEmpty) */
  initialInstruments?: InstrumentListItem[];
  /** 服务端的运行期传输提示:"poll" = 服务端没有 /ws(transportModeForServer:START_MODE=next、本进程没有 hub、或 WS_DISABLED=1),transport.start("poll") 首帧就轮询、不试 /ws;缺省按构建期模式 */
  transportMode?: TransportMode;
};

export function MarketProvider({ symbol, interval: intervalProp, initialInstruments, transportMode }: MarketProviderProps): null {
  const prefs = usePrefs();
  const interval = intervalProp ?? prefs.interval;
  const meId = useSyncExternalStore(subscribeAccount, readMeId, readServerMeId);
  const { symbols: watchlist } = useWatchlist();
  const watchKey = watchlist.join("\n");

  // 首屏数据进 store 的唯一入口:挂载后,不在渲染期
  useEffect(() => {
    if (initialInstruments) marketActions.setInstruments(initialInstruments, { onlyIfEmpty: true });
  }, [initialInstruments]);

  // transport 生命周期 + ticker:* 常驻订阅 + 登录 / 登出重连钩子。运行期提示 "poll"(回滚模式)时 start("poll"):
  // connection 同步报 poll/degraded,随后的 usePolling 首轮就打 REST —— 没有「先试 /ws、3 次超时再降级」的 30 余秒
  useEffect(() => {
    const rt = getMarketRuntime();
    if (!rt) return;
    return startFeed(rt, transportMode);
  }, [transportMode]);

  // 以 symbol 为 restartKey:book / trades;退订 90 s 后 evictSymbol
  useEffect(() => {
    const rt = getMarketRuntime();
    if (!rt) return;
    cancelEvict(symbol);
    const topics: Topic[] = [`book:${symbol}`, `trades:${symbol}`];
    for (const topic of topics) rt.transport.subscribe(topic);
    return () => {
      for (const topic of topics) rt.transport.unsubscribe(topic);
      scheduleEvict(symbol);
    };
  }, [symbol]);

  // candles 随 symbol + interval(单独一个 effect:换 interval 不重订 book / trades)
  useEffect(() => {
    const rt = getMarketRuntime();
    if (!rt) return;
    const topic: Topic = `candles:${symbol}:${interval}`;
    rt.transport.subscribe(topic);
    return () => rt.transport.unsubscribe(topic);
  }, [symbol, interval]);

  // account 只在登录后订阅;登出时账户 store 会调 requestTransportReconnect,新连接重新验签。
  // 挂单 / 持仓:transport 送不来(或一时送不来)时自己拉一次(loadAccountListsUnlessStreamed)
  useEffect(() => {
    if (!meId) return;
    const rt = getMarketRuntime();
    if (!rt) return;
    return subscribeAccountTopic(rt);
  }, [meId]);

  // 自选镜像进 store(setWatchlist 同内容不 set)
  useEffect(() => {
    marketActions.setWatchlist(watchKey ? watchKey.split("\n") : []);
  }, [watchKey]);

  usePolling(
    () => {
      const rt = getMarketRuntime();
      if (!rt || !isPolling()) return;
      return pollMarket(symbol, rt);
    },
    POLL_MARKET_MS,
    symbol,
  );
  usePolling(
    () => {
      const rt = getMarketRuntime();
      if (!rt || !isPolling() || !meId) return;
      return pollAccount(meId, rt);
    },
    POLL_ACCOUNT_MS,
    meId,
  );
  usePolling(
    () => {
      const rt = getMarketRuntime();
      if (!rt) return;
      return calibrateCandles(symbol, interval, rt);
    },
    CALIBRATE_CANDLES_MS,
    `${symbol}:${interval}`,
  );

  return null;
}
