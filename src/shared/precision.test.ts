import { describe, expect, it, vi } from "vitest";
import { clampPricePrecision, formatPrice, formatQty, qtyDecimals } from "./precision";

describe("formatPrice", () => {
  it("精度 2:整数分 → 两位小数带千分位(en-US / zh-CN)", () => {
    expect(formatPrice(123_456, 2, "en-US")).toBe("1,234.56");
    expect(formatPrice(123_456, 2, "zh-CN")).toBe("1,234.56");
    expect(formatPrice(1_050, 2, "en-US")).toBe("10.50");
  });

  it("精度 1:一位小数", () => {
    expect(formatPrice(123_450, 1, "en-US")).toBe("1,234.5");
    expect(formatPrice(123_450, 1, "zh-CN")).toBe("1,234.5");
  });

  it("精度 0:整元(按 Intl 四舍五入)", () => {
    expect(formatPrice(1_000, 0, "en-US")).toBe("10");
    expect(formatPrice(1_050, 0, "zh-CN")).toBe("11");
    expect(formatPrice(1_234_500, 0, "en-US")).toBe("12,345");
  });

  it("精度 > 2 钳到 2,负数或 NaN 精度回默认", () => {
    expect(formatPrice(123_456, 4, "en-US")).toBe("1,234.56");
    expect(formatPrice(123_456, -1, "en-US")).toBe("1,235");
    expect(formatPrice(123_456, NaN, "en-US")).toBe("1,234.56");
    expect(clampPricePrecision(3)).toBe(2);
    expect(clampPricePrecision(1.9)).toBe(1);
  });

  it("0 与负数正常显示;非有限显示「—」", () => {
    expect(formatPrice(0, 2, "en-US")).toBe("0.00");
    expect(formatPrice(-1_050, 2, "en-US")).toBe("-10.50");
    expect(formatPrice(NaN, 2, "en-US")).toBe("—");
    expect(formatPrice(Infinity, 2, "en-US")).toBe("—");
  });

  it("locale 影响分隔符;非法 locale 回退 en-US 而不是抛错", () => {
    expect(formatPrice(123_456, 2, "de-DE")).toBe("1.234,56");
    expect(formatPrice(123_456, 2, "not a locale!!")).toBe("1,234.56");
  });

  it("同 locale + 精度复用同一个 Intl.NumberFormat:1,000 次调用只构造一次", () => {
    // 用本文件其它用例没碰过的 locale,保证缓存里还没有这个键;spy 只计数,构造仍交给原生实现
    const Original = Intl.NumberFormat;
    const ctor = vi.spyOn(Intl, "NumberFormat").mockImplementation(function (locales, options) {
      return new Original(locales, options);
    });
    try {
      for (let i = 0; i < 1_000; i++) formatPrice(i, 1, "en-GB");
      for (let i = 0; i < 1_000; i++) formatQty(i, 1, "en-GB");
      const gb = ctor.mock.calls.filter(([locale]) => locale === "en-GB");
      // en-GB|1(价格一位小数)与 en-GB|0(整数吨)各构造一次
      expect(gb).toHaveLength(2);
      expect(gb.map(([, opts]) => opts?.maximumFractionDigits).sort()).toEqual([0, 1]);
      expect(formatPrice(123_456, 1, "en-GB")).toBe("1,234.6");
    } finally {
      ctor.mockRestore();
    }
  });
});

describe("formatQty", () => {
  it("整数步长:整数吨带千分位", () => {
    expect(formatQty(1_500, 1, "en-US")).toBe("1,500");
    expect(formatQty(1_500, 10, "zh-CN")).toBe("1,500");
    expect(formatQty(0, 1, "en-US")).toBe("0");
  });

  it("小数步长按步长位数(Phase 1 不出现,仅保证签名可扩展)", () => {
    expect(qtyDecimals(1)).toBe(0);
    expect(qtyDecimals(0.5)).toBe(1);
    expect(qtyDecimals(0.25)).toBe(2);
    expect(qtyDecimals(0)).toBe(0);
    expect(formatQty(3, 0.5, "en-US")).toBe("3.0");
  });

  it("非有限显示「—」", () => {
    expect(formatQty(NaN, 1, "en-US")).toBe("—");
  });
});
