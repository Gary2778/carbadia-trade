import { describe, expect, it } from "vitest";
import { filterCredits, getCreditProfile, type CarbonAsset } from "./carbon";
const asset = (overrides: Partial<CarbonAsset> = {}): CarbonAsset => ({
  id: "a",
  symbol: "VCS-FOR-2021",
  name: "Forest",
  standard: "VCS",
  projectType: "林业碳汇",
  vintage: 2021,
  country: "中国",
  registry: "Verra",
  description: "",
  isScenario: false,
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
  it("does not invent a methodology or verification for demo assets", () => {
    const p = getCreditProfile(asset());
    expect(p.methodology).toBeNull();
    expect(p.verification).toBeNull();
    expect(p.registryUrl).toMatch(/^https:/);
  });
  it("does not assume unknown technologies are removals", () => {
    expect(
      getCreditProfile(asset({ projectType: "Unknown", symbol: "NEW" }))
        .approach,
    ).toBe("Not specified");
  });
});
