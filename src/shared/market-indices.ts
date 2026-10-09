// 模拟指数(计划 §6.3.2 C6):服务端路由 GET /api/market/indices 与 /trade/markets 页面的客户端重算共用同一个纯函数。
// 一组的 change24h = 组内 change24h 为有限数的成员的算术平均(等权,不看价格高低:价位 9–98 美元混在一起,平均价没有意义);
// level = 100 × (1 + change24h / 100),即「24 小时前 = 100」;volume24h 是吨数之和(不是美元)。情景标的不参与任何一组。
import type { IndexRow, InstrumentListItem, MarketIndices } from "./types";

/** 「全部」那一行的 key(registry / projectType 的原始串里没有这个值) */
const ALL_INDEX_KEY = "all";

/** 四舍五入到 2 位小数,正负对称(半数远离 0),避免 Math.round 在负半数上向 0 靠;结果不带 -0 */
function round2(value: number): number {
  const rounded = (Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100)) / 100;
  return rounded === 0 ? 0 : rounded;
}

type Accumulator = { members: number; counted: number; changeSum: number; volume24h: number; advancers: number; decliners: number };

const emptyAccumulator = (): Accumulator => ({ members: 0, counted: 0, changeSum: 0, volume24h: 0, advancers: 0, decliners: 0 });

function add(acc: Accumulator, change: number | null, volume: number): void {
  acc.members += 1;
  if (Number.isFinite(volume)) acc.volume24h += volume;
  if (change === null) return;
  acc.counted += 1;
  acc.changeSum += change;
  if (change > 0) acc.advancers += 1;
  else if (change < 0) acc.decliners += 1;
}

function rowOf(key: string, acc: Accumulator): IndexRow {
  const change24h = acc.counted > 0 ? round2(acc.changeSum / acc.counted) : null;
  return {
    key,
    members: acc.members,
    counted: acc.counted,
    change24h,
    level: change24h === null ? null : round2(100 * (1 + change24h / 100)),
    volume24h: acc.volume24h,
    advancers: acc.advancers,
    decliners: acc.decliners,
  };
}

const compareKeys = (a: IndexRow, b: IndexRow): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function rowsOf(groups: Map<string, Accumulator>): IndexRow[] {
  return [...groups].map(([key, acc]) => rowOf(key, acc)).sort(compareKeys);
}

/**
 * 全部非情景标的 + 按 registry、按 projectType 各一组。ts 由调用方给(服务端 Date.now(),客户端按它重算的时刻);
 * 输入不被修改;分组的 key 是 registry / projectType 的原始串,按码元序排,服务端与客户端同序。
 */
export function computeIndices(items: readonly InstrumentListItem[], ts: number): MarketIndices {
  const all = emptyAccumulator();
  const byRegistry = new Map<string, Accumulator>();
  const byProjectType = new Map<string, Accumulator>();
  for (const { instrument, ticker } of items) {
    if (instrument.isScenario) continue;
    const change = typeof ticker.change24h === "number" && Number.isFinite(ticker.change24h) ? ticker.change24h : null;
    const volume = ticker.volume24h;
    add(all, change, volume);
    for (const [groups, key] of [[byRegistry, instrument.registry], [byProjectType, instrument.projectType]] as const) {
      let acc = groups.get(key);
      if (!acc) {
        acc = emptyAccumulator();
        groups.set(key, acc);
      }
      add(acc, change, volume);
    }
  }
  return { ts, all: rowOf(ALL_INDEX_KEY, all), byRegistry: rowsOf(byRegistry), byProjectType: rowsOf(byProjectType) };
}
