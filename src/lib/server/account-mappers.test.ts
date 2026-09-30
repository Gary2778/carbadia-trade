// Prisma 行 → 共享 Order / Fill / Position 的映射(计划 §3.5、§9.1 第 1/24/25/41 条):cancelReason 派生(含自成交防护撤单)、updatedAt 回退、role 由 takerSideOf 决定、
// 持仓三态与成本状态、账本视图、按成交重算均价。
import { describe, expect, it } from "vitest";
import type { OrderRow, TradeRow } from "../exchange/matching";
import type { CostBasisLedgerLine } from "../exchange/portfolio-analysis";
import { avgFillPricesByOrder, ledgerIdsByTrade, selfTradeCancelledIds, toFill, toLedgerLineView, toOrder, toPosition, type HoldingRow } from "./account-mappers";

const T0 = new Date("2026-09-26T00:00:00.000Z");
const T1 = new Date("2026-09-26T00:00:05.000Z");

function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "ord_1", userId: "u_alice", assetId: "a_1", side: "BUY", type: "LIMIT", price: 10_000, quantity: 5, filledQuantity: 0,
    status: "OPEN", avgFillPrice: null, createdAt: T0, clientOrderId: null, updatedAt: null, asset: { symbol: "VCS-FOR-2021" }, ...over,
  };
}

function tradeRow(over: Partial<TradeRow> = {}): TradeRow {
  return {
    id: "trd_1", assetId: "a_1", buyOrderId: "ord_buy", sellOrderId: "ord_sell", buyerId: "u_alice", sellerId: "u_bob",
    price: 9_800, quantity: 3, createdAt: T1, asset: { symbol: "VCS-FOR-2021" },
    buyOrder: { id: "ord_buy", type: "LIMIT", price: 10_000, createdAt: T1 },
    sellOrder: { id: "ord_sell", type: "LIMIT", price: 9_800, createdAt: T0 },
    ...over,
  };
}

describe("toOrder", () => {
  it("symbol 来自 asset, 时间转 unix ms, 旧行 updatedAt NULL 回退到 createdAt, 不外露 userId", () => {
    const order = toOrder(orderRow({ clientOrderId: "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab" }));
    expect(order).toEqual({
      id: "ord_1", clientOrderId: "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab", assetId: "a_1", symbol: "VCS-FOR-2021", side: "BUY", type: "LIMIT",
      price: 10_000, quantity: 5, filledQuantity: 0, status: "OPEN", avgFillPrice: null, cancelReason: null,
      createdAt: T0.getTime(), updatedAt: T0.getTime(),
    });
    expect("userId" in order).toBe(false);
    expect(toOrder(orderRow({ updatedAt: T1 })).updatedAt).toBe(T1.getTime());
  });

  it("cancelReason: MARKET 余量撤销 → MARKET_REMAINDER, LIMIT 撤单 → USER, 未撤销 → null", () => {
    expect(toOrder(orderRow({ type: "MARKET", price: null, status: "CANCELLED", filledQuantity: 2 })).cancelReason).toBe("MARKET_REMAINDER");
    expect(toOrder(orderRow({ type: "LIMIT", status: "CANCELLED", filledQuantity: 2 })).cancelReason).toBe("USER");
    expect(toOrder(orderRow({ status: "PARTIAL", filledQuantity: 2 })).cancelReason).toBeNull();
    expect(toOrder(orderRow({ status: "FILLED", filledQuantity: 5 })).cancelReason).toBeNull();
  });

  it("cancelReason: selfTraded 里的 LIMIT 撤单 → SELF_TRADE;不在里面的、未撤销的、市价单不受影响", () => {
    const stp = new Set(["ord_stp"]);
    expect(toOrder(orderRow({ id: "ord_stp", status: "CANCELLED" }), undefined, stp).cancelReason).toBe("SELF_TRADE");
    expect(toOrder(orderRow({ id: "ord_stp", status: "CANCELLED", filledQuantity: 2 }), 9_900, stp)).toMatchObject({ cancelReason: "SELF_TRADE", avgFillPrice: 9_900 });
    expect(toOrder(orderRow({ id: "ord_user", status: "CANCELLED" }), undefined, stp).cancelReason).toBe("USER");
    expect(toOrder(orderRow({ id: "ord_stp", status: "OPEN" }), undefined, stp).cancelReason).toBeNull();
    expect(toOrder(orderRow({ id: "ord_stp", type: "MARKET", price: null, status: "CANCELLED", filledQuantity: 2 }), undefined, stp).cancelReason).toBe("MARKET_REMAINDER");
  });

  it("avg 第二参覆盖行上的 avgFillPrice(含显式 null), 不传则沿用", () => {
    const row = orderRow({ avgFillPrice: 9_900, filledQuantity: 5, status: "FILLED" });
    expect(toOrder(row).avgFillPrice).toBe(9_900);
    expect(toOrder(row, 9_850).avgFillPrice).toBe(9_850);
    expect(toOrder(row, null).avgFillPrice).toBeNull();
  });
});

describe("toFill", () => {
  it("买方视角: 限价买 taker(价 ≠ 成交价)→ side BUY, role TAKER, orderId 取 buyOrderId; ledgerRefs 不传即 []", () => {
    const fill = toFill(tradeRow(), "u_alice");
    expect(fill).toEqual({
      id: "trd_1", orderId: "ord_buy", symbol: "VCS-FOR-2021", side: "BUY", role: "TAKER", price: 9_800, quantity: 3, notional: 29_400,
      feeCents: 0, ts: T1.getTime(), auditRef: "SIM-TRD-trd_1", ledgerRefs: [],
    });
  });

  it("ledgerRefs = 传入的本人账本行 id(计划 §3.5), 拷贝一份而不是引用调用方的数组", () => {
    const ids = ["led_1", "led_2"];
    const fill = toFill(tradeRow(), "u_alice", ids);
    expect(fill.ledgerRefs).toEqual(["led_1", "led_2"]);
    expect(fill.ledgerRefs).not.toBe(ids);
  });

  it("卖方视角同一笔成交: side SELL, role MAKER, orderId 取 sellOrderId", () => {
    const fill = toFill(tradeRow(), "u_bob");
    expect(fill).toMatchObject({ orderId: "ord_sell", side: "SELL", role: "MAKER", notional: 29_400, feeCents: 0 });
  });

  it("MARKET 单一律是 taker, 与价格无关", () => {
    const t = tradeRow({ price: 9_800, buyOrder: { id: "ord_buy", type: "LIMIT", price: 9_800, createdAt: T0 }, sellOrder: { id: "ord_sell", type: "MARKET", price: null, createdAt: T1 } });
    expect(toFill(t, "u_bob").role).toBe("TAKER");
    expect(toFill(t, "u_alice").role).toBe("MAKER");
  });
});

describe("selfTradeCancelledIds", () => {
  it("只拿 CANCELLED 的 LIMIT 单去查 SELF_TRADE_UNLOCK / ORDER 流水,一批一次;没有候选时不查库", async () => {
    const calls: unknown[] = [];
    const db = {
      ledgerEntry: {
        findMany: async (args: unknown) => {
          calls.push(args);
          // 同一张单两行流水(CASH_LOCKED / CASH)、refId 为空的脏行都要能处理
          return [{ refId: "ord_stp" }, { refId: "ord_stp" }, { refId: null }];
        },
      },
    } as unknown as Parameters<typeof selfTradeCancelledIds>[0];

    const orders = [
      orderRow({ id: "ord_stp", status: "CANCELLED" }),
      orderRow({ id: "ord_user", status: "CANCELLED" }),
      orderRow({ id: "ord_open", status: "OPEN" }),
      orderRow({ id: "ord_mkt", type: "MARKET", price: null, status: "CANCELLED", filledQuantity: 1 }),
    ];
    expect([...(await selfTradeCancelledIds(db, orders))]).toEqual(["ord_stp"]);
    expect(calls).toEqual([{ where: { refType: "ORDER", refId: { in: ["ord_stp", "ord_user"] }, reason: "SELF_TRADE_UNLOCK" }, select: { refId: true } }]);

    expect((await selfTradeCancelledIds(db, [orderRow({ status: "FILLED" })])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("ledgerIdsByTrade", () => {
  it("按 tradeId 分组本人的 TRADE 账本行 id, 一批一次查询; tradeIds 为空时不查库", async () => {
    const calls: unknown[] = [];
    const db = {
      ledgerEntry: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [
            { id: "led_1", refId: "trd_1" },
            { id: "led_2", refId: "trd_1" },
            { id: "led_3", refId: "trd_2" },
            { id: "led_x", refId: null },
          ];
        },
      },
    } as unknown as Parameters<typeof ledgerIdsByTrade>[0];

    const byTrade = await ledgerIdsByTrade(db, "u_alice", ["trd_1", "trd_2", "trd_9"]);
    expect([...byTrade.entries()]).toEqual([["trd_1", ["led_1", "led_2"]], ["trd_2", ["led_3"]]]);
    expect(byTrade.get("trd_9")).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ where: { userId: "u_alice", refType: "TRADE", refId: { in: ["trd_1", "trd_2", "trd_9"] } } });

    expect((await ledgerIdsByTrade(db, "u_alice", [])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("toPosition", () => {
  const holding = (over: Partial<HoldingRow> = {}): HoldingRow => ({
    assetId: "a_1", quantity: 10, locked: 3, asset: { symbol: "VCS-FOR-2021", lastPrice: 10_000, isScenario: false }, ...over,
  });
  const line = (over: Partial<CostBasisLedgerLine>): CostBasisLedgerLine => ({
    id: "led_1", account: "HOLDING", assetId: "a_1", delta: 10, reason: "TRADE_SETTLE", refType: "TRADE", refId: "trd_1", createdAt: T0, ...over,
  });

  it("三态 + 市值 + 成本完整: available = quantity − locked, retired 来自参数, avg / pnl 由账本重建", () => {
    const rows = [
      line({ id: "led_cash", account: "CASH", assetId: null, delta: -95_000 }),
      line({ id: "led_hold", account: "HOLDING", delta: 10 }),
    ];
    expect(toPosition(holding(), 4, rows)).toEqual({
      assetId: "a_1", symbol: "VCS-FOR-2021", quantity: 10, locked: 3, available: 7, retired: 4, lastPrice: 10_000, marketValue: 100_000,
      averagePurchasePrice: 9_500, unrealisedPnl: 5_000, costBasisStatus: "complete", isScenario: false,
    });
  });

  it("成本不完整时 averagePurchasePrice / unrealisedPnl 为 null 而不是 0: 种子持仓 → unknown_acquisition_cost, 账本对不上 → incomplete_ledger", () => {
    const seeded = toPosition(holding(), 0, [line({ reason: "SEED", refType: null, refId: null })]);
    expect(seeded).toMatchObject({ costBasisStatus: "unknown_acquisition_cost", averagePurchasePrice: null, unrealisedPnl: null, marketValue: 100_000 });
    const missing = toPosition(holding(), 0, []);
    expect(missing).toMatchObject({ costBasisStatus: "incomplete_ledger", averagePurchasePrice: null, unrealisedPnl: null });
  });

  it("lastPrice 为 null → marketValue 0、lastPrice null; 情景标的带 isScenario true; locked 超过 quantity 时 available 不为负", () => {
    const p = toPosition(holding({ quantity: 2, locked: 5, asset: { symbol: "CEA-SCENARIO", lastPrice: null, isScenario: true } }), 0, []);
    expect(p).toMatchObject({ lastPrice: null, marketValue: 0, available: 0, isScenario: true });
    expect("userId" in p).toBe(false);
  });
});

describe("toLedgerLineView", () => {
  it("delta BigInt → number, createdAt → unix ms, 不带 userId / refId", () => {
    const view = toLedgerLineView({ id: "led_1", account: "CASH", delta: BigInt(-28_500), reason: "TRADE_SETTLE", createdAt: T1 });
    expect(view).toEqual({ id: "led_1", account: "CASH", delta: -28_500, reason: "TRADE_SETTLE", createdAt: T1.getTime() });
  });
});

describe("avgFillPricesByOrder", () => {
  it("只对 filledQuantity > 0 的订单查一次成交; 成交量对得上 → 四舍五入均价, 对不上 → null; 没有已成交订单不查库", async () => {
    const calls: unknown[] = [];
    const db = {
      trade: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [
            { buyOrderId: "ord_a", sellOrderId: "ord_x", quantity: 2, price: 9_000 },
            { buyOrderId: "ord_a", sellOrderId: "ord_y", quantity: 1, price: 9_301 },
            { buyOrderId: "ord_z", sellOrderId: "ord_b", quantity: 1, price: 5_000 },
          ];
        },
      },
    } as unknown as Parameters<typeof avgFillPricesByOrder>[0];

    const avg = await avgFillPricesByOrder(db, [
      { id: "ord_a", filledQuantity: 3 },
      { id: "ord_b", filledQuantity: 4 }, // 只查到 1 吨成交: 旧成交已清理 → 未知
      { id: "ord_c", filledQuantity: 0 },
    ]);
    expect(avg.get("ord_a")).toBe(9_100); // (18000 + 9301) / 3 = 9100.33 → 9100
    expect(avg.get("ord_b")).toBeNull();
    expect(avg.has("ord_c")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ where: { OR: [{ buyOrderId: { in: ["ord_a", "ord_b"] } }, { sellOrderId: { in: ["ord_a", "ord_b"] } }] } });

    expect((await avgFillPricesByOrder(db, [{ id: "ord_c", filledQuantity: 0 }])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
