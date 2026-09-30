import { describe, expect, it } from "vitest";
import { filterCredits, getCreditProfile, type CarbonAsset, type CreditFilters } from "./carbon";
const asset = (overrides: Partial<CarbonAsset> = {}): CarbonAsset => ({
  id: "a",
  symbol: "VCS-FOR-2021",
  name: "Forest",
  standard: "VCS",
  projectType: "林业碳汇",
  vintage: 2021,
  country: "中国",
  registry: "Verra",
  isScenario: false,
  projectId: "SIM-PRJ-VCS-FOR",
  methodology: null,
  verificationStatus: null,
  pricePrecision: 2,
  lastPrice: 1000,
  bestAsk: 1100,
  bestBid: 900,
  volume24h: 10,
  change24h: 1,
  spark: [],
  availableSupply: 5,
  ...overrides,
});
describe("carbon credit discovery", () => {
  it("excludes allowance and scenario instruments by default", () => {
    expect(
      filterCredits([asset(), asset({ id: "b", isScenario: true })], {}).map(
        (x) => x.id,
      ),
    ).toEqual(["a"]);
  });
  it("combines search, vintage, registry, supply and price filters", () => {
    const a = asset();
    expect(
      filterCredits([a], {
        search: "forest",
        vintage: "2021",
        standard: "VCS",
        minSupply: "4",
        maxPrice: "11",
      }),
    ).toEqual([a]);
    expect(filterCredits([a], { minSupply: "6" })).toEqual([]);
    expect(filterCredits([a], { maxPrice: "9" })).toEqual([]);
  });
  it("sorts unpriced credits last in both directions", () => {
    const items = [
      asset({ id: "none", lastPrice: null }),
      asset({ id: "low", lastPrice: 100 }),
      asset({ id: "high", lastPrice: 500 }),
    ];
    expect(
      filterCredits(items, { sort: "price-desc" }).map((a) => a.id),
    ).toEqual(["high", "low", "none"]);
    expect(
      filterCredits(items, { sort: "price-asc" }).map((a) => a.id),
    ).toEqual(["low", "high", "none"]);
  });
  it("filters by registry, projectId and a dollar price band (priceMin / priceMax in dollars, prices in cents)", () => {
    const a = asset(); // Verra, SIM-PRJ-VCS-FOR, lastPrice 1000 分 = $10
    const b = asset({ id: "b", registry: "Gold Standard", projectId: "SIM-PRJ-GS-WIND", lastPrice: 2500 });
    const ids = (f: CreditFilters) => filterCredits([a, b], f).map((x) => x.id);
    expect(ids({ registry: "Verra" })).toEqual(["a"]);
    expect(ids({ registry: "Gold Standard" })).toEqual(["b"]);
    expect(ids({ projectId: "SIM-PRJ-GS-WIND" })).toEqual(["b"]);
    expect(ids({ projectId: "SIM-PRJ-NONE" })).toEqual([]);
    expect(ids({ priceMin: "10" })).toEqual(["a", "b"]); // >= $10.00
    expect(ids({ priceMin: "10.01" })).toEqual(["b"]);
    expect(ids({ priceMax: "10" })).toEqual(["a"]); // <= $10.00
    expect(ids({ priceMin: "5", priceMax: "20" })).toEqual(["a"]);
    expect(ids({ priceMax: "24.99" })).toEqual(["a"]);
    // maxPrice 旧键继续生效, 与 priceMax 同义
    expect(ids({ maxPrice: "10" })).toEqual(["a"]);
    // 无价标的不落进任何价格带
    expect(ids({ priceMin: "0" })).toEqual(["a", "b"]);
    expect(filterCredits([asset({ id: "none", lastPrice: null })], { priceMin: "0" })).toEqual([]);
    expect(filterCredits([asset({ id: "none", lastPrice: null })], { priceMax: "999" })).toEqual([]);
  });
  it("does not invent a methodology or verification for demo assets", () => {
    const p = getCreditProfile(asset());
    expect(p.methodology).toBeNull();
    expect(p.verification).toBeNull();
    expect(p.registryUrl).toMatch(/^https:/);
  });
  it("carries the instrument's own methodology / verification through unchanged (filled by Instrument, never by the profile)", () => {
    const p = getCreditProfile(asset({ methodology: "VM0007", verificationStatus: "SIMULATED_UNVERIFIED" }));
    expect(p.methodology).toBe("VM0007");
    expect(p.verification).toBe("SIMULATED_UNVERIFIED");
    // 旧调用方只传 symbol / projectType 也仍是 null, 不会杜撰
    expect(getCreditProfile({ symbol: "GS-WIND-2022", projectType: "可再生能源" }).methodology).toBeNull();
  });
  it("colours are design tokens, never hex", () => {
    for (const [symbol, projectType] of [
      ["VCS-FOR-2021", "林业碳汇"], ["GS-MANG-2022", "蓝碳"], ["VCS-COOK-2020", "能效"], ["CDM-METH-2019", "甲烷回收"],
      ["GS-WIND-2022", "可再生能源"], ["CCER-SOL-2023", "可再生能源"], ["X-DAC-2024", "direct air"], ["NEW", "Unknown"],
    ]) {
      expect(getCreditProfile({ symbol, projectType }).color).toMatch(/^var\(--series(-[234])?\)$/);
    }
  });
  it("does not assume unknown technologies are removals", () => {
    expect(
      getCreditProfile(asset({ projectType: "Unknown", symbol: "NEW" }))
        .approach,
    ).toBe("Not specified");
  });
});
