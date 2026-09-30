// 盘口视图(计划 §3.6、§9.1 第 7 条):buildBookView 是纯函数,getBookView 在它外面套一层显式 memo cache。
// hook 的引用稳定性在 node 环境不可测,所以视图计算与缓存都不放在 hook 里:
// 键 [book.version, stepCents, depth, mineVersion] 全等 → 返回上次同一引用;任一变化才重算。
// 单位:价格整数分、数量整数吨;pct 0..1 直接给深度条 scaleX。
import type { Order, OrderBookLevel, Side } from "@/shared";
import { aggregateLevels, cumulate, spread } from "@/shared/orderbook";
import type { BookState } from "./store";

export type BookViewRow = { price: number; quantity: number; orders: number; cum: number; pct: number; mine: boolean; flashKey: number };
export type BookView = { bids: BookViewRow[]; asks: BookViewRow[]; spread: { abs: number; bps: number } | null };

/** 自家挂单价集合,分 side(买单只标买盘档、卖单只标卖盘档;聚合后按同一取整规则落桶) */
export type MinePrices = { bids: ReadonlySet<number>; asks: ReadonlySet<number> };
export const EMPTY_MINE: MinePrices = { bids: new Set(), asks: new Set() };

/** 每个聚合价一格:quantity 变化时 flashKey + 1(OrderBookRow 用 key={flashKey} 重挂闪烁 span) */
export type FlashSlot = { quantity: number; flashKey: number };
export type FlashState = { bids: Map<number, FlashSlot>; asks: Map<number, FlashSlot> };
export const createFlashState = (): FlashState => ({ bids: new Map(), asks: new Map() });

const normalizeStep = (stepCents: number): number => (Number.isSafeInteger(stepCents) && stepCents > 0 ? stepCents : 1);
const bucketOf = (price: number, step: number, side: Side): number => (side === "BUY" ? Math.floor(price / step) * step : Math.ceil(price / step) * step);

function buildSide(levels: Map<number, OrderBookLevel>, side: Side, step: number, depth: number, mine: ReadonlySet<number>, slots: Map<number, FlashSlot>): BookViewRow[] {
  const aggregated = aggregateLevels(levels.values(), step, side);
  const shown = Number.isFinite(depth) && depth > 0 && aggregated.length > depth ? aggregated.slice(0, depth) : aggregated;
  const mineBuckets = new Set<number>();
  for (const price of mine) mineBuckets.add(bucketOf(price, step, side));
  const next = new Map<number, FlashSlot>();
  const rows = cumulate(shown).map(({ level, cum, pct }) => {
    const prev = slots.get(level.price);
    const flashKey = prev ? (prev.quantity === level.quantity ? prev.flashKey : prev.flashKey + 1) : 0;
    next.set(level.price, { quantity: level.quantity, flashKey });
    return { price: level.price, quantity: level.quantity, orders: level.orders, cum, pct, mine: mineBuckets.has(level.price), flashKey };
  });
  // 只保留当前可见档的闪烁槽,价格漂移不会让 Map 无限增长
  slots.clear();
  for (const [price, slot] of next) slots.set(price, slot);
  return rows;
}

/** 原始最优价(聚合前):spread 反映真实市场,不随档位聚合变化 */
function rawTop(book: BookState): { bestBid: number | null; bestAsk: number | null } {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const price of book.bids.keys()) if (bestBid === null || price > bestBid) bestBid = price;
  for (const price of book.asks.keys()) if (bestAsk === null || price < bestAsk) bestAsk = price;
  return { bestBid, bestAsk };
}

/**
 * 纯函数:把盘口 Map 按 stepCents 聚合(BUY 向下、SELL 向上取整)、截到 depth 档、累计量与比例(按可见档的总量),
 * 标记自家档(mine 的原始挂单价按同一规则落桶),并维护 flashState 里每档的 flashKey(quantity 变化时 + 1;首次出现为 0)。
 * flashState 是显式传入的状态槽(默认新建,即无闪烁历史),同一输入 + 同一槽状态 → 同一输出。
 */
export function buildBookView(book: BookState, mine: MinePrices, stepCents: number, depth: number, flashState: FlashState = createFlashState()): BookView {
  const step = normalizeStep(stepCents);
  const { bestBid, bestAsk } = rawTop(book);
  return {
    bids: buildSide(book.bids, "BUY", step, depth, mine.bids, flashState.bids),
    asks: buildSide(book.asks, "SELL", step, depth, mine.asks, flashState.asks),
    spread: spread(bestBid, bestAsk),
  };
}

type ViewSlot = { version: number; stepCents: number; depth: number; mineVersion: number; view: BookView; flash: FlashState };
const viewCache = new Map<string, ViewSlot>();

/**
 * 每 symbol 一个缓存槽:键 [book.version, stepCents, depth, mineVersion] 全等则返回上次同一引用(React.memo 行组件零提交),
 * 否则用该 symbol 的 flashState 重算。book.version 全局单调(store.ts),evict 再订阅不会撞键。
 * 换了合并档(stepCents 变)时闪烁槽从头算:两档共有的桶价(7000、7015 …)在两种档位下聚合量不同,沿用旧槽会把
 * 「换档」当成「数量变了」让这些行白闪一下;新槽里每档都是首次出现(flashKey 0),换档本身不闪。只改深度不重置。
 */
export function getBookView(symbol: string, book: BookState, stepCents: number, depth: number, mine: MinePrices, mineVersion: number): BookView {
  const slot = viewCache.get(symbol);
  if (slot && slot.version === book.version && slot.stepCents === stepCents && slot.depth === depth && slot.mineVersion === mineVersion) return slot.view;
  const flash = slot && slot.stepCents === stepCents ? slot.flash : createFlashState();
  const view = buildBookView(book, mine, stepCents, depth, flash);
  viewCache.set(symbol, { version: book.version, stepCents, depth, mineVersion, view, flash });
  return view;
}

type MineSlot = { openOrders: ReadonlyMap<string, Order>; mine: MinePrices; version: number };
const mineCache = new Map<string, MineSlot>();
let mineVersionSeq = 0;
const sameSet = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 从账户 store 的 openOrders 派生本 symbol 的自家挂单价集合,并给它一个版本号:
 * openOrders 引用不变 → 直接返回上次;引用变了但集合内容相同 → 版本号不变(视图缓存不失效);内容变了才 + 1。
 * 只算 OPEN / PARTIAL 的限价单(市价单无价)。
 */
export function minePricesOf(symbol: string, openOrders: ReadonlyMap<string, Order>): { mine: MinePrices; version: number } {
  const slot = mineCache.get(symbol);
  if (slot && slot.openOrders === openOrders) return slot;
  const bids = new Set<number>();
  const asks = new Set<number>();
  for (const order of openOrders.values()) {
    if (order.symbol !== symbol || order.price === null) continue;
    if (order.status !== "OPEN" && order.status !== "PARTIAL") continue;
    (order.side === "BUY" ? bids : asks).add(order.price);
  }
  const same = slot !== undefined && sameSet(slot.mine.bids, bids) && sameSet(slot.mine.asks, asks);
  const next: MineSlot = same ? { openOrders, mine: slot.mine, version: slot.version } : { openOrders, mine: { bids, asks }, version: ++mineVersionSeq };
  mineCache.set(symbol, next);
  return next;
}

/** 测试用:清空视图缓存与自家档缓存 */
export function resetBookViewCache(): void {
  viewCache.clear();
  mineCache.clear();
}
