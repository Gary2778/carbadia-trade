import { describe, expect, it } from "vitest";
import { SPARK_POINTS, sampleTimes } from "./sparkline";

describe("sampleTimes", () => {
  it("首尾时刻必在,等距,整数毫秒,不递减", () => {
    const t0 = 1_790_000_000_000, t1 = t0 + 86_400_000;
    const times = sampleTimes(t0, t1);
    expect(times).toHaveLength(SPARK_POINTS);
    expect(times[0]).toBe(t0);
    expect(times.at(-1)).toBe(t1);
    for (let k = 1; k < times.length; k++) {
      expect(Number.isInteger(times[k])).toBe(true);
      expect(times[k]).toBeGreaterThanOrEqual(times[k - 1]);
    }
    // 相邻间隔只差舍入误差
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("首尾同一时刻时全部落在该时刻;只要一个点时取末尾", () => {
    expect(sampleTimes(5, 5, 3)).toEqual([5, 5, 5]);
    expect(sampleTimes(1, 9, 1)).toEqual([9]);
  });
});
