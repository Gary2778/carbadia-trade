import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Balance, Instrument, Position, Ticker } from "@/shared";
import { computeAccountTotals } from "@/shared/account-totals";
import { registerAccountSource } from "./account-bridge";
import { accountSource, createInitialAccountState, useAccountStore } from "./account-store";
import { accountPhase, accountSignature, allocationOf, heldPrices, liveTotals, matchesHoldingQuery, overviewGuard, seedFromOverview } from "./account-view";
import { lastPriceOf, positionValue } from "./position-groups";

// 资产页 /trade/account 的纯函数(计划 §6.2.3 P2-10)。重点一条:「数字与终端 PositionsTab 一致」—— 同一份 store 数据喂给两边,
// 资产页的合计(liveTotals)等于终端持仓页签各行(positionValue(position, lastPriceOf(行情, symbol)))相加。

const me = { id: "u1", email: "u@x", name: "u", cashBalance: 1_000_000, lockedCash: 20_000 };
const balance: Balance = { cashBalance: 1_000_000, lockedCash: 20_000 };

function position(symbol: string, patch: Partial<Position> = {}): Position {
  return {
    assetId: `asset-${symbol}`,
    symbol,
    quantity: 10,
    locked: 0,
    lockedBy: { orders: 0, otc: 0 },
    available: 10,
    retired: 0,
    lastPrice: 1_000,
    marketValue: 10_000,
    averagePurchasePrice: 900,
    unrealisedPnl: 1_000,
    costBasisStatus: "complete",
    isScenario: false,
    ...patch,
  };
}

const ticker = (symbol: string, lastPrice: number | null): Ticker => ({ symbol, lastPrice, bestBid: null, bestAsk: null, change24h: 0, high24h: null, low24h: null, volume24h: 0, ts: 1 });
const instrumentPrice = (lastPrice: number | null) => ({ lastPrice }) as Instrument;

beforeEach(() => {
  registerAccountSource(accountSource);
  useAccountStore.setState(createInitialAccountState(), true);
});
afterEach(() => {
  useAccountStore.setState(createInitialAccountState(), true);
});

describe("accountPhase", () => {
  it("maps the session and the first overview load to the page state", () => {
    expect(accountPhase("idle", false, { loaded: false, failed: false })).toBe("loading");
    expect(accountPhase("loading", false, { loaded: false, failed: false })).toBe("loading");
    expect(accountPhase("anon", false, { loaded: false, failed: false })).toBe("anon");
    // /api/auth/me 瞬时失败落下的「未确认 anon」:出错可重试,不说成「你没登录」
    expect(accountPhase("anon", true, { loaded: false, failed: false })).toBe("unverified");
    expect(accountPhase("ready", false, { loaded: false, failed: false })).toBe("loading");
    expect(accountPhase("ready", false, { loaded: false, failed: true })).toBe("error");
    // 取到过之后,重取失败只提示,不撤掉数据
    expect(accountPhase("ready", false, { loaded: true, failed: true })).toBe("ready");
  });
});

describe("same store data, same numbers as the terminal's Positions tab", () => {
  const positions = [
    position("VCS-FOR-2021"),
    // 成本取整:3 吨成本 1,000 分(均价记 333),服务端在 400 时 +200
    position("GS-WIND-2022", { quantity: 3, available: 3, lastPrice: 400, marketValue: 1_200, averagePurchasePrice: 333, unrealisedPnl: 200 }),
    // 行情里没有这个标的:两边都退回行上的价格
    position("CCER-SOL-2022", { quantity: 5, available: 5, lastPrice: 2_000, marketValue: 10_000, averagePurchasePrice: 1_500, unrealisedPnl: 2_500 }),
    // 整仓注销的行:只进 retiredCredits
    position("VCS-FOR-2019", { quantity: 0, available: 0, retired: 7, marketValue: 0, unrealisedPnl: 0 }),
  ];
  const market = {
    tickers: { "VCS-FOR-2021": ticker("VCS-FOR-2021", 1_150) },
    instruments: { "VCS-FOR-2021": instrumentPrice(1_100), "GS-WIND-2022": instrumentPrice(451) },
  };

  it("liveTotals over heldPrices equals the sum of the tab's rows, to the cent", () => {
    const prices = heldPrices(market, positions);
    expect(prices).toEqual({ "VCS-FOR-2021": 1_150, "GS-WIND-2022": 451, "CCER-SOL-2022": null, "VCS-FOR-2019": null });
    const totals = liveTotals(balance, positions, prices);
    // 终端持仓页签的每一行:PositionRow 用 lastPriceOf(行情 store, symbol) 取价,再 positionValue
    const rows = positions.filter((p) => p.quantity > 0).map((p) => positionValue(p, lastPriceOf(market, p.symbol)));
    expect(totals.holdingsValue).toBe(rows.reduce((sum, row) => sum + (row.marketValue ?? 0), 0));
    expect(totals.unrealisedPnl).toBe(rows.reduce((sum, row) => sum + (row.unrealisedPnl ?? 0), 0));
    expect(totals).toEqual({
      holdingsValue: 11_500 + 1_353 + 10_000,
      totalAssets: 1_020_000 + 22_853,
      heldCredits: 18,
      retiredCredits: 7,
      unrealisedPnl: 2_500 + 353 + 2_500,
      valuationComplete: true,
      costBasisComplete: true,
    });
  });

  it("with no market data at all it is exactly the server's figure (computeAccountTotals on the rows' own prices)", () => {
    const empty = { tickers: {}, instruments: {} };
    expect(liveTotals(balance, positions, heldPrices(empty, positions))).toEqual(computeAccountTotals(balance, positions, (p) => p.lastPrice));
  });

  it("without a balance yet it counts cash as zero instead of failing", () => {
    expect(liveTotals(null, [], {}).totalAssets).toBe(0);
  });
});

describe("matchesHoldingQuery", () => {
  it("matches symbol, project and names case-insensitively; an empty query matches everything", () => {
    const fields = ["VCS-FOR-2021", "SIM-PRJ-VCS-FOR", "Amazon forest", "亚马逊森林"];
    expect(matchesHoldingQuery("", fields)).toBe(true);
    expect(matchesHoldingQuery("  ", fields)).toBe(true);
    expect(matchesHoldingQuery("vcs-for", fields)).toBe(true);
    expect(matchesHoldingQuery("prj-vcs", fields)).toBe(true);
    expect(matchesHoldingQuery("FOREST", fields)).toBe(true);
    expect(matchesHoldingQuery("森林", fields)).toBe(true);
    expect(matchesHoldingQuery("wind", fields)).toBe(false);
    expect(matchesHoldingQuery("x", [null, undefined])).toBe(false);
  });
});

describe("allocationOf", () => {
  const byType: Record<string, string> = { "VCS-FOR-2021": "Forestry", "VCS-FOR-2023": "Forestry", "GS-WIND-2022": "Wind", "CEA-SCEN-2026": "Scenario" };
  const group = (p: Position) => byType[p.symbol] ?? "Other";

  it("shares by market value, sorted by value; scenario instruments and fully retired rows are left out", () => {
    const allocation = allocationOf(
      [
        position("VCS-FOR-2021", { quantity: 10 }),
        position("VCS-FOR-2023", { quantity: 5 }),
        position("GS-WIND-2022", { quantity: 20 }),
        position("CEA-SCEN-2026", { quantity: 100, isScenario: true }),
        position("VCS-FOR-2019", { quantity: 0, retired: 4 }),
      ],
      group,
      (p) => ({ "VCS-FOR-2021": 1_000, "VCS-FOR-2023": 2_000, "GS-WIND-2022": 500, "CEA-SCEN-2026": 9_999 })[p.symbol] ?? null,
    );
    expect(allocation.total).toBe(10_000 + 10_000 + 10_000);
    expect(allocation.unpriced).toBe(0);
    expect(allocation.slices).toEqual([
      { label: "Forestry", value: 20_000, tonnes: 15, share: 2 / 3 },
      { label: "Wind", value: 10_000, tonnes: 20, share: 1 / 3 },
    ]);
    expect(allocation.slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });

  it("does not count an unpriced holding as zero: it is left out of the shares and counted separately", () => {
    const allocation = allocationOf([position("VCS-FOR-2021"), position("GS-WIND-2022")], group, (p) => (p.symbol === "GS-WIND-2022" ? null : 1_000));
    expect(allocation.slices).toEqual([{ label: "Forestry", value: 10_000, tonnes: 10, share: 1 }]);
    expect(allocation.unpriced).toBe(1);
  });

  it("is empty with nothing to allocate (no holdings, or only scenario instruments)", () => {
    expect(allocationOf([], group, () => 1)).toEqual({ slices: [], total: 0, unpriced: 0 });
    expect(allocationOf([position("CEA-SCEN-2026", { isScenario: true })], group, () => 1).slices).toEqual([]);
  });

  it("breaks ties by label so the order is stable", () => {
    const allocation = allocationOf([position("GS-WIND-2022"), position("VCS-FOR-2021")], group, () => 1_000);
    expect(allocation.slices.map((s) => s.label)).toEqual(["Forestry", "Wind"]);
  });
});

describe("accountSignature", () => {
  it("changes with the balance, a quantity, a lock, an OTC lock or a retirement; not with prices or a re-sent identical snapshot", () => {
    const base = new Map([["a", position("VCS-FOR-2021", { assetId: "a" })]]);
    const sig = accountSignature(balance, base);
    // 轮询每 5 s 重灌一次同样的快照:引用换了、内容没变
    expect(accountSignature({ ...balance }, new Map([["a", { ...base.get("a")! }]]))).toBe(sig);
    expect(accountSignature(balance, new Map([["a", position("VCS-FOR-2021", { assetId: "a", lastPrice: 9_999, marketValue: 99_990 })]]))).toBe(sig);
    for (const patch of [{ quantity: 9 }, { locked: 2 }, { lockedBy: { orders: 0, otc: 2 } }, { retired: 1 }] as Partial<Position>[]) {
      expect(accountSignature(balance, new Map([["a", position("VCS-FOR-2021", { assetId: "a", ...patch })]])), JSON.stringify(patch)).not.toBe(sig);
    }
    expect(accountSignature({ ...balance, cashBalance: 1 }, base)).not.toBe(sig);
    expect(accountSignature(null, base)).not.toBe(sig);
  });
});

describe("seedFromOverview (first load puts the overview's positions and balance into the account store)", () => {
  const ready = (patch: Partial<ReturnType<typeof createInitialAccountState>> = {}) =>
    useAccountStore.setState({ ...createInitialAccountState(), me, balance: { cashBalance: 1, lockedCash: 1 }, status: "ready", ...patch }, true);

  it("no guard when signed out or the identity is unknown", () => {
    expect(overviewGuard()).toBeNull();
    useAccountStore.setState({ status: "anon", me: null });
    expect(overviewGuard()).toBeNull();
  });

  it("writes positions (dropping ones the overview no longer has) and the balance when nothing changed during the request", () => {
    ready({ positions: new Map([["asset-OLD", position("OLD")]]) });
    const guard = overviewGuard()!;
    expect(seedFromOverview({ balance, positions: [position("VCS-FOR-2021"), position("VCS-FOR-2019", { quantity: 0, retired: 3 })] }, guard)).toBe(true);
    const state = useAccountStore.getState();
    expect([...state.positions.keys()].sort()).toEqual(["asset-VCS-FOR-2019", "asset-VCS-FOR-2021"]);
    expect(state.balance).toEqual(balance);
    expect(state.me?.cashBalance).toBe(balance.cashBalance);
  });

  it("drops the whole snapshot when the lists were written during the request (a push or a subscription snapshot is newer)", () => {
    ready();
    const guard = overviewGuard()!;
    useAccountStore.setState({ positions: new Map([["asset-NEW", position("NEW")]]) });
    expect(seedFromOverview({ balance, positions: [position("VCS-FOR-2021")] }, guard)).toBe(false);
    expect([...useAccountStore.getState().positions.keys()]).toEqual(["asset-NEW"]);
  });

  it("keeps a balance that changed during the request, and drops everything when the user changed", () => {
    ready();
    const guard = overviewGuard()!;
    const pushed = { cashBalance: 5, lockedCash: 0 };
    useAccountStore.setState({ balance: pushed });
    expect(seedFromOverview({ balance, positions: [position("VCS-FOR-2021")] }, guard)).toBe(true);
    expect(useAccountStore.getState().balance).toBe(pushed);
    expect(useAccountStore.getState().positions.has("asset-VCS-FOR-2021")).toBe(true);

    ready();
    const other = overviewGuard()!;
    useAccountStore.setState({ me: { ...me, id: "u2" } });
    expect(seedFromOverview({ balance, positions: [position("VCS-FOR-2021")] }, other)).toBe(false);
  });
});
