import { describe, expect, it } from "vitest";
import { DEFAULT_FEE_SCHEDULE } from "./constants";
import { estimateFee } from "./fees";

describe("estimateFee", () => {
  it("0 费率恒 0,不论名义额与 minFee", () => {
    expect(estimateFee(1_000_000, 0, 0)).toBe(0);
    expect(estimateFee(1_000_000, 0, 50)).toBe(0);
    expect(estimateFee(Number.MAX_SAFE_INTEGER, 0, 0)).toBe(0);
  });

  it("默认费率表(演示)下任何名义额都是 0", () => {
    for (const notional of [1, 10_000, 500_000, 1_000_000_000]) {
      expect(estimateFee(notional, DEFAULT_FEE_SCHEDULE.takerBps, DEFAULT_FEE_SCHEDULE.minFeeCents)).toBe(0);
      expect(estimateFee(notional, DEFAULT_FEE_SCHEDULE.makerBps, DEFAULT_FEE_SCHEDULE.minFeeCents)).toBe(0);
    }
  });

  it("按万分之 bps 计费:10 bps × $1,000 = $1", () => {
    expect(estimateFee(100_000, 10, 0)).toBe(100);
    expect(estimateFee(100_000, 25, 0)).toBe(250);
  });

  it("不足一分向上取整(预估不低估)", () => {
    expect(estimateFee(999, 10, 0)).toBe(1); // 0.999 分
    expect(estimateFee(1, 1, 0)).toBe(1); // 0.0001 分
  });

  it("minFee 生效:计算值低于 minFee 时取 minFee", () => {
    expect(estimateFee(1_000, 10, 50)).toBe(50);
    expect(estimateFee(1_000_000, 10, 50)).toBe(1_000);
  });

  it("名义额为 0 或负数返回 0", () => {
    expect(estimateFee(0, 10, 50)).toBe(0);
    expect(estimateFee(-100, 10, 50)).toBe(0);
  });

  it("非有限输入返回 0", () => {
    expect(estimateFee(NaN, 10, 0)).toBe(0);
    expect(estimateFee(1_000, Infinity, 0)).toBe(0);
    expect(estimateFee(1_000, 10, NaN)).toBe(1);
  });

  it("负 minFee 视为 0", () => {
    expect(estimateFee(1_000, 10, -5)).toBe(1);
  });
});
