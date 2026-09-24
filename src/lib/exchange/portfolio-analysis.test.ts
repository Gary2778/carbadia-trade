import { describe, expect, it } from "vitest";
import { reconstructPositionBasis, type CostBasisLedgerLine } from "./portfolio-analysis";

const at = (day: number) => new Date(`2026-08-${String(day).padStart(2, "0")}T00:00:00Z`);
const line = (
  id: string, day: number, account: string, delta: number | bigint,
  reason = "TRADE_SETTLE", refId: string | null = id, refType: string | null = "TRADE",
): CostBasisLedgerLine => ({ id, createdAt: at(day), account, delta, reason, refId, refType, assetId: account.startsWith("HOLDING") ? "credit" : null });

describe("remaining position cost basis", () => {
  it("reconstructs a purchase from retained ledger rows without a Trade record", () => {
    const basis = reconstructPositionBasis("credit", 10, 1_200, [
      line("purchase-cash", 1, "CASH", -10_000, "TRADE_SETTLE", "purchase"),
      line("purchase-credit", 1, "HOLDING", 10, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis).toEqual({ costBasis: 10_000, averagePurchasePrice: 1_000, unrealisedPnl: 2_000, costBasisComplete: true, costBasisStatus: "complete" });
  });

  it("keeps weighted-average remaining cost through a sale and a later purchase", () => {
    const basis = reconstructPositionBasis("credit", 10, 2_000, [
      line("cash-1", 1, "CASH", -10_000, "TRADE_SETTLE", "buy-1"),
      line("holding-1", 1, "HOLDING", 10, "TRADE_SETTLE", "buy-1"),
      line("cash-2", 2, "CASH", -30_000, "TRADE_SETTLE", "buy-2"),
      line("holding-2", 2, "HOLDING", 10, "TRADE_SETTLE", "buy-2"),
      line("sale", 3, "HOLDING", -15),
      line("sale-cash", 3, "CASH", 45_000, "TRADE_SETTLE", "sale"),
      line("cash-3", 4, "CASH", -5_000, "TRADE_SETTLE", "buy-3"),
      line("holding-3", 4, "HOLDING", 5, "TRADE_SETTLE", "buy-3"),
    ]);
    expect(basis.costBasis).toBe(15_000);
    expect(basis.averagePurchasePrice).toBe(1_500);
    expect(basis.unrealisedPnl).toBe(5_000);
  });

  it("deducts price-improvement refunds from cash locked for a limit fill", () => {
    const basis = reconstructPositionBasis("credit", 10, 1_100, [
      line("order-lock", 1, "CASH", -15_000, "ORDER_LOCK", "order", "ORDER"),
      line("fill-cash", 2, "CASH_LOCKED", -12_000, "TRADE_SETTLE", "fill"),
      line("fill-refund", 2, "CASH", 2_000, "PRICE_IMPROVE_REFUND", "fill"),
      line("fill-credit", 2, "HOLDING", 10, "TRADE_SETTLE", "fill"),
    ]);
    expect(basis.costBasis).toBe(10_000);
    expect(basis.unrealisedPnl).toBe(1_000);
  });

  it("includes OTC purchases and reduces their basis proportionally when retired", () => {
    const basis = reconstructPositionBasis("credit", 7, 1_300, [
      line("otc-cash", 1, "CASH", -12_000, "OTC_SETTLE", "deal", "DEAL"),
      line("otc-credit", 1, "HOLDING", 10, "OTC_SETTLE", "deal", "DEAL"),
      line("retirement", 2, "HOLDING", -3, "SIMULATED_RETIREMENT", "retirement", "RETIREMENT"),
    ]);
    expect(basis.costBasis).toBe(8_400);
    expect(basis.unrealisedPnl).toBe(700);
  });

  it.each(["SEED", "GRANT", "MIGRATION_BASELINE"])("does not assign a zero purchase cost to %s credits", (reason) => {
    const basis = reconstructPositionBasis("credit", 20, 1_200, [
      line("grant", 1, "HOLDING", 10, reason, null, null),
      line("purchase-cash", 2, "CASH", -10_000, "TRADE_SETTLE", "purchase"),
      line("purchase-credit", 2, "HOLDING", 10, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis.costBasisComplete).toBe(false);
    expect(basis.costBasisStatus).toBe("unknown_acquisition_cost");
    expect(basis.averagePurchasePrice).toBeNull();
    expect(basis.unrealisedPnl).toBeNull();
  });

  it("can establish a new basis after an unknown-cost holding is fully disposed", () => {
    const basis = reconstructPositionBasis("credit", 10, 1_200, [
      line("grant", 1, "HOLDING", 10, "SEED", null, null),
      line("sale", 2, "HOLDING", -10),
      line("purchase-cash", 3, "CASH", -10_000, "TRADE_SETTLE", "purchase"),
      line("purchase-credit", 3, "HOLDING", 10, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis.costBasisComplete).toBe(true);
    expect(basis.costBasis).toBe(10_000);
  });

  it("returns unknown when a purchase has no retained payment evidence", () => {
    const basis = reconstructPositionBasis("credit", 10, 1_200, [line("purchase", 1, "HOLDING", 10)]);
    expect(basis.costBasisStatus).toBe("unknown_acquisition_cost");
    expect(basis.costBasis).toBeNull();
  });

  it("rejects a ledger that cannot reconcile to the current holding", () => {
    const basis = reconstructPositionBasis("credit", 12, 1_200, [
      line("purchase-cash", 1, "CASH", -10_000, "TRADE_SETTLE", "purchase"),
      line("purchase-credit", 1, "HOLDING", 10, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis.costBasisStatus).toBe("incomplete_ledger");
    expect(basis.costBasisComplete).toBe(false);
    expect(basis.unrealisedPnl).toBeNull();
  });

  it("does not lose precision by converting unsafe ledger amounts to numbers", () => {
    const basis = reconstructPositionBasis("credit", 1, 1_200, [
      line("cash", 1, "CASH", BigInt("-9007199254740993"), "TRADE_SETTLE", "purchase"),
      line("credit", 1, "HOLDING", 1, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis.costBasis).toBeNull();
    expect(basis.costBasisComplete).toBe(false);
  });

  it("flags a missing opening acquisition even when net movement matches the current balance", () => {
    const basis = reconstructPositionBasis("credit", 5, 1_200, [
      line("sale-before-history", 1, "HOLDING", -5),
      line("cash", 2, "CASH", -10_000, "TRADE_SETTLE", "purchase"),
      line("credit", 2, "HOLDING", 10, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis.costBasisStatus).toBe("incomplete_ledger");
    expect(basis.costBasis).toBeNull();
  });

  it("keeps known acquisition cost but withholds P&L when the current price is absent", () => {
    const basis = reconstructPositionBasis("credit", 10, null, [
      line("cash", 1, "CASH", -10_000, "TRADE_SETTLE", "purchase"),
      line("credit", 1, "HOLDING", 10, "TRADE_SETTLE", "purchase"),
    ]);
    expect(basis.costBasisComplete).toBe(true);
    expect(basis.costBasis).toBe(10_000);
    expect(basis.unrealisedPnl).toBeNull();
  });
});
