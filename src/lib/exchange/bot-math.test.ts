import { describe, expect, it } from "vitest";
import { buildQuoteLevels, nextFair, shouldTake, takeQty } from "./bot-math";

const mid = () => 0.5; // 恒定中值随机源

describe("nextFair", () => {
  it("rng=0.5 且 last=anchor 时价格不变(噪声为0、无回归力)", () => {
    expect(nextFair(10000, 10000, mid)).toBe(10000);
  });
  it("last 高于 anchor 时向下回归", () => {
    expect(nextFair(11000, 10000, mid)).toBeLessThan(11000);
  });
  it("last 低于 anchor 时向上回归", () => {
    expect(nextFair(9000, 10000, mid)).toBeGreaterThan(9000);
  });
  it("永远为正且为整数分", () => {
    const v = nextFair(2, 1, () => 0); // 最大向下噪声
    expect(v).toBeGreaterThan(0);
    expect(Number.isInteger(v)).toBe(true);
  });
  it("触发最低价下限 1 分", () => {
    expect(nextFair(1, 1, () => 0)).toBe(1);
  });
});

describe("buildQuoteLevels", () => {
  it("买档全部低于 fair, 卖档全部高于 fair, 各5档", () => {
    const { bids, asks } = buildQuoteLevels(10000, mid);
    expect(bids).toHaveLength(5);
    expect(asks).toHaveLength(5);
    for (const b of bids) expect(b.price).toBeLessThan(10000);
    for (const a of asks) expect(a.price).toBeGreaterThan(10000);
  });
  it("数量在 10~200 吨之间, 价格为整数分", () => {
    const { bids, asks } = buildQuoteLevels(5730, mid);
    for (const l of [...bids, ...asks]) {
      expect(l.quantity).toBeGreaterThanOrEqual(10);
      expect(l.quantity).toBeLessThanOrEqual(200);
      expect(Number.isInteger(l.price)).toBe(true);
    }
  });
});

describe("shouldTake / takeQty", () => {
  it("rng<0.3 时吃单", () => {
    expect(shouldTake(() => 0.1)).toBe(true);
    expect(shouldTake(() => 0.5)).toBe(false);
  });
  it("吃单量在 10~80 吨", () => {
    expect(takeQty(() => 0)).toBe(10);
    expect(takeQty(() => 0.9999)).toBe(80);
  });
});
