// 市场发布器(计划 §3.2 服务端数据流、§3.4「globalThis 总线契约与两级门控」「撮合与 OTC」、§6.2.2 C2):
// 撮合 / 撤单事务提交后由 placeOrder / cancelOrder 调 publishOrderResult(result),OTC 成交后由 buyListing 调 publishLastPrice(...),
// 注销(retireCredits)与 OTC 挂牌 / 撤牌(createListing / cancelListing)提交后调 publishPositionChange(userId, assetId) ——
// 这三种只动持仓(数量或锁定),现金不变,所以只发该标的的 position。
// 这里把结果派生成 book / trades / ticker / candle / account 五种纯数据消息发到 globalThis.__carbadiaBus,hub 再按 topic 扇出。
//
// 两级门控(不派生就不查库):
//   ① bus.hasSubscribers() 为 false(START_MODE=next 无 hub、WS_DISABLED)→ 什么都不做;
//   ② presence.hasInterest(topic) / hasUser(userId):没人订 book:SYM 就不读盘口、没人订 candles:SYM:1m 就不折桶、用户不在线就不查账户。
// trades 是撮合结果的直接映射(不查库),有订阅者就立即发:hub 靠它维护 64 条环,晚到的订阅者才有快照可拿。
//
// 状态放哪:本模块会被打进 instrumentation(bot)与 route handler(REST 下单、OTC)两个 bundle,各有一份模块级变量。
// 决定发出去的数值的状态必须跨 bundle 一致,挂 globalThis(纯数据):差分基线 __carbadiaBookCache、K 线当前桶 __carbadiaCandleState
//(计划 §3.4 的两个名字),以及发布器私有的 __carbadiaPublisherState(24 h 统计、盘口 / 余额 / 持仓的读取票号、订单行票号、K 线折算水位)。
// 统计缓存若每个 bundle 一份,bot 发的 ticker 要到下次刷新才含用户那笔成交,相邻两条 ticker 的量 / 高低会先倒退再跳回。
//
// 顺序:trades 同步发出;其余派生按标的排进串行队列,盘口另走 50 ms 去抖(同一窗口内多次下单只读一次库)。
// 串行队列与去抖 / 节流计时器是模块级的,每个 bundle 一份:同一 bundle 内同一标的的派生按事务提交顺序处理;
// 分属两个 bundle 的两笔成交互不排队,派生可能交错,甚至按与提交相反的顺序发出。会因此发错数值的地方不靠队列顺序,各自裁决:
//   - 盘口:每次读库前领一个跨 bundle 的单调票号;较晚发出的读取已成为基线时,较早发出、较晚返回的那份丢掉
//     (否则旧簿成为基线并作为 delta 发出,把 hub 的盘口倒回去,直到下一次变化);
//   - 余额:按用户、跨标的跨 bundle,同一写法的票号(balanceReads):较晚发出的余额读取已经发布过,较早发出、较晚返回的那条不发
//     (否则客户端整行覆盖成旧余额,空闲用户可能很久都没有下一条事件来纠正);
//   - 订单行:按订单的票号(orderReads),在 publishOrderResult 里(事务提交后、同步)领,所以票号顺序 = 提交顺序:
//     较晚提交的结果里的这张单已经发布过,较早提交、派生较晚的那条不发(终审 P1-25a:bot 的部分成交在 instrumentation 的队列里
//     排着,用户经 REST 撤单先发出 CANCELLED,晚到的 PARTIAL 会把撤掉的单放回挂单列表,终结的单再没有事件来纠正)。
//     提交时用户不在线就不领票、不发这张单的行:他订阅时拿到的快照读在提交之后,不比这一行旧;这张单的票号条目当场删掉
//     (见下「提交时用户不在线」),他掉线前在途的那次派生带着的旧行(OPEN / PARTIAL)因此不会在新快照之后发出去。
//     订单行不能指望「下一条事件纠正」:终结(FILLED / CANCELLED)之后这张单再也没有事件。所以除了这里的票号,客户端还有一道
//     兜底(src/lib/market/account-store.ts 的 closedOrders):同一 id 终结之后到达的 OPEN / PARTIAL 行一律丢弃,终结不可逆;
//   - 持仓:按 (用户, 标的) 的读取票号(positionTickets),与余额同一写法 —— 读库前领票,发布那一刻裁决:同一用户同一标的上
//     较晚发出的持仓读取已经发布过,较早发出、较晚返回的那一行不发(计划 §6.2.2 C2;否则客户端按 assetId 整行覆盖成旧值:
//     注销或撤牌之后如果没有下一条事件,旧的数量 / 锁定会一直留到重订阅)。较晚发出的读取看到的提交点不早于较早发出的那次
//     要反映的提交,所以丢掉旧行不丢信息;每次改动持仓的提交都有自己的读取(成交 / 撤单 / OTC / 注销),最后发出的那次读取总会发布;
//   - 提交时(或派生开始时)用户不在线:不读库、不发,并当场删掉他在这次提交动到的票号条目(dropOfflineTickets:该标的的持仓票号,
//     成交 / 撤单 / OTC 成交另加余额票号;成交 / 撤单还有这次结果里他的每张单的订单票号)。他掉线之前发出、还在途的读取因此找不到
//     条目,按已被取代丢掉 —— 否则他赶在清扫之前重连时,那次读取(读在这次提交之前)会在新快照(读在提交之后)之后到达,把行盖回旧值,
//     而掉线期间的这次提交没有事件来纠正。已知的两处局限,都只是一瞬间的旧值、随即被纠正,不会停留:
//       · 成交 / OTC 成交的「不在线」是在派生里判的,而同一 bundle 同一标的的派生排在在途那次之后:在途的读取先返回时条目还在,
//         用户若已重连,旧的余额 / 持仓行会先发出,紧接着这次派生自己的读取把它纠正(订单行在提交时同步删,没有这一条);
//       · takeTicket 重建条目时 applied 取当时的序列值,裁决是 mine < applied:条目删掉后被新的提交重建、而在途那张票恰好是全局
//         最新的一张(期间没有任何领票)时,旧读取先返回会被采用,随后新读取必然再发一条纠正;
//   - K 线:冷启动补桶记下补到的时刻(seedTo),之后跳过 ts ≤ seedTo 的成交(它们已在库里补的桶里,再折一次量就翻倍);
//     比已折进来的最新成交更早的成交(另一个 bundle 的派生晚到)只补量与高低,不改收盘价;
//   - 24 h 统计:只折 ts > 刷新时刻的成交,每笔恰好折一次(量 / 高低与顺序无关)。
// 仍会乱序、由下一条事件纠正的:ticker 的 lastPrice(较早一批的派生晚到时,最后价暂时退回那一批,下一笔成交即更新)。
// 票号只在发布器这一侧裁决,事件里不带票号(协议不变):hub 按发布顺序给 account 事件编 seq,客户端按到达顺序应用;
// account 订阅快照与事件之间的先后由 hub 的 seq 检查负责(查询期间有事件流出就重查)。
// 票号表按用户回收(见 sweepTickets):用户离线后每分钟清扫一次,回收之后才返回的旧读取按「已被取代」丢掉;终结的挂单一发布就删;
// 掉线期间有提交动到的条目不等清扫、当场删(见上「提交时用户不在线」)。
// 做市机器人账户不发 account 事件(机器人名单首次需要时查一次库,挂在 __carbadiaPublisherState 上)。
// 所有计时器 unref():测试与 SIGTERM 不被挂住。
import type { AccountEvent, CarbadiaBus } from "../../shared/bus";
import { bucketUpdate, INTERVAL_MS } from "../../shared/candle-live";
import { auditRefOf, CANDLE_INTERVALS } from "../../shared/constants";
import { diffBook } from "../../shared/orderbook";
import type { Balance, CandleBar, Order, OrderBookSnapshot, Position, Side, TapeEntry, TickerUpdate } from "../../shared/types";
import type { CancelOrderResult, OrderRow, PlaceOrderResult, TradeRow } from "../exchange/matching";
import { getOrderBook } from "../exchange/matching";
import { stats24h, type Stats24h } from "../exchange/stats24h";
import { avgFillPricesByOrder, ledgerIdsByTrade, selfTradeCancelledIds, toFill, toOrder } from "./account-mappers";
import { getBus } from "./bus";
import { prisma } from "./db";
import { WS_TAPE_RING } from "../../shared/ws-protocol";
import { getBars, getRecentTrades, invalidateInstrumentsCache } from "./market-snapshots";
import { loadPositions, positionReads, positionsFromRows } from "./positions";
import { hasInterest, hasUser } from "./presence";

/** 盘口去抖窗口:窗口内的多次下单 / 撤单只读一次库 */
export const BOOK_DEBOUNCE_MS = 50;
/** ticker 节流:首条立即发,窗口内后续更新合并成一条尾随发出 */
export const TICKER_THROTTLE_MS = 250;
/** 24 h 统计(stats24h)的刷新间隔;两次刷新之间把本批成交折进缓存,不再查库 */
export const STATS_TTL_MS = 10_000;
/** 发给 hub 的盘口深度 = 客户端最大深度选项 */
export const BOOK_DEPTH = 50;

/** account 订阅时 hub 要的快照(计划 §3.3「snapshot-on-subscribe」的 account 段);hub 零 DB,经 globalThis 钩子取 */
export type AccountSnapshot = { balance: Balance; orders: Order[]; positions: Position[] };

/**
 * refreshBook 的结果:found = 库里有这个 symbol。hub 只用它区分「查无此 symbol」——那就不再为它请刷新(直到下一次订阅),
 * 否则一个不存在的 symbol 的订阅会让这里每秒查一次库(server/ws-hub.mjs 的 BookRefreshOutcome 与之同形)。
 * found: true 不保证发了盘口(没人订 book:SYM 时不读),hub 另有次数闸
 */
export type BookRefreshResult = { found: boolean };

/**
 * recentTrades 的结果:found = 库里有这个 symbol;trades = 最近 WS_TAPE_RING(64)笔,时间升序(与 hub 的成交环同序)。
 * hub 的 RecentTradesOutcome(server/ws-hub.mjs)与之同形
 */
export type RecentTradesResult = { found: boolean; trades: TapeEntry[] };

declare global {
  /**
   * hub(server/ws-hub.mjs)在 account 订阅时调用;由本模块在加载时挂上。是「globalThis 只放纯数据」纪律的一处例外(lead 裁决):
   * server.mjs 不能 import src/**,而快照需要 Prisma 与 account-mappers。没挂上(hub 起了、Next 还没加载本模块)时 hub 不发快照,
   * 客户端仍经 /api/auth/me + /api/account/* 水合。
   */
  var __carbadiaAccountSnapshot: ((userId: string) => Promise<AccountSnapshot>) | undefined;
  /**
   * hub 在 book:SYM 订阅时发现自己没有这本簿的缓存(无人订阅期间已淘汰,或进程刚起)时调用(每个 symbol 每秒至多一次),见 refreshBook;
   * 与 __carbadiaAccountSnapshot 同属函数型全局的例外(hub 不能 import src/**)。没挂上时 hub 什么都不请:此时没有任何 bundle 加载过本模块,
   * 也就没有差分基线,第一次发布本来就是整份快照。结果 { found: false } 让 hub 不再为这个 symbol 请刷新
   */
  var __carbadiaBookRefresh: ((symbol: string) => Promise<BookRefreshResult>) | undefined;
  /**
   * hub 在 trades:SYM 订阅时发现自己的成交环没满、还没为这个 symbol 预读过(进程刚起)时调用,见 recentTrades(终审 P1-25a;
   * 与 __carbadiaBookRefresh 同属函数型全局的例外)。没挂上时 hub 照旧发环里现有的
   */
  var __carbadiaRecentTrades: ((symbol: string) => Promise<RecentTradesResult>) | undefined;
  /** 发布器私有、跨 bundle 共用的状态(纯数据,见文件头);不是 hub / REST 的契约,别处不读 */
  var __carbadiaPublisherState: PublisherState | undefined;
}

/**
 * ticker 用的 24 h 统计:at 之前提交的成交已在 stats 里,之后的由产生它的那个 bundle 折进来。
 * 两个 bundle 共用一份,各自只折自己的成交,每笔成交恰好被折一次。
 */
type StatsEntry = { at: number; stats: Stats24h };
/**
 * 读取票号:issued = 已发出的最大票号,applied = 已采用(盘口:成为差分基线;余额 / 订单行:已发布)的最大票号。
 * 票号取自全局序列(PublisherState.ticketSeq),不是每个 key 各数各的:条目回收后再建,新票号仍大于回收前发出的任何一张。
 * userId:按订单 / 按持仓的票号记下主人,清扫时按用户回收
 */
type ReadTickets = { issued: number; applied: number; userId?: string };
/** 持仓读取票号的键:同一用户同一标的一条 */
const positionKey = (userId: string, assetId: string): string => `${userId}:${assetId}`;
/** K 线折算水位:seedTo = 冷启动补桶查到的时刻(ts ≤ 它的成交已在补的桶里);lastTs = 已折进当前桶的最新成交时刻 */
type CandleMark = { seedTo: number; lastTs: number };
type PublisherState = {
  /** key = assetId */
  stats: Map<string, StatsEntry>;
  /** key = assetId */
  bookReads: Map<string, ReadTickets>;
  /** key = userId;用户离线后由 sweepTickets 回收 */
  balanceReads: Map<string, ReadTickets>;
  /** key = orderId(终审 P1-25a);终结的单发布即删,主人离线后由 sweepTickets 回收 */
  orderReads: Map<string, ReadTickets>;
  /** key = positionKey(userId, assetId)(计划 §6.2.2 C2);用户离线后由 sweepTickets 回收 */
  positionTickets: Map<string, ReadTickets>;
  /** 全部票号共用的单调序列(跨 key、跨 bundle) */
  ticketSeq: number;
  /** 上次清扫票号表的时刻(ms) */
  sweptAt: number;
  /** 做市机器人的 userId;首次需要时查库(isBot),之后不再查。null = 还没查过 */
  botUserIds: string[] | null;
  /** key = "assetId:interval"(与 __carbadiaCandleState 同键) */
  candleMarks: Map<string, CandleMark>;
};
type TickerFields = Omit<TickerUpdate, "symbol" | "ts">;
type TickerThrottle = { cooldown: NodeJS.Timeout | null; pending: TickerFields | null };

// ---- 模块级状态(每个 bundle 一份;见文件头) ----
/** assetId → symbol:结果里带着 symbol,记下来让 markBookDirty(assetId) 不必再查 */
const symbols = new Map<string, string>();
const bookTimers = new Map<string, NodeJS.Timeout>();
const tickers = new Map<string, TickerThrottle>();
const chains = new Map<string, Promise<void>>();

function bookCache(): Map<string, OrderBookSnapshot> {
  return (globalThis.__carbadiaBookCache ??= new Map());
}
function candleState(): Map<string, CandleBar> {
  return (globalThis.__carbadiaCandleState ??= new Map());
}
function publisherState(): PublisherState {
  const state = (globalThis.__carbadiaPublisherState ??= {
    stats: new Map(),
    bookReads: new Map(),
    balanceReads: new Map(),
    orderReads: new Map(),
    positionTickets: new Map(),
    ticketSeq: 0,
    sweptAt: 0,
    botUserIds: null,
    candleMarks: new Map(),
  });
  // dev HMR:globalThis 上的状态可能由加这几项之前的模块版本建的
  state.balanceReads ??= new Map();
  state.orderReads ??= new Map();
  state.positionTickets ??= new Map();
  // 旧版本的票号是每个 key 各数各的,计数随运行时长涨到 N(issued = applied = N):全局序列若从 0 起,新票号全都小于 applied,
  // 盘口与余额读取会被一律判为过期,直到序列追上最大的旧计数。所以从旧表里最大的票号接着数(P1-25a 复审)
  state.ticketSeq ??= Math.max(
    0,
    ...[...state.bookReads.values(), ...state.balanceReads.values(), ...state.orderReads.values(), ...state.positionTickets.values()].map((t) => Math.max(t.issued, t.applied)),
  );
  state.sweptAt ??= 0;
  state.botUserIds ??= null;
  return state;
}

/**
 * 领一张读取票号(跨 key、跨 bundle 单调);在发出读取之前领。条目不存在(第一次,或已回收)时新建,applied 取此刻的序列值:
 * 回收之前发出、还在途的读取一律当作已被取代,不会在新条目上被当成最新的。
 */
function takeTicket(reads: Map<string, ReadTickets>, key: string, userId?: string): number {
  const state = publisherState();
  let ticket = reads.get(key);
  if (!ticket) reads.set(key, (ticket = { issued: state.ticketSeq, applied: state.ticketSeq, userId }));
  ticket.issued = ++state.ticketSeq;
  return ticket.issued;
}

/**
 * 读取返回后裁决:较晚发出的读取已经被采用 → 这份更旧,返回 false(不用);否则记为已采用并返回 true。
 * 条目已回收(用户离线 / 终结的单,或测试的 _internal.reset())→ 这张票领在回收之前,同样按已被取代处理。
 * 与采用之后的动作(成为基线 / 发布)放在同一段同步代码里,中间不 await。
 */
function adoptTicket(reads: Map<string, ReadTickets>, key: string, mine: number): boolean {
  const ticket = reads.get(key);
  if (!ticket) return false;
  if (mine < ticket.applied) return false;
  ticket.applied = mine;
  return true;
}

/** 每用户票号表的清扫间隔:随发布顺带做(不另起计时器),两次之间至少隔这么久 */
const TICKET_SWEEP_MS = 60_000;

/**
 * 回收离线用户(presence 里没有他的 account 订阅)的余额票号、订单票号与持仓票号,否则这几张表随历史用户数一直涨(终审 P1-25a)。
 * 不必等 applied === issued:回收之后还在途的读取在 adoptTicket 里找不到条目,按已被取代丢掉——用户离线时本来就没人收,
 * 他再上线时 hub 会给他一份读在之后的快照。
 */
function sweepTickets(): void {
  const state = publisherState();
  const t = Date.now();
  if (t - state.sweptAt < TICKET_SWEEP_MS) return;
  state.sweptAt = t;
  for (const userId of [...state.balanceReads.keys()]) if (!hasUser(userId)) state.balanceReads.delete(userId);
  for (const [orderId, ticket] of [...state.orderReads]) if (!ticket.userId || !hasUser(ticket.userId)) state.orderReads.delete(orderId);
  for (const [key, ticket] of [...state.positionTickets]) if (!ticket.userId || !hasUser(ticket.userId)) state.positionTickets.delete(key);
}

/**
 * 一次提交之后发现该用户不在线(不读库、不发):删掉他在这个标的上的持仓票号条目;withBalance(这次提交也动了现金:成交 / 撤单 /
 * OTC 成交)时连他的余额票号条目一起删。等于只对这一条提前做了 sweepTickets 的事,理由也相同:用户不在线时在途的读取没人收,
 * 他再上线时 hub 给的快照读在这之后。不等清扫的原因:清扫每分钟至多一次,而重连只要几百毫秒 —— 条目还在的话,他掉线前发出、
 * 重连后才返回的那次读取会被采用,在新快照之后把行盖回这次提交之前的值,掉线期间的这次提交又没有事件来纠正。
 * 只在 hasUser(userId) 为 false 时调用;只改内存,不查库。
 */
function dropOfflineTickets(userId: string, assetId: string, withBalance: boolean): void {
  const state = publisherState();
  state.positionTickets.delete(positionKey(userId, assetId));
  if (withBalance) state.balanceReads.delete(userId);
}

/** 门控 ②(成交 / 撤单 / OTC 成交):在线的用户留下;不在线的不查库,并删掉他被这次提交动到的票号条目(dropOfflineTickets) */
function onlineOf(userIds: Iterable<string>, assetId: string): string[] {
  const online: string[] = [];
  for (const userId of userIds) {
    if (hasUser(userId)) online.push(userId);
    else dropOfflineTickets(userId, assetId, true);
  }
  return online;
}

/** 这个 userId 已知是做市机器人吗(名单查过才知道;同步判断,用在提交后领票的地方) */
function knownBot(userId: string): boolean {
  return publisherState().botUserIds?.includes(userId) ?? false;
}

/** 本 bundle 在途的机器人名单查询(两个 bundle 各至多查一次,之后都读 globalThis 上的结果) */
let botIdsLoading: Promise<ReadonlySet<string>> | null = null;

/**
 * 做市机器人的 userId 集合。机器人不发 account 事件(P1-25b 让机器人账户不能登录;这里是 WS 一侧的收口,
 * 也挡住在那之前签出、hub 仍能验过的旧会话)。首次需要时查一次库,结果挂在 __carbadiaPublisherState 上;
 * 机器人账户只由种子创建,进程内不会新增。查库失败时本次按「没有机器人」处理、下次再查,不因此丢掉真人用户的事件。
 */
async function botUserIds(): Promise<ReadonlySet<string>> {
  const known = publisherState().botUserIds;
  if (known) return new Set(known);
  botIdsLoading ??= prisma.user
    .findMany({ where: { isBot: true }, select: { id: true } })
    .then((rows) => {
      const ids = rows.map((row) => row.id);
      publisherState().botUserIds = ids;
      return new Set(ids);
    })
    .catch((err) => {
      logError("bot user lookup failed", err);
      return new Set<string>();
    })
    .finally(() => {
      botIdsLoading = null;
    });
  return botIdsLoading;
}

function logError(what: string, err: unknown) {
  console.error(`[publisher] ${what}`, err instanceof Error ? err.message : err);
}

/** 同一标的的异步派生在本 bundle 内串行执行(按事务提交顺序;跨 bundle 不排队,见文件头);任务失败只记日志,不影响后续 */
function enqueue(assetId: string, task: () => Promise<void>): void {
  const prev = chains.get(assetId) ?? Promise.resolve();
  const next = prev.then(task).catch((err) => logError(`derive failed for ${symbols.get(assetId) ?? assetId}`, err));
  chains.set(assetId, next);
  void next.then(() => {
    if (chains.get(assetId) === next) chains.delete(assetId);
  });
}

// ---- 入口 ----

/**
 * 事务已提交才会被调用(失败的事务永不进总线);调用方不 await。
 * 重放结果(replayed: true,DB 无变化)整体跳过:不标脏盘口、不发 account 事件。
 */
export function publishOrderResult(result: PlaceOrderResult | CancelOrderResult): void {
  const bus = getBus();
  if (!bus.hasSubscribers()) return; // 门控 ①
  if ("replayed" in result && result.replayed) return;
  const { order } = result;
  const assetId = order.assetId;
  const symbol = order.asset.symbol;
  symbols.set(assetId, symbol);
  sweepTickets();
  // 订单行的票号在这里同步领(事务刚提交,两个 bundle 的调用按提交顺序到达):派生排在队列里、晚多久都不改变先后
  const orderTickets = takeOrderTickets(result);

  const trades = "trades" in result ? result.trades : [];
  // takerSide = 下单方的 side(事件路径已知 taker,不必走 takerSideOf);顺序 = 撮合顺序 = 时间升序(store 的 tape 是追加语义)
  const entries: TapeEntry[] = trades.map((t) => ({
    id: t.id,
    symbol,
    price: t.price,
    quantity: t.quantity,
    takerSide: order.side as Side,
    ts: t.createdAt.getTime(),
    auditRef: auditRefOf(t.id),
  }));
  if (entries.length > 0) bus.publish({ kind: "trades", symbol, trades: entries });

  markBookDirty(assetId);
  enqueue(assetId, async () => {
    if ("trades" in result && entries.length > 0) {
      // 与 matching.ts 写进 Asset.lastPrice 的值同源(round(filledCost / filledQty)):REST 与 WS 看到同一个最后价
      const lastPrice = Math.round(result.filledCost / result.filledQty);
      await publishTicker(bus, assetId, symbol, lastPrice, entries);
      await publishCandles(bus, assetId, symbol, entries);
    }
    await publishAccountEvents(bus, result, orderTickets);
  });
}

/**
 * 这次结果触碰的每张在线真人用户的单各领一张订单票号(orderId → 票号);不在线的不领,派生时也就不发它的行,
 * 并删掉这张单的票号条目:他掉线前在途的派生(带着更早的票)返回时找不到条目,不会把旧行发在重连快照之后(见文件头「提交时用户不在线」)
 */
function takeOrderTickets(result: PlaceOrderResult | CancelOrderResult): Map<string, number> {
  const tickets = new Map<string, number>();
  const reads = publisherState().orderReads;
  const rows = "makerOrders" in result ? [result.order, ...result.makerOrders] : [result.order];
  for (const row of rows) {
    if (!hasUser(row.userId)) reads.delete(row.id);
    else if (!knownBot(row.userId)) tickets.set(row.id, takeTicket(reads, row.id, row.userId));
  }
  return tickets;
}

/**
 * 订单行发布前的裁决(与发布在同一段同步代码里):没领票(提交时不在线)或较晚提交的结果已经发布过这张单 → 不发。
 * 终结的单(FILLED / CANCELLED)发布后若没有更晚的票在途就回收条目:它不会再有事件,之后在途的旧票找不到条目,同样丢掉。
 */
function adoptOrderTicket(order: Order, mine: number | undefined): boolean {
  if (mine === undefined) return false;
  const reads = publisherState().orderReads;
  if (!adoptTicket(reads, order.id, mine)) return false;
  const ticket = reads.get(order.id);
  if ((order.status === "FILLED" || order.status === "CANCELLED") && ticket && ticket.applied === ticket.issued) reads.delete(order.id);
  return true;
}

/**
 * OTC 成交(otc.ts buyListing 事务提交后调用):ticker 的最后价 + 买卖双方的 balance / position(在线才查)。
 * 另外作废 listInstruments 的 2 s 进程缓存:OTC 成交是用户手动触发的稀事件,买完立刻看 /api/market/instruments 应当已是新价;
 * 撮合成交不这么做——bot 每 tick 都在成交,逐笔失效等于没有缓存。作废走代数(invalidateInstrumentsCache):
 * 只清空的话,一个在 OTC 提交前读了 Asset、在清空后才返回的 listInstruments 会把旧价写回缓存,再挂 2 s。
 */
export function publishLastPrice(input: { assetId: string; symbol: string; lastPrice: number; buyerId: string; sellerId: string }): void {
  invalidateInstrumentsCache();
  const bus = getBus();
  if (!bus.hasSubscribers()) return; // 门控 ①
  const { assetId, symbol, lastPrice, buyerId, sellerId } = input;
  symbols.set(assetId, symbol);
  sweepTickets();
  enqueue(assetId, async () => {
    await publishTicker(bus, assetId, symbol, lastPrice, []);
    const online = onlineOf(new Set([buyerId, sellerId]), assetId);
    const bots = online.length > 0 ? await botUserIds() : new Set<string>();
    for (const userId of online) {
      if (bots.has(userId)) continue;
      const balanceRead = takeTicket(publisherState().balanceReads, userId, userId);
      const positionRead = takePositionTicket(userId, assetId);
      const [balance, positions] = await Promise.all([loadBalance(userId), loadPositionRows(userId, assetId)]);
      if (adoptTicket(publisherState().balanceReads, userId, balanceRead)) bus.publish({ kind: "account", userId, event: { t: "balance", balance } });
      publishPositionRows(bus, userId, positions, positionRead);
    }
  });
}

/**
 * 只动持仓的提交之后(计划 §6.2.2 C2):注销(数量减少、retired 增加,整仓注销后是 quantity 0、retired > 0 的行)、
 * OTC 挂牌 / 撤牌(locked 与 lockedBy.otc 变化)。现金不变,只发该用户在该标的上的 position 事件(在线才查库,机器人不发)。
 * 事务已提交才调用,调用方不 await;重放的请求(库没变)不调用。与 publishOrderResult 一样,发布失败只记日志:
 * 同步部分也包在 try 里 —— 业务事务已经提交,不能因为发布器的问题让那次请求变成 500。
 */
export function publishPositionChange(userId: string, assetId: string): void {
  try {
    const bus = getBus();
    if (!bus.hasSubscribers()) return; // 门控 ①
    // 门控 ②:提交时不在线就不查(他订阅时拿到的快照读在提交之后),并删掉这一条票号 —— 掉线前在途的读取不得盖住那份快照
    if (!hasUser(userId)) return dropOfflineTickets(userId, assetId, false);
    if (knownBot(userId)) return;
    sweepTickets();
    enqueue(assetId, async () => {
      if (!hasUser(userId)) return dropOfflineTickets(userId, assetId, false); // 提交之后、派生开始之前掉线:同上
      if ((await botUserIds()).has(userId)) return;
      const positionRead = takePositionTicket(userId, assetId);
      publishPositionRows(bus, userId, await loadPositionRows(userId, assetId), positionRead);
    });
  } catch (err) {
    logError("position change publish failed", err);
  }
}

// ---- book:50 ms 去抖 → getOrderBook(assetId, 50) → diffBook ----

/** 标脏盘口:窗口内再次标脏只合并,50 ms 后统一读一次库;flush 一开始就清掉计时器,读库期间的新标脏会排下一次 */
export function markBookDirty(assetId: string): void {
  if (bookTimers.has(assetId)) return;
  const timer = setTimeout(() => {
    void flushBook(assetId).catch((err) => logError(`book flush failed for ${symbols.get(assetId) ?? assetId}`, err));
  }, BOOK_DEBOUNCE_MS);
  timer.unref();
  bookTimers.set(assetId, timer);
}

async function symbolOf(assetId: string): Promise<string | null> {
  const known = symbols.get(assetId);
  if (known) return known;
  const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { symbol: true } });
  if (row) symbols.set(assetId, row.symbol);
  return row?.symbol ?? null;
}

async function assetIdOf(symbol: string): Promise<string | null> {
  for (const [assetId, known] of symbols) if (known === symbol) return assetId;
  const row = await prisma.asset.findUnique({ where: { symbol }, select: { id: true } });
  if (row) symbols.set(row.id, symbol);
  return row?.id ?? null;
}

/**
 * hub 的 book:SYM 订阅者等着一份整份快照(hub 在无人订阅时淘汰了缓存,或进程刚起;hub 经 globalThis.__carbadiaBookRefresh 调用,
 * 同一 symbol 在途时不重复调、每秒至多调一次)。客户端 store 只认 book.snapshot、WS 模式下不拉 REST 盘口,所以不能等下一次成交:
 *   1. 同步丢掉该标的的差分基线(按快照里的 symbol 找;键是 assetId)。此后先完成的那次读取——这一次,或别的 bundle 在途、
 *      较晚返回的那次——必以 delta null 发整份快照,即使盘口没变;不丢的话,这次读取在盘口没变时只算出「没变化」、什么都不发,
 *      等着的订阅者就一直没有簿(hub 对等着的连接会把先到的任何一条盘口消息都当整份快照发出,但总得有一条);
 *   2. 立即读一次盘口(flushBook:有兴趣才读,读取票号照常裁决),整份快照与书顶 ticker 经总线回到 hub。
 * 库里没有这个 symbol → { found: false }(一次 asset.findUnique,不读盘口),hub 据此不再为它请刷新;否则 { found: true }。
 * 读库失败时 reject(hub 记日志,冷却结束时还有人在等就再请);基线已丢,下一次成交的 flush 仍是整份快照。
 */
export function refreshBook(symbol: string): Promise<BookRefreshResult> {
  const cache = bookCache();
  for (const [assetId, snapshot] of cache) if (snapshot.symbol === symbol) cache.delete(assetId);
  return (async () => {
    const assetId = await assetIdOf(symbol);
    if (!assetId) return { found: false };
    await flushBook(assetId);
    return { found: true };
  })();
}

/**
 * hub 的成交环在重启后是空的(环只收 hub 起来之后发布的成交),客户端 WS 模式下的成交带只来自 hub 的快照:hub 在 trades:SYM
 * 第一次订阅时经 globalThis.__carbadiaRecentTrades 调这里,读库里最近 64 笔(与 GET /api/market/[symbol]/trades 同一个 getRecentTrades,
 * takerSide 经 takerSideOf 派生、auditRef = SIM-TRD-<id>),接到环前面再发给订阅者。hub 已做在途去重、每秒至多一次与超时放行。
 * 库里没有这个 symbol → { found: false, trades: [] }(一次 asset.findUnique)
 */
export async function recentTrades(symbol: string): Promise<RecentTradesResult> {
  const assetId = await assetIdOf(symbol);
  if (!assetId) return { found: false, trades: [] };
  return { found: true, trades: await getRecentTrades({ id: assetId, symbol }, WS_TAPE_RING) };
}

async function flushBook(assetId: string): Promise<void> {
  const timer = bookTimers.get(assetId);
  if (timer) {
    clearTimeout(timer);
    bookTimers.delete(assetId);
  }
  const bus = getBus();
  if (!bus.hasSubscribers()) return;
  const symbol = await symbolOf(assetId);
  if (!symbol) return;
  const cache = bookCache();
  if (!hasInterest(`book:${symbol}`)) {
    // 门控 ②:没人看盘口就不读库(集成测试用 spy 证明零调用)。同时丢掉基线:无人订阅期间 hub 已淘汰它的盘口缓存与书顶,
    // 下次有人订时按第一次处理——整份快照(delta null)+ 书顶 ticker,一次换新,不在一份可能停了几小时的基线上叠增量
    //(有人订阅而没有活动时,hub 经 refreshBook 请这一次)
    cache.delete(assetId);
    return;
  }

  // 读取票号(跨 bundle 单调):两次读取可能乱序返回——每个 bundle 各有一份去抖;同一 bundle 里读库超过 50 ms 时,
  // 期间的新标脏也会排出第二次 flush。较晚发出的读取已成为基线时,这份较早的结果更旧:不当基线、不发
  const reads = publisherState().bookReads;
  const mine = takeTicket(reads, assetId);
  const { bids, asks } = await getOrderBook(assetId, BOOK_DEPTH);
  if (!adoptTicket(reads, assetId, mine)) return;
  const next: OrderBookSnapshot = { symbol, bids, asks, ts: Date.now() };
  const prev = cache.get(assetId) ?? null;
  cache.set(assetId, next);
  // 第一次(或兴趣中断后)没有基线 → delta null,hub 推整份快照;之后只发变化档,没变化就不发
  const delta = prev ? diffBook(prev, next) : null;
  if (delta && delta.bids.length === 0 && delta.asks.length === 0) return;
  bus.publish({ kind: "book", symbol, snapshot: next, delta });

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  if (!prev || bestBid !== (prev.bids[0]?.price ?? null) || bestAsk !== (prev.asks[0]?.price ?? null)) {
    queueTicker(bus, symbol, { bestBid, bestAsk });
  }
}

// ---- ticker:250 ms 节流(首条立即,窗口内合并尾随)+ 24 h 统计 10 s 刷新 ----

function emitTicker(bus: CarbadiaBus, symbol: string, fields: TickerFields) {
  bus.publish({ kind: "ticker", symbol, ticker: { symbol, ts: Date.now(), ...fields } });
}

function queueTicker(bus: CarbadiaBus, symbol: string, fields: TickerFields): void {
  if (!hasInterest(`ticker:${symbol}`)) return; // 门控 ②(ticker:* 视为对所有标的有兴趣)
  const throttle = tickers.get(symbol) ?? { cooldown: null, pending: null };
  tickers.set(symbol, throttle);
  if (throttle.cooldown) {
    throttle.pending = { ...throttle.pending, ...fields };
    return;
  }
  emitTicker(bus, symbol, fields);
  armCooldown(symbol, throttle);
}

function armCooldown(symbol: string, throttle: TickerThrottle) {
  throttle.cooldown = setTimeout(() => {
    throttle.cooldown = null;
    const pending = throttle.pending;
    throttle.pending = null;
    if (!pending) return;
    const bus = getBus();
    if (!bus.hasSubscribers() || !hasInterest(`ticker:${symbol}`)) return;
    emitTicker(bus, symbol, pending);
    armCooldown(symbol, throttle);
  }, TICKER_THROTTLE_MS);
  throttle.cooldown.unref();
}

/** 与 stats24h.ts 同一公式:(last − first) × 100 / first,百分数;首笔缺失或非正 → null */
function changePct(firstPrice: number | null, lastPrice: number | null): number | null {
  if (firstPrice == null || lastPrice == null || firstPrice <= 0) return null;
  return ((lastPrice - firstPrice) * 100) / firstPrice;
}

/**
 * 成交 / OTC 之后的 ticker(有兴趣才算)。没人订 ticker:SYM(也没人订 ticker:*)时丢掉该标的的 24 h 统计缓存,与 K 线当前桶同理:
 * 兴趣中断期间的成交不会被折进缓存,兴趣在 STATS_TTL_MS 内恢复时,拿着缺了这些成交的缓存继续折,量 / 高低会少算到下次刷新。
 * 丢掉之后,恢复后的第一条 ticker 从库里刷新。
 */
async function publishTicker(bus: CarbadiaBus, assetId: string, symbol: string, lastPrice: number, trades: readonly TapeEntry[]): Promise<void> {
  if (!hasInterest(`ticker:${symbol}`)) {
    publisherState().stats.delete(assetId);
    return;
  }
  queueTicker(bus, symbol, await tickerFields(assetId, lastPrice, trades));
}

/**
 * ticker 的最后价 + 24 h 统计。统计每 STATS_TTL_MS 经 stats24h 从库里刷新一次;两次刷新之间把「刷新之后才成交」的本批成交折进缓存
 *(量累加、高低取极值、窗口原本无成交则本批首笔成为首笔),涨跌按新的最后价重算——不查库也不会出现「最后价变了、涨跌幅还是旧的」。
 *
 * 一笔成交要么在刷新查询里、要么被折进来,不会两者都有:
 *   - at 取查询返回之后的时刻。成交的 createdAt 在插入时取,createdAt > at 的成交插入晚于查询结束,不可能在查询结果里,只能被折;
 *   - 只折 ts > at 的成交。ts ≤ at 的要么已在查询里(包括本批:派生在事务提交之后才跑),要么是查询期间才提交、没被查到的,
 *     后者少算到下次刷新(至多 10 s),宁少不重;
 *   - 缓存在 globalThis 上,两个 bundle 各折自己的成交、互不重复。另一个 bundle 刷新时若没查到本 bundle 刚折进去的成交,
 *     那笔成交同样少算到下次刷新。
 */
async function tickerFields(assetId: string, lastPrice: number, trades: readonly TapeEntry[]): Promise<TickerFields> {
  const cache = publisherState().stats;
  let entry = cache.get(assetId);
  if (!entry || Date.now() - entry.at >= STATS_TTL_MS) {
    const stats = await stats24h(assetId, lastPrice);
    entry = { at: Date.now(), stats };
  } else {
    let { high24h, low24h, volume24h, firstPrice } = entry.stats;
    for (const t of trades) {
      if (t.ts <= entry.at) continue;
      high24h = high24h == null ? t.price : Math.max(high24h, t.price);
      low24h = low24h == null ? t.price : Math.min(low24h, t.price);
      volume24h += t.quantity;
      firstPrice ??= t.price;
    }
    entry = { at: entry.at, stats: { firstPrice, high24h, low24h, volume24h, change24hPct: changePct(firstPrice, lastPrice) } };
  }
  cache.set(assetId, entry);
  const s = entry.stats;
  return { lastPrice, change24h: s.change24hPct, high24h: s.high24h, low24h: s.low24h, volume24h: s.volume24h };
}

// ---- candle:六个 interval 各自的当前桶(globalThis.__carbadiaCandleState),bucketUpdate 折进成交 ----

/**
 * 每个有兴趣的 interval:桶缺失时从库里补齐,否则按水位(__carbadiaPublisherState.candleMarks)把本批成交折进当前桶。
 * 水位解决两个 bundle 的派生乱序(见文件头):
 *   - ts ≤ seedTo 的成交已在补桶的查询结果里(补桶查的是 createdAt ≤ seedTo 的全部成交),跳过,不再折一次;
 *   - seedTo < ts < lastTs 的成交比已折进来的最新成交更早(另一个 bundle 的派生晚到):同一桶只补量与高低,收盘价不倒回;
 *     落在更早的桶里的忽略(那根已经发过最终状态,由客户端的定时校准纠正)。
 * 同一毫秒的另一笔成交若在补桶查询之后才提交,会因 ts = seedTo 被跳过、少算到校准;宁少不重。
 */
async function publishCandles(bus: CarbadiaBus, assetId: string, symbol: string, trades: readonly TapeEntry[]): Promise<void> {
  const state = candleState();
  const marks = publisherState().candleMarks;
  for (const interval of CANDLE_INTERVALS) {
    const key = `${assetId}:${interval}`;
    if (!hasInterest(`candles:${symbol}:${interval}`)) {
      // 门控 ②:没人订就不折桶;同时丢掉旧桶与水位——下次有人订时从库里重建,免得拿着缺了中间成交的桶继续累加
      state.delete(key);
      marks.delete(key);
      continue;
    }
    let bar = state.get(key) ?? null;
    if (!bar) {
      // 冷启动 / 兴趣中断后:当前桶从库里补齐(含本批成交)。只拿这一笔开新桶的话,客户端 mergeHistory 会用这根残缺的 bar
      // 盖掉 REST 里完整的当前桶(1d 桶尤其明显:每次部署后日线塌成一笔)。
      const seedTo = trades[trades.length - 1].ts;
      const [seed] = await getBars({ id: assetId, symbol }, interval, 1, seedTo);
      // 查询期间另一个 bundle 可能已补好这一桶、甚至折进了更新的成交:以它为准,本批按它的水位折(不拿本次的结果覆盖)
      bar = state.get(key) ?? null;
      if (!bar) {
        if (seed) {
          state.set(key, seed);
          marks.set(key, { seedTo, lastTs: seedTo });
          bus.publish({ kind: "candle", symbol, interval, candle: seed });
        }
        continue;
      }
    }
    const step = INTERVAL_MS[interval];
    const mark = marks.get(key) ?? { seedTo: -Infinity, lastTs: -Infinity };
    let dirty = false;
    for (const t of trades) {
      if (t.ts <= mark.seedTo) continue;
      if (t.ts < mark.lastTs) {
        if (Math.floor(t.ts / step) * step === bar.t) {
          bar = { ...bar, h: Math.max(bar.h, t.price), l: Math.min(bar.l, t.price), v: bar.v + t.quantity };
          dirty = true;
        }
        continue;
      }
      const next = bucketUpdate(bar, { price: t.price, quantity: t.quantity, ts: t.ts }, step);
      // 本批成交跨桶:先把上一根的最终状态发出去,再开新桶
      if (next.isNew && dirty) bus.publish({ kind: "candle", symbol, interval, candle: bar });
      bar = next.bar;
      mark.lastTs = t.ts;
      dirty = true;
    }
    if (!dirty) continue; // 本批全在补桶里(或落在更早的桶):桶没变,不发
    state.set(key, bar);
    marks.set(key, mark);
    bus.publish({ kind: "candle", symbol, interval, candle: bar });
  }
}

// ---- account:taker 与每个 maker,在线(hasUser)才查;order → fill → balance → position ----

async function publishAccountEvents(bus: CarbadiaBus, result: PlaceOrderResult | CancelOrderResult, orderTickets: Map<string, number>): Promise<void> {
  const { order } = result;
  const trades = "trades" in result ? result.trades : [];
  const touched = new Map<string, OrderRow[]>([[order.userId, [order]]]);
  if ("makerOrders" in result) {
    for (const maker of result.makerOrders) {
      const list = touched.get(maker.userId) ?? [];
      list.push(maker);
      touched.set(maker.userId, list);
    }
  }
  const online = onlineOf(touched.keys(), order.assetId); // 门控 ②
  // 提交时在线(领了票)、派生开始前掉线:这几张单的行不发了,条目一并删掉(与 takeOrderTickets 的不在线分支同理)
  for (const [userId, rows] of touched) if (!online.includes(userId)) for (const row of rows) publisherState().orderReads.delete(row.id);
  if (online.length === 0) return;
  const bots = await botUserIds(); // 机器人不发 account 事件(见 botUserIds)
  for (const userId of online) {
    const orders = touched.get(userId) ?? [];
    if (bots.has(userId)) {
      // 名单查到之前领的票(本进程第一次派生时还不知道谁是机器人)在这里还掉,不留在表里
      for (const row of orders) publisherState().orderReads.delete(row.id);
      continue;
    }
    const { events, balanceRead, positionRead } = await accountEventsFor(userId, order.assetId, orders, trades, orderTickets);
    for (const event of events) {
      // 票号裁决紧挨着发布(同一段同步代码):余额——更晚发出的余额读取已经发布过,这条更旧,不发;
      // 订单行——较晚提交的结果已经发布过这张单,这条更旧,不发;持仓——同一标的上更晚发出的持仓读取已经发布过,这一行更旧,不发
      if (event.t === "balance" && !adoptTicket(publisherState().balanceReads, userId, balanceRead)) continue;
      if (event.t === "order" && !adoptOrderTicket(event.order, orderTickets.get(event.order.id))) continue;
      if (event.t === "position" && !adoptTicket(publisherState().positionTickets, positionKey(userId, event.position.assetId), positionRead)) continue;
      bus.publish({ kind: "account", userId, event });
    }
  }
}

/**
 * 一个用户在这次结果里的账户事件:该用户被触碰的订单(均价按实际成交重算,与 /api/account/orders 同一规则)、
 * 该用户参与的成交(ledgerRefs 经 ledgerIdsByTrade 一次查出)、余额、该标的的持仓(含卖光后的 0 持仓,让客户端能清掉)。
 * balanceRead / positionRead = 余额、持仓读取发出前领的票号(见文件头「余额」「持仓」),由调用方在发布那一刻裁决。
 */
async function accountEventsFor(
  userId: string,
  assetId: string,
  orders: readonly OrderRow[],
  trades: readonly TradeRow[],
  orderTickets: ReadonlyMap<string, number>,
): Promise<{ events: AccountEvent[]; balanceRead: number; positionRead: number }> {
  const mine = trades.filter((t) => t.buyerId === userId || t.sellerId === userId);
  const balanceRead = takeTicket(publisherState().balanceReads, userId, userId);
  const positionRead = takePositionTicket(userId, assetId);
  // 提交时不在线、没领票的单不发它的行(见文件头「订单行」),均价与自成交派生也就不必为它查
  orders = orders.filter((row) => orderTickets.has(row.id));
  const [avg, selfTraded, ledgerIds, balance, positions] = await Promise.all([
    avgFillPricesByOrder(prisma, orders),
    selfTradeCancelledIds(prisma, orders), // 被自成交防护撤掉的挂单:与 REST /api/account/orders 同一派生,WS 与 REST 的 cancelReason 一致
    ledgerIdsByTrade(prisma, userId, mine.map((t) => t.id)),
    loadBalance(userId),
    loadPositionRows(userId, assetId),
  ]);
  const events: AccountEvent[] = [];
  for (const row of orders) events.push({ t: "order", order: toOrder(row, avg.has(row.id) ? avg.get(row.id) : undefined, selfTraded) });
  for (const t of mine) events.push({ t: "fill", fill: toFill(t, userId, ledgerIds.get(t.id) ?? []) });
  events.push({ t: "balance", balance });
  for (const position of positions) events.push({ t: "position", position });
  return { events, balanceRead, positionRead };
}

async function loadBalance(userId: string): Promise<Balance> {
  const row = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { cashBalance: true, lockedCash: true } });
  return { cashBalance: Number(row.cashBalance), lockedCash: Number(row.lockedCash) }; // BigInt → number
}

/** 领一张持仓读取票号(在发出读取之前领;见文件头「持仓」) */
function takePositionTicket(userId: string, assetId: string): number {
  return takeTicket(publisherState().positionTickets, positionKey(userId, assetId), userId);
}

/**
 * 成交 / 撤单 / OTC / 注销之后该用户在该标的上的一行(src/lib/server/positions.ts,与 REST、快照同一份查询与映射):
 * 包括已经卖光的空行(includeEmpty:客户端按 assetId 覆盖,才能把行清掉)与整仓注销的行(quantity 0、retired > 0,客户端保留)。
 * 没有 Holding 行(从没持有过)时是空数组。
 */
function loadPositionRows(userId: string, assetId: string): Promise<Position[]> {
  return loadPositions(prisma, userId, { assetIds: [assetId], includeEmpty: true });
}

/** 持仓行发布前的裁决(与发布在同一段同步代码里):同一标的上更晚发出的读取已经发布过 → 这一行更旧,不发 */
function publishPositionRows(bus: CarbadiaBus, userId: string, positions: readonly Position[], mine: number): void {
  for (const position of positions) {
    if (!adoptTicket(publisherState().positionTickets, positionKey(userId, position.assetId), mine)) continue;
    bus.publish({ kind: "account", userId, event: { t: "position", position } });
  }
}

/**
 * account 订阅时的快照:balance + 当前挂单(OPEN / PARTIAL,与 GET /api/account/orders?status=open 同序)+ 持仓
 *(hub 经 globalThis.__carbadiaAccountSnapshot 调用)。持仓与 GET /api/account/positions 同一口径(positions.ts):数量 > 0 的行,
 * 加上整仓注销的行(数量 0、retired > 0),带锁定来源 lockedBy。余额、挂单与持仓的五个读取(持仓行、账本、注销、SELL 挂单汇总、
 * 场外挂牌汇总)放进同一个批量事务:看到的是同一个提交点,不会出现「余额已含某笔成交、挂单还是成交前」的拼接快照。
 * 挂单均价在事务之后按成交重算(需要挂单 id):只有成交合计恰好等于行上的 filledQuantity 才给值,读到中间态时是 null,不会给错数。
 * 快照不领持仓票号:票号只裁决事件之间的先后;快照若采用票号,在途的事件读取会被丢掉,而快照只发给正在订阅的那条连接,
 * 同一用户的其它连接就收不到那次变化。快照与事件的先后由 hub 的 seq 检查负责。
 */
export async function loadAccountSnapshot(userId: string): Promise<AccountSnapshot> {
  // 机器人账户没有 account 流(见 botUserIds):拒绝,hub 记一行、不发;它的账本很大,也不该为一个旧会话整本读一遍
  if ((await botUserIds()).has(userId)) throw new Error("bot accounts have no account stream");
  const [balanceRow, orderRows, ...positionRows] = await prisma.$transaction([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { cashBalance: true, lockedCash: true } }),
    prisma.order.findMany({
      where: { userId, status: { in: ["OPEN", "PARTIAL"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: { asset: { select: { symbol: true } } },
    }),
    ...positionReads(prisma, userId),
  ]);
  const avg = await avgFillPricesByOrder(prisma, orderRows);
  return {
    balance: { cashBalance: Number(balanceRow.cashBalance), lockedCash: Number(balanceRow.lockedCash) }, // BigInt → number
    orders: orderRows.map((row) => toOrder(row, avg.has(row.id) ? avg.get(row.id) : undefined)),
    positions: await positionsFromRows(prisma, userId, positionRows),
  };
}

// 加载即挂钩子(不用 ??=:dev HMR 或两个 bundle 先后加载时,最新的一份生效)
globalThis.__carbadiaAccountSnapshot = loadAccountSnapshot;
globalThis.__carbadiaBookRefresh = refreshBook;
globalThis.__carbadiaRecentTrades = recentTrades;

// ---- 测试钩子 ----
export const _internal = {
  /** 取消去抖计时器并立刻读一次盘口(有兴趣才读) */
  flushBook,
  /** 清掉计时器、队列与 globalThis 上的发布器状态(盘口基线、K 线当前桶、发布器私有状态) */
  reset(): void {
    for (const timer of bookTimers.values()) clearTimeout(timer);
    bookTimers.clear();
    for (const throttle of tickers.values()) if (throttle.cooldown) clearTimeout(throttle.cooldown);
    tickers.clear();
    chains.clear();
    symbols.clear();
    botIdsLoading = null;
    globalThis.__carbadiaBookCache = undefined;
    globalThis.__carbadiaCandleState = undefined;
    globalThis.__carbadiaPublisherState = undefined;
  },
  /** 等当前排队的派生全部结束(测试用) */
  async idle(): Promise<void> {
    await Promise.all([...chains.values()]);
  },
};
