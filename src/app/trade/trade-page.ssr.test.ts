import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, InstrumentListItem, Ticker } from "@/shared";
import { generateMetadata } from "@/app/trade/[symbol]/layout";
import TradeLayout from "@/app/trade/layout";
import TradePage from "@/app/trade/[symbol]/page";
import { connectionBadgeKind, lastMessageTime } from "@/components/terminal/ConnectionBadge";
import { INSTRUMENT_SEARCH_ID } from "@/components/terminal/InstrumentFilters";
import { MOBILE_TABS, initialMobileTab, nextMobileTab } from "@/components/terminal/MobileTabs";
import { TerminalShell, hotkeyAllowedWithDrawer, mobileTabFor, trapFocusTarget } from "@/components/terminal/TerminalShell";
import { HOTKEYS } from "@/lib/market/hotkeys";
import { layoutFor } from "@/components/terminal/useTerminalLayout";
import en from "@/i18n/messages/en";
import { INSTRUMENT_SEEDS } from "@/lib/exchange/ensure-instruments";
import { fmtPrice } from "@/lib/format";
import { createInitialState, marketActions, useMarketStore } from "@/lib/market/store";

// 终端首屏的服务端标记测试(计划 §3.2「SSR 首屏」、§6.1 SSR 首屏规则、§9.1 第 7 条:node 环境,不引 jsdom)。
// 要证明的是:头部与左栏 14 行只来自 initialInstruments props,渲染期不读 / 不写 store —— zustand 5 在服务端与水合期
// 读 getInitialState()(空),所以首屏写成 store 值 ?? props 值;store 里有什么都不该改变 HTML。

// 图表库只能经 next/dynamic({ ssr: false }) 在浏览器里加载:测试进程一旦 import 它就直接失败
vi.mock("lightweight-charts", () => {
  throw new Error("lightweight-charts must not be imported by the terminal's server render");
});

// App Router 之外没有 pathname / searchParams 上下文,按 next/navigation 的模块边界打桩(同 Nav.ssr.test.ts)
const nav = vi.hoisted(() => ({ pathname: null as string | null, search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

// page.tsx 的数据源:listInstruments 查库,这里换成固定的 14 个标的(INITIAL 在下面定义,调用时才取)
vi.mock("@/lib/server/market-snapshots", () => ({
  listInstruments: async () => ({ instruments: INITIAL, feeSchedule: { makerBps: 0, takerBps: 0, minFeeCents: 0, demo: true }, serverTime: 0 }),
}));

const TS = 1_790_000_000_000;
const SYMBOL_RE = /(VCS|CCER|GS|CDM|CEA)-[A-Z]+-[0-9]{4}/g;

function item(seed: { symbol: string; name: string; standard: string; projectType: string; vintage: number; country: string; registry: string; mid: number }, i: number, isScenario = false): InstrumentListItem {
  const instrument: Instrument = {
    id: `asset-${i}`,
    symbol: seed.symbol,
    name: seed.name,
    standard: seed.standard,
    projectType: seed.projectType,
    vintage: seed.vintage,
    country: seed.country,
    registry: seed.registry,
    isScenario,
    projectId: isScenario ? null : `SIM-PRJ-${seed.standard}`,
    methodology: null,
    verificationStatus: null,
    tickSize: 1,
    pricePrecision: 2,
    qtyStep: 1,
    minQty: 1,
    currency: "USD",
    lastPrice: seed.mid + i,
  };
  const ticker: Ticker = {
    symbol: seed.symbol,
    lastPrice: seed.mid + i,
    bestBid: seed.mid + i - 5,
    bestAsk: seed.mid + i + 5,
    change24h: i % 3 === 0 ? 1.25 : i % 3 === 1 ? -0.5 : null,
    high24h: seed.mid + i + 40,
    low24h: seed.mid + i - 40,
    volume24h: 100 + i,
    ts: TS,
  };
  return { instrument, ticker };
}

// 12 条多 vintage 种子 + 2 个情景标的 = 生产的 14 个标的
const SCENARIOS = [
  { symbol: "CCER-SCEN-2026", name: "CCER 情景", standard: "CCER", projectType: "情景", vintage: 2026, country: "中国", registry: "—", mid: 9033 },
  { symbol: "CEA-SCEN-2026", name: "CEA 情景", standard: "CEA", projectType: "情景", vintage: 2026, country: "中国", registry: "—", mid: 9041 },
];
const INITIAL: InstrumentListItem[] = [...INSTRUMENT_SEEDS.map((s, i) => item(s, i)), ...SCENARIOS.map((s, i) => item(s, 20 + i, true))];
const byName = (symbol: string) => INITIAL.find((x) => x.instrument.symbol === symbol)!;

// /trade 下的页面都渲染在共用布局 src/app/trade/layout.tsx 之内,终端文案由它登记(P2-01:terminal 命名空间不在根 LangProvider 里)。
// 这里走真实的布局组件,而不是测试替身:布局一旦不再登记文案,下面所有用例都会抛错。
const renderToStaticMarkup = (page: React.ReactNode) => renderMarkup(createElement(TradeLayout, null, page));

const render = (props: Partial<Parameters<typeof TerminalShell>[0]> = {}) =>
  renderToStaticMarkup(createElement(TerminalShell, { symbol: "VCS-FOR-2021", initialInstruments: INITIAL, ...props }));
const symbolsIn = (html: string) => new Set(html.match(SYMBOL_RE));
const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  useMarketStore.setState(createInitialState(), true);
  nav.pathname = "/trade/VCS-FOR-2021";
  nav.search = "";
});
afterEach(() => {
  useMarketStore.setState(createInitialState(), true);
});

describe("TerminalShell server render", () => {
  it("renders the header and all 14 instrument rows from props while the store is empty", () => {
    expect(INITIAL).toHaveLength(14);
    expect(useMarketStore.getState().instrumentsVersion).toBe(0); // store 为空:下面的标记只能来自 props

    const html = render();
    expect(html).toContain('data-terminal=""');
    expect(html).toContain('data-glass="off"');
    // 行密度(P3-10):服务端与水合首帧恒为 comfortable(存储值挂载后才读),根节点带 data-density;头部有开关,未按下
    expect(html).toContain('data-glass="off" data-density="comfortable" data-layout="desktop"');
    expect(html).toContain('aria-pressed="false" aria-label="Compact rows" title="Compact rows" data-density-toggle="comfortable"');
    // 与验收同一条正则:HTML 里出现全部 14 个标的代码
    expect(symbolsIn(html)).toEqual(new Set(INITIAL.map((x) => x.instrument.symbol)));
    for (const x of INITIAL) expect(html, x.instrument.symbol).toContain(`data-symbol="${x.instrument.symbol}"`);

    // 头部:当前标的代码与最新价(FlashCell 里的 data-last-price)
    const current = byName("VCS-FOR-2021");
    expect(html).toMatch(/<h1[^>]*>VCS-FOR-2021<\/h1>/);
    const price = fmtPrice(current.ticker.lastPrice, current.instrument, "en");
    expect(html).toMatch(new RegExp(`data-last-price=""[^>]*>${price.replace(".", "\\.")}<`));
    // 当前行高亮、指向深链(新标签页打开仍是完整页面)
    expect(html).toContain('href="/trade/VCS-FOR-2021" aria-current="page"');

    // Demo 徽标与连接徽标相邻;连接徽标首屏是按构建期模式的占位(不在首屏喊「离线」),不写 Live / 实时
    expect(html).toContain(`>${en.nav.demoBadge}<`);
    expect(html).toMatch(new RegExp(`${en.terminal.connection.live}|${en.terminal.connection.polling}`));
    expect(html).toContain("data-pending");
    expect(html).not.toContain(`>${en.terminal.connection.offline}<`);
    expect(html).not.toMatch(/\bLive\b/);
    // 两个徽标紧跟最新价(计划 §3.1「紧邻最新价」):在 data-last-price 之后、24h 数据的 <dl> 之前,且同在价格组里
    const at = (needle: string) => html.indexOf(needle);
    const header = html.slice(at("<header"), at("</header>"));
    expect(at("data-last-price")).toBeGreaterThan(-1);
    expect(at('data-demo-badge="regular"')).toBeGreaterThan(at("data-last-price"));
    expect(at("data-connection=")).toBeGreaterThan(at('data-demo-badge="regular"'));
    expect(at("<dl")).toBeGreaterThan(at("data-connection="));
    const group = header.slice(header.indexOf("data-price-group"), header.indexOf("<dl"));
    for (const needle of ["data-last-price", 'data-demo-badge="regular"', "data-connection="]) expect(group).toContain(needle);

    // 面板都已接进网格(P1-22):每个 data-area 恰好一个
    for (const area of ["chart", "book", "tape", "order", "meta", "tabs"]) expect(count(html, `data-area="${area}"`), area).toBe(1);
    // 图表:ChartPanel 的工具条进 HTML,图表库本身不进(lightweight-charts 一旦被 import 本文件顶部的 mock 就会抛错),
    // 懒加载位上是面板骨架
    expect(html).toContain("data-chart-panel");
    expect(html).toContain('data-interval="1m"');
    // 盘口 / 成交:store 空 → Skeleton;底部 Tab:账户 status idle → Skeleton
    expect(count(html, 'role="status" aria-busy="true"')).toBeGreaterThanOrEqual(4);
    // 下单面板:表单首屏就画(核对按钮禁用),价格框带 priceField 快捷键的挂钩
    expect(html).toContain("data-price-field");
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Review order<\/button>/);
    // 碳元数据:来自 initial 的 instrument(方法学 / 核证状态为 null → 未提供)
    expect(html).toContain('data-meta="methodology"');
    expect(html).toContain(`>${en.terminal.meta.notProvided}<`);
    // 底部六个 Tab(P2-07 加「流水」,P3-07 加「条件单」;另有手机页签条的三个,见下一条用例)
    const bottomTabs = html.slice(html.indexOf('data-area="tabs"'));
    expect(count(bottomTabs, 'role="tab"')).toBe(6);
    expect(bottomTabs).toContain(`>${en.terminal.tabs.triggers}</button>`);
    expect(bottomTabs).toContain(`>${en.terminal.ledger.tab}</button>`);
    // 头部的同项目 vintage chip(测试数据的 projectId 按 standard 分组:VCS 的其它标的都是兄弟)
    expect(html).toContain("data-vintage-selector");
    expect(html).toContain('data-symbol="VCS-FOR-2022" aria-label="VCS-FOR-2022"');
    // 快捷键帮助只在按 ? 之后才挂载
    expect(html).not.toContain("data-shortcuts");
    expect(html).not.toContain("<dialog");
    // 服务端快照恒为 desktop:SSR 不出手机子树(页签面板与底部买卖条);页签条除外,见下一条用例
    expect(html).toContain('data-layout="desktop"');
    expect(html).not.toContain("data-mobile-actions");
    expect(html).not.toContain('data-area="mobile-panel"');
  });

  it("always renders the mobile tab strip (terminal.css shows it only below 48rem), so the phone's first frame already reserves its row", () => {
    // P1-25f:水合后才插入页签条会把图表与页脚推下约 58 px(Lighthouse 移动 CLS 0.118)。页签条现在总在 HTML 里,
    // 位置在头部与抽屉之后、第一块面板之前 —— 与手机子树里的位置相同;useTerminalLayout() 只决定面板挂在哪里
    const html = render();
    expect(count(html, 'data-area="mobile-tabs"')).toBe(1);
    const strip = html.slice(html.indexOf('data-area="mobile-tabs"'), html.indexOf('data-area="chart"'));
    expect(strip).toContain(`role="tablist" aria-label="${en.terminal.mobile.tabsLabel}"`);
    expect(count(strip, 'role="tab"')).toBe(3);
    for (const label of [en.terminal.mobile.chart, en.terminal.mobile.book, en.terminal.mobile.order]) expect(strip).toContain(`>${label}</button>`);
    // 服务端没有页签面板:页签不写 aria-controls(不指向不存在的节点)
    expect(strip).not.toContain("aria-controls");
    expect(html.indexOf('data-area="mobile-tabs"')).toBeGreaterThan(html.indexOf("</aside>"));
    expect(html.indexOf('data-area="mobile-tabs"')).toBeLessThan(html.indexOf('data-area="chart"'));
    // 根上的 data-mobile-tab 让手机的 SSR 首帧只露当前页签的面板:默认图表,?side= 落在下单页签(与 initialMobileTab 一致)
    expect(html).toContain('data-mobile-tab="chart"');
    expect(strip).toMatch(new RegExp(`aria-selected="true"[^>]*>${en.terminal.mobile.chart}<`));
    const sided = render({ initialSide: "SELL" });
    expect(sided).toContain('data-mobile-tab="order"');
    expect(sided.slice(sided.indexOf('data-area="mobile-tabs"'))).toMatch(new RegExp(`aria-selected="true"[^>]*>${en.terminal.mobile.order}<`));
  });

  it("produces byte-identical markup whatever the store holds (no getState() leak during render)", () => {
    const empty = render();
    // 灌入完全不同的数据:更高的价、不同的涨跌、连接已打开、自选有星
    marketActions.setInstruments(
      INITIAL.map((x) => ({ instrument: { ...x.instrument, name: "LEAK" }, ticker: { ...x.ticker, lastPrice: 123_456, change24h: 99, ts: TS + 1 } })),
    );
    marketActions.setConnection({ transport: "ws", state: "open", lastMessageAt: TS, rttMs: 42 });
    marketActions.setWatchlist(["VCS-FOR-2021"]);
    expect(useMarketStore.getState().instrumentsVersion).toBe(1);

    const filled = render();
    expect(filled).toBe(empty);
    expect(filled).not.toContain("LEAK");
    expect(filled).not.toContain(fmtPrice(123_456, { pricePrecision: 2 }, "en"));
  });

  it("derives the current symbol from the pathname, not the stale server prop, after a replaceState switch", () => {
    nav.pathname = "/trade/GS-WIND-2023";
    const html = render({ symbol: "VCS-FOR-2021" });
    expect(html).toMatch(/<h1[^>]*>GS-WIND-2023<\/h1>/);
    expect(html).toContain('href="/trade/GS-WIND-2023" aria-current="page"');
    expect(html).not.toContain('href="/trade/VCS-FOR-2021" aria-current="page"');
    const current = byName("GS-WIND-2023");
    expect(html).toContain(`>${fmtPrice(current.ticker.lastPrice, current.instrument, "en")}<`);
  });

  it("falls back to the server prop outside /trade/<SYMBOL> and mounts PerfHud only with ?perf=1", () => {
    nav.pathname = null;
    expect(render({ symbol: "CEA-SCEN-2026" })).toMatch(/<h1[^>]*>CEA-SCEN-2026<\/h1>/);
    nav.pathname = "/trade/CEA-SCEN-2026";
    expect(render()).not.toContain("data-perf-hud");
    nav.search = "perf=1&side=BUY";
    const withHud = render({ initialSide: "BUY" });
    expect(withHud).toContain("data-perf-hud");
    expect(withHud).toContain(`aria-label="${en.terminal.header.perf}"`);
    // ?side= 经 initialSide 进下单面板:对应方向的按钮按下
    expect(withHud).toMatch(new RegExp(`aria-pressed="true"[^>]*>${en.terminal.order.buy}<`));
    expect(render({ initialSide: "SELL" })).toMatch(new RegExp(`aria-pressed="true"[^>]*>${en.terminal.order.sell}<`));
    // HUD 不在头部的 sticky 层叠上下文里:挂在终端根下、</header> 之后
    expect(withHud.indexOf("data-perf-hud")).toBeGreaterThan(withHud.indexOf("</header>"));
  });

  it("renders the drawer closed and non-modal on the server", () => {
    const html = render();
    expect(html).toContain('data-drawer="closed"');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("aria-modal");
    expect(html).not.toContain("data-drawer-scrim");
    expect(html).not.toContain("inert");
  });

  it("applies initialFilters to the SSR list the same way the client will", () => {
    const html = render({ initialFilters: { q: "GS-WIND" } });
    // 只看左栏(头部的当前标的与 vintage chip 不受筛选影响)
    const aside = html.slice(html.indexOf('data-area="instruments"'), html.indexOf("</aside>"));
    expect(symbolsIn(aside)).toEqual(new Set(["GS-WIND-2022", "GS-WIND-2023"]));
    expect(html).toMatch(/<h1[^>]*>VCS-FOR-2021<\/h1>/);
    expect(html).toContain(`>${en.terminal.instruments.count(2)}<`);
  });

  it("keeps the order-form hooks the keyboard shortcuts drive (l / m / ↑ ↓ in TerminalShell)", () => {
    // TerminalShell 的 l / m 按 data-order-type="LIMIT" / "MARKET" 找下单面板的类型按钮(与文案、按钮顺序无关),↑ ↓ 找 data-price-field;
    // 面板改结构时这条先红,别让快捷键悄悄失效
    const html = render();
    const order = html.slice(html.indexOf('data-area="order"'), html.indexOf('data-area="meta"'));
    const typeButton = (type: string) => order.match(new RegExp(`<button[^>]*data-order-type="${type}"[^>]*>([^<]*)</button>`));
    expect(typeButton("LIMIT")?.[1]).toBe(en.terminal.order.limit);
    expect(typeButton("MARKET")?.[1]).toBe(en.terminal.order.market);
    expect(order.match(/data-order-type="/g)).toHaveLength(2);
    expect(order).toMatch(/<input[^>]*data-price-field=""[^>]*>/);
  });

  it("puts a close button inside the drawer (hidden by terminal.css once the column docks)", () => {
    const html = render();
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect(aside).toMatch(new RegExp(`<button type="button" data-drawer-close="" aria-label="${en.terminal.a11y.drawerClose}"`));
    expect(aside).toContain(`<span>${en.ui.close}</span>`);
    // 关闭按钮在面板之前(抽屉顶部),面板本身仍在抽屉里
    expect(aside.indexOf("data-drawer-close")).toBeLessThan(aside.indexOf(`id="${INSTRUMENT_SEARCH_ID}"`));
  });
});

describe("terminal.css: the phone's first frame and the hydrated phone subtree lay out the same (P1-25f)", () => {
  const css = readFileSync(new URL("../terminal.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** 一段 @media 块的正文(按花括号配对) */
  const mediaBody = (query: string) => {
    const start = css.indexOf(`@media ${query} {`);
    expect(start, query).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) return css.slice(start, i);
    }
    throw new Error(`unbalanced ${query}`);
  };

  it("has no grid-template-areas below 48rem: hidden panels leave no empty rows or row gaps", () => {
    const base = css.slice(css.indexOf("[data-terminal] {"), css.indexOf("}", css.indexOf("[data-terminal] {")));
    expect(base).toContain("display: grid");
    expect(base).not.toContain("grid-template-areas");
    // 各面板的 grid-area 只在 ≥ 48rem 的网格里指定
    expect(mediaBody("(width >= 48rem)")).toMatch(/\[data-area="chart"\] \{\s*grid-area: chart;/);
  });

  it("hides the tab strip from 48rem up and, below it, shows only the initial tab's panels until hydration", () => {
    expect(mediaBody("(width >= 48rem)")).toMatch(/\[data-terminal\] > \[data-area="mobile-tabs"\] \{\s*display: none;/);
    const phone = mediaBody("(width < 48rem)");
    for (const tab of MOBILE_TABS) expect(phone, tab).toContain(`[data-terminal][data-layout="desktop"][data-mobile-tab="${tab}"]`);
  });
});

describe("terminal route metadata", () => {
  const meta = (symbol: string) => generateMetadata({ params: Promise.resolve({ symbol }) });

  it("titles a well-formed symbol and keeps the simulated description", async () => {
    await expect(meta("VCS-FOR-2021")).resolves.toEqual({
      title: "VCS-FOR-2021 · Terminal",
      description: "Simulated order book, candles and orders for VCS-FOR-2021 on Carbadia Trade.",
      alternates: { canonical: "/trade/VCS-FOR-2021" },
    });
    // 形状对但库里没有:不查库,仍按代码出标题(404 由 page.tsx 决定)
    expect((await meta("NOPE-XX-2020")).title).toBe("NOPE-XX-2020 · Terminal");
  });

  it("does not interpolate arbitrary decoded path text into the title or description", async () => {
    for (const bad of ["Send funds to example.com", "vcs-for-2021", "VCS-FOR-2021/extra", "VCS-FOR-2021#x", "VCS-FOR-2021?x=1", "", "A--B", "<b>X</b>"]) {
      const m = await meta(bad);
      expect(m, bad).toEqual({ title: "Terminal" });
    }
  });
});

describe("rollback hint (START_MODE=next, or no hub in this process: the server has no /ws)", () => {
  const badge = (html: string) => html.match(/<span data-connection="([a-z]+)"( data-pending="")?[^>]*>/);

  const page = async () =>
    (await TradePage({ params: Promise.resolve({ symbol: "VCS-FOR-2021" }), searchParams: Promise.resolve({}) })) as React.ReactElement<{ transportMode?: string }>;
  /** server.mjs 的 hub 在 listen 前建好 __carbadiaWsStats;这里只放 transportModeForServer 看的字段 */
  const withHub = (enabled: boolean | null) => {
    if (enabled === null) delete globalThis.__carbadiaWsStats;
    else globalThis.__carbadiaWsStats = { enabled } as NonNullable<typeof globalThis.__carbadiaWsStats>;
  };

  it("page.tsx reads START_MODE at request time: next → transportMode \"poll\"; unset or custom with the hub up → no hint", async () => {
    try {
      withHub(true);
      vi.stubEnv("START_MODE", "next");
      const rollback = await page();
      expect(rollback.props.transportMode).toBe("poll");
      expect(renderToStaticMarkup(rollback)).toContain('data-connection="polling"');
      vi.stubEnv("START_MODE", "custom");
      expect((await page()).props.transportMode).toBeUndefined();
      vi.stubEnv("START_MODE", undefined);
      const normal = await page();
      expect(normal.props.transportMode).toBeUndefined();
      expect(renderToStaticMarkup(normal)).toBe(render());
    } finally {
      vi.unstubAllEnvs();
      withHub(null);
    }
  });

  it("page.tsx also polls from the first frame when this process has no hub (start:plain / dev:plain) or the hub is off (WS_DISABLED)", async () => {
    try {
      vi.stubEnv("START_MODE", undefined);
      withHub(null);
      const plain = await page();
      expect(plain.props.transportMode).toBe("poll");
      expect(renderToStaticMarkup(plain)).toContain('data-connection="polling"');
      withHub(false);
      expect((await page()).props.transportMode).toBe("poll");
      withHub(true);
      expect((await page()).props.transportMode).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      withHub(null);
    }
  });

  it("without a hint the pending badge shows the build-time mode's label (live), exactly as before", () => {
    const html = render();
    expect(badge(html)?.[1]).toBe("live");
    expect(badge(html)?.[2]).toBe(' data-pending=""');
    expect(html).toContain(en.terminal.connection.live);
    expect(render({ transportMode: undefined })).toBe(html);
  });

  it('transportMode="poll": the server HTML already shows the polling label (pending until the transport reports) and the degraded notice, never "Connected"', () => {
    const html = render({ transportMode: "poll" });
    expect(badge(html)?.[1]).toBe("polling");
    expect(badge(html)?.[2]).toBe(' data-pending=""');
    expect(html).toContain(en.terminal.connection.polling);
    expect(html).not.toContain(en.terminal.connection.live);
    // 降级说明(≥ 80rem 可见)也在服务端 HTML 里:不等传输层报告才出现、把宽屏头部撑高(P1-25f;回滚模式桌面 CLS 0.494 的来源)
    const status = `<span role="status" class="sr-only text-t-xs text-warning xl:not-sr-only xl:truncate">`;
    expect(html).toContain(`${status}${en.terminal.connection.degradedBody}</span>`);
    expect(render()).toContain(`${status}</span>`);
    // 除此之外只有徽标变了:其余标记与不带提示时逐字相同
    expect(
      html
        .replace(en.terminal.connection.degradedBody, "")
        .replaceAll(en.terminal.connection.polling, en.terminal.connection.live)
        .replaceAll('data-connection="polling"', 'data-connection="live"'),
    ).toBe(render());
  });
});

describe("terminal shell helpers", () => {
  it("maps the two media queries to a layout tier (server snapshot is desktop)", () => {
    expect(layoutFor(true, true)).toBe("desktop");
    expect(layoutFor(false, true)).toBe("tablet");
    expect(layoutFor(false, false)).toBe("mobile");
  });

  it("maps the connection slice to a badge, with a pending placeholder before the transport reports", () => {
    const idle = { transport: "none", state: "offline", lastMessageAt: null, rttMs: null } as const;
    expect(connectionBadgeKind(idle, "ws")).toEqual({ kind: "live", pending: true });
    expect(connectionBadgeKind(idle, "poll")).toEqual({ kind: "polling", pending: true });
    expect(connectionBadgeKind({ ...idle, transport: "ws", state: "open" }, "ws")).toEqual({ kind: "live", pending: false });
    expect(connectionBadgeKind({ ...idle, transport: "poll", state: "open" }, "ws")).toEqual({ kind: "polling", pending: false });
    expect(connectionBadgeKind({ ...idle, transport: "ws", state: "connecting" }, "ws")).toEqual({ kind: "reconnecting", pending: false });
    expect(connectionBadgeKind({ ...idle, transport: "ws", state: "offline", lastMessageAt: TS }, "ws")).toEqual({ kind: "offline", pending: false });
  });

  it("formats the badge's last-message time by the UI language, not the browser default", () => {
    expect(lastMessageTime(null, "en", "local")).toBeNull();
    const d = new Date(TS);
    expect(lastMessageTime(TS, "en", "local")).toBe(d.toLocaleTimeString("en-US", { hour12: false }));
    expect(lastMessageTime(TS, "zh-CN", "local")).toBe(d.toLocaleTimeString("zh-CN", { hour12: false }));
    // 冻结语言(界面只维护 en 与 zh-CN)一律按 en-US
    expect(lastMessageTime(TS, "ja", "local")).toBe(d.toLocaleTimeString("en-US", { hour12: false }));
  });

  it("cycles Tab / Shift+Tab inside the modal drawer", () => {
    const items = ["first", "middle", "scrim"];
    // 刚打开:焦点在抽屉容器本身(不在列表里)
    expect(trapFocusTarget(items, "drawer", false)).toBe("first");
    expect(trapFocusTarget(items, "drawer", true)).toBe("scrim");
    expect(trapFocusTarget(items, null, false)).toBe("first");
    // 两端回绕
    expect(trapFocusTarget(items, "scrim", false)).toBe("first");
    expect(trapFocusTarget(items, "first", true)).toBe("scrim");
    // 中间交给浏览器默认顺序
    expect(trapFocusTarget(items, "first", false)).toBeNull();
    expect(trapFocusTarget(items, "middle", true)).toBeNull();
    expect(trapFocusTarget([], "drawer", false)).toBeNull();
  });

  it("moves between the mobile tabs with ← → Home End (WAI-ARIA tabs), wrapping at the ends", () => {
    expect(MOBILE_TABS).toEqual(["chart", "book", "order"]);
    expect(nextMobileTab("chart", "ArrowRight")).toBe("book");
    expect(nextMobileTab("order", "ArrowRight")).toBe("chart");
    expect(nextMobileTab("chart", "ArrowLeft")).toBe("order");
    expect(nextMobileTab("book", "Home")).toBe("chart");
    expect(nextMobileTab("book", "End")).toBe("order");
    expect(nextMobileTab("book", "ArrowDown")).toBeNull();
    expect(nextMobileTab("book", "Enter")).toBeNull();
    // ?side= 带来的方向直接落在下单页签
    expect(initialMobileTab()).toBe("chart");
    expect(initialMobileTab("SELL")).toBe("order");
  });

  it("routes hotkeys to the mobile tab they need, and keeps only search / help / Esc while the drawer is modal", () => {
    expect(mobileTabFor("sideBuy")).toBe("order");
    expect(mobileTabFor("typeMarket")).toBe("order");
    expect(mobileTabFor("interval1")).toBe("chart");
    expect(mobileTabFor("interval7")).toBe("chart");
    expect(mobileTabFor("help")).toBeNull();
    expect(mobileTabFor("focusSearch")).toBeNull();
    const allowed = HOTKEYS.filter((h) => hotkeyAllowedWithDrawer(h.action)).map((h) => h.action);
    expect(new Set(allowed)).toEqual(new Set(["focusSearch", "help", "cancelDialog"]));
  });
});
