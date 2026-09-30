// 盘口纯函数(计划 §3.5):增量合并、快照差分、档位聚合、累计与价差。
// 单位:价格整数分、数量整数吨。bids 降序、asks 升序是快照约定,这里的输出遵守同一约定。
import type { OrderBookDelta, OrderBookLevel, OrderBookSnapshot, Side } from "./types";

/** 把增量合并进档位表:quantity === 0 删档,其余覆盖;返回新 Map,不改入参 */
export function applyDelta(levels: Map<number, OrderBookLevel>, delta: OrderBookLevel[]): Map<number, OrderBookLevel> {
  const next = new Map(levels);
  for (const level of delta) {
    if (level.quantity === 0) next.delete(level.price);
    else next.set(level.price, level);
  }
  return next;
}

/** 单侧差分:next 里与 prev 不同(新增或量/单数变化)的档原样输出,prev 有而 next 没有的档以 quantity 0 输出 */
function diffSide(prev: OrderBookLevel[] | undefined, next: OrderBookLevel[]): OrderBookLevel[] {
  const before = new Map<number, OrderBookLevel>();
  for (const level of prev ?? []) before.set(level.price, level);
  const out: OrderBookLevel[] = [];
  const seen = new Set<number>();
  for (const level of next) {
    seen.add(level.price);
    const old = before.get(level.price);
    if (!old || old.quantity !== level.quantity || old.orders !== level.orders) out.push(level);
  }
  for (const price of before.keys()) {
    if (!seen.has(price)) out.push({ price, quantity: 0, orders: 0 });
  }
  return out;
}

/** 快照差分:只含变化档;prev 为 null 时整个 next 就是增量。输出保持 bids 降序、asks 升序 */
export function diffBook(prev: OrderBookSnapshot | null, next: OrderBookSnapshot): OrderBookDelta {
  return {
    symbol: next.symbol,
    bids: diffSide(prev?.bids, next.bids).sort((a, b) => b.price - a.price),
    asks: diffSide(prev?.asks, next.asks).sort((a, b) => a.price - b.price),
    ts: next.ts,
  };
}

/**
 * 按 stepCents 合并档位:BUY 价格向下取整(买盘合并到更低的档)、SELL 向上取整(卖盘合并到更高的档),
 * 量与单数相加。输出按最优价在前:BUY 降序、SELL 升序。stepCents 非正整数时按 1(不合并,只排序)。
 */
export function aggregateLevels(levels: Iterable<OrderBookLevel>, stepCents: number, side: Side): OrderBookLevel[] {
  const step = Number.isSafeInteger(stepCents) && stepCents > 0 ? stepCents : 1;
  const buckets = new Map<number, OrderBookLevel>();
  for (const level of levels) {
    const price = side === "BUY" ? Math.floor(level.price / step) * step : Math.ceil(level.price / step) * step;
    const bucket = buckets.get(price);
    if (bucket) {
      bucket.quantity += level.quantity;
      bucket.orders += level.orders;
    } else {
      buckets.set(price, { price, quantity: level.quantity, orders: level.orders });
    }
  }
  const out = [...buckets.values()];
  return side === "BUY" ? out.sort((a, b) => b.price - a.price) : out.sort((a, b) => a.price - b.price);
}

export type CumulatedLevel = { level: OrderBookLevel; cum: number; pct: number };

/** 按给定顺序累计数量;pct = cum / 总量,取值 0..1(深度条直接用作 scaleX 的比例) */
export function cumulate(levels: OrderBookLevel[]): CumulatedLevel[] {
  let total = 0;
  for (const level of levels) total += level.quantity;
  let cum = 0;
  return levels.map((level) => {
    cum += level.quantity;
    return { level, cum, pct: total > 0 ? cum / total : 0 };
  });
}

/** 价差:abs = ask − bid(分),bps = abs / 中间价 × 10000;任一侧缺失或非正数返回 null */
export function spread(bestBid: number | null | undefined, bestAsk: number | null | undefined): { abs: number; bps: number } | null {
  if (bestBid == null || bestAsk == null) return null;
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) return null;
  const abs = bestAsk - bestBid;
  const mid = (bestAsk + bestBid) / 2;
  return { abs, bps: (abs / mid) * 10_000 };
}
