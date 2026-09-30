// 实时 K 线折算(计划 §3.5、§3.6):发布器与轮询模式都用 bucketUpdate 把成交折进当前桶;
// toCandleBar 把 lib 的 Candle{ t: ISO } 转成 CandleBar{ t: unix ms }(结构类型参数,不 import lib)。
import type { CandleBar, CandleInterval } from "./types";

export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** 正的有限毫秒数才是合法桶宽;其余按 1 ms(每笔成交自成一桶),与 order-math 的 stepOf 同一约定,从不产出 NaN 的 t */
const intervalOf = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? ms : 1);

/**
 * 把一笔成交折进 K 线:同桶更新 h / l / c、累加 v;新桶(或 prev 为 null)开一根 isNew 的 bar。
 * 成交落在比 prev 更早的桶(乱序)时忽略,原样返回 prev。不改入参。
 * intervalMs 非法(0、负数、NaN、Infinity)时按 1 ms 分桶,不抛错、不产出 NaN。
 */
export function bucketUpdate(
  prev: CandleBar | null,
  trade: { price: number; quantity: number; ts: number },
  intervalMs: number,
): { bar: CandleBar; isNew: boolean } {
  const step = intervalOf(intervalMs);
  const t = Math.floor(trade.ts / step) * step;
  if (prev && t < prev.t) return { bar: prev, isNew: false };
  if (!prev || t !== prev.t) {
    return { bar: { t, o: trade.price, h: trade.price, l: trade.price, c: trade.price, v: trade.quantity }, isNew: true };
  }
  return {
    bar: {
      t: prev.t,
      o: prev.o,
      h: Math.max(prev.h, trade.price),
      l: Math.min(prev.l, trade.price),
      c: trade.price,
      v: prev.v + trade.quantity,
    },
    isNew: false,
  };
}

/** lib/exchange/candles 的 Candle(t 为 ISO 字符串)→ CandleBar(t 为 unix ms) */
export function toCandleBar(c: { t: string; o: number; h: number; l: number; c: number; v: number }): CandleBar {
  return { t: Date.parse(c.t), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
}
