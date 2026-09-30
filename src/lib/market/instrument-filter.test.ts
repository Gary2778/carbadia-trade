import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instrument, InstrumentListItem, Ticker } from "@/shared";
import {
  centsToPriceInput,
  compareCodeUnits,
  facets,
  filterByQuery,
  filterInstruments,
  hasActiveFilters,
  matchesQuery,
  priceInputToCents,
  setFilter,
  siblingsByProject,
  sortOptionsByLabel,
  syncPriceInput,
  type InstrumentListRow,
} from "./instrument-filter";

const ins = (symbol: string, over: Partial<Instrument> = {}): Instrument => ({
  id: `id-${symbol}`,
  symbol,
  name: `Name ${symbol}`,
  standard: "VCS",
  projectType: "FOR",
  vintage: 2021,
  country: "BR",
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
  lastPrice: 1000,
  ...over,
});
const tk = (symbol: string, over: Partial<Ticker> = {}): Ticker => ({
  symbol,
  lastPrice: 1000,
  bestBid: null,
  bestAsk: null,
  change24h: null,
  high24h: null,
  low24h: null,
  volume24h: 0,
  ts: 1,
  ...over,
});
const row = (instrument: Instrument, ticker?: Ticker, starred = false): InstrumentListRow => ({ instrument, ticker, starred });

const rows: InstrumentListRow[] = [
  row(ins("VCS-FOR-2021"), tk("VCS-FOR-2021", { lastPrice: 1200, change24h: 1.5, volume24h: 50 })),
  row(ins("GS-REN-2020", { registry: "Gold Standard", projectType: "REN", vintage: 2020, name: "Wind farm" }), tk("GS-REN-2020", { lastPrice: 800, change24h: -2, volume24h: 300 }), true),
  row(ins("ACR-BLU-2022", { registry: "ACR", projectType: "BLU", vintage: 2022 }), tk("ACR-BLU-2022", { lastPrice: null, change24h: null, volume24h: 10 })),
  row(ins("VCS-FOR-2019", { vintage: 2019, lastPrice: null }), undefined),
];
const symbols = (r: InstrumentListRow[]) => r.map((x) => x.instrument.symbol);

describe("filterInstruments", () => {
  it("空条件返回全部且是新数组、不改入参", () => {
    const out = filterInstruments(rows, {});
    expect(symbols(out)).toEqual(symbols(rows));
    expect(out).not.toBe(rows);
  });

  it("q 大小写不敏感匹配 symbol / name / registry / projectType,空白 q 不过滤", () => {
    expect(symbols(filterInstruments(rows, { q: "wind" }))).toEqual(["GS-REN-2020"]);
    expect(symbols(filterInstruments(rows, { q: "gold" }))).toEqual(["GS-REN-2020"]);
    expect(symbols(filterInstruments(rows, { q: "blu" }))).toEqual(["ACR-BLU-2022"]);
    expect(symbols(filterInstruments(rows, { q: "vcs-for" }))).toEqual(["VCS-FOR-2021", "VCS-FOR-2019"]);
    expect(symbols(filterInstruments(rows, { q: "   " }))).toEqual(symbols(rows));
  });

  it("registry / projectType 精确匹配,空串视为未设", () => {
    expect(symbols(filterInstruments(rows, { registry: "ACR" }))).toEqual(["ACR-BLU-2022"]);
    expect(symbols(filterInstruments(rows, { projectType: "FOR" }))).toEqual(["VCS-FOR-2021", "VCS-FOR-2019"]);
    expect(symbols(filterInstruments(rows, { registry: "", projectType: "" }))).toEqual(symbols(rows));
  });

  it("vintage 精确匹配,NaN 视为未设", () => {
    expect(symbols(filterInstruments(rows, { vintage: 2020 }))).toEqual(["GS-REN-2020"]);
    expect(symbols(filterInstruments(rows, { vintage: Number.NaN }))).toEqual(symbols(rows));
  });

  it("价格区间以分比较现价(live ticker 优先),null 现价在设区间时排除", () => {
    expect(symbols(filterInstruments(rows, { minPrice: 1000 }))).toEqual(["VCS-FOR-2021"]);
    expect(symbols(filterInstruments(rows, { maxPrice: 1000 }))).toEqual(["GS-REN-2020"]);
    expect(symbols(filterInstruments(rows, { minPrice: 800, maxPrice: 1200 }))).toEqual(["VCS-FOR-2021", "GS-REN-2020"]);
  });

  it("ticker 缺失时用 instrument.lastPrice 判价", () => {
    const list = [row(ins("X-1", { lastPrice: 500 }), undefined)];
    expect(symbols(filterInstruments(list, { minPrice: 400 }))).toEqual(["X-1"]);
    expect(symbols(filterInstruments(list, { minPrice: 600 }))).toEqual([]);
  });

  it("watchlistOnly 只留 starred", () => {
    expect(symbols(filterInstruments(rows, { watchlistOnly: true }))).toEqual(["GS-REN-2020"]);
  });

  it("sort=symbol 升序", () => {
    expect(symbols(filterInstruments(rows, { sort: "symbol" }))).toEqual(["ACR-BLU-2022", "GS-REN-2020", "VCS-FOR-2019", "VCS-FOR-2021"]);
  });

  it("sort=change 降序且 null 末尾", () => {
    expect(symbols(filterInstruments(rows, { sort: "change" }))).toEqual(["VCS-FOR-2021", "GS-REN-2020", "ACR-BLU-2022", "VCS-FOR-2019"]);
  });

  it("sort=volume 降序,无 ticker 按 0", () => {
    expect(symbols(filterInstruments(rows, { sort: "volume" }))).toEqual(["GS-REN-2020", "VCS-FOR-2021", "ACR-BLU-2022", "VCS-FOR-2019"]);
  });

  it("sort=price 降序且 null 末尾", () => {
    expect(symbols(filterInstruments(rows, { sort: "price" }))).toEqual(["VCS-FOR-2021", "GS-REN-2020", "ACR-BLU-2022", "VCS-FOR-2019"]);
  });

  it("多个条件为交集", () => {
    expect(symbols(filterInstruments(rows, { q: "vcs", vintage: 2021, minPrice: 1000 }))).toEqual(["VCS-FOR-2021"]);
    expect(symbols(filterInstruments(rows, { q: "vcs", vintage: 2021, watchlistOnly: true }))).toEqual([]);
  });
});

describe("filterInstruments 价格区间边界", () => {
  const list = [
    row(ins("A-1"), tk("A-1", { lastPrice: 999 })),
    row(ins("A-2"), tk("A-2", { lastPrice: 1000 })),
    row(ins("A-3"), tk("A-3", { lastPrice: 1001 })),
  ];
  it("上下限都是闭区间(等于边界的价格保留)", () => {
    expect(symbols(filterInstruments(list, { minPrice: 1000, maxPrice: 1000 }))).toEqual(["A-2"]);
    expect(symbols(filterInstruments(list, { minPrice: 1000 }))).toEqual(["A-2", "A-3"]);
    expect(symbols(filterInstruments(list, { maxPrice: 1000 }))).toEqual(["A-1", "A-2"]);
  });

  it("minPrice > maxPrice 时为空集,不交换两端", () => {
    expect(filterInstruments(list, { minPrice: 1001, maxPrice: 999 })).toEqual([]);
  });

  it("live ticker 的 null 现价压过 instrument.lastPrice:设了价格区间即排除", () => {
    const l = [row(ins("B-1", { lastPrice: 1000 }), tk("B-1", { lastPrice: null }))];
    expect(filterInstruments(l, { minPrice: 0 })).toEqual([]);
    expect(symbols(filterInstruments(l, {}))).toEqual(["B-1"]);
  });
});

describe("hasActiveFilters", () => {
  it("空条件、空白 q、空串、NaN 都不算", () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: "  ", registry: "", projectType: " ", vintage: Number.NaN, minPrice: Number.NaN, watchlistOnly: false })).toBe(false);
  });

  it("任一维度设了即为真(含 0 分的价格下限与排序)", () => {
    expect(hasActiveFilters({ q: "vcs" })).toBe(true);
    expect(hasActiveFilters({ vintage: 2021 })).toBe(true);
    expect(hasActiveFilters({ minPrice: 0 })).toBe(true);
    expect(hasActiveFilters({ watchlistOnly: true })).toBe(true);
    expect(hasActiveFilters({ sort: "price" })).toBe(true);
  });
});

describe("setFilter", () => {
  it("设值返回新对象、不改入参;undefined / 空串 / false / NaN 删键", () => {
    const base = { q: "vcs", vintage: 2021, watchlistOnly: true } as const;
    const next = setFilter(base, "registry", "Verra");
    expect(next).toEqual({ q: "vcs", vintage: 2021, watchlistOnly: true, registry: "Verra" });
    expect(base).toEqual({ q: "vcs", vintage: 2021, watchlistOnly: true });
    expect(setFilter(base, "q", "")).toEqual({ vintage: 2021, watchlistOnly: true });
    expect(setFilter(base, "vintage", undefined)).toEqual({ q: "vcs", watchlistOnly: true });
    expect(setFilter(base, "watchlistOnly", false)).toEqual({ q: "vcs", vintage: 2021 });
    expect(setFilter(base, "minPrice", Number.NaN)).toEqual(base);
    // 0 分是合法的价格下限;q 保留空格(输入中)
    expect(setFilter({}, "minPrice", 0)).toEqual({ minPrice: 0 });
    expect(setFilter({}, "q", "vcs ")).toEqual({ q: "vcs " });
  });
});

describe("facets", () => {
  it("去重、去空并排序:字符串按码元序升序,年份升序", () => {
    const f = facets([
      ...rows,
      row(ins("X-EMPTY", { registry: "", projectType: " ", vintage: 2020 })),
      row(ins("X-DUP", { registry: "Verra", projectType: "FOR", vintage: 2021 })),
    ]);
    expect(f.registries).toEqual(["ACR", "Gold Standard", "Verra"]);
    expect(f.projectTypes).toEqual(["BLU", "FOR", "REN"]);
    expect(f.vintages).toEqual([2019, 2020, 2021, 2022]);
  });

  it("接受 SSR 注入的 { instrument, ticker } 形状,空列表给三个空数组", () => {
    const items: InstrumentListItem[] = [{ instrument: ins("Y-1", { registry: "UNFCCC" }), ticker: tk("Y-1") }];
    expect(facets(items).registries).toEqual(["UNFCCC"]);
    expect(facets([])).toEqual({ registries: [], projectTypes: [], vintages: [] });
  });

  it("拉丁与汉字混排时按码元序:拉丁在前、汉字按码位,与运行时默认 locale 无关", () => {
    // 生产种子的真实原值;不带 locale 的 localeCompare 在 en-US 与 zh-CN 下给出两种顺序(水合不一致的来源)
    const registries = ["国家温室气体自愿减排登记簿", "Verra", "Gold Standard", "UNFCCC", "情景标的(无真实登记)"];
    const projectTypes = ["林业碳汇", "可再生能源", "蓝碳", "能效", "甲烷回收", "配额情景"];
    const list = registries.flatMap((registry, i) => projectTypes.map((projectType, j) => ({ instrument: ins(`M-${i}-${j}`, { registry, projectType }) })));
    const f = facets(list);
    const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    expect(f.registries).toEqual([...registries].sort(byCodeUnit));
    expect(f.projectTypes).toEqual([...projectTypes].sort(byCodeUnit));
    // 钉死具体顺序:可 U+53EF < 林 U+6797 < 甲 U+7532 < 能 U+80FD < 蓝 U+84DD < 配 U+914D
    expect(f.registries).toEqual(["Gold Standard", "UNFCCC", "Verra", "国家温室气体自愿减排登记簿", "情景标的(无真实登记)"]);
    expect(f.projectTypes).toEqual(["可再生能源", "林业碳汇", "甲烷回收", "能效", "蓝碳", "配额情景"]);
  });
});

describe("排序不走运行时默认 locale", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compareCodeUnits 是全序:等串为 0,方向按码元", () => {
    expect(compareCodeUnits("a", "a")).toBe(0);
    expect(compareCodeUnits("B", "a")).toBeLessThan(0); // 码元序:大写在小写前
    expect(compareCodeUnits("Verra", "林业碳汇")).toBeLessThan(0);
    expect(compareCodeUnits("林业碳汇", "可再生能源")).toBeGreaterThan(0);
  });

  it("facets / siblingsByProject / sort=symbol 都不调用 localeCompare", () => {
    const spy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare depends on the runtime default locale");
    });
    facets([...rows, row(ins("H-1", { registry: "林业碳汇", projectType: "蓝碳" }))]);
    siblingsByProject([ins("P-B-2021", { projectId: "P" }), ins("P-A-2021", { projectId: "P" })], "P");
    expect(symbols(filterInstruments(rows, { sort: "symbol" }))).toEqual(["ACR-BLU-2022", "GS-REN-2020", "VCS-FOR-2019", "VCS-FOR-2021"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("siblingsByProject 同年按 symbol 码元序", () => {
    const all = [ins("P-b-2021", { projectId: "P" }), ins("P-B-2021", { projectId: "P" }), ins("P-A-2021", { projectId: "P" })];
    expect(siblingsByProject(all, "P").map((i) => i.symbol)).toEqual(["P-A-2021", "P-B-2021", "P-b-2021"]);
  });
});

describe("sortOptionsByLabel", () => {
  const opt = (value: string, label: string) => ({ value, label });

  it("按显示文字、用给定语言的 collator 排序,不改入参", () => {
    const options = [opt("林业碳汇", "Forestry sink"), opt("可再生能源", "Renewable energy"), opt("蓝碳", "Blue carbon"), opt("甲烷回收", "Methane capture")];
    const before = options.map((o) => o.value);
    expect(sortOptionsByLabel(options, new Intl.Collator("en")).map((o) => o.label)).toEqual(["Blue carbon", "Forestry sink", "Methane capture", "Renewable energy"]);
    expect(options.map((o) => o.value)).toEqual(before);
  });

  it("中文界面按 zh-CN collator(拼音)排", () => {
    const options = ["林业碳汇", "可再生能源", "蓝碳", "能效", "甲烷回收"].map((v) => opt(v, v));
    expect(sortOptionsByLabel(options, new Intl.Collator("zh-CN")).map((o) => o.label)).toEqual(["甲烷回收", "可再生能源", "蓝碳", "林业碳汇", "能效"]);
  });

  it("显示文字比不出先后时按原值码元序,结果确定", () => {
    const options = [opt("b", "Same"), opt("a", "same"), opt("c", "Same")];
    const base = new Intl.Collator("en", { sensitivity: "base" }); // Same 与 same 视为相等
    expect(sortOptionsByLabel(options, base).map((o) => o.value)).toEqual(["a", "b", "c"]);
  });
});

describe("matchesQuery / filterByQuery", () => {
  const forest = ins("VCS-FOR-2021", { name: "云南森林经营碳汇项目", registry: "Verra", projectType: "林业碳汇" });
  const labelsEn = ["Yunnan Forest Management Carbon Sink", "Verra", "Forestry sink"];

  it("匹配 symbol 与种子原值,大小写不敏感、先 trim;空白 q 恒为真", () => {
    expect(matchesQuery(forest, "vcs-for")).toBe(true);
    expect(matchesQuery(forest, "森林")).toBe(true);
    expect(matchesQuery(forest, " VERRA ")).toBe(true);
    expect(matchesQuery(forest, "碳汇")).toBe(true);
    expect(matchesQuery(forest, "   ")).toBe(true);
    expect(matchesQuery(forest, undefined)).toBe(true);
  });

  it("翻译后的显示标签也能命中;不给标签时英文词找不到中文原值", () => {
    expect(matchesQuery(forest, "forest")).toBe(false);
    expect(matchesQuery(forest, "forest", labelsEn)).toBe(true);
    expect(matchesQuery(forest, "yunnan", labelsEn)).toBe(true);
    expect(matchesQuery(forest, "forestry SINK", labelsEn)).toBe(true);
    expect(matchesQuery(forest, "solar", labelsEn)).toBe(false);
  });

  it("filterByQuery 保持入参顺序;空白 q 返回同一个数组引用", () => {
    const list = [row(ins("B-1", { name: "Beta" })), row(ins("A-1", { name: "Alpha" })), row(ins("C-1", { name: "Alphabet" }))];
    const labelsOf = (i: Instrument) => [`label ${i.symbol.toLowerCase()}`];
    expect(filterByQuery(list, "", labelsOf)).toBe(list);
    expect(filterByQuery(list, "  ", labelsOf)).toBe(list);
    expect(symbols(filterByQuery(list, "alpha", labelsOf))).toEqual(["A-1", "C-1"]);
    expect(symbols(filterByQuery(list, "label b-", labelsOf))).toEqual(["B-1"]);
    expect(list.map((r) => r.instrument.symbol)).toEqual(["B-1", "A-1", "C-1"]);
  });
});

describe("siblingsByProject", () => {
  const all: Instrument[] = [
    ins("VCS-FOR-2023", { vintage: 2023, projectId: "SIM-PRJ-VCS-FOR" }),
    ins("VCS-FOR-2021", { vintage: 2021, projectId: "SIM-PRJ-VCS-FOR" }),
    ins("VCS-FOR-2022", { vintage: 2022, projectId: "SIM-PRJ-VCS-FOR" }),
    ins("VCS-COOK-2021", { vintage: 2021, projectId: "SIM-PRJ-VCS-COOK" }),
    ins("CEA-SCEN-2026", { vintage: 2026, projectId: "SIM-PRJ-VCS-FOR", isScenario: true }),
    ins("ORPHAN-2021", { projectId: null }),
  ];

  it("同 projectId、按 vintage 升序,排除自身与情景标的", () => {
    expect(siblingsByProject(all, "SIM-PRJ-VCS-FOR", "VCS-FOR-2021").map((i) => i.symbol)).toEqual(["VCS-FOR-2022", "VCS-FOR-2023"]);
  });

  it("不给 excludeSymbol 时返回整个项目(仍不含情景标的)", () => {
    expect(siblingsByProject(all, "SIM-PRJ-VCS-FOR").map((i) => i.symbol)).toEqual(["VCS-FOR-2021", "VCS-FOR-2022", "VCS-FOR-2023"]);
  });

  it("projectId 为 null / 空串 → [],不按 null 把未知项目归成一组", () => {
    expect(siblingsByProject(all, null, "ORPHAN-2021")).toEqual([]);
    expect(siblingsByProject(all, "")).toEqual([]);
  });

  it("项目只有自身一个 vintage → [];不改入参顺序", () => {
    const before = all.map((i) => i.symbol);
    expect(siblingsByProject(all, "SIM-PRJ-VCS-COOK", "VCS-COOK-2021")).toEqual([]);
    expect(all.map((i) => i.symbol)).toEqual(before);
  });
});

describe("价格输入换算(美元串 ↔ 整数分)", () => {
  it("合法输入换成整数分,无浮点误差", () => {
    expect(priceInputToCents("12")).toBe(1200);
    expect(priceInputToCents("12.5")).toBe(1250);
    expect(priceInputToCents(" 4.35 ")).toBe(435);
    expect(priceInputToCents(".5")).toBe(50);
    expect(priceInputToCents("0")).toBe(0);
    expect(priceInputToCents("12.")).toBe(1200);
  });

  it("空串、负数、三位小数、非数字、指数写法 → undefined", () => {
    for (const bad of ["", "  ", "-1", "1.234", "abc", "1e3", "1,000", "."]) expect(priceInputToCents(bad), bad).toBeUndefined();
  });

  it("整数分 → 两位小数串,可再解析回同一值", () => {
    expect(centsToPriceInput(undefined)).toBe("");
    expect(centsToPriceInput(1250)).toBe("12.50");
    expect(centsToPriceInput(5)).toBe("0.05");
    for (const c of [0, 1, 99, 100, 435, 987654]) expect(priceInputToCents(centsToPriceInput(c))).toBe(c);
  });
});

describe("syncPriceInput(外部改了价格筛选后,输入框里的原文怎么办)", () => {
  it("原文仍表示新值:保留(正在输入的「12.5」「12.」不被改写成 12.50)", () => {
    expect(syncPriceInput("12.5", 1250)).toBe("12.5");
    expect(syncPriceInput("12.", 1200)).toBe("12.");
    expect(syncPriceInput("", undefined)).toBe("");
    expect(syncPriceInput("  ", undefined)).toBe("  ");
  });

  it("原文表示别的值:换成新值的标准写法", () => {
    expect(syncPriceInput("12.5", 1300)).toBe("13.00");
    expect(syncPriceInput("12.5", undefined)).toBe("");
    expect(syncPriceInput("", 1250)).toBe("12.50");
  });

  it("审查复现:框里是解析不了的「12.5x」,点「清除筛选」(值变 undefined)→ 清空,不再残留红框", () => {
    // 旧写法只比 priceInputToCents(text) !== cents:undefined === undefined,原文被留下
    expect(priceInputToCents("12.5x")).toBeUndefined();
    expect(syncPriceInput("12.5x", undefined)).toBe("");
    expect(syncPriceInput("abc", 1250)).toBe("12.50");
  });
});
