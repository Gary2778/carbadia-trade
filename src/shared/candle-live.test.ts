import { describe, expect, it } from "vitest";
import { INTERVAL_MS, bucketUpdate, toCandleBar } from "./candle-live";
import { CANDLE_INTERVALS } from "./constants";
import type { CandleBar } from "./types";

const T0 = Date.parse("2026-06-13T08:00:00.000Z");
const trade = (offsetSec: number, price: number, quantity = 10) => ({ price, quantity, ts: T0 + offsetSec * 1000 });

describe("INTERVAL_MS", () => {
  it("六个周期与 CANDLE_INTERVALS 一一对应", () => {
    expect(Object.keys(INTERVAL_MS)).toEqual([...CANDLE_INTERVALS]);
  });

  it("毫秒值正确", () => {
    expect(INTERVAL_MS).toEqual({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 });
  });
});

describe("bucketUpdate", () => {
  it("prev 为 null 时开新桶,t 为桶起点,OHLC 都是成交价", () => {
    const { bar, isNew } = bucketUpdate(null, trade(37, 1000, 5), INTERVAL_MS["1m"]);
    expect(isNew).toBe(true);
    expect(bar).toEqual({ t: T0, o: 1000, h: 1000, l: 1000, c: 1000, v: 5 });
  });

  it("同桶:h 取高、l 取低、c 取最新、v 累加,o 不变", () => {
    const first = bucketUpdate(null, trade(0, 1000, 5), INTERVAL_MS["1m"]).bar;
    const up = bucketUpdate(first, trade(10, 1040, 3), INTERVAL_MS["1m"]);
    expect(up.isNew).toBe(false);
    expect(up.bar).toEqual({ t: T0, o: 1000, h: 1040, l: 1000, c: 1040, v: 8 });
    const down = bucketUpdate(up.bar, trade(59, 980, 2), INTERVAL_MS["1m"]);
    expect(down.bar).toEqual({ t: T0, o: 1000, h: 1040, l: 980, c: 980, v: 10 });
  });

  it("跨桶:isNew 且新 bar 只含本笔", () => {
    const first = bucketUpdate(null, trade(0, 1000, 5), INTERVAL_MS["1m"]).bar;
    const next = bucketUpdate(first, trade(60, 1010, 1), INTERVAL_MS["1m"]);
    expect(next.isNew).toBe(true);
    expect(next.bar).toEqual({ t: T0 + 60_000, o: 1010, h: 1010, l: 1010, c: 1010, v: 1 });
  });

  it("跳过多个空桶仍以成交所在桶为起点", () => {
    const first = bucketUpdate(null, trade(0, 1000), INTERVAL_MS["5m"]).bar;
    const next = bucketUpdate(first, trade(3 * 300 + 7, 1010), INTERVAL_MS["5m"]);
    expect(next.isNew).toBe(true);
    expect(next.bar.t).toBe(T0 + 3 * 300_000);
  });

  it("六个 interval 的桶起点各自对齐", () => {
    const ts = T0 + 5 * 3_600_000 + 17 * 60_000 + 3_000; // 13:17:03Z
    for (const [interval, ms] of Object.entries(INTERVAL_MS)) {
      const { bar } = bucketUpdate(null, { price: 1, quantity: 1, ts }, ms);
      expect(bar.t % ms, interval).toBe(0);
      expect(bar.t).toBeLessThanOrEqual(ts);
      expect(ts - bar.t).toBeLessThan(ms);
    }
  });

  it("落在更早桶的乱序成交忽略,返回同一个 prev 引用", () => {
    const cur = bucketUpdate(null, trade(120, 1000), INTERVAL_MS["1m"]).bar;
    const res = bucketUpdate(cur, trade(30, 5000, 99), INTERVAL_MS["1m"]);
    expect(res.isNew).toBe(false);
    expect(res.bar).toBe(cur);
  });

  it("intervalMs 非法(0 / 负数 / NaN / Infinity)按 1 ms 分桶:t 有限、等于成交时间戳,不产出 NaN", () => {
    const prev = bucketUpdate(null, trade(0, 1000, 5), INTERVAL_MS["1m"]).bar;
    for (const bad of [0, -60_000, NaN, Infinity]) {
      const opened = bucketUpdate(null, trade(37, 1000, 5), bad);
      expect(opened.isNew, String(bad)).toBe(true);
      expect(opened.bar.t, String(bad)).toBe(T0 + 37_000);
      const next = bucketUpdate(prev, trade(37, 1010, 1), bad);
      expect(Number.isFinite(next.bar.t), String(bad)).toBe(true);
      expect(next.bar, String(bad)).toEqual({ t: T0 + 37_000, o: 1010, h: 1010, l: 1010, c: 1010, v: 1 });
      // 同一毫秒的第二笔仍是同桶累加
      const same = bucketUpdate(next.bar, trade(37, 1020, 2), bad);
      expect(same.isNew, String(bad)).toBe(false);
      expect(same.bar.v, String(bad)).toBe(3);
    }
  });

  it("不改入参 prev", () => {
    const prev: CandleBar = { t: T0, o: 1000, h: 1000, l: 1000, c: 1000, v: 5 };
    const copy = { ...prev };
    bucketUpdate(prev, trade(10, 1040, 3), INTERVAL_MS["1m"]);
    expect(prev).toEqual(copy);
  });
});

describe("toCandleBar", () => {
  it("ISO t → unix ms,其余字段原样", () => {
    expect(toCandleBar({ t: "2026-06-13T08:00:00.000Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 7 })).toEqual({ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 7 });
  });

  it("与 bucketUpdate 的桶起点一致", () => {
    const bar = toCandleBar({ t: "2026-06-13T08:05:00.000Z", o: 1, h: 1, l: 1, c: 1, v: 1 });
    expect(bucketUpdate(null, trade(5 * 60 + 30, 1), INTERVAL_MS["5m"]).bar.t).toBe(bar.t);
  });
});
