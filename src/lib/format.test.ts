import { describe, expect, it } from "vitest";
import { fmtMoney, fmtPrice, fmtQty, fmtTonnes } from "./format";

describe("fmtPrice", () => {
  it("按 instrument.pricePrecision 取小数位(0 / 1 / 2)", () => {
    expect(fmtPrice(123_456, { pricePrecision: 2 }, "en")).toBe("1,234.56");
    expect(fmtPrice(123_450, { pricePrecision: 1 }, "en")).toBe("1,234.5");
    expect(fmtPrice(123_456, { pricePrecision: 0 }, "en")).toBe("1,235");
  });

  it("zh-CN 走 zh-CN locale,其余语言都按 en-US", () => {
    expect(fmtPrice(123_456, { pricePrecision: 2 }, "zh-CN")).toBe("1,234.56");
    expect(fmtPrice(123_456, { pricePrecision: 2 }, "en")).toBe("1,234.56");
    expect(fmtPrice(123_456, { pricePrecision: 2 }, "de")).toBe("1,234.56");
  });

  it("精度 > 2 钳到 2(§9.1 第 6 条)", () => {
    expect(fmtPrice(123_456, { pricePrecision: 4 }, "en")).toBe("1,234.56");
  });

  it("null / undefined / 非有限显示「—」", () => {
    expect(fmtPrice(null, { pricePrecision: 2 }, "en")).toBe("—");
    expect(fmtPrice(undefined, { pricePrecision: 2 }, "zh-CN")).toBe("—");
    expect(fmtPrice(NaN, { pricePrecision: 2 }, "en")).toBe("—");
  });

  it("精度 2 时与 fmtMoney 同串(旧页面与终端并存期间数字一致)", () => {
    for (const cents of [0, 1, 99, 100, 1_050, 123_456, 100_000_000]) {
      expect(fmtPrice(cents, { pricePrecision: 2 }, "en")).toBe(fmtMoney(cents));
    }
  });
});

describe("旧签名不动", () => {
  it("fmtMoney 固定两位、fmtQty / fmtTonnes 千分位整数、空值「—」", () => {
    expect(fmtMoney(123_456)).toBe("1,234.56");
    expect(fmtMoney(null)).toBe("—");
    expect(fmtQty(1_500)).toBe("1,500");
    expect(fmtQty(undefined)).toBe("—");
    expect(fmtTonnes(1_499.6)).toBe("1,500");
    expect(fmtTonnes(null)).toBe("—");
  });
});
