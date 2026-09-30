import { describe, expect, it } from "vitest";
import { CANDLE_INTERVALS } from "../../shared/constants";
import { INTERVAL_MS } from "../../shared/candle-live";
import { bucketTrades, DEFAULT_MAX_BARS, INTERVALS } from "./candles";

const T0 = Date.parse("2026-06-13T08:00:00.000Z");
const tr = (offsetSec: number, price: number, quantity = 10) => ({
  price,
  quantity,
  createdAt: new Date(T0 + offsetSec * 1000),
});

describe("bucketTrades", () => {
  it("空输入返回空数组", () => {
    expect(bucketTrades([], 60_000)).toEqual([]);
  });

  it("同一分钟内聚合出正确 OHLCV", () => {
    const out = bucketTrades([tr(0, 10), tr(10, 14), tr(20, 8), tr(30, 12, 5)], 60_000);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ o: 10, h: 14, l: 8, c: 12, v: 35 });
    expect(out[0].t).toBe("2026-06-13T08:00:00.000Z");
  });

  it("跨桶切分且按时间升序", () => {
    const out = bucketTrades([tr(5, 10), tr(70, 20)], 60_000);
    expect(out).toHaveLength(2);
    expect(out[0].c).toBe(10);
    expect(out[1].o).toBe(20);
  });

  it("max 不传时最多返回 240 根(保留最新的), 旧 /api/assets/[symbol]/candles 行为不变", () => {
    expect(DEFAULT_MAX_BARS).toBe(240);
    const trades = Array.from({ length: 300 }, (_, i) => tr(i * 60, 100 + i));
    const out = bucketTrades(trades, 60_000);
    expect(out).toHaveLength(240);
    expect(out[239].c).toBe(100 + 299);
  });

  it("max 参数取代写死的 240: 传 1500 时 300 根全留, 传 50 时只留最新 50 根", () => {
    const trades = Array.from({ length: 300 }, (_, i) => tr(i * 60, 100 + i));
    expect(bucketTrades(trades, 60_000, 1500)).toHaveLength(300);
    const fifty = bucketTrades(trades, 60_000, 50);
    expect(fifty).toHaveLength(50);
    expect(fifty[0].o).toBe(100 + 250);
    expect(fifty[49].c).toBe(100 + 299);
  });

  it("max 不足 1 时返回空, 不会因 slice(-0) 整段放行", () => {
    expect(bucketTrades([tr(0, 10)], 60_000, 0)).toEqual([]);
  });

  it("15m 桶: 同一刻钟合并, 跨刻钟切分, t 对齐到刻钟起点", () => {
    const out = bucketTrades([tr(0, 10), tr(14 * 60, 12), tr(15 * 60, 20), tr(29 * 60 + 59, 18)], INTERVALS["15m"].ms);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ t: "2026-06-13T08:00:00.000Z", o: 10, c: 12 });
    expect(out[1]).toMatchObject({ t: "2026-06-13T08:15:00.000Z", o: 20, c: 18 });
  });

  it("4h 桶: 08:00 与 11:59 同桶, 12:00 开新桶", () => {
    const out = bucketTrades([tr(0, 10), tr(3 * 3600 + 59 * 60, 11), tr(4 * 3600, 30)], INTERVALS["4h"].ms);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ t: "2026-06-13T08:00:00.000Z", o: 10, c: 11, v: 20 });
    expect(out[1]).toMatchObject({ t: "2026-06-13T12:00:00.000Z", o: 30 });
  });
});

describe("INTERVALS", () => {
  it("提供 1m/5m/15m/1h/4h/1d 六个周期, 与共享 CANDLE_INTERVALS 与 INTERVAL_MS 一致", () => {
    expect(Object.keys(INTERVALS)).toEqual([...CANDLE_INTERVALS]);
    for (const key of CANDLE_INTERVALS) expect(INTERVALS[key].ms).toBe(INTERVAL_MS[key]);
  });

  it("15m 回看 3 天、4h 回看 30 天(只供旧端点)", () => {
    expect(INTERVALS["15m"]).toEqual({ ms: 900_000, lookbackMs: 3 * 86_400_000 });
    expect(INTERVALS["4h"]).toEqual({ ms: 14_400_000, lookbackMs: 30 * 86_400_000 });
  });
});
