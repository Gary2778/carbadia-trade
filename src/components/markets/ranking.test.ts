import { describe, expect, it } from "vitest";
import { RANK_SIZE, rankMarkets } from "./ranking";
import { CREDITS, ITEMS, SCENARIOS, marketItem } from "./test-support";

const symbols = (items: { instrument: { symbol: string } }[]) => items.map((item) => item.instrument.symbol);

describe("rankMarkets", () => {
  it("每张榜 5 名:涨幅榜按涨得多排(第 6 名 GS-COOK-2021 +0.4% 落榜),跌幅榜按跌得多排,成交量榜按吨数排", () => {
    expect(RANK_SIZE).toBe(5);
    const { gainers, losers, volume } = rankMarkets(ITEMS);
    expect(symbols(gainers)).toEqual(["GS-WIND-2021", "VCS-FOR-2021", "VCS-FOR-2022", "VCS-WIND-2021", "VCS-SOL-2021"]);
    expect(symbols(losers)).toEqual(["GS-MANG-2022", "GS-MANG-2021", "CCER-SOL-2023"]);
    expect(symbols(volume)).toEqual(["VCS-SOL-2021", "VCS-FOR-2021", "CCER-SOL-2022", "GS-MANG-2021", "GS-COOK-2021"]);
  });

  it("涨跌为 null 的不上涨幅榜也不上跌幅榜(CDM-METH-2019 没有成交);涨跌恰为 0 的两张榜都不上", () => {
    const { gainers, losers } = rankMarkets(ITEMS);
    for (const symbol of ["CDM-METH-2019", "CCER-SOL-2022"]) {
      expect(symbols(gainers)).not.toContain(symbol);
      expect(symbols(losers)).not.toContain(symbol);
    }
    // 没有任何标的上涨时涨幅榜是空的,而不是拿下跌的凑数(跌幅榜同理)
    const allDown = rankMarkets(CREDITS.filter((item) => (item.ticker.change24h ?? 0) < 0));
    expect(allDown.gainers).toEqual([]);
    expect(symbols(allDown.losers)).toEqual(["GS-MANG-2022", "GS-MANG-2021", "CCER-SOL-2023"]);
  });

  it("成交量榜只收有成交的:没成交(0 吨)的不凑数", () => {
    const { volume } = rankMarkets(ITEMS);
    expect(symbols(volume)).not.toContain("CDM-METH-2019");
    expect(rankMarkets([marketItem({ symbol: "Q-2021", name: "Quiet", registry: "Verra", projectType: "林业碳汇", change: null, volume: 0, price: null })]).volume).toEqual([]);
  });

  it("情景标的不进任何一张榜(涨幅 +50% 与 9999 吨都比信用标的大),单独列在 scenarios 里并按 symbol 排", () => {
    const { gainers, losers, volume, scenarios } = rankMarkets(ITEMS);
    for (const list of [gainers, losers, volume]) {
      expect(symbols(list)).not.toContain("CEA-SCEN-2026");
      expect(symbols(list)).not.toContain("CCER-SCEN-2026");
    }
    expect(symbols(scenarios)).toEqual(["CCER-SCEN-2026", "CEA-SCEN-2026"]);
    expect(rankMarkets(SCENARIOS).gainers).toEqual([]);
  });

  it("同涨跌 / 同成交量按 symbol 的码元序打破平局,与输入顺序无关(服务端渲染与水合排出同一个顺序)", () => {
    const tie = ["B-2021", "A-2021", "C-2021"].map((symbol) => marketItem({ symbol, name: symbol, registry: "Verra", projectType: "林业碳汇", change: 1.5, volume: 10, price: 100 }));
    const forward = rankMarkets(tie);
    const backward = rankMarkets([...tie].reverse());
    expect(symbols(forward.gainers)).toEqual(["A-2021", "B-2021", "C-2021"]);
    expect(symbols(forward.volume)).toEqual(["A-2021", "B-2021", "C-2021"]);
    expect(backward).toEqual(forward);
  });

  it("空列表:四个分区都是空的;不改输入", () => {
    expect(rankMarkets([])).toEqual({ gainers: [], losers: [], volume: [], scenarios: [] });
    const snapshot = JSON.stringify(ITEMS);
    rankMarkets(ITEMS);
    expect(JSON.stringify(ITEMS)).toBe(snapshot);
  });
});
