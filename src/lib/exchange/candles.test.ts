import { describe, expect, it } from "vitest";
import { bucketTrades, INTERVALS } from "./candles";

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

  it("最多返回 240 根(保留最新的)", () => {
    const trades = Array.from({ length: 300 }, (_, i) => tr(i * 60, 100 + i));
    const out = bucketTrades(trades, 60_000);
    expect(out).toHaveLength(240);
    expect(out[239].c).toBe(100 + 299);
  });
});

describe("INTERVALS", () => {
  it("提供 1m/5m/1h/1d 四个周期", () => {
    expect(Object.keys(INTERVALS)).toEqual(["1m", "5m", "1h", "1d"]);
  });
});
