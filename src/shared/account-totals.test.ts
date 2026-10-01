// computeAccountTotals 的纯函数测试(计划 §6.2.2 C6、§6.2.3 P2-05):情景标的无价格、成本不完整、整仓注销行、空持仓、价格为 0、
// 以及「价格跟着行情走」时未实现盈亏按同一份成本重算。
import { describe, expect, it } from "vitest";
import { computeAccountTotals, unrealisedPnlAt } from "./account-totals";
import type { Balance, Position } from "./types";

const balance: Balance = { cashBalance: 1_000_000, lockedCash: 25_000 };

/** 一行持仓;默认是成本完整、有价格的普通标的(均价 1000,现价 1200,10 吨) */
function position(over: Partial<Position> = {}): Position {
  const base: Position = {
    assetId: "asset-a", symbol: "VCS-FOR-2021", quantity: 10, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 10, retired: 0,
    lastPrice: 1_200, marketValue: 12_000, averagePurchasePrice: 1_000, unrealisedPnl: 2_000, costBasisStatus: "complete", isScenario: false,
  };
  return { ...base, ...over };
}

const lastPrice = (p: Position) => p.lastPrice;

describe("computeAccountTotals", () => {
  it("空持仓:合计只有现金,未实现盈亏是 0 而不是 null", () => {
    expect(computeAccountTotals(balance, [], lastPrice)).toEqual({
      holdingsValue: 0, totalAssets: 1_025_000, heldCredits: 0, retiredCredits: 0, unrealisedPnl: 0, valuationComplete: true, costBasisComplete: true,
    });
  });

  it("按 priceOf 给的价格估值:totalAssets = 可用现金 + 冻结现金 + 持仓市值", () => {
    const positions = [position(), position({ assetId: "asset-b", symbol: "GS-WIND-2022", quantity: 4, available: 4, lastPrice: 500, marketValue: 2_000, averagePurchasePrice: 700, unrealisedPnl: -800 })];
    expect(computeAccountTotals(balance, positions, lastPrice)).toEqual({
      holdingsValue: 14_000, totalAssets: 1_039_000, heldCredits: 14, retiredCredits: 0, unrealisedPnl: 1_200, valuationComplete: true, costBasisComplete: true,
    });
  });

  it("情景标的没有价格:不计入市值,valuationComplete 为 false,未实现盈亏为 null;数量也不算进 heldCredits", () => {
    const scenario = position({ assetId: "asset-s", symbol: "SCN-2030", quantity: 7, available: 7, lastPrice: null, marketValue: 0, averagePurchasePrice: 300, unrealisedPnl: null, isScenario: true });
    const totals = computeAccountTotals(balance, [position(), scenario], lastPrice);
    expect(totals).toEqual({
      holdingsValue: 12_000, totalAssets: 1_037_000, heldCredits: 10, retiredCredits: 0, unrealisedPnl: null, valuationComplete: false, costBasisComplete: true,
    });
  });

  it("情景标的有价格时照常估值,只是不算信用吨数", () => {
    const scenario = position({ assetId: "asset-s", symbol: "SCN-2030", quantity: 7, available: 7, lastPrice: 100, marketValue: 700, averagePurchasePrice: 100, unrealisedPnl: 0, isScenario: true });
    const totals = computeAccountTotals(balance, [position(), scenario], lastPrice);
    expect(totals.holdingsValue).toBe(12_700);
    expect(totals.heldCredits).toBe(10);
    expect(totals.unrealisedPnl).toBe(2_000);
  });

  it.each(["unknown_acquisition_cost", "incomplete_ledger"] as const)("成本不完整(%s):市值照算,costBasisComplete 为 false,未实现盈亏为 null", (costBasisStatus) => {
    const unknown = position({ assetId: "asset-b", symbol: "GS-WIND-2022", quantity: 5, available: 5, lastPrice: 400, marketValue: 2_000, averagePurchasePrice: null, unrealisedPnl: null, costBasisStatus });
    expect(computeAccountTotals(balance, [position(), unknown], lastPrice)).toEqual({
      holdingsValue: 14_000, totalAssets: 1_039_000, heldCredits: 15, retiredCredits: 0, unrealisedPnl: null, valuationComplete: true, costBasisComplete: false,
    });
  });

  it("整仓注销的行(数量 0、retired > 0):只进 retiredCredits,不影响估值与成本是否完整", () => {
    const retiredOnly = position({ assetId: "asset-r", symbol: "VCS-COOK-2020", quantity: 0, available: 0, retired: 30, lastPrice: null, marketValue: 0, averagePurchasePrice: null, unrealisedPnl: null, costBasisStatus: "incomplete_ledger" });
    expect(computeAccountTotals(balance, [position({ retired: 2 }), retiredOnly], lastPrice)).toEqual({
      holdingsValue: 12_000, totalAssets: 1_037_000, heldCredits: 10, retiredCredits: 32, unrealisedPnl: 2_000, valuationComplete: true, costBasisComplete: true,
    });
  });

  it("价格为 0 是一个价格,不是没有价格:市值 0、估值完整、浮亏等于成本", () => {
    const totals = computeAccountTotals(balance, [position()], () => 0);
    expect(totals).toEqual({
      holdingsValue: 0, totalAssets: 1_025_000, heldCredits: 10, retiredCredits: 0, unrealisedPnl: -10_000, valuationComplete: true, costBasisComplete: true,
    });
  });

  it("priceOf 给出新的价格时,市值与未实现盈亏跟着走(客户端按行情重算)", () => {
    const totals = computeAccountTotals(balance, [position()], () => 1_350);
    expect(totals.holdingsValue).toBe(13_500);
    expect(totals.totalAssets).toBe(1_038_500);
    expect(totals.unrealisedPnl).toBe(3_500);
  });

  it("持仓行上没有价格、priceOf 从行情拿到了:估值完整,成本退回 均价 × 数量", () => {
    const stale = position({ lastPrice: null, marketValue: 0, unrealisedPnl: null });
    const totals = computeAccountTotals(balance, [stale], () => 1_100);
    expect(totals).toMatchObject({ holdingsValue: 11_000, unrealisedPnl: 1_000, valuationComplete: true });
  });

  it("价格不是有限数(NaN)按没有价格处理", () => {
    const totals = computeAccountTotals(balance, [position()], () => Number.NaN);
    expect(totals).toMatchObject({ holdingsValue: 0, unrealisedPnl: null, valuationComplete: false });
  });

  it("不改入参", () => {
    const positions = [position()];
    const before = JSON.stringify({ balance, positions });
    computeAccountTotals(balance, positions, () => 900);
    expect(JSON.stringify({ balance, positions })).toBe(before);
  });
});

describe("unrealisedPnlAt", () => {
  it("用服务端算好的成本(市值 − 未实现盈亏),不受均价四舍五入影响", () => {
    // 3 吨、成本 1000 分 → 均价 333(四舍五入);现价 400 → 市值 1200、浮盈 200。均价 × 数量会得到 999 的成本、201 的浮盈
    const p = position({ quantity: 3, available: 3, lastPrice: 400, marketValue: 1_200, averagePurchasePrice: 333, unrealisedPnl: 200 });
    expect(unrealisedPnlAt(p, 400)).toBe(200);
    expect(unrealisedPnlAt(p, 500)).toBe(500);
  });

  it("成本不完整、或既没有服务端浮盈也没有均价时为 null", () => {
    expect(unrealisedPnlAt(position({ costBasisStatus: "unknown_acquisition_cost", averagePurchasePrice: null, unrealisedPnl: null }), 1_200)).toBeNull();
    expect(unrealisedPnlAt(position({ lastPrice: null, averagePurchasePrice: null, unrealisedPnl: null }), 1_200)).toBeNull();
  });
});
