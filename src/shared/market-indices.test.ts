import { describe, expect, it } from "vitest";
import { computeIndices } from "./market-indices";
import type { IndexRow, Instrument, InstrumentListItem, Ticker } from "./types";

const TS = 1_790_000_000_000;

type Seed = { symbol: string; registry: string; projectType: string; change: number | null; volume: number; scenario?: boolean };

/** 只填指数用得到的字段:registry / projectType / isScenario 与 ticker 的 change24h / volume24h,其余给固定占位 */
function item(seed: Seed): InstrumentListItem {
  const instrument: Instrument = {
    id: `asset-${seed.symbol}`,
    symbol: seed.symbol,
    name: seed.symbol,
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
    lastPrice: 1_000,
  };
  const ticker: Ticker = { symbol: seed.symbol, lastPrice: 1_000, bestBid: null, bestAsk: null, change24h: seed.change, high24h: null, low24h: null, volume24h: seed.volume, ts: TS };
  return { instrument, ticker };
}

const row = (patch: Partial<IndexRow> & Pick<IndexRow, "key">): IndexRow => ({
  members: 0,
  counted: 0,
  change24h: null,
  level: null,
  volume24h: 0,
  advancers: 0,
  decliners: 0,
  ...patch,
});

// 手算夹具:五个信用标的 + 一个情景标的(涨幅与成交量都很大,混进去就会让每一个数都对不上)
//   A  Verra          Forestry   +2    100 t
//   B  Verra          Renewable  −1     50 t
//   C  Gold Standard  Forestry   +4     30 t
//   D  Gold Standard  Renewable   0      0 t
//   E  UNFCCC         Methane    无涨跌   5 t   (24 小时内没有成交)
//   S  情景标的        配额情景   +50  1000 t   (不参与)
const FIXTURE: Seed[] = [
  { symbol: "A", registry: "Verra", projectType: "Forestry", change: 2, volume: 100 },
  { symbol: "B", registry: "Verra", projectType: "Renewable", change: -1, volume: 50 },
  { symbol: "C", registry: "Gold Standard", projectType: "Forestry", change: 4, volume: 30 },
  { symbol: "D", registry: "Gold Standard", projectType: "Renewable", change: 0, volume: 0 },
  { symbol: "E", registry: "UNFCCC", projectType: "Methane", change: null, volume: 5 },
  { symbol: "S", registry: "Scenario registry", projectType: "Allowance scenario", change: 50, volume: 1_000, scenario: true },
];

describe("computeIndices", () => {
  it("空列表:全部与两组分组都是空的,涨跌与点位为 null,ts 原样带回", () => {
    expect(computeIndices([], TS)).toEqual({ ts: TS, all: row({ key: "all" }), byRegistry: [], byProjectType: [] });
  });

  it("与手算一致:全部 = 四个有涨跌的成员的平均(2 − 1 + 4 + 0)/ 4 = 1.25,点位 101.25,成交量含没有涨跌的成员,情景标的不算", () => {
    const { all } = computeIndices(FIXTURE.map(item), TS);
    expect(all).toEqual({ key: "all", members: 5, counted: 4, change24h: 1.25, level: 101.25, volume24h: 185, advancers: 2, decliners: 1 });
  });

  it("按 registry 分组:key 是原始串、按码元序排;组内平均、吨数之和、涨 / 跌成员数各自手算", () => {
    const { byRegistry } = computeIndices(FIXTURE.map(item), TS);
    expect(byRegistry).toEqual([
      row({ key: "Gold Standard", members: 2, counted: 2, change24h: 2, level: 102, volume24h: 30, advancers: 1, decliners: 0 }),
      row({ key: "UNFCCC", members: 1, counted: 0, volume24h: 5 }),
      row({ key: "Verra", members: 2, counted: 2, change24h: 0.5, level: 100.5, volume24h: 150, advancers: 1, decliners: 1 }),
    ]);
  });

  it("按 projectType 分组:同样手算", () => {
    const { byProjectType } = computeIndices(FIXTURE.map(item), TS);
    expect(byProjectType).toEqual([
      row({ key: "Forestry", members: 2, counted: 2, change24h: 3, level: 103, volume24h: 130, advancers: 2, decliners: 0 }),
      row({ key: "Methane", members: 1, counted: 0, volume24h: 5 }),
      row({ key: "Renewable", members: 2, counted: 2, change24h: -0.5, level: 99.5, volume24h: 50, advancers: 0, decliners: 1 }),
    ]);
  });

  it("情景标的被忽略:只有情景标的时全部与分组都是空的,混进去的情景标的不改变任何一个数", () => {
    const scenarioOnly = computeIndices([item({ symbol: "S", registry: "Scenario registry", projectType: "Allowance scenario", change: 50, volume: 1_000, scenario: true })], TS);
    expect(scenarioOnly).toEqual({ ts: TS, all: row({ key: "all" }), byRegistry: [], byProjectType: [] });
    const without = computeIndices(FIXTURE.filter((seed) => !seed.scenario).map(item), TS);
    expect(computeIndices(FIXTURE.map(item), TS)).toEqual(without);
  });

  it("只有一个成员的组:平均就是它自己,涨跌与点位各取两位小数(−3.337 → −3.34,点位 96.66)", () => {
    const { byRegistry, all } = computeIndices([item({ symbol: "ONE", registry: "UNFCCC", projectType: "Methane", change: -3.337, volume: 7 })], TS);
    expect(byRegistry).toEqual([row({ key: "UNFCCC", members: 1, counted: 1, change24h: -3.34, level: 96.66, volume24h: 7, advancers: 0, decliners: 1 })]);
    expect(all).toEqual(row({ key: "all", members: 1, counted: 1, change24h: -3.34, level: 96.66, volume24h: 7, decliners: 1 }));
  });

  it("成员的涨跌全是 null 的组:counted 为 0,涨跌与点位为 null(不是 0 与 100),成交量照加", () => {
    const { all, byRegistry, byProjectType } = computeIndices(
      [
        item({ symbol: "N1", registry: "Verra", projectType: "Forestry", change: null, volume: 3 }),
        item({ symbol: "N2", registry: "Verra", projectType: "Forestry", change: null, volume: 4 }),
      ],
      TS,
    );
    const expected = { members: 2, counted: 0, change24h: null, level: null, volume24h: 7, advancers: 0, decliners: 0 };
    expect(all).toEqual({ key: "all", ...expected });
    expect(byRegistry).toEqual([{ key: "Verra", ...expected }]);
    expect(byProjectType).toEqual([{ key: "Forestry", ...expected }]);
  });

  it("涨跌不是有限数(NaN、Infinity)按没有涨跌处理:不进平均,也不算涨跌家数", () => {
    const { all } = computeIndices(
      [
        item({ symbol: "X1", registry: "Verra", projectType: "Forestry", change: 6, volume: 1 }),
        item({ symbol: "X2", registry: "Verra", projectType: "Forestry", change: Number.NaN, volume: 1 }),
        item({ symbol: "X3", registry: "Verra", projectType: "Forestry", change: Number.POSITIVE_INFINITY, volume: 1 }),
      ],
      TS,
    );
    expect(all).toEqual({ key: "all", members: 3, counted: 1, change24h: 6, level: 106, volume24h: 3, advancers: 1, decliners: 0 });
  });

  it("平均取两位小数:(1.111 + 2.223)/ 2 = 1.667 → 1.67,点位 101.67;极小的负数舍成 0 而不是 −0", () => {
    const mean = computeIndices(
      [item({ symbol: "R1", registry: "Verra", projectType: "Forestry", change: 1.111, volume: 0 }), item({ symbol: "R2", registry: "Verra", projectType: "Forestry", change: 2.223, volume: 0 })],
      TS,
    ).all;
    expect([mean.change24h, mean.level]).toEqual([1.67, 101.67]);
    const tiny = computeIndices([item({ symbol: "T", registry: "Verra", projectType: "Forestry", change: -0.001, volume: 0 })], TS).all;
    expect(Object.is(tiny.change24h, 0)).toBe(true);
    expect(tiny.level).toBe(100);
    expect(tiny.decliners).toBe(1); // 家数按未舍入的值数:它确实是跌的
  });

  it("level = 100 × (1 + change24h / 100):每一行的点位都等于 100 + 涨跌(两位小数内)", () => {
    const indices = computeIndices(FIXTURE.map(item), TS);
    for (const r of [indices.all, ...indices.byRegistry, ...indices.byProjectType]) {
      if (r.change24h === null) expect(r.level).toBeNull();
      else expect(r.level).toBeCloseTo(100 + r.change24h, 10);
    }
  });

  it("registry / projectType 的原始串按码元序排,与输入顺序和运行时 locale 无关(中文原值排在拉丁字母之后)", () => {
    const seeds: Seed[] = [
      { symbol: "Z", registry: "国家温室气体自愿减排登记簿", projectType: "林业碳汇", change: 1, volume: 1 },
      { symbol: "Y", registry: "Verra", projectType: "蓝碳", change: 1, volume: 1 },
      { symbol: "X", registry: "Gold Standard", projectType: "Forestry", change: 1, volume: 1 },
    ];
    const forward = computeIndices(seeds.map(item), TS);
    const backward = computeIndices([...seeds].reverse().map(item), TS);
    expect(forward.byRegistry.map((r) => r.key)).toEqual(["Gold Standard", "Verra", "国家温室气体自愿减排登记簿"]);
    expect(forward.byProjectType.map((r) => r.key)).toEqual(["Forestry", "林业碳汇", "蓝碳"]);
    expect(backward).toEqual(forward);
  });

  it("不改输入、结果可 JSON 往返(plain data)", () => {
    const items = FIXTURE.map(item);
    const snapshot = JSON.stringify(items);
    const indices = computeIndices(items, TS);
    expect(JSON.stringify(items)).toBe(snapshot);
    expect(JSON.parse(JSON.stringify(indices))).toEqual(indices);
  });
});
