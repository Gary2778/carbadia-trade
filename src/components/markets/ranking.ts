// 市场总览页的榜单与分区(纯函数,node 环境可测):三张榜各取前 RANK_SIZE 名,情景标的单独一栏、不进榜单(也不进指数)。
// 排序都带 symbol 作决胜项(码元序):同一份数据在服务端渲染与浏览器水合里排出同一个顺序。
import type { InstrumentListItem } from "@/shared";

/** 每张榜的名额 */
export const RANK_SIZE = 5;

export type MarketRankings = {
  /** 24h 涨跌 > 0,涨得多的在前 */
  gainers: InstrumentListItem[];
  /** 24h 涨跌 < 0,跌得多的在前 */
  losers: InstrumentListItem[];
  /** 24h 成交吨数 > 0,量大的在前 */
  volume: InstrumentListItem[];
  /** 全部情景标的,按 symbol 排 */
  scenarios: InstrumentListItem[];
};

const bySymbol = (a: InstrumentListItem, b: InstrumentListItem): number => (a.instrument.symbol < b.instrument.symbol ? -1 : a.instrument.symbol > b.instrument.symbol ? 1 : 0);

export function rankMarkets(items: readonly InstrumentListItem[]): MarketRankings {
  const credits = items.filter((item) => !item.instrument.isScenario);
  // 涨跌是有限数才上涨跌榜(null、NaN 都不上,与指数里「没有涨跌」同一口径);涨跌为 0 的两张榜都不上
  const moved: { item: InstrumentListItem; change: number }[] = [];
  for (const item of credits) {
    const change = item.ticker.change24h;
    if (typeof change === "number" && Number.isFinite(change)) moved.push({ item, change });
  }
  const take = (rows: { item: InstrumentListItem; change: number }[]) => rows.slice(0, RANK_SIZE).map(({ item }) => item);
  return {
    gainers: take(moved.filter(({ change }) => change > 0).sort((a, b) => b.change - a.change || bySymbol(a.item, b.item))),
    losers: take(moved.filter(({ change }) => change < 0).sort((a, b) => a.change - b.change || bySymbol(a.item, b.item))),
    volume: credits
      .filter((item) => Number.isFinite(item.ticker.volume24h) && item.ticker.volume24h > 0)
      .sort((a, b) => b.ticker.volume24h - a.ticker.volume24h || bySymbol(a, b))
      .slice(0, RANK_SIZE),
    scenarios: items.filter((item) => item.instrument.isScenario).sort(bySymbol),
  };
}
