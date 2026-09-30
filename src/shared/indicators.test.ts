import { describe, expect, it } from "vitest";
import { ema, emaNext, sma, smaLast } from "./indicators";

const closes = [10, 11, 12, 13, 14, 15, 16];

describe("sma", () => {
  it("前 period − 1 位为 null,之后与手算对照", () => {
    expect(sma(closes, 3)).toEqual([null, null, 11, 12, 13, 14, 15]);
  });

  it("period 1 即原序列;period 大于长度全 null", () => {
    expect(sma([5, 7], 1)).toEqual([5, 7]);
    expect(sma([5, 7], 3)).toEqual([null, null]);
  });

  it("空输入返回空;非法 period 全 null", () => {
    expect(sma([], 3)).toEqual([]);
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null]);
    expect(sma([1, 2, 3], 2.5)).toEqual([null, null, null]);
  });

  it("滑动窗口不累积浮点误差到可见程度", () => {
    const values = Array.from({ length: 1_000 }, (_, i) => 1000 + (i % 7) * 0.1);
    const out = sma(values, 25);
    const manual = values.slice(975).reduce((a, b) => a + b, 0) / 25;
    expect(out[999]).toBeCloseTo(manual, 9);
  });
});

describe("ema", () => {
  it("以前 period 根的 SMA 起算,再按 k = 2/(period+1) 递推(手算对照)", () => {
    // period 3:k = 0.5;seed = (10+11+12)/3 = 11;然后 12, 13, 14, 15
    expect(ema(closes, 3)).toEqual([null, null, 11, 12, 13, 14, 15]);
  });

  it("非等差序列手算对照", () => {
    // period 2:k = 2/3;seed = (10+20)/2 = 15;下一根 = 15 + 2/3 × (5 − 15) = 8.333…
    const out = ema([10, 20, 5], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(15);
    expect(out[2]).toBeCloseTo(15 + (2 / 3) * (5 - 15), 12);
  });

  it("与逐根 emaNext 递推一致", () => {
    const values = [3, 8, 1, 9, 4, 7, 2, 6];
    const whole = ema(values, 3);
    let prev = whole[2]!;
    for (let i = 3; i < values.length; i++) {
      prev = emaNext(prev, values[i], 3);
      expect(whole[i]).toBeCloseTo(prev, 12);
    }
  });

  it("非法 period 全 null;不足 period 全 null", () => {
    expect(ema([1, 2], 0)).toEqual([null, null]);
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });
});

describe("smaLast / emaNext", () => {
  it("smaLast 取最后 period 个的均值,不足返回 null", () => {
    expect(smaLast(closes, 3)).toBe(15);
    expect(smaLast(closes, 7)).toBe(13);
    expect(smaLast(closes, 8)).toBeNull();
    expect(smaLast(closes, 0)).toBeNull();
  });

  it("smaLast 与整段 sma 的末位相等", () => {
    expect(smaLast(closes, 4)).toBe(sma(closes, 4)[closes.length - 1]);
  });

  it("emaNext 手算:prev 100、value 110、period 9 → 100 + 0.2 × 10 = 102", () => {
    expect(emaNext(100, 110, 9)).toBeCloseTo(102, 12);
  });

  it("emaNext 非法 period 直接返回新值", () => {
    expect(emaNext(100, 110, 0)).toBe(110);
    expect(emaNext(100, 110, 1)).toBe(110);
  });
});
