// K线聚合 — 从成交记录在内存中聚合 OHLCV, 纯函数
import type { CandleInterval } from "../../shared/types";

export type CandleInput = { price: number; quantity: number; createdAt: Date };
export type Candle = { t: string; o: number; h: number; l: number; c: number; v: number };

/**
 * 六个周期与 CandleInterval 一一对应(satisfies 绑定, 少一个都编译不过)。
 * lookbackMs 只供旧 /api/assets/[symbol]/candles 用(固定窗口 + 默认 240 根);
 * 新 /api/market/[symbol]/candles 走 market-snapshots.getBars, 窗口按 limit × ms 取, 不看 lookbackMs(计划 §9.1 第 22 条)。
 */
export const INTERVALS = {
  "1m": { ms: 60_000, lookbackMs: 4 * 3_600_000 },
  "5m": { ms: 300_000, lookbackMs: 24 * 3_600_000 },
  "15m": { ms: 900_000, lookbackMs: 3 * 86_400_000 },
  "1h": { ms: 3_600_000, lookbackMs: 7 * 86_400_000 },
  "4h": { ms: 14_400_000, lookbackMs: 30 * 86_400_000 },
  "1d": { ms: 86_400_000, lookbackMs: 90 * 86_400_000 },
} as const satisfies Record<CandleInterval, { ms: number; lookbackMs: number }>;
export type IntervalKey = keyof typeof INTERVALS;

/** 旧端点的默认上限; 新端点按 limit 传 max(≤ MAX_BARS 1500) */
export const DEFAULT_MAX_BARS = 240;

/**
 * 输入必须按 createdAt 升序(调用方查询已 orderBy asc), 函数内不再复制排序。
 * 最多返回 max 根(保留最新的); max 不传 = 240, 与旧 /api/assets/[symbol]/candles 的行为一致。
 */
export function bucketTrades(trades: CandleInput[], intervalMs: number, max = DEFAULT_MAX_BARS): Candle[] {
  const map = new Map<number, Candle>();
  for (const tr of trades) {
    const bucket = Math.floor(tr.createdAt.getTime() / intervalMs) * intervalMs;
    const c = map.get(bucket);
    if (!c) {
      map.set(bucket, { t: new Date(bucket).toISOString(), o: tr.price, h: tr.price, l: tr.price, c: tr.price, v: tr.quantity });
    } else {
      c.h = Math.max(c.h, tr.price);
      c.l = Math.min(c.l, tr.price);
      c.c = tr.price;
      c.v += tr.quantity;
    }
  }
  const all = [...map.values()];
  if (max < 1) return [];
  return all.length > max ? all.slice(-max) : all;
}
