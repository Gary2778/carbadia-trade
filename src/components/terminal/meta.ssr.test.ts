import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, InstrumentListItem, Ticker } from "@/shared";
import type { Lang } from "@/i18n/config";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import { tProjectType, tRegistry } from "@/i18n/data";
import { getCreditProfile } from "@/lib/exchange/carbon";
import { INSTRUMENT_SEEDS } from "@/lib/exchange/ensure-instruments";
import { facets, filterInstruments, setFilter, type InstrumentFilters as Filters } from "@/lib/market/instrument-filter";
import { createInitialState, marketActions, useMarketStore } from "@/lib/market/store";
import { CarbonMetaPanel } from "./CarbonMetaPanel";
import { INSTRUMENT_SEARCH_ID, InstrumentFilters } from "./InstrumentFilters";
import { InstrumentPanel, filtersFromRestoredUrl, firstInstrumentMatch, focusInstrumentSearch, panelRows } from "./InstrumentPanel";
import { VintageSelector } from "./VintageSelector";

// 标的面板、vintage 选择器与碳元数据面板的服务端标记测试(计划 §3.1、§6.1 SSR 首屏规则、§9.1 第 7 条:node 环境,不引 jsdom)。
// 要证明的是:① 元数据缺失一律「未提供」,核证状态只出现模拟标记,链接只有 getCreditProfile 给的登记处网站,不杜撰任何值;
// ② store 为空时左栏 14 行、vintage chip、元数据全部来自 props,store 里有什么都不改变 HTML(渲染期不读 / 不写 store)。

// 语言:LangProvider 的上下文不导出,按模块边界打桩成可切换的当前语言(其余导出原样)
const i18n = vi.hoisted(() => ({ lang: "en" as Lang }));
vi.mock("@/i18n/LangProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/LangProvider")>();
  // 完整文案(核心 + terminal)直接取合并对象:useT 整个被换掉,不经 TerminalMessagesProvider(P2-01 起 @/i18n 的 MESSAGES 只有核心命名空间)。
  // 不能在这个工厂里引入 @/i18n/test-support:它经 TerminalMessages 又引入正在被替换的 LangProvider,会互相等待
  const ALL = { en: (await import("@/i18n/messages/en")).default, "zh-CN": (await import("@/i18n/messages/zh-CN")).default };
  return {
    ...actual,
    useLang: () => ({ lang: i18n.lang, setLang: () => {} }),
    useT: (ns: keyof typeof ALL.en) => ALL[i18n.lang][ns],
  };
});

const TS = 1_790_000_000_000;
const SYMBOL_RE = /(VCS|CCER|GS|CDM|CEA)-[A-Z]+-[0-9]{4}/g;
const count = (html: string, needle: string) => html.split(needle).length - 1;
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

function instrumentOf(
  seed: { symbol: string; name: string; standard: string; projectType: string; vintage: number; country: string; registry: string; mid: number; projectId: string | null },
  i: number,
  isScenario = false,
): Instrument {
  return {
    id: `asset-${i}`,
    symbol: seed.symbol,
    name: seed.name,
    standard: seed.standard,
    projectType: seed.projectType,
    vintage: seed.vintage,
    country: seed.country,
    registry: seed.registry,
    isScenario,
    projectId: seed.projectId,
    methodology: null,
    verificationStatus: null,
    tickSize: 1,
    pricePrecision: 2,
    qtyStep: 1,
    minQty: 1,
    currency: "USD",
    lastPrice: seed.mid,
  };
}
const tickerOf = (symbol: string, lastPrice: number, i: number): Ticker => ({
  symbol,
  lastPrice,
  bestBid: lastPrice - 5,
  bestAsk: lastPrice + 5,
  change24h: i % 2 === 0 ? 1.25 : -0.5,
  high24h: lastPrice + 40,
  low24h: lastPrice - 40,
  volume24h: 100 + i,
  ts: TS,
});

// 12 条多 vintage 种子 + 2 个情景标的(shadow.ts 的 SCENARIO_ASSETS 形状:projectId null、registry 为情景原值)= 生产的 14 个标的
const SCENARIOS = [
  { symbol: "CEA-SCEN-2026", name: "全国碳市场配额情景(CEA)", standard: "CEA", projectType: "配额情景", vintage: 2026, country: "中国", registry: "情景标的(无真实登记)", mid: 9000, projectId: null },
  { symbol: "CCER-SCEN-2026", name: "CCER 市场指数情景", standard: "CCER", projectType: "配额情景", vintage: 2026, country: "中国", registry: "情景标的(无真实登记)", mid: 9000, projectId: null },
];
const INSTRUMENTS: Instrument[] = [...INSTRUMENT_SEEDS.map((s, i) => instrumentOf(s, i)), ...SCENARIOS.map((s, i) => instrumentOf(s, 20 + i, true))];
const ITEMS: InstrumentListItem[] = INSTRUMENTS.map((instrument, i) => ({ instrument, ticker: tickerOf(instrument.symbol, instrument.lastPrice ?? 0, i) }));
const bySymbol = (symbol: string) => INSTRUMENTS.find((x) => x.symbol === symbol)!;

/** 全部可空字段为 null、字符串元数据为空串的标的(年份是 number,照常显示) */
const ALL_NULL: Instrument = {
  ...instrumentOf({ symbol: "X-NULL-2021", name: "", standard: "", projectType: "", vintage: 2021, country: "", registry: "", mid: 100, projectId: null }, 99),
  lastPrice: null,
};

const renderMeta = (instrument: Instrument | undefined, symbol = instrument?.symbol ?? "X-NONE-2021") =>
  renderToStaticMarkup(createElement(CarbonMetaPanel, { symbol, initial: instrument }));
const renderPanel = (initialFilters = {}) =>
  renderToStaticMarkup(createElement(InstrumentPanel, { symbol: "VCS-FOR-2021", initialItems: ITEMS, initialFilters }));
const renderVintages = (current: string) =>
  renderToStaticMarkup(createElement(VintageSelector, { projectId: bySymbol(current).projectId, current, initialItems: ITEMS }));

beforeEach(() => {
  i18n.lang = "en";
  useMarketStore.setState(createInitialState(), true);
});
afterEach(() => {
  useMarketStore.setState(createInitialState(), true);
});

describe("CarbonMetaPanel", () => {
  it("shows Not provided for each of the five unknown fields of an all-null instrument, and no link or simulated mark", () => {
    const html = renderMeta(ALL_NULL);
    expect(html).toContain('data-area="meta"');
    expect(html).toContain(`>${en.terminal.meta.title}<`);
    // 项目类型、方法学、注册机构、核证状态、项目编号;年份是数字,照常显示
    expect(count(html, `>${en.terminal.meta.notProvided}<`)).toBe(5);
    expect(count(html, "data-not-provided")).toBe(5);
    expect(html).toMatch(/data-meta="vintage".*?<dd[^>]*><span class="tnum">2021<\/span><\/dd>/);
    expect(html).not.toContain("href=");
    expect(html).not.toContain("data-simulated");
    expect(html).not.toContain(en.ui.simulatedUnverified);
    expect(html).not.toContain("data-scenario");
  });

  it("treats a non-positive vintage as not provided rather than printing 0", () => {
    const html = renderMeta({ ...ALL_NULL, vintage: 0 });
    expect(count(html, `>${en.terminal.meta.notProvided}<`)).toBe(6);
  });

  it("marks SIMULATED_UNVERIFIED as simulated instead of printing a verification claim", () => {
    const html = renderMeta({ ...ALL_NULL, verificationStatus: "SIMULATED_UNVERIFIED" });
    expect(count(html, `>${en.terminal.meta.notProvided}<`)).toBe(4);
    expect(html).toMatch(new RegExp(`data-simulated=""[^>]*>${en.ui.simulatedUnverified}<`));
    expect(html).not.toMatch(/\bverified\b/i); // 只有 "unverified",没有单独的 verified 声明
  });

  it("matches INSTRUMENT_SEEDS exactly: seed values, simulated project IDs, only the profile's registry-site link", () => {
    for (const ins of INSTRUMENTS.filter((x) => !x.isScenario)) {
      const html = renderMeta(ins);
      const profileUrl = getCreditProfile(ins).registryUrl;
      // 方法学与核证状态在种子里全是 null:都显示「未提供」,不补任何值
      expect(count(html, `>${en.terminal.meta.notProvided}<`), ins.symbol).toBe(2);
      expect(html, ins.symbol).toContain(`>${tProjectType(ins.projectType, "en")}<`);
      expect(html, ins.symbol).toContain(`>${tRegistry(ins.registry, "en")}<`);
      expect(html, ins.symbol).toContain(`<span class="tnum">${ins.vintage}</span>`);
      // 模拟项目编号原样显示并加注「不是登记机构记录」
      expect(html, ins.symbol).toContain(`>${ins.projectId}<`);
      expect(html, ins.symbol).toMatch(new RegExp(`data-simulated=""[^>]*>${en.terminal.meta.simulatedProjectId}<`));
      // 唯一的链接就是按 standard 取的 registryUrl;不含项目编号、代码或任何拼出来的路径
      const links = hrefs(html);
      expect(links, ins.symbol).toEqual(profileUrl ? [profileUrl] : []);
      for (const link of links) {
        expect(link).not.toContain(ins.projectId!);
        expect(link).not.toContain(ins.symbol);
        expect(link).not.toMatch(/SIM-/);
      }
      if (profileUrl) {
        expect(html).toContain('rel="noopener noreferrer"');
        // 链接文字是中性的「登记处或项目方网站」:CDM 的地址是项目检索页、ACCU 是计划页,不都是「登记簿首页」
        expect(html, ins.symbol).toMatch(new RegExp(`<a [^>]*href="${profileUrl.replace(/[.?]/g, "\\$&")}"[^>]*>${en.terminal.meta.registrySite}<`));
        expect(html, ins.symbol).not.toContain(en.terminal.meta.registryLink);
      }
    }
  });

  it("tags scenario instruments and does not link them to any registry", () => {
    const html = renderMeta(bySymbol("CCER-SCEN-2026"));
    expect(html).toMatch(new RegExp(`data-scenario=""[^>]*>${en.terminal.meta.scenario}<`));
    expect(html).not.toContain("href=");
    // 项目编号、方法学、核证状态未知
    expect(count(html, `>${en.terminal.meta.notProvided}<`)).toBe(3);
  });

  it("renders 未提供 in zh-CN", () => {
    i18n.lang = "zh-CN";
    const html = renderMeta(ALL_NULL);
    expect(zhCN.terminal.meta.notProvided).toBe("未提供");
    expect(count(html, ">未提供<")).toBe(5);
    expect(html).toContain(`>${zhCN.terminal.meta.title}<`);
    expect(html).not.toContain(en.terminal.meta.notProvided);
  });

  it("renders a skeleton, not invented values, when the instrument is unknown", () => {
    const html = renderMeta(undefined);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(en.terminal.meta.notProvided);
    expect(html).not.toContain("<dl");
  });

  it("markup comes from props only: a populated store does not change the server render", () => {
    const ins = bySymbol("VCS-FOR-2021");
    const empty = renderMeta(ins);
    marketActions.setInstruments([{ instrument: { ...ins, methodology: "STORE-ONLY", projectId: "STORE-PRJ" }, ticker: tickerOf(ins.symbol, 1, 0) }]);
    expect(useMarketStore.getState().instrumentsVersion).toBeGreaterThan(0);
    expect(renderMeta(ins)).toBe(empty);
  });
});

describe("InstrumentPanel", () => {
  // P1-25d 终审修复:浏览器前进 / 后退恢复缓存页时,RSC 的 initialFilters 是首次请求时的({}),地址栏却是后来
  // replaceState 写进去的 ?q=forest。挂载后以 URL 为准对一次:规范化后相同就不动(不多一次渲染),不同就换成 URL 的。
  describe("filtersFromRestoredUrl (URL wins after a back / forward restore)", () => {
    it("returns the URL filters when the restored props are stale", () => {
      expect(filtersFromRestoredUrl({}, { q: "forest" })).toEqual({ q: "forest" });
      expect(filtersFromRestoredUrl({ q: "forest" }, {})).toEqual({});
      expect(filtersFromRestoredUrl({ q: "forest", sort: "price" }, { q: "forest", sort: "change" })).toEqual({ q: "forest", sort: "change" });
    });

    it("returns null when both describe the same filters (key order, blanks and false flags do not count)", () => {
      expect(filtersFromRestoredUrl({}, {})).toBeNull();
      expect(filtersFromRestoredUrl({ q: "forest", vintage: 2022 }, { vintage: 2022, q: "forest" })).toBeNull();
      expect(filtersFromRestoredUrl({ q: " forest " }, { q: "forest" })).toBeNull();
      expect(filtersFromRestoredUrl({ q: "", watchlistOnly: false }, {})).toBeNull();
    });
  });

  // 终审复核:当前行铺的是 --terminal-selected 染色,浅色下 --muted-2 在它上面只有 4.26:1(--muted 也只有 4.46)。
  // 当前行的标的名改用 --foreground;其余行照旧 --muted-2(门禁 contrast.test.ts 的「染色底」一节)
  it("renders the active row's instrument name in --foreground (the selected wash is too dark for the muted greys)", () => {
    const html = renderPanel();
    const rowOf = (symbol: string) => {
      const start = html.indexOf(`data-symbol="${symbol}"`);
      expect(start, symbol).toBeGreaterThan(-1);
      const next = html.indexOf("data-symbol=", start + 1);
      return html.slice(start, next === -1 ? undefined : next);
    };
    const active = rowOf("VCS-FOR-2021");
    expect(active).toContain('data-active=""');
    expect(active).toMatch(/<span class="truncate text-t-2xs text-foreground">[^<]+<\/span>/);
    expect(active).not.toContain("text-muted-2\">");
    const other = rowOf("VCS-FOR-2022");
    expect(other).not.toContain("data-active");
    expect(other).toMatch(/<span class="truncate text-t-2xs text-muted-2">[^<]+<\/span>/);
  });

  it("pluralises the English instrument count (1 instrument, 0 / 2 instruments) and keeps zh-CN as a function", () => {
    expect(en.terminal.instruments.count(1)).toBe("1 instrument");
    expect(en.terminal.instruments.count(0)).toBe("0 instruments");
    expect(en.terminal.instruments.count(2)).toBe("2 instruments");
    expect(zhCN.terminal.instruments.count(1)).toBe("1 个标的");
    const one = renderPanel({ q: "VCS-FOR-2022" });
    expect(one).toContain(">1 instrument<");
  });

  it("renders all 14 symbols from props while the store is empty, inside the virtual list", () => {
    expect(ITEMS).toHaveLength(14);
    expect(useMarketStore.getState().instrumentsVersion).toBe(0);
    const html = renderPanel();
    expect(new Set(html.match(SYMBOL_RE))).toEqual(new Set(INSTRUMENTS.map((x) => x.symbol)));
    for (const x of INSTRUMENTS) expect(html, x.symbol).toContain(`data-symbol="${x.symbol}"`);
    expect(html).toContain(`role="region" aria-label="${en.terminal.a11y.instrumentsRegion}"`);
    expect(html).toContain(`>${en.terminal.instruments.count(14)}<`);
    expect(html).toContain(`id="${INSTRUMENT_SEARCH_ID}"`);
    // 当前行高亮并指向深链;行是 div(VirtualList 的包装层里不能放 li)
    expect(html).toContain('href="/trade/VCS-FOR-2021" aria-current="page"');
    expect(html).not.toContain("<li");
  });

  it("applies the URL filters on the server render (same pure parse as the client)", () => {
    const html = renderPanel({ q: "gs-" });
    expect(new Set(html.match(/data-symbol="([^"]+)"/g))).toEqual(
      new Set(INSTRUMENTS.filter((x) => x.symbol.startsWith("GS-")).map((x) => `data-symbol="${x.symbol}"`)),
    );
    expect(html).toContain('value="gs-"');
    expect(html).toContain(`>${en.terminal.instruments.clear}<`);
  });

  it("search matches the translated labels shown in the rows, not only the Chinese seed values", () => {
    const rowsOf = (html: string) => new Set([...html.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]));
    const forest = INSTRUMENTS.filter((x) => x.symbol.startsWith("VCS-FOR-")).map((x) => x.symbol);
    expect(forest).toHaveLength(3);
    // 名称(Yunnan Forest …)与项目类型(Forestry sink)都是英文翻译;种子原值是中文
    const html = renderPanel({ q: "forest" });
    expect(rowsOf(html)).toEqual(new Set(forest));
    expect(html).toContain(`>${en.terminal.instruments.count(3)}<`);
    expect(html).not.toContain(`>${en.terminal.instruments.empty}<`);
    expect(rowsOf(renderPanel({ q: "Yunnan" }))).toEqual(new Set(forest));
    expect(rowsOf(renderPanel({ q: "mangrove" }))).toEqual(new Set(["GS-MANG-2022", "GS-MANG-2023"]));
    expect(rowsOf(renderPanel({ q: "KENYA" }))).toEqual(new Set(["VCS-COOK-2020", "VCS-COOK-2021"]));
    expect(rowsOf(renderPanel({ q: "solar" }))).toEqual(new Set(["CCER-SOL-2022", "CCER-SOL-2023"]));
    // 注册机构的翻译标签(China CCER Registry)也算
    expect(rowsOf(renderPanel({ q: "ccer registry" }))).toEqual(new Set(["CCER-SOL-2022", "CCER-SOL-2023"]));
    // 种子原值照样命中,与其它筛选取交集
    expect(rowsOf(renderPanel({ q: "森林" }))).toEqual(new Set(forest));
    expect(rowsOf(renderPanel({ q: "forest", vintage: 2022 }))).toEqual(new Set(["VCS-FOR-2022"]));
  });

  it("search does not depend on the UI language: the same ?q= gives the same rows in en and zh-CN (no post-hydration flip)", () => {
    const rowsOf = (html: string) => new Set([...html.matchAll(/data-symbol="([^"]+)"/g)].map((m) => m[1]));
    const forest = INSTRUMENTS.filter((x) => x.symbol.startsWith("VCS-FOR-")).map((x) => x.symbol);
    const queries = ["forest", "Yunnan", "mangrove", "红树林", "ccer registry", "森林", "solar", "kenya"];
    const en = queries.map((q) => rowsOf(renderPanel({ q })));
    i18n.lang = "zh-CN";
    // 审查复现:深链 ?q=forest 在 SSR(DEFAULT_LANG = en)出三行,zh-CN 偏好的读者水合后不能掉成 0 行
    const zhForest = renderPanel({ q: "forest" });
    expect(rowsOf(zhForest)).toEqual(new Set(forest));
    expect(zhForest).toContain(`>${zhCN.terminal.instruments.count(3)}<`);
    expect(zhForest).not.toContain(`>${zhCN.terminal.instruments.empty}<`);
    expect(rowsOf(renderPanel({ q: "红树林" }))).toEqual(new Set(["GS-MANG-2022", "GS-MANG-2023"]));
    expect(queries.map((q) => rowsOf(renderPanel({ q })))).toEqual(en);
  });

  it("server render never compares with the runtime default locale (filtered deep link with every advanced filter)", () => {
    // 服务端(Node,en-US)与 zh-CN 浏览器的默认 locale 不同:渲染期任何不带 locale 的 localeCompare 都会让两边出不同顺序
    const spy = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("localeCompare depends on the runtime default locale");
    });
    try {
      const html = renderPanel({ registry: "Gold Standard", projectType: "蓝碳", vintage: 2023, minPrice: 100, maxPrice: 20000, sort: "symbol" });
      expect(html).toContain("<select");
      expect(html).toContain('data-symbol="GS-MANG-2023"');
      expect(renderVintages("VCS-FOR-2022")).toContain("/trade/VCS-FOR-2021");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("shows the empty state with a clear action when nothing matches (watchlist is empty on the server)", () => {
    const html = renderPanel({ watchlistOnly: true });
    expect(html).not.toMatch(/data-symbol="/);
    expect(html).toContain(`>${en.terminal.instruments.empty}<`);
    expect(count(html, `>${en.terminal.instruments.clear}<`)).toBe(2); // 筛选条 + 空态入口
    expect(html).toContain(`>${en.terminal.instruments.count(0)}<`);
  });

  it("Enter in the search picks the first match from the panel's filtered data: the row the list renders first", () => {
    // 与 InstrumentPanel 同一条管线:useInstrumentList(除 q 以外的筛选)的纯函数部分 → panelRows(再按两种语言的标签过 q)
    const firstOf = (f: Filters) => {
      const listed = filterInstruments(
        ITEMS.map((item) => ({ instrument: item.instrument, ticker: item.ticker, starred: false })),
        setFilter(f, "q", undefined),
      );
      return firstInstrumentMatch(panelRows(listed, f.q), f.q);
    };
    const firstRendered = (f: Filters) => renderPanel(f).match(/data-symbol="([^"]+)"/)?.[1];
    for (const f of [{ q: "forest" }, { q: "forest", sort: "change" }, { q: "gs-", sort: "price" }, { q: "ccer registry" }, { q: "森林", vintage: 2022 }] as Filters[]) {
      const first = firstOf(f);
      expect(first, JSON.stringify(f)).not.toBeNull();
      expect(first, JSON.stringify(f)).toBe(firstRendered(f));
    }
    // 排序决定第一条:按 24h 量排序时是量最大的那个 GS 标的,不是种子顺序里的第一个
    const gs = ITEMS.filter((item) => item.instrument.symbol.startsWith("GS-"));
    const loudest = gs.reduce((a, b) => (b.ticker.volume24h > a.ticker.volume24h ? b : a)).instrument.symbol;
    expect(firstOf({ q: "gs-", sort: "volume" })).toBe(loudest);
    expect(firstOf({ q: "gs-" })).toBe(gs[0].instrument.symbol);
    expect(loudest).not.toBe(gs[0].instrument.symbol);
  });

  it("the first-match action does nothing for a blank search or when nothing matches", () => {
    const rows = panelRows(
      ITEMS.map((item) => ({ instrument: item.instrument, ticker: item.ticker, starred: false })),
      undefined,
    );
    expect(rows).toHaveLength(14);
    expect(firstInstrumentMatch(rows, undefined)).toBeNull();
    expect(firstInstrumentMatch(rows, "   ")).toBeNull();
    expect(firstInstrumentMatch([], "forest")).toBeNull();
    expect(firstInstrumentMatch(panelRows(rows, "no-such-thing"), "no-such-thing")).toBeNull();
  });

  it("focusInstrumentSearch is a no-op without a document (server / node)", () => {
    expect(typeof document).toBe("undefined");
    expect(focusInstrumentSearch()).toBe(false);
  });

  it("does not leak store state into the server render", () => {
    const empty = renderPanel();
    marketActions.setInstruments(ITEMS.slice(0, 3).map((item) => ({ ...item, ticker: { ...item.ticker, lastPrice: 1, ts: TS + 1 } })));
    marketActions.setWatchlist(["VCS-FOR-2021"]);
    expect(renderPanel()).toBe(empty);
  });
});

describe("InstrumentFilters", () => {
  const f = facets(ITEMS);

  it("keeps advanced filters folded by default and lists facets in the current language when opened by URL filters", () => {
    const folded = renderToStaticMarkup(createElement(InstrumentFilters, { filters: {}, facets: f, onChange: () => {} }));
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).not.toContain("<select");
    expect(folded).not.toContain(en.terminal.instruments.clear);

    const html = renderToStaticMarkup(createElement(InstrumentFilters, { filters: { registry: "Verra", vintage: 2022, minPrice: 1250, sort: "price" }, facets: f, onChange: () => {} }));
    expect(html).toContain('aria-expanded="true"');
    expect(count(html, "<select")).toBe(3);
    for (const label of [en.terminal.instruments.registry, en.terminal.instruments.projectType, en.terminal.instruments.vintage]) {
      expect(html).toContain(`<select aria-label="${label}"`);
    }
    // 选项的值是种子原值,显示按当前语言翻译
    expect(html).toContain(`<option value="国家温室气体自愿减排登记簿">${tRegistry("国家温室气体自愿减排登记簿", "en")}</option>`);
    expect(html).toContain(`<option value="林业碳汇">${tProjectType("林业碳汇", "en")}</option>`);
    for (const y of f.vintages) expect(html).toMatch(new RegExp(`<option value="${y}"( selected="")?>${y}</option>`));
    expect(html).toContain('<option value="Verra" selected="">');
    expect(html).toContain('<option value="2022" selected="">');
    expect(html).toContain('value="12.50"');
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${en.terminal.instruments.sortPrice}<`));
    expect(html).toContain(`>${en.terminal.instruments.clear}<`);
  });

  /** 某个 select(按 aria-label 找)里的选项文字,去掉「全部」 */
  const optionLabels = (html: string, label: string) => {
    const start = html.indexOf(`<select aria-label="${label}"`);
    const body = html.slice(start, html.indexOf("</select>", start));
    return [...body.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].filter((m) => m[1] !== "").map((m) => m[2]);
  };
  const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  it("orders the text options by their displayed label in the UI language, not by the Chinese seed values", () => {
    const html = renderToStaticMarkup(createElement(InstrumentFilters, { filters: { sort: "price" }, facets: f, onChange: () => {} }));
    const projectTypes = optionLabels(html, en.terminal.instruments.projectType).map(decode);
    const registries = optionLabels(html, en.terminal.instruments.registry).map(decode);
    expect(projectTypes).toEqual(["Allowance scenario", "Blue carbon", "Efficiency", "Forestry sink", "Methane capture", "Renewable energy"]);
    expect(registries).toEqual(["China CCER Registry", "Gold Standard", "Scenario instrument (no real registry)", "UNFCCC", "Verra"]);
    const collator = new Intl.Collator("en");
    expect(projectTypes).toEqual([...projectTypes].sort(collator.compare));

    i18n.lang = "zh-CN";
    const zh = renderToStaticMarkup(createElement(InstrumentFilters, { filters: { sort: "price" }, facets: f, onChange: () => {} }));
    // 中文界面按拼音:jia < ke < lan < lin < neng < pei
    expect(optionLabels(zh, zhCN.terminal.instruments.projectType)).toEqual(["甲烷回收", "可再生能源", "蓝碳", "林业碳汇", "能效", "配额情景"].map((p) => tProjectType(p, "zh-CN")));
  });
});

describe("VintageSelector", () => {
  it("lists the other vintages of the project as links, not the current one", () => {
    const html = renderVintages("VCS-FOR-2021");
    expect(html).toContain(`aria-label="${en.terminal.instruments.vintages}"`);
    expect(hrefs(html)).toEqual(["/trade/VCS-FOR-2022", "/trade/VCS-FOR-2023"]);
    expect(html).not.toContain('data-symbol="VCS-FOR-2021"');
    expect(html).toContain(">2022<");
    expect(html).toContain(">2023<");
  });

  it("renders nothing for scenario instruments or a project without other vintages", () => {
    expect(renderVintages("CEA-SCEN-2026")).toBe("");
    expect(renderToStaticMarkup(createElement(VintageSelector, { projectId: "SIM-PRJ-NONE", current: "X-1", initialItems: ITEMS }))).toBe("");
    expect(renderToStaticMarkup(createElement(VintageSelector, { projectId: null, current: "VCS-FOR-2021", initialItems: ITEMS }))).toBe("");
  });

  it("every seeded project with two vintages shows exactly one sibling chip, same markup with a populated store", () => {
    for (const symbol of ["CCER-SOL-2023", "GS-WIND-2022", "GS-MANG-2023", "VCS-COOK-2020"]) {
      expect(hrefs(renderVintages(symbol)), symbol).toHaveLength(1);
    }
    expect(hrefs(renderVintages("CDM-METH-2019"))).toEqual([]);
    const empty = renderVintages("VCS-FOR-2022");
    marketActions.setInstruments(ITEMS);
    expect(renderVintages("VCS-FOR-2022")).toBe(empty);
  });
});
