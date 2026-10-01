import { describe, expect, it } from "vitest";
import type { Instrument, Position } from "@/shared";
import { computeAccountTotals, unrealisedPnlAt } from "@/shared/account-totals";
import { groupPositions, lastPriceOf, lockSourcesOf, positionMetaOf, positionValue } from "./position-groups";

function instrument(symbol: string, patch: Partial<Instrument> = {}): Instrument {
  return {
    id: `asset-${symbol}`,
    symbol,
    name: `${symbol} project`,
    standard: "VCS",
    projectType: "forestry",
    vintage: 2021,
    country: "CN",
    registry: "Verra",
    isScenario: false,
    projectId: null,
    methodology: null,
    verificationStatus: null,
    tickSize: 1,
    pricePrecision: 2,
    qtyStep: 1,
    minQty: 1,
    currency: "USD",
    lastPrice: 6800,
    ...patch,
  };
}

function position(symbol: string, patch: Partial<Position> = {}): Position {
  return {
    assetId: `asset-${symbol}`,
    symbol,
    quantity: 100,
    locked: 0,
    lockedBy: { orders: 0, otc: 0 },
    available: 100,
    retired: 0,
    lastPrice: 7000,
    marketValue: 700_000,
    averagePurchasePrice: 6800,
    unrealisedPnl: 20_000,
    costBasisStatus: "complete",
    isScenario: false,
    ...patch,
  };
}

const INSTRUMENTS: Record<string, Instrument> = {
  "VCS-FOR-2021": instrument("VCS-FOR-2021", { projectId: "SIM-PRJ-VCS-FOR", vintage: 2021 }),
  "VCS-FOR-2023": instrument("VCS-FOR-2023", { projectId: "SIM-PRJ-VCS-FOR", vintage: 2023 }),
  "VCS-FOR-2019": instrument("VCS-FOR-2019", { projectId: "SIM-PRJ-VCS-FOR", vintage: 2019 }),
  "GS-WIND-2022": instrument("GS-WIND-2022", { projectId: "SIM-PRJ-GS-WIND", vintage: 2022, standard: "GS", projectType: "wind", country: "IN" }),
  "ACR-SOLO-2020": instrument("ACR-SOLO-2020", { projectId: null, vintage: 2020, standard: "ACR" }),
  "CEA-SCEN-2026": instrument("CEA-SCEN-2026", { projectId: "SIM-PRJ-VCS-FOR", vintage: 2026, isScenario: true }),
};

describe("positionMetaOf", () => {
  it("keeps the static fields only (no price)", () => {
    const meta = positionMetaOf(INSTRUMENTS);
    expect(meta["GS-WIND-2022"]).toEqual({ name: "GS-WIND-2022 project", projectId: "SIM-PRJ-GS-WIND", projectType: "wind", standard: "GS", country: "IN", registry: "Verra", vintage: 2022, pricePrecision: 2 });
    expect(Object.keys(meta)).toHaveLength(6);
  });

  it("returns the same object while the content is unchanged (polling replaces instruments every 2 s; pushes only move lastPrice)", () => {
    const first = positionMetaOf(INSTRUMENTS);
    expect(positionMetaOf(INSTRUMENTS)).toBe(first);
    const replaced = Object.fromEntries(Object.entries(INSTRUMENTS).map(([symbol, ins]) => [symbol, { ...ins, lastPrice: 9999 }]));
    expect(positionMetaOf(replaced)).toBe(first);
  });

  it("returns a new object when a field, or the set of instruments, changes", () => {
    const first = positionMetaOf(INSTRUMENTS);
    const renamed: Record<string, Instrument> = { ...INSTRUMENTS, "GS-WIND-2022": { ...INSTRUMENTS["GS-WIND-2022"], country: "VN" } };
    const second = positionMetaOf(renamed);
    expect(second).not.toBe(first);
    expect(second["GS-WIND-2022"].country).toBe("VN");
    const fewer = Object.fromEntries(Object.entries(renamed).filter(([symbol]) => symbol !== "ACR-SOLO-2020"));
    expect(positionMetaOf(fewer)).not.toBe(second);
    expect(Object.keys(positionMetaOf(fewer))).toHaveLength(5);
  });

  it("serves the empty store (the initial state that server rendering and hydration read) without dropping the cached value", () => {
    const first = positionMetaOf(INSTRUMENTS);
    const empty = positionMetaOf({});
    expect(empty).toEqual({});
    expect(positionMetaOf({})).toBe(empty);
    expect(positionMetaOf(INSTRUMENTS)).toBe(first);
  });
});

describe("groupPositions", () => {
  const meta = positionMetaOf(INSTRUMENTS);

  it("groups by project, one row per vintage in ascending order, groups ordered by their smallest symbol", () => {
    const { groups, retired, retiredTonnes } = groupPositions(
      [position("VCS-FOR-2023"), position("GS-WIND-2022"), position("VCS-FOR-2019"), position("ACR-SOLO-2020"), position("VCS-FOR-2021")],
      meta,
    );
    expect(groups.map((g) => [g.key, g.positions.map((p) => p.symbol)])).toEqual([
      ["symbol:ACR-SOLO-2020", ["ACR-SOLO-2020"]],
      ["project:SIM-PRJ-GS-WIND", ["GS-WIND-2022"]],
      ["project:SIM-PRJ-VCS-FOR", ["VCS-FOR-2019", "VCS-FOR-2021", "VCS-FOR-2023"]],
    ]);
    expect(retired).toEqual([]);
    expect(retiredTonnes).toBe(0);
  });

  it("carries the project id, type, standard and country on the group header", () => {
    const { groups } = groupPositions([position("GS-WIND-2022"), position("ACR-SOLO-2020")], meta);
    expect(groups[1]).toMatchObject({ projectId: "SIM-PRJ-GS-WIND", symbol: "GS-WIND-2022", projectType: "wind", standard: "GS", country: "IN", isScenario: false });
    // 没有项目编号:按标的名单独成组
    expect(groups[0]).toMatchObject({ projectId: null, symbol: "ACR-SOLO-2020", projectType: "forestry", standard: "ACR", country: "CN" });
  });

  it("never merges a scenario instrument into a project, and gives an instrument without metadata its own bare group", () => {
    const { groups } = groupPositions([position("VCS-FOR-2021"), position("CEA-SCEN-2026", { isScenario: true }), position("ZZZ-GONE-2018")], meta);
    expect(groups.map((g) => g.key)).toEqual(["symbol:CEA-SCEN-2026", "project:SIM-PRJ-VCS-FOR", "symbol:ZZZ-GONE-2018"]);
    expect(groups[0]).toMatchObject({ projectId: null, isScenario: true });
    expect(groups[2]).toMatchObject({ projectId: null, symbol: "ZZZ-GONE-2018", projectType: null, standard: null, country: null });
  });

  it("puts fully retired rows (quantity 0, retired > 0) in the retired list with their total, and drops empty rows", () => {
    const { groups, retired, retiredTonnes } = groupPositions(
      [
        position("VCS-FOR-2023", { quantity: 0, available: 0, retired: 40 }),
        position("VCS-FOR-2021", { retired: 5 }), // 还有数量:留在项目组里,它的已注销不进合计
        position("GS-WIND-2022", { quantity: 0, available: 0, retired: 60 }),
        position("ACR-SOLO-2020", { quantity: 0, available: 0, retired: 0 }), // 卖光且没注销过:不是持仓
      ],
      meta,
    );
    expect(groups.map((g) => g.positions.map((p) => p.symbol))).toEqual([["VCS-FOR-2021"]]);
    expect(retired.map((p) => p.symbol)).toEqual(["GS-WIND-2022", "VCS-FOR-2023"]);
    expect(retiredTonnes).toBe(100);
  });

  it("sorts an unknown vintage last within its group", () => {
    const partial = positionMetaOf({ "VCS-FOR-2021": INSTRUMENTS["VCS-FOR-2021"], "VCS-FOR-2023": INSTRUMENTS["VCS-FOR-2023"] });
    const { groups } = groupPositions([position("VCS-FOR-2023"), position("VCS-FOR-2021")], partial);
    expect(groups[0].positions.map((p) => p.symbol)).toEqual(["VCS-FOR-2021", "VCS-FOR-2023"]);
  });
});

describe("lockSourcesOf", () => {
  it("returns the sources the server sent, and null when the payload has none (a Phase 1 server after a rollback)", () => {
    const sources = { orders: 12, otc: 8 };
    expect(lockSourcesOf({ lockedBy: sources })).toBe(sources);
    expect(lockSourcesOf({ lockedBy: { orders: 0, otc: 0 } })).toEqual({ orders: 0, otc: 0 });
    expect(lockSourcesOf({})).toBeNull();
    expect(lockSourcesOf({ lockedBy: undefined })).toBeNull();
    expect(lockSourcesOf({ lockedBy: null })).toBeNull();
    // 形状不对的也不拆来源(界面只显示锁定总数)
    expect(lockSourcesOf({ lockedBy: { orders: 12 } as unknown as Position["lockedBy"] })).toBeNull();
    expect(lockSourcesOf({ lockedBy: { orders: Number.NaN, otc: 1 } })).toBeNull();
  });
});

describe("lastPriceOf", () => {
  it("prefers the pushed ticker, then the instrument list, then null", () => {
    const state = { tickers: { A: { lastPrice: 7100 }, B: { lastPrice: null } }, instruments: { A: { lastPrice: 7000 }, B: { lastPrice: 6900 }, C: { lastPrice: null } } };
    expect(lastPriceOf(state, "A")).toBe(7100);
    expect(lastPriceOf(state, "B")).toBe(6900);
    expect(lastPriceOf(state, "C")).toBeNull();
    expect(lastPriceOf(state, "D")).toBeNull();
  });
});

describe("positionValue", () => {
  it("values the position at the live price, not the value frozen in the event", () => {
    // 事件那一刻:7000 × 100 = 700,000,盈亏 +20,000(成本 680,000);行情现在 7150
    expect(positionValue(position("VCS-FOR-2021"), 7150)).toEqual({ lastPrice: 7150, marketValue: 715_000, averagePurchasePrice: 6800, unrealisedPnl: 35_000 });
    expect(positionValue(position("VCS-FOR-2021"), 6500)).toMatchObject({ marketValue: 650_000, unrealisedPnl: -30_000 });
  });

  it("matches the server's figure to the cent when the average cost was rounded", () => {
    // 成本 1,000 分买 3 吨:均价取整 333;服务端在 400 时算 3 × 400 − 1000 = +200
    const odd = position("VCS-FOR-2021", { quantity: 3, available: 3, lastPrice: 400, marketValue: 1200, averagePurchasePrice: 333, unrealisedPnl: 200 });
    expect(positionValue(odd, 400).unrealisedPnl).toBe(200);
    expect(positionValue(odd, 450).unrealisedPnl).toBe(350); // 3 × 450 − 1000,不是 3 × (450 − 333) = 351
  });

  it("falls back to the position's own last price when the market store has none", () => {
    expect(positionValue(position("VCS-FOR-2021"), null)).toEqual({ lastPrice: 7000, marketValue: 700_000, averagePurchasePrice: 6800, unrealisedPnl: 20_000 });
    expect(positionValue(position("VCS-FOR-2021"), undefined).marketValue).toBe(700_000);
  });

  it("shows no value at all when the instrument has never traded (no zero in place of a missing price)", () => {
    const unpriced = position("VCS-FOR-2021", { lastPrice: null, marketValue: 0, unrealisedPnl: null });
    expect(positionValue(unpriced, null)).toEqual({ lastPrice: null, marketValue: null, averagePurchasePrice: 6800, unrealisedPnl: null });
    // 之后有了成交价:事件里没有可倒推的成本,用均价
    expect(positionValue(unpriced, 7000)).toMatchObject({ marketValue: 700_000, unrealisedPnl: 20_000 });
  });

  it("never shows an average cost or P&L when the cost basis is incomplete, whatever the server sent", () => {
    for (const costBasisStatus of ["unknown_acquisition_cost", "incomplete_ledger"] as const) {
      const value = positionValue(position("VCS-FOR-2021", { costBasisStatus, averagePurchasePrice: 6800, unrealisedPnl: 999 }), 7150);
      expect(value).toEqual({ lastPrice: 7150, marketValue: 715_000, averagePurchasePrice: null, unrealisedPnl: null });
    }
  });
});

// P2-10:逐行估值(positionValue,终端持仓页签与资产页的每一行)与账户合计(computeAccountTotals,资产页页头)是同一个实现,
// 同一份持仓、同一组价格上两边对得上 —— 界面上的合计与各行相加不会差几分。
describe("positionValue and computeAccountTotals agree (one implementation, P2-10)", () => {
  const balance = { cashBalance: 1_000_000, lockedCash: 25_000 };
  // 成本取整的一行(3 吨成本 1,000 分,均价记 333)、普通一行、整仓注销的一行(不持有,不估值)
  const rows: Position[] = [
    position("VCS-FOR-2021"),
    position("GS-WIND-2022", { quantity: 3, available: 3, lastPrice: 400, marketValue: 1200, averagePurchasePrice: 333, unrealisedPnl: 200 }),
    position("VCS-FOR-2019", { quantity: 0, available: 0, retired: 40, lastPrice: 6900, marketValue: 0, unrealisedPnl: 0 }),
  ];
  const held = rows.filter((row) => row.quantity > 0);
  const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);

  it("with priceOf = each row's own last price, the account P&L is the sum of the rows' unrealisedPnl (and of positionValue's)", () => {
    const totals = computeAccountTotals(balance, rows, (row) => row.lastPrice);
    expect(totals.unrealisedPnl).toBe(sum(held.map((row) => row.unrealisedPnl)));
    expect(totals.unrealisedPnl).toBe(sum(held.map((row) => positionValue(row, row.lastPrice).unrealisedPnl)));
    expect(totals.holdingsValue).toBe(sum(held.map((row) => row.marketValue)));
  });

  it("at live prices, the sums of the rows' market value and P&L equal holdingsValue and unrealisedPnl to the cent", () => {
    const live: Record<string, number> = { "VCS-FOR-2021": 7_150, "GS-WIND-2022": 451, "VCS-FOR-2019": 1 };
    const totals = computeAccountTotals(balance, rows, (row) => live[row.symbol] ?? row.lastPrice);
    const values = held.map((row) => positionValue(row, live[row.symbol]));
    expect(totals.holdingsValue).toBe(sum(values.map((value) => value.marketValue)));
    expect(totals.unrealisedPnl).toBe(sum(values.map((value) => value.unrealisedPnl)));
    expect(totals.totalAssets).toBe(balance.cashBalance + balance.lockedCash + totals.holdingsValue);
    // 逐行就是 unrealisedPnlAt:3 × 451 − 1000 = 353,不是 3 × (451 − 333) = 354
    expect(values[1].unrealisedPnl).toBe(unrealisedPnlAt(held[1], 451));
    expect(values[1].unrealisedPnl).toBe(353);
  });

  it("an incomplete cost basis makes the row's P&L and the account P&L unknown together", () => {
    const incomplete = [...rows, position("ACR-SOLO-2020", { costBasisStatus: "incomplete_ledger", averagePurchasePrice: null, unrealisedPnl: null })];
    expect(computeAccountTotals(balance, incomplete, (row) => row.lastPrice).unrealisedPnl).toBeNull();
    expect(positionValue(incomplete[3], 7000).unrealisedPnl).toBeNull();
  });
});
