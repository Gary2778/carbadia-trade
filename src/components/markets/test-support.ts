// 测试专用(运行时代码不得引入):市场总览页各测试共用的手算夹具。涨跌与成交量的取值让每个平均数都落在两位小数以内(不踩四舍五入的半数),
// 所以测试里写的数就是手算的数。
import type { Instrument, InstrumentListItem, Ticker } from "@/shared";

export const TS = 1_790_000_000_000;

type Seed = { symbol: string; name: string; registry: string; projectType: string; change: number | null; volume: number; price: number | null; scenario?: boolean };

export function marketItem(seed: Seed): InstrumentListItem {
  const instrument: Instrument = {
    id: `asset-${seed.symbol}`,
    symbol: seed.symbol,
    name: seed.name,
    standard: "VCS",
    projectType: seed.projectType,
    vintage: 2021,
    country: "Brazil",
    registry: seed.registry,
    isScenario: seed.scenario ?? false,
    projectId: null,
    methodology: null,
    verificationStatus: null,
    tickSize: 1,
    pricePrecision: 2,
    qtyStep: 1,
    minQty: 1,
    currency: "USD",
    lastPrice: seed.price,
  };
  const ticker: Ticker = { symbol: seed.symbol, lastPrice: seed.price, bestBid: null, bestAsk: null, change24h: seed.change, high24h: null, low24h: null, volume24h: seed.volume, ts: TS };
  return { instrument, ticker };
}

const CREDIT_SEEDS: Omit<Seed, "scenario">[] = [
  { symbol: "VCS-FOR-2021", name: "Forest A", registry: "Verra", projectType: "林业碳汇", change: 3.5, volume: 900, price: 1_000 },
  { symbol: "VCS-FOR-2022", name: "Forest B", registry: "Verra", projectType: "林业碳汇", change: 2.3, volume: 300, price: 1_100 },
  { symbol: "VCS-WIND-2021", name: "Wind C", registry: "Verra", projectType: "可再生能源", change: 1, volume: 400, price: 2_500 },
  { symbol: "VCS-SOL-2021", name: "Solar D", registry: "Verra", projectType: "可再生能源", change: 0.6, volume: 1_200, price: 3_000 },
  { symbol: "GS-WIND-2021", name: "Wind E", registry: "Gold Standard", projectType: "可再生能源", change: 4, volume: 50, price: 4_550 },
  { symbol: "GS-MANG-2021", name: "Mangrove F", registry: "Gold Standard", projectType: "蓝碳", change: -2, volume: 700, price: 9_600 },
  { symbol: "GS-MANG-2022", name: "Mangrove G", registry: "Gold Standard", projectType: "蓝碳", change: -4, volume: 100, price: 9_700 },
  { symbol: "GS-COOK-2021", name: "Cookstoves H", registry: "Gold Standard", projectType: "能效", change: 0.4, volume: 650, price: 1_250 },
  { symbol: "CDM-METH-2019", name: "Methane I", registry: "UNFCCC", projectType: "甲烷回收", change: null, volume: 0, price: 915 },
  { symbol: "CCER-SOL-2022", name: "Solar J", registry: "国家温室气体自愿减排登记簿", projectType: "可再生能源", change: 0, volume: 800, price: 8_000 },
  { symbol: "CCER-SOL-2023", name: "Solar K", registry: "国家温室气体自愿减排登记簿", projectType: "可再生能源", change: -1.5, volume: 20, price: 8_050 },
];

/** 十一个信用标的:11 个成员、10 个有涨跌(CDM-METH-2019 没有成交);全部 = (3.5 + 2.3 + 1 + 0.6 + 4 − 2 − 4 + 0.4 + 0 − 1.5)/ 10 = 0.43 */
export const CREDITS: InstrumentListItem[] = CREDIT_SEEDS.map(marketItem);

/** 两个情景标的:涨幅与成交量都比任何信用标的大,混进指数或榜单就会让数对不上 */
export const SCENARIOS: InstrumentListItem[] = [
  marketItem({ symbol: "CEA-SCEN-2026", name: "CEA scenario", registry: "情景标的(无真实登记)", projectType: "配额情景", change: 50, volume: 9_999, price: 9_041, scenario: true }),
  marketItem({ symbol: "CCER-SCEN-2026", name: "CCER scenario", registry: "情景标的(无真实登记)", projectType: "配额情景", change: -10, volume: 1, price: 9_033, scenario: true }),
];

/** 服务端给页面的清单:信用标的 + 情景标的(顺序不重要,页面与指数都不依赖输入顺序) */
export const ITEMS: InstrumentListItem[] = [...CREDITS, ...SCENARIOS];
