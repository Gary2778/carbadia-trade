import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarketsRoute from "@/app/trade/markets/page";
import TradeLayout from "@/app/trade/layout";
import en from "@/i18n/messages/en";
import { renderToStaticMarkup as render } from "@/i18n/test-support";
import { createInitialAccountState, useAccountStore } from "@/lib/market/account-store";
import { createInitialState, marketActions, useMarketStore } from "@/lib/market/store";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { MarketsBody, MarketsFrame, MarketsPage, MarketsSkeleton } from "./MarketsPage";
import { ITEMS, TS, marketItem } from "./test-support";
import { computeIndices } from "@/shared/market-indices";

// 市场总览页 /trade/markets 的服务端渲染(计划 §6.3.3 P3-05 的测试清单):首屏的指数卡与三张榜只来自 props、有情景标的分区、未登录也完整;
// 三态(骨架 / 空 / 出错);路由本身(await connection()、listInstruments() → props)。node 环境、不引 jsdom:effect 不跑,store 在服务端与水合首帧读的是初始状态。
// 数都是手算的(夹具见 test-support.ts)。

vi.mock("next/server", () => ({ connection: async () => {} }));
// 页面的数据源:listInstruments 查库,这里换成固定的夹具(调用时才取,工厂里不引用外层变量)
vi.mock("@/lib/server/market-snapshots", async () => {
  const { ITEMS: items, TS: serverTime } = await import("./test-support");
  return { listInstruments: async () => ({ instruments: items, feeSchedule: { makerBps: 0, takerBps: 0, minFeeCents: 0, demo: true }, serverTime }) };
});

const t = en.terminal.markets;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
/** 一张指数卡的标记:从 data-index="<id>" 到它的 </article> */
const card = (html: string, id: string) => html.split(`data-index="${id}"`)[1]?.split("</article>")[0] ?? "";
const cardIds = (html: string, prefix: string) => [...html.matchAll(new RegExp(`data-index="(${prefix}[^"]*)"`, "g"))].map((m) => m[1]);
/** 一张榜 / 一个分区的标记 */
const section = (html: string, attr: string) => html.split(attr)[1]?.split("</section>")[0] ?? "";
const symbolsIn = (markup: string) => [...markup.matchAll(/<li data-symbol="([^"]+)"/g)].map((m) => m[1]);

const count = (markup: string, needle: string) => markup.split(needle).length - 1;
const noop = () => {};
const page = (patch: Partial<Parameters<typeof MarketsPage>[0]> = {}) => createElement(MarketsPage, { initialInstruments: ITEMS, serverTime: TS, transportMode: "poll", ...patch });

beforeEach(() => {
  useMarketStore.setState(createInitialState(), true);
  useAccountStore.setState(createInitialAccountState(), true);
});
afterEach(() => {
  useMarketStore.setState(createInitialState(), true);
});

describe("the page shell (server render from props, logged out)", () => {
  const html = render(page());

  it("renders the terminal-scoped document root, the title, the Demo badge and the one-line explanation (simulated, 24 hours ago = 100)", () => {
    expect(html).toMatch(/^<div data-terminal="" data-glass="off" data-account="">/);
    expect(html).toContain(`<h1 class="text-t-2xl font-semibold text-foreground">${t.title}</h1>`);
    expect(html).toContain('data-demo-badge="regular"');
    expect(text(section(html, "data-markets-intro"))).toContain("These are simulated indices: 24 hours ago = 100.");
    expect(html.match(/<h1/g)).toHaveLength(1);
    // 内容列最大 80rem 居中(与资产页同一个外框写法)
    expect(html).toContain('class="mx-auto flex w-full max-w-7xl flex-col gap-panel"');
  });

  it("is a public page: no login gate, no account data, no cash, no deposit / withdraw / transfer words, no Live", () => {
    expect(html).not.toContain("data-account-gate");
    expect(html).not.toMatch(/\$\d/);
    expect(text(html)).not.toContain(en.nav.cash);
    expect(html).not.toMatch(/deposit|withdraw|transfer/i);
    expect(text(html)).not.toMatch(/\blive\b/i);
    // 内部字段不外露
    expect(html).not.toMatch(/realClose|anchorPrice/);
  });

  it("renders no loading skeleton, no empty state and no error when the props carry the instruments", () => {
    expect(html).not.toContain("data-markets-skeleton");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });
});

describe("index cards (hand-computed numbers, first paint from props)", () => {
  const html = render(page());

  it("the overall index: level 100.43 = 100 × (1 + 0.43 / 100), +0.43%, 11 projects, 6 up, 3 down; says it is based on 10 of the 11 (one has no 24h trades)", () => {
    const all = text(card(html, "all"));
    expect(all).toContain(t.allTitle);
    expect(all).toContain(t.simulatedIndex);
    // 一个标题:卡片自己的 h2,没有另一个只给读屏的同名标题
    expect(card(html, "all")).toMatch(/<h2 class="[^"]*">All projects<\/h2>/);
    expect(html.split(t.allTitle).length - 1).toBe(1);
    expect(html).not.toContain('id="markets-all"');
    expect(all).toContain("100.43");
    expect(all).toContain("+0.43%");
    expect(all).toContain("11 projects · 6 up · 3 down");
    expect(all).toContain("Based on 10 of 11 projects. The rest have no 24h trades.");
    // 方向色:涨用终端的涨色 token(随涨跌轴翻转),不是站点的 text-up
    expect(card(html, "all")).toContain("text-(--terminal-up)");
    expect(card(html, "all")).not.toMatch(/text-up|text-down/);
  });

  it("by registry: four cards in code-unit order of the raw key, named through tRegistry; every card is labelled simulated", () => {
    expect(cardIds(html, "registry:")).toEqual(["registry:Gold Standard", "registry:UNFCCC", "registry:Verra", "registry:国家温室气体自愿减排登记簿"]);
    const gold = text(card(html, "registry:Gold Standard"));
    expect(gold).toContain("Gold Standard");
    expect(gold).toContain("99.60"); // (4 − 2 − 4 + 0.4)/ 4 = −0.4
    expect(gold).toContain("-0.40%");
    expect(gold).toContain("4 projects · 2 up · 2 down");
    expect(gold).not.toContain("Based on"); // 四个成员都有涨跌:不写「按 n 个计算」
    const verra = text(card(html, "registry:Verra"));
    expect(verra).toContain("101.85"); // (3.5 + 2.3 + 1 + 0.6)/ 4
    expect(verra).toContain("+1.85%");
    const ccer = text(card(html, "registry:国家温室气体自愿减排登记簿"));
    expect(ccer).toContain(en.data.registries.ccer); // 原始中文 key → 当前语言的显示名
    expect(ccer).toContain("99.25");
    expect(ccer).toContain("2 projects · 0 up · 1 down");
    // 只有一个成员、而且没有 24h 成交:点位与涨跌都是「—」,并说明原因(不是 100.00 与 0.00%)
    const unfccc = text(card(html, "registry:UNFCCC"));
    expect(unfccc).toContain("1 project · 0 up · 0 down");
    expect(unfccc).toContain(t.noTrades);
    expect(unfccc).not.toContain("100.00");
    expect(unfccc.match(/—/g)).toHaveLength(2);
    // 两个「—」各带读屏用的替代文字(复用 markets.noTrades):视觉上是破折号(aria-hidden),读屏读「24h 内还没有成交」
    const raw = card(html, "registry:UNFCCC");
    expect(raw.match(new RegExp(`<span aria-hidden="true">—</span><span class="sr-only">${t.noTrades}</span>`, "g"))).toHaveLength(2);
    expect(raw).toMatch(/data-level=""[^>]*><span aria-hidden="true">—<\/span><span class="sr-only">/);
    expect(raw).toMatch(/data-change=""[^>]*><span aria-hidden="true">—<\/span><span class="sr-only">/);
    // 有值的卡片没有这种占位
    expect(card(html, "registry:Verra")).not.toContain("sr-only");
    // 1 + 4 + 5 张卡,每张都有「模拟指数」
    const total = cardIds(html, "").length;
    expect(total).toBe(10);
    expect(html.split(`>${t.simulatedIndex}<`).length - 1).toBe(total);
  });

  it("by project type: five cards in code-unit order, named through tProjectType", () => {
    expect(cardIds(html, "project-type:")).toEqual(["project-type:可再生能源", "project-type:林业碳汇", "project-type:甲烷回收", "project-type:能效", "project-type:蓝碳"]);
    const renewable = text(card(html, "project-type:可再生能源"));
    expect(renewable).toContain(en.data.projectTypes.renewable);
    expect(renewable).toContain("100.82"); // (1 + 0.6 + 4 + 0 − 1.5)/ 5 = 0.82
    expect(renewable).toContain("5 projects · 3 up · 1 down");
    expect(text(card(html, "project-type:林业碳汇"))).toContain("102.90");
    expect(text(card(html, "project-type:蓝碳"))).toContain("97.00");
    expect(text(card(html, "project-type:能效"))).toContain("100.40");
    expect(text(card(html, "project-type:甲烷回收"))).toContain(t.noTrades);
  });

  it("sections are labelled (headings by registry / by project type) and the scenario registry never appears as an index", () => {
    expect(text(html)).toContain(t.byRegistry);
    expect(text(html)).toContain(t.byProjectType);
    expect(html).not.toContain("registry:情景标的");
    expect(html).not.toContain("project-type:配额情景");
  });
});

describe("the three ranked lists and the scenario section", () => {
  const html = render(page());

  it("top gainers: five rows by change (the sixth, +0.4%, is cut), each with price at the instrument's precision, change and a link to the terminal", () => {
    const gainers = section(html, 'data-ranking="gainers"');
    expect(text(gainers)).toContain(t.gainers);
    expect(symbolsIn(gainers)).toEqual(["GS-WIND-2021", "VCS-FOR-2021", "VCS-FOR-2022", "VCS-WIND-2021", "VCS-SOL-2021"]);
    const first = gainers.split('data-symbol="GS-WIND-2021"')[1].split("</li>")[0];
    expect(first).toContain('href="/trade/GS-WIND-2021"');
    expect(text(first)).toContain("Wind E"); // 项目名
    expect(text(first)).toContain("45.50"); // 4550 分,精度 2
    expect(text(first)).toContain("+4.00%");
    expect(first).toContain("text-(--terminal-up)");
    expect(text(gainers.split('data-symbol="VCS-FOR-2021"')[1])).toContain("10.00");
  });

  it("top losers: the three that fell, deepest first; red (terminal down token) with a minus sign", () => {
    const losers = section(html, 'data-ranking="losers"');
    expect(text(losers)).toContain(t.losers);
    expect(symbolsIn(losers)).toEqual(["GS-MANG-2022", "GS-MANG-2021", "CCER-SOL-2023"]);
    const first = losers.split('data-symbol="GS-MANG-2022"')[1].split("</li>")[0];
    expect(text(first)).toContain("-4.00%");
    expect(first).toContain("text-(--terminal-down)");
    expect(first).toContain('href="/trade/GS-MANG-2022"');
  });

  it("top volume: five rows by tonnes with the volume column; instruments with no 24h trades are not ranked", () => {
    const volume = section(html, 'data-ranking="volume"');
    expect(text(volume)).toContain(t.topVolume);
    expect(symbolsIn(volume)).toEqual(["VCS-SOL-2021", "VCS-FOR-2021", "CCER-SOL-2022", "GS-MANG-2021", "GS-COOK-2021"]);
    expect(text(volume.split('data-symbol="VCS-SOL-2021"')[1].split("</li>")[0])).toContain("1,200 t");
    // 涨跌为 0 的 CCER-SOL-2022 在成交量榜里,显示「0.00%」且是中性色
    const flat = volume.split('data-symbol="CCER-SOL-2022"')[1].split("</li>")[0];
    expect(text(flat)).toContain("0.00%");
    expect(flat).not.toMatch(/terminal-up|terminal-down/);
    // 涨跌榜没有 volume 列
    expect(section(html, 'data-ranking="gainers"')).not.toContain("data-volume");
  });

  it("each list is ranked 1..n inside an ordered list", () => {
    for (const id of ["gainers", "losers", "volume"]) {
      const list = section(html, `data-ranking="${id}"`);
      expect(list).toContain("<ol>");
      expect([...list.matchAll(/<span aria-hidden="true" class="tnum w-4 shrink-0 text-end text-t-xs text-muted">(\d)<\/span>/g)].map((m) => Number(m[1]))).toEqual(
        Array.from({ length: symbolsIn(list).length }, (_, i) => i + 1),
      );
    }
  });

  it("the scenario section lists both scenario instruments, labelled as scenarios and not part of any index; they are in no ranking and no index", () => {
    const scenarios = section(html, "data-scenarios");
    expect(text(scenarios)).toContain(t.scenarios);
    expect(text(scenarios)).toContain(t.scenariosNote);
    expect(symbolsIn(scenarios)).toEqual(["CCER-SCEN-2026", "CEA-SCEN-2026"]);
    expect(scenarios.match(new RegExp(`>${en.terminal.tabs.scenarioTag}<`, "g"))).toHaveLength(2);
    expect(scenarios).toContain('href="/trade/CEA-SCEN-2026"');
    expect(text(scenarios)).toContain("90.41"); // 价格
    // 其它地方一个情景标的也没有
    const rest = html.replace(scenarios, "");
    expect(rest).not.toMatch(/SCEN/);
    // 指数不受情景标的影响(+50% / −10% 混进去全部就不是 100.43 了)
    expect(text(card(html, "all"))).toContain("100.43");
  });

  it("without scenario instruments the section is not drawn; with no gainers the list says so instead of padding", () => {
    const credits = ITEMS.filter((item) => !item.instrument.isScenario);
    expect(render(page({ initialInstruments: credits }))).not.toContain("data-scenarios");
    const allDown = render(page({ initialInstruments: credits.filter((item) => (item.ticker.change24h ?? 0) < 0) }));
    const gainers = section(allDown, 'data-ranking="gainers"');
    expect(symbolsIn(gainers)).toEqual([]);
    expect(text(gainers)).toContain(t.emptyGainers);
    expect(text(section(allDown, 'data-ranking="losers"'))).not.toContain(t.emptyLosers);
  });
});

describe("markup never depends on the stores (props only during render)", () => {
  it("is byte-identical whatever the market store and the account store hold", () => {
    const empty = render(page());
    marketActions.setInstruments(ITEMS.map((x) => ({ instrument: { ...x.instrument, name: "LEAK" }, ticker: { ...x.ticker, lastPrice: 123_456, change24h: 99, volume24h: 1, ts: TS + 1 } })));
    marketActions.setConnection({ transport: "none", state: "offline", lastMessageAt: TS, rttMs: 1 });
    useAccountStore.setState({
      me: { id: "u-1", email: "a@example.com", name: "Alice", cashBalance: 12_345, lockedCash: 0, unreadNotices: 0 },
      balance: { cashBalance: 12_345, lockedCash: 0 },
      status: "ready",
    });
    expect(render(page())).toBe(empty);
    expect(empty).not.toContain("LEAK");
  });
});

describe("states (the shared ui components)", () => {
  const indices = computeIndices(ITEMS, TS);
  const body = (patch: Partial<Parameters<typeof MarketsBody>[0]>) => render(createElement(MarketsBody, { items: ITEMS, indices, loaded: true, offline: false, onRetry: noop, ...patch }));

  it("no instruments yet and not loaded → the skeleton (same shape as the page: one big card, a row of cards, three lists)", () => {
    const html = body({ items: [], indices: computeIndices([], TS), loaded: false });
    expect(html).toBe(render(createElement(MarketsSkeleton)));
    expect(html).toContain('role="status" aria-busy="true"');
    expect(html).not.toContain("data-index=");
  });

  it("loaded but nothing listed → the empty state", () => {
    const html = body({ items: [], indices: computeIndices([], TS) });
    expect(text(html)).toContain(t.noProjects);
    expect(html).not.toContain("data-markets-skeleton");
    expect(html).not.toContain('role="alert"');
  });

  it("no data and the feed is offline → an error with retry (ui.error / ui.retry), not a blank page or a skeleton", () => {
    const html = body({ items: [], indices: computeIndices([], TS), loaded: false, offline: true });
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(en.ui.error);
    expect(text(html)).toContain(en.ui.retry);
    expect(html).not.toContain("data-markets-skeleton");
  });

  it("with data the last values stay on screen even if the feed is offline (no error replaces them)", () => {
    const html = body({ offline: true });
    expect(html).toContain('data-index="all"');
    expect(html).not.toContain('role="alert"');
  });

  it("offline with data on screen: one short line that the numbers may be out of date (warning token, a status region, above the content); gone when the feed is back", () => {
    const offline = body({ offline: true });
    expect(count(offline, "data-markets-stale")).toBe(1);
    const note = offline.slice(offline.indexOf("<p role=\"status\" data-markets-stale"), offline.indexOf("</p>", offline.indexOf("data-markets-stale")) + 4);
    expect(note).toContain("text-warning");
    expect(note).toContain('role="status"');
    expect(text(note)).toBe(t.stale);
    expect(offline.indexOf("data-markets-stale")).toBeLessThan(offline.indexOf('data-index="all"'));
    // 连回来:同一份数据,说明不在了,其余标记不变
    const online = body({ offline: false });
    expect(online).not.toContain("data-markets-stale");
    expect(online).not.toContain(t.stale);
    expect(offline.replace(note, "")).toBe(online);
  });

  it("the note is not shown while loading, when empty, or with the error (those say it themselves); the markup never says Live", () => {
    for (const html of [body({ items: [], indices: computeIndices([], TS), loaded: false }), body({ items: [], indices: computeIndices([], TS) }), body({ items: [], indices: computeIndices([], TS), offline: true })]) {
      expect(html).not.toContain("data-markets-stale");
    }
    expect(body({ offline: true })).not.toMatch(/\blive\b/i);
  });

  it("the frame alone (title, Demo badge, explanation) renders around any body", () => {
    const html = render(createElement(MarketsFrame, null, createElement("p", null, "BODY")));
    expect(html).toContain("<p>BODY</p>");
    expect(text(html)).toContain(t.intro);
  });
});

describe("ranked lists: accessible names", () => {
  const html = render(page());
  const row = (list: string, symbol: string) => section(html, `data-ranking="${list}"`).split(`data-symbol="${symbol}"`)[1].split("</li>")[0];

  it("each row link is named by symbol, project name, last price and 24h change with their labels", () => {
    expect(row("gainers", "GS-WIND-2021")).toContain('aria-label="GS-WIND-2021, Wind E, last price 45.50, 24h change +4.00%"');
    expect(row("losers", "GS-MANG-2022")).toContain(`aria-label="GS-MANG-2022, ${en.data.assetNames["GS-MANG-2022"]}, last price 97.00, 24h change -4.00%"`); // 已知代码的名字走 data 目录的译名
    // 成交量榜另有 24h 成交量;涨跌为 0 照读「0.00%」
    expect(row("volume", "VCS-SOL-2021")).toContain('aria-label="VCS-SOL-2021, Solar D, last price 30.00, 24h change +0.60%, 24h volume 1,200 t"');
    expect(row("volume", "CCER-SOL-2022")).toContain(`aria-label="CCER-SOL-2022, ${en.data.assetNames["CCER-SOL-2022"]}, last price 80.00, 24h change 0.00%, 24h volume 800 t"`);
    // 涨跌榜没有成交量
    expect(row("gainers", "GS-WIND-2021")).not.toContain("24h volume");
    // 名字里的数字就是行里看得见的数字(label in name)
    for (const needle of ["45.50", "+4.00%"]) expect(text(row("gainers", "GS-WIND-2021"))).toContain(needle);
  });

  it("every row of every list has one, and the label is on the link (the only focusable element in the row)", () => {
    for (const list of ["gainers", "losers", "volume"]) {
      const markup = section(html, `data-ranking="${list}"`);
      expect(count(markup, "<a ")).toBe(symbolsIn(markup).length);
      expect(count(markup, "<a ")).toBe(count(markup, 'aria-label="'));
    }
    const scenarios = section(html, "data-scenarios");
    expect(count(scenarios, 'aria-label="')).toBe(2);
    expect(scenarios).toContain(`aria-label="CEA-SCEN-2026, ${en.data.assetNames["CEA-SCEN-2026"]} (scenario), last price 90.41, 24h change +50.00%"`);
  });

  it("a row with no price or no 24h trades says why instead of reading a dash", () => {
    const quiet = render(page({ initialInstruments: [...ITEMS, marketItem({ symbol: "NEW-SCEN-2026", name: "New scenario", registry: "x", projectType: "y", change: null, volume: 0, price: null, scenario: true })] }));
    const markup = section(quiet, "data-scenarios").split('data-symbol="NEW-SCEN-2026"')[1].split("</li>")[0];
    expect(markup).toContain(`last price ${en.ui.notProvided}, 24h change ${t.noTrades}"`);
  });

  it("the visible rank number is hidden from assistive technology; the ordered list carries the order", () => {
    for (const list of ["gainers", "losers", "volume"]) {
      const markup = section(html, `data-ranking="${list}"`);
      expect(markup).toContain("<ol>");
      const ranks = [...markup.matchAll(/<span aria-hidden="true" class="tnum w-4 shrink-0 text-end text-t-xs text-muted">(\d)<\/span>/g)];
      expect(ranks).toHaveLength(symbolsIn(markup).length);
      expect(ranks.map((m) => Number(m[1]))).toEqual(Array.from({ length: ranks.length }, (_, i) => i + 1));
    }
    // 标签以代码起头,不带名次(名次在 <ol> 的序里)
    expect(row("gainers", "VCS-FOR-2021")).toContain('aria-label="VCS-FOR-2021, ');
  });
});

describe("the route (server component)", () => {
  it("awaits the connection, reads the instruments and passes them with the server time to the page; hands the transport hint to it", async () => {
    const element = await MarketsRoute();
    expect(element.props.initialInstruments).toBe(ITEMS);
    expect(element.props.serverTime).toBe(TS);
    // 测试进程里没有 hub(globalThis.__carbadiaWsStats 缺失)→ 服务端接不了 /ws → 首帧就轮询
    expect(element.props.transportMode).toBe("poll");
    const html = renderMarkup(createElement(TradeLayout, null, element));
    expect(html).toContain('data-index="all"');
    expect(text(html)).toContain(t.title);
  });
});
