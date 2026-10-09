import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server 的同名函数 + /trade 布局登记终端文案的那层 Provider(P2-01)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
import { FILL_DISCLOSURE, type Fill, type FillDetailResponse, type Instrument, type Order, type Position } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import en from "@/i18n/messages/en";
import { createInitialAccountState, useAccountStore } from "@/lib/market/account-store";
import { createInitialState, marketActions, useMarketStore } from "@/lib/market/store";
import { BOTTOM_TABS, BottomTabs, nextTab, stripExportHref } from "./BottomTabs";
import { ExportCsvLink, STRIP_ITEM_BOX, STRIP_RULE } from "./ExportCsvLink";
import { MobileTabs } from "./MobileTabs";
import { FillDetailView, fillPrecisionSelector, fillDetailUrl } from "./FillDetailDialog";
import { FILLS_CSV_HREF, FillRow, FillsTab, fillsPageUrl, fillsQueries, newestFillFirst } from "./FillsTab";
import { armedEscapeAction, cancelOrderRequest, liveArmedId, OpenOrderRow, OpenOrdersView, reconcileArmed } from "./OpenOrdersTab";
import { HISTORY_CSV_HREF, HistoryRow, OrderHistoryTab, cancelReasonText, historyPageUrl, historyQueries, newestOrderFirst } from "./OrderHistoryTab";
import { groupPositions, positionMetaOf } from "@/lib/market/position-groups";
import {
  focusPositionsRegion,
  handlePositionSell,
  PositionGroupRow,
  positionRows,
  PositionsTab,
  PositionsView,
  reconcileRetireRequest,
  RetiredGroupRow,
  RETIREMENT_HISTORY_HREF,
  type PositionsViewProps,
  type RetireRequest,
} from "./PositionsTab";
import { appendDescribedBy, pricePrecisionsOf, TabTable, type TabTableProps } from "./TabTable";

// 底部四个 Tab 的服务端标记测试(计划 §9.1 第 7 条:node 环境,不引 jsdom;交互靠内置浏览器手工验收)。
// zustand 5 在服务端读 getInitialState()(空账户、status idle),所以带数据的断言渲染纯展示件(PositionsView / FillRow /
// OpenOrdersView / FillDetailView),容器只断言 SSR 首屏(Skeleton、空态)。没有 LangProvider 时 useT 落到默认英文。

vi.mock("next/navigation", () => ({
  usePathname: () => "/trade/VCS-FOR-2021",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const T = en.terminal;
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** renderToStaticMarkup 的转义(& 与 ")*/
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * terminal.css 里持仓贴边列(.t-pin*)的规则,按「断点块外」与「贴边所在的断点块」分开读(去掉注释,按花括号配对分块)。
 * base / wide 返回某个选择器(省略 `[data-terminal] ` 前缀)的声明表;找不到时断言失败。
 */
function pinRules() {
  const css = readFileSync(fileURLToPath(new URL("../../app/terminal.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = (src: string) => {
    const out: { prelude: string; body: string }[] = [];
    let depth = 0;
    let start = 0;
    let open = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === "{") {
        if (depth === 0) open = i;
        depth++;
      } else if (src[i] === "}") {
        depth--;
        if (depth === 0) {
          out.push({ prelude: src.slice(start, open).trim(), body: src.slice(open + 1, i) });
          start = i + 1;
        }
      }
    }
    return out;
  };
  // 每条声明按第一个冒号切成「属性: 值」(值里可能还有冒号)
  const decls = (body: string) =>
    Object.fromEntries(
      body
        .split(";")
        .filter((d) => d.includes(":"))
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
    );
  const top = blocks(css);
  const pinSelector = /^\[data-terminal\] \.t-pin/;
  const baseRules = top.filter((b) => pinSelector.test(b.prelude));
  const wideBlocks = top.filter((b) => b.prelude.startsWith("@media") && /\.t-pin\b/.test(b.body));
  expect(wideBlocks, "exactly one breakpoint block holds the pin rules").toHaveLength(1);
  const wideRules = blocks(wideBlocks[0].body);
  const pick = (rules: { prelude: string; body: string }[], selector: string) => {
    const rule = rules.find((r) => r.prelude === `[data-terminal] ${selector}`);
    expect(rule, selector).toBeDefined();
    return decls(rule!.body);
  };
  const isStickyPin = (r: { prelude: string; body: string }) => /\.t-pin/.test(r.prelude) && /position:\s*sticky/.test(r.body);
  return {
    base: (selector: string) => pick(baseRules, selector),
    wide: (selector: string) => pick(wideRules, selector),
    baseSelectors: baseRules.map((r) => r.prelude.replace("[data-terminal] ", "")),
    widePrelude: wideBlocks[0].prelude,
    stickyCount: [...baseRules, ...top.filter((b) => b.prelude.startsWith("@")).flatMap((b) => blocks(b.body))].filter(isStickyPin).length,
  };
}

function instrument(symbol: string, vintage: number, isScenario = false): Instrument {
  return {
    id: `asset-${symbol}`,
    symbol,
    name: symbol,
    standard: "VCS",
    projectType: "forestry",
    vintage,
    country: "CN",
    registry: "Verra",
    isScenario,
    projectId: null,
    methodology: null,
    verificationStatus: null,
    tickSize: 1,
    pricePrecision: 2,
    qtyStep: 1,
    minQty: 1,
    currency: "USD",
    lastPrice: 6800,
  };
}
const INSTRUMENTS: Record<string, Instrument> = {
  "VCS-FOR-2021": instrument("VCS-FOR-2021", 2021),
  "GS-WIND-2022": instrument("GS-WIND-2022", 2022),
  "CEA-SCEN-2026": instrument("CEA-SCEN-2026", 2026, true),
};
const PRECISIONS = pricePrecisionsOf(INSTRUMENTS);

function position(symbol: string, patch: Partial<Position> = {}): Position {
  return {
    assetId: `asset-${symbol}`,
    symbol,
    quantity: 120,
    locked: 20,
    lockedBy: { orders: 20, otc: 0 },
    available: 100,
    retired: 5,
    lastPrice: 6900,
    marketValue: 828_000,
    averagePurchasePrice: 6800,
    unrealisedPnl: 12_000,
    costBasisStatus: "complete",
    isScenario: false,
    ...patch,
  };
}

function fill(id: string, ts: number, patch: Partial<Fill> = {}): Fill {
  return {
    id,
    orderId: `ord-${id}`,
    symbol: "VCS-FOR-2021",
    side: "BUY",
    role: "TAKER",
    price: 6850,
    quantity: 10,
    notional: 68_500,
    feeCents: 0,
    ts,
    auditRef: `SIM-TRD-${id}`,
    ledgerRefs: [],
    ...patch,
  };
}

function order(id: string, createdAt: number, patch: Partial<Order> = {}): Order {
  return {
    id,
    clientOrderId: null,
    assetId: "asset-VCS-FOR-2021",
    symbol: "VCS-FOR-2021",
    side: "SELL",
    type: "LIMIT",
    price: 7000,
    quantity: 30,
    filledQuantity: 10,
    status: "PARTIAL",
    avgFillPrice: 7000,
    cancelReason: null,
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}

beforeEach(() => {
  useAccountStore.setState(createInitialAccountState(), true);
  useMarketStore.setState(createInitialState(), true);
});

describe("PositionsTab (PositionsView)", () => {
  // VCS-FOR 两个年份同属一个项目;GS-WIND-2022 没有项目编号(按标的单独成组);情景标的自成一组;GS-WIND-2023 已整仓注销
  const META = positionMetaOf({
    "VCS-FOR-2021": { ...instrument("VCS-FOR-2021", 2021), projectId: "SIM-PRJ-VCS-FOR", projectType: "林业碳汇", country: "中国" },
    "VCS-FOR-2023": { ...instrument("VCS-FOR-2023", 2023), projectId: "SIM-PRJ-VCS-FOR", projectType: "林业碳汇", country: "中国" },
    "GS-WIND-2022": { ...instrument("GS-WIND-2022", 2022), standard: "GS", projectType: "可再生能源", country: "印度" },
    "GS-WIND-2023": { ...instrument("GS-WIND-2023", 2023), standard: "GS" },
    "CEA-SCEN-2026": instrument("CEA-SCEN-2026", 2026, true),
  });
  const unlocked = { locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 120 };
  const positions = [
    position("VCS-FOR-2023", unlocked),
    position("GS-WIND-2022", { ...unlocked, costBasisStatus: "unknown_acquisition_cost", unrealisedPnl: 999, averagePurchasePrice: null }),
    position("VCS-FOR-2021", { lockedBy: { orders: 12, otc: 8 } }),
    position("CEA-SCEN-2026", { ...unlocked, isScenario: true, costBasisStatus: "incomplete_ledger", unrealisedPnl: null }),
  ];
  const retiredOut = position("GS-WIND-2023", { quantity: 0, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 0, retired: 40, marketValue: 0 });
  const render = (patch: Partial<PositionsViewProps> = {}) =>
    renderToStaticMarkup(createElement(PositionsView, { positions, meta: META, onSell: () => {}, onRetire: () => {}, onProtect: () => {}, retiredOpen: false, onToggleRetired: () => {}, ...patch }));
  const rowOf = (markup: string, assetId: string) => {
    const start = markup.indexOf(`data-asset-id="${assetId}"`);
    const next = markup.slice(start + 1).search(/data-(?:asset-id|group|locks-for|retired-group|retired-asset-id)=/);
    return markup.slice(start, next === -1 ? undefined : start + 1 + next);
  };
  const html = render();

  it("has the vintage · symbol, tradable / locked / retired, average cost, last price, market value and P&L column titles", () => {
    for (const label of [T.tabs.tradable, T.tabs.locked, T.tabs.retired, T.tabs.colAvgCost, T.header.lastPrice, T.tabs.colMarketValue, T.tabs.colPnl]) {
      expect(html).toContain(`>${esc(label)}</span>`);
    }
    expect(html).toContain(`>${T.meta.vintage} · ${T.tabs.colSymbol}</span>`);
  });

  it("fits 1440-wide bottom tabs (~798 px) without scrolling; narrower (from 48rem), the first and action columns and the group titles stay pinned (P2-12)", () => {
    // 最小宽度 49.75rem = 796 px ≤ 1440 宽时底部页签的内容宽约 798 px:不横向滚动就看得到「卖出 / 注销 / 止盈止损」(P3-07 加第三个按钮)
    expect(html).toContain("min-width:49.75rem");
    expect(parseFloat(/min-width:([\d.]+)rem/.exec(html)?.[1] ?? "99") * 16).toBeLessThanOrEqual(798);
    // 表头在虚拟列表的滚动容器里贴顶,横向滚动也由那个容器做(外层不再 overflow-x-auto):sticky 的格子才有参照
    const region = html.slice(html.indexOf('role="region"'));
    expect(region.indexOf('class="sticky top-0 z-(--z-sticky)"')).toBeGreaterThan(-1);
    expect(region.indexOf('class="sticky top-0')).toBeLessThan(region.indexOf(`>${T.meta.vintage} · ${T.tabs.colSymbol}</span>`));
    expect(html).not.toContain("overflow-x-auto");
    // 表头:首格贴左、操作列贴右
    expect(html).toContain(`<span class="truncate t-pin t-pin-start">${T.meta.vintage} · ${T.tabs.colSymbol}</span>`);
    expect(html).toContain('<span class="truncate t-pin t-pin-end"></span>');
    // 每一行持仓:年份 · 标的贴左,「卖出 / 注销」贴右,行带悬停叠色的标记
    for (const assetId of ["asset-VCS-FOR-2021", "asset-VCS-FOR-2023", "asset-GS-WIND-2022", "asset-CEA-SCEN-2026"]) {
      const row = rowOf(html, assetId);
      expect(row, assetId).toMatch(/class="[^"]*t-pin-row[^"]*"/);
      expect(row, assetId).toMatch(/<span class="truncate t-pin t-pin-start flex items-center gap-gap ps-panel">/);
      expect(row, assetId).toMatch(/<span class="t-pin t-pin-end flex items-center justify-end gap-gap"><button type="button" aria-label="Sell /);
    }
    // 分组标题、锁定来源、「已注销」组头的文字贴左(分组标题与组头用二级面板色)
    expect(html.match(/data-group="[^"]+" class="[^"]*"><span class="t-pin t-pin-start t-pin-alt /g)).toHaveLength(3);
    expect(html).toMatch(/data-locks-for="asset-VCS-FOR-2021"[^>]*><span class="t-pin t-pin-start /);
    const retired = render({ positions: [...positions, retiredOut], retiredOpen: true });
    expect(retired).toMatch(/data-retired-group=""[^>]*><span class="t-pin t-pin-start t-pin-alt /);
    const retiredRow = retired.slice(retired.indexOf('data-retired-asset-id="asset-GS-WIND-2023"'));
    expect(retiredRow).toMatch(/^[^>]*class="[^"]*t-pin-row/);
    // 「注销记录」链接比「卖出 / 注销」长:跨盈亏与操作两列、贴右
    expect(retiredRow).toMatch(/t-pin t-pin-end col-span-2 flex items-center justify-end"><a [^>]*href="\/retirement"/);
  });

  it("pinned cells fill the whole row height, so the header's empty action cell really covers the labels scrolled under it (P2-12 fix round)", () => {
    // 行是 items-center 的网格:格子默认只有内容那么高。表头操作列那格没有文字,不撑满的话高度是 0,底色画不出来,
    // 「未实现盈亏」一类表头文字就露在「卖出 / 注销」上方。贴边格一律 align-self: stretch,内容 flex 竖直居中;贴右的格子内容靠右
    const pin = pinRules();
    expect(pin.base(".t-pin")).toMatchObject({ "align-self": "stretch", display: "flex", "align-items": "center" });
    expect(pin.base(".t-pin-end")).toMatchObject({ "justify-content": "flex-end" });
    expect(pin.wide(".t-pin")).toMatchObject({ position: "sticky" });
    expect(pin.wide(".t-pin")["background"]).toMatch(/var\(--terminal-panel\)/);
    expect(pin.wide(".t-pin-end")).toMatchObject({ "inset-inline-end": "0" });
    expect(pin.wide(".t-pin-start")).toMatchObject({ "inset-inline-start": "0" });
    // 表头与各行都是固定行高(h-row)的容器,贴边格撑满的就是这一整行
    expect(html).toMatch(/<div class="grid h-row items-center [^"]*bg-\(--terminal-panel\)"[^>]*><span class="truncate t-pin t-pin-start">/);
  });

  it("phones do not pin: sticky, the opaque fill and the gap extension apply only from 48rem, so a 375-wide phone scrolls the whole table and every column can be read in full (P2-12 fix round 2)", () => {
    // 375 宽时滚动区约 317 px;首列最窄 10.5rem(168 px)、操作列 9.5rem(152 px,P3-07 起三个按钮),两头一贴中间七列一点都不剩
    expect(/grid-template-columns:([^;"]+)/.exec(html)?.[1]).toMatch(/^minmax\(10\.5rem,[^)]*\) .* 9\.5rem$/);
    const pin = pinRules();
    // 断点块外:只有撑满行高、竖直居中、贴右格内容靠右这些版面规则,没有 sticky、inset、底色、z-index、伸出间隙
    expect(pin.base(".t-pin")).toEqual({ "align-self": "stretch", display: "flex", "align-items": "center" });
    expect(pin.base(".t-pin-end")).toEqual({ "justify-content": "flex-end" });
    for (const selector of [".t-pin-start", ".t-pin-alt", ".t-pin-row:hover > .t-pin"]) expect(pin.baseSelectors, selector).not.toContain(selector);
    // 贴边的全部规则只在 ≥ 48rem 的那一个断点块里(48rem 起底部页签占满整行,约 734 px)
    expect(pin.widePrelude).toBe("@media (width >= 48rem)");
    expect(pin.wide(".t-pin")).toEqual({ position: "sticky", "z-index": "var(--z-sticky)", background: "var(--t-pin-bg, var(--terminal-panel))" });
    expect(pin.wide(".t-pin-alt")).toEqual({ "--t-pin-bg": "var(--terminal-panel-2)" });
    expect(pin.wide(".t-pin-start")).toEqual({ "inset-inline-start": "0", "margin-inline-end": "calc(var(--spacing-gap) * -1)", "padding-inline-end": "var(--spacing-gap)" });
    expect(pin.wide(".t-pin-end")).toEqual({ "inset-inline-end": "0", "margin-inline-start": "calc(var(--spacing-gap) * -1)", "padding-inline-start": "var(--spacing-gap)" });
    expect(pin.wide(".t-pin-row:hover > .t-pin")["background"]).toMatch(/var\(--terminal-row-hover\)/);
    // 整个样式表里 .t-pin 的 sticky 只有这一处
    expect(pin.stickyCount).toBe(1);
  });

  it("groups by project with one row per vintage, ascending; an instrument without a project id and a scenario instrument are groups of their own", () => {
    const order = [...html.matchAll(/data-(group|asset-id|locks-for)="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    expect(order).toEqual([
      "group:symbol:CEA-SCEN-2026",
      "asset-id:asset-CEA-SCEN-2026",
      "group:symbol:GS-WIND-2022",
      "asset-id:asset-GS-WIND-2022",
      "group:project:SIM-PRJ-VCS-FOR",
      "asset-id:asset-VCS-FOR-2021",
      "locks-for:asset-VCS-FOR-2021",
      "asset-id:asset-VCS-FOR-2023",
    ]);
  });

  it("heads each group with the project id (or the symbol), type, standard and country, and marks a simulated project id as such", () => {
    const head = (key: string) => {
      const start = html.indexOf(`data-group="${key}"`);
      return html.slice(start, html.indexOf("</div>", start));
    };
    const project = head("project:SIM-PRJ-VCS-FOR");
    expect(project).toContain(`<span class="sr-only">${T.meta.projectId}</span>`);
    expect(project).toContain(`title="${T.meta.simulatedProjectId}"`);
    expect(project).toContain(">SIM-PRJ-VCS-FOR</span>");
    // 组头的文字包在一层贴左的 span 里(P2-12:横向滚动时整条标题贴左)
    expect(project).toMatch(/· Forestry sink<\/span><span>· VCS<\/span><span>· China<\/span><\/span>$/);
    const solo = head("symbol:GS-WIND-2022");
    expect(solo).toContain(">GS-WIND-2022</span>");
    expect(solo).toMatch(/· Renewable energy<\/span><span>· GS<\/span><span>· India<\/span><\/span>$/);
    expect(solo).not.toContain(T.meta.projectId);
    expect(solo).not.toContain("title=");
    // 组头是标题(读屏可按标题跳组),行高与数据行一致(虚拟列表的一行)
    expect(html.match(/role="heading" aria-level="3" data-group=/g)).toHaveLength(3);
    expect(html.match(/data-group="[^"]+" class="flex h-row /g)).toHaveLength(3);
  });

  it("shows the vintage first, then the symbol, and tradable = available, locked and retired as separate numbers", () => {
    const row = rowOf(html, "asset-VCS-FOR-2021");
    expect(row).toMatch(/>2021<\/span><span class="truncate text-muted">VCS-FOR-2021<\/span>/);
    expect(row).toMatch(/>100<\/span>[\s\S]*?>20<\/span>[\s\S]*?>5<\/span>/);
  });

  it("splits a locked quantity into its sources: a visible line under the row and the same text as the cell's title", () => {
    const source = T.retire.lockedBy({ orders: "12", otc: "8" });
    expect(source).toBe("Locked: sell orders 12 · OTC listings 8");
    expect(rowOf(html, "asset-VCS-FOR-2021")).toContain(`data-locked="" class="tnum truncate text-end text-muted" title="${source}">20</span>`);
    const line = html.slice(html.indexOf('data-locks-for="asset-VCS-FOR-2021"'));
    expect(line.slice(0, line.indexOf("</div>"))).toContain(`>${source}</span>`);
    // 没有锁定的行:没有来源行,也没有 title
    expect(html.match(/data-locks-for=/g)).toHaveLength(1);
    expect(rowOf(html, "asset-VCS-FOR-2023")).toContain('data-locked="" class="tnum truncate text-end text-muted">0</span>');
  });

  it("shows lockedBy as read even when it does not add up to locked (locked stays the figure that counts)", () => {
    const markup = render({ positions: [position("VCS-FOR-2021", { locked: 20, available: 100, lockedBy: { orders: 12, otc: 3 } })] });
    expect(rowOf(markup, "asset-VCS-FOR-2021")).toMatch(/>100<\/span><span data-locked=""[^>]*>20<\/span>/);
    expect(markup).toContain(`>${T.retire.lockedBy({ orders: "12", otc: "3" })}</span>`);
  });

  it("tolerates positions without lockedBy (a Phase 1 server after a rollback): the locked total only, no sources line or title, no crash", () => {
    const noSources = (patch: Partial<Position> = {}) => position("VCS-FOR-2021", { ...patch, lockedBy: undefined as unknown as Position["lockedBy"] });
    const markup = render({ positions: [noSources(), position("VCS-FOR-2023", { ...unlocked, lockedBy: null as unknown as Position["lockedBy"] })] });
    expect(rowOf(markup, "asset-VCS-FOR-2021")).toContain('data-locked="" class="tnum truncate text-end text-muted">20</span>');
    expect(rowOf(markup, "asset-VCS-FOR-2021")).toMatch(/>100<\/span><span data-locked=""[^>]*>20<\/span><span[^>]*>5<\/span>/);
    expect(rowOf(markup, "asset-VCS-FOR-2023")).toContain('data-locked="" class="tnum truncate text-end text-muted">0</span>');
    expect(markup).not.toContain("data-locks-for=");
    expect(markup).not.toContain("Locked: sell orders");
    expect(positionRows(groupPositions([noSources()], META), false).map((r) => r.kind)).toEqual(["group", "position"]);
    // 来源齐全的行不受影响
    expect(positionRows(groupPositions([position("VCS-FOR-2021")], META), false)[2]).toEqual({ kind: "locks", key: "locks:asset-VCS-FOR-2021", assetId: "asset-VCS-FOR-2021", orders: 20, otc: 0 });
  });

  it("shows a signed P&L only when the cost basis is complete, otherwise the — placeholder with the reason as title", () => {
    expect(html).toContain("+120.00");
    expect(html).not.toContain("9.99"); // unknown_acquisition_cost:服务端给了数也不显示
    expect(count(html, `title="${T.tabs.pnlUnavailable}"`)).toBe(4); // 两行 × (均价 + 盈亏)
    expect(html).toMatch(new RegExp(`data-pnl=""[^>]*title="${T.tabs.pnlUnavailable}"[^>]*>—<span class="sr-only">`));
  });

  it("computes market value and P&L from the last price, not from the figures frozen in the event", () => {
    // 事件里的 marketValue / unrealisedPnl 是旧的(按 6,800 算:816,000 / 0);这一行现在的价格是 6,900
    const stale = position("VCS-FOR-2021", { lastPrice: 6900, marketValue: 816_000, averagePurchasePrice: 6800, unrealisedPnl: 12_000 });
    const row = rowOf(render({ positions: [stale] }), "asset-VCS-FOR-2021");
    expect(row).toContain('data-last-price="" class="tnum truncate text-end">69.00</span>');
    expect(row).toContain('data-market-value="" class="tnum truncate text-end">8,280.00</span>'); // 120 × 69.00
    expect(row).not.toContain("8,160.00");
    expect(row).toContain(">+120.00<");
  });

  it("shows — for last price and market value when the instrument has never traded (lastPrice null), not the server's (0 × qty) zero", () => {
    const markup = render({ positions: [position("VCS-FOR-2021"), position("GS-WIND-2022", { lastPrice: null, marketValue: 0, unrealisedPnl: null })] });
    expect(rowOf(markup, "asset-VCS-FOR-2021")).toContain('data-market-value="" class="tnum truncate text-end">8,280.00</span>');
    const unpriced = rowOf(markup, "asset-GS-WIND-2022");
    expect(unpriced).toContain('data-last-price="" class="tnum truncate text-end">—</span>');
    expect(unpriced).toContain('data-market-value="" class="tnum truncate text-end">—</span>');
    expect(unpriced).not.toContain(">0.00<");
  });

  it("Retire is a button that opens the dialog (no link to the old wizard), disabled with the reason for scenario instruments", () => {
    const retire = rowOf(html, "asset-VCS-FOR-2021");
    expect(retire).toMatch(new RegExp(`<button type="button" data-retire="" aria-label="${T.tabs.retire} VCS-FOR-2021" aria-haspopup="dialog" title="${T.tabs.retireHint}"[^>]*>${T.tabs.retire}</button>`));
    expect(html).not.toContain('href="/retirement');
    expect(html.match(/data-retire=""/g)).toHaveLength(3);
    // 情景标的:真正的 disabled 按钮(读屏会报不可用),原因在 title 与 sr-only 文字里;不是带 aria-disabled 的 span
    const scenario = rowOf(html, "asset-CEA-SCEN-2026");
    expect(scenario).toMatch(new RegExp(`<span title="${T.retire.scenarioBlocked}"[^>]*><button type="button" disabled=""[^>]*>${T.tabs.retire}</button><span class="sr-only">${T.retire.scenarioBlocked}</span></span>`));
    expect(scenario).not.toContain("data-retire");
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).toContain(`>${T.tabs.scenarioTag}<`);
    // 卖出不变:每个持仓行一个,读屏名带标的
    expect(count(html, `>${T.order.sell}</button>`)).toBe(4);
    expect(html).toContain(`aria-label="${T.order.sell} GS-WIND-2022"`);
  });

  it("loads the retire dialog with next/dynamic only (no static import: it must stay out of the terminal's first load)", () => {
    const source = readFileSync(fileURLToPath(new URL("./PositionsTab.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/dynamic\(\(\) => import\("@\/components\/account\/RetireDialog"\)[^\n]*ssr: false/);
    expect(source).not.toMatch(/^import [^\n]*from "@\/components\/account\/RetireDialog"/m);
    expect(source).not.toMatch(/from "@\/lib\/(?:market\/retire-flow|exchange\/retirement-form)"/);
    // 服务端标记里没有对话框(没点过「注销」就不挂载)
    expect(html).not.toContain("<dialog");
    expect(renderToStaticMarkup(createElement(PositionsTab))).not.toContain("<dialog");
  });

  it("keeps fully retired rows in a collapsed group at the bottom, headed by their count and total tonnes", () => {
    const another = position("VCS-FOR-2023", { quantity: 0, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 0, retired: 1260, marketValue: 0 });
    const held = positions.filter((p) => p.symbol !== "VCS-FOR-2023");
    const collapsed = render({ positions: [...held, retiredOut, another] });
    const label = T.retire.retiredGroup({ count: 2, tonnes: "1,300" });
    // 不说「全部注销」:数量 0 的行也可能是注销一部分、其余卖掉(P2-13,终审 UI-2)
    expect(label).toBe("Retired, no longer held (2) · 1,300 t");
    expect(collapsed).toMatch(new RegExp(`<button type="button" data-retired-group="" aria-expanded="false"[^>]*>.*?<span>${esc(label).replace(/[()]/g, "\\$&")}</span></span></button>`));
    expect(collapsed).not.toContain("data-retired-asset-id=");
    expect(collapsed).not.toContain('data-asset-id="asset-GS-WIND-2023"');
    expect(collapsed.match(/data-asset-id=/g)).toHaveLength(held.length);
    // 折叠按钮排在所有项目组之后
    expect(collapsed.lastIndexOf("data-group=")).toBeLessThan(collapsed.indexOf("data-retired-group="));
    expect(collapsed.lastIndexOf("data-asset-id=")).toBeLessThan(collapsed.indexOf("data-retired-group="));
  });

  it("lists the retired rows when the group is open: retired tonnes only, a link to the retirement history (certificates), no Sell / Retire", () => {
    const open = render({ positions: [...positions, retiredOut], retiredOpen: true });
    expect(open).toContain('data-retired-group="" aria-expanded="true"');
    const start = open.indexOf('data-retired-asset-id="asset-GS-WIND-2023"');
    expect(start).toBeGreaterThan(open.indexOf("data-retired-group="));
    const row = open.slice(start);
    expect(row).toMatch(/>2023<\/span><span class="truncate text-muted">GS-WIND-2023<\/span>/);
    expect(row).toContain('<span class="tnum truncate text-end">40</span>');
    expect(row).toContain(`href="${RETIREMENT_HISTORY_HREF}"`);
    expect(row).toContain(`>${T.retire.history}</a>`);
    expect(row).not.toContain(`>${T.order.sell}</button>`);
    expect(row).not.toContain("data-retire=");
    // 只有整仓注销的行:不是空态,是一个折叠的分组
    const onlyRetired = render({ positions: [retiredOut] });
    expect(onlyRetired).not.toContain(esc(T.tabs.emptyPositions));
    expect(onlyRetired).toContain(esc(T.retire.retiredGroup({ count: 1, tonnes: "40" })));
  });

  it("builds the row list: group head, vintages, lock sources, and the retired group only when there is something in it", () => {
    const kinds = (list: Position[], retiredOpen: boolean) => positionRows(groupPositions(list, META), retiredOpen).map((r) => r.kind);
    expect(kinds([position("VCS-FOR-2021"), position("VCS-FOR-2023", unlocked)], false)).toEqual(["group", "position", "locks", "position"]);
    expect(kinds([position("VCS-FOR-2021", unlocked), retiredOut], false)).toEqual(["group", "position", "retiredHeader"]);
    expect(kinds([position("VCS-FOR-2021", unlocked), retiredOut], true)).toEqual(["group", "position", "retiredHeader", "retired"]);
    expect(kinds([], true)).toEqual([]);
    const keys = positionRows(groupPositions([...positions, retiredOut], META), true).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("group heads and the retired-group toggle are memoised and take primitives only, so an unchanged group does not re-render", () => {
    const MEMO = Symbol.for("react.memo");
    expect((PositionGroupRow as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO);
    expect((RetiredGroupRow as unknown as { $$typeof: symbol }).$$typeof).toBe(MEMO);
    // 组头只收原始类型:groupPositions 每次都生成新的组对象,传对象进来 memo 的浅比较永远不中
    const head = renderToStaticMarkup(
      createElement(PositionGroupRow, { groupKey: "project:SIM-PRJ-VCS-FOR", projectId: "SIM-PRJ-VCS-FOR", symbol: "VCS-FOR-2021", projectType: "林业碳汇", standard: "VCS", country: "中国" }),
    );
    expect(head).toContain('data-group="project:SIM-PRJ-VCS-FOR"');
    expect(head).toMatch(/· Forestry sink<\/span><span>· VCS<\/span><span>· China<\/span>/);
    const source = readFileSync(fileURLToPath(new URL("./PositionsTab.tsx", import.meta.url)), "utf8");
    expect(source).not.toMatch(/<PositionGroupRow group=/);
    // 两次分组(持仓事件前后)组对象不同,但组头拿到的每个值都相等
    const a = groupPositions(positions, META).groups;
    const b = groupPositions(positions.map((p) => ({ ...p })), META).groups;
    expect(a[2]).not.toBe(b[2]);
    for (const key of ["key", "projectId", "symbol", "projectType", "standard", "country"] as const) expect(a[2][key]).toBe(b[2][key]);
  });

  it("names its scroll region terminal.a11y.positionsRegion (not the orders table)", () => {
    expect(html).toContain(`aria-label="${T.a11y.positionsRegion}"`);
    expect(html).not.toContain(`aria-label="${T.a11y.ordersRegion}"`);
  });

  it("Sell seeds a SELL draft on the position's symbol and drops a price picked on another instrument", () => {
    marketActions.setDraft({ symbol: "VCS-FOR-2021", side: "BUY", price: 6850 }); // 盘口点价(别的标的)
    const nonce = useMarketStore.getState().draft.nonce;
    handlePositionSell("GS-WIND-2022");
    const draft = useMarketStore.getState().draft;
    // setDraft 整颗替换:种子里根本没有 price 这个键,不必再显式传 price: undefined
    expect(draft).toEqual({ symbol: "GS-WIND-2022", side: "SELL", nonce: nonce + 1 });
    expect("price" in draft).toBe(false);
  });

  it("after the dialog closes, focus goes to the table only when it has nowhere else to be (the row moved into the collapsed retired group)", () => {
    const focus = vi.fn();
    const host = { querySelector: vi.fn(() => ({ focus })) } as unknown as Element;
    const body = {} as Element;
    const button = {} as Element;
    focusPositionsRegion(host, button, body); // 焦点已还给「注销」按钮
    expect(focus).not.toHaveBeenCalled();
    focusPositionsRegion(host, body, body);
    focusPositionsRegion(host, null, body);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(host.querySelector).toHaveBeenCalledWith('[role="region"]');
    expect(() => focusPositionsRegion(null, null, body)).not.toThrow();
  });

  it("drops the retire request once its position leaves the store, so the dialog does not open by itself when the asset is bought again", () => {
    // 按 PositionsTab 的写法模拟几次渲染:dropped 时把返回的 request 写回 state;wasOpen 时记一次「对话框随持仓消失」(焦点兜底)
    let request: RetireRequest | null = { assetId: "asset-VCS-FOR-2021", open: true };
    let orphaned = 0;
    const renderWith = (list: Position[]) => {
      const r = reconcileRetireRequest(request, list);
      if (r.dropped) {
        request = r.request;
        if (r.wasOpen) orphaned++;
      }
      const target = request ? list.find((p) => p.assetId === request?.assetId) : undefined;
      return request && target ? { mounted: true, open: request.open } : { mounted: false, open: false };
    };
    const held = position("VCS-FOR-2021");
    expect(renderWith([held, position("GS-WIND-2022")])).toEqual({ mounted: true, open: true });
    expect(orphaned).toBe(0);
    // 整仓注销的行(数量 0、已注销 > 0)还在 store 里:请求不作废(回执还要显示)
    expect(renderWith([position("VCS-FOR-2021", { quantity: 0, available: 0, locked: 0, retired: 125 })])).toEqual({ mounted: true, open: true });
    // 卖光且没注销过:行被移除 → 请求作废,对话框卸载,记一次焦点兜底
    expect(renderWith([position("GS-WIND-2022")])).toEqual({ mounted: false, open: false });
    expect(request).toBeNull();
    expect(orphaned).toBe(1);
    // 同一标的再买回来:不会自己弹出来,也不再记
    expect(renderWith([held, position("GS-WIND-2022")])).toEqual({ mounted: false, open: false });
    expect(renderWith([position("GS-WIND-2022")])).toEqual({ mounted: false, open: false });
    expect(orphaned).toBe(1);
  });

  it("reconcileRetireRequest: a closed request is dropped quietly; a live or absent one is left alone", () => {
    const list = [position("GS-WIND-2022")];
    expect(reconcileRetireRequest({ assetId: "asset-VCS-FOR-2021", open: false }, list)).toEqual({ request: null, dropped: true, wasOpen: false });
    expect(reconcileRetireRequest({ assetId: "asset-VCS-FOR-2021", open: true }, [])).toEqual({ request: null, dropped: true, wasOpen: true });
    const live: RetireRequest = { assetId: "asset-GS-WIND-2022", open: true };
    expect(reconcileRetireRequest(live, list)).toEqual({ request: live, dropped: false, wasOpen: false });
    expect(reconcileRetireRequest(live, list).request).toBe(live);
    expect(reconcileRetireRequest(null, list)).toEqual({ request: null, dropped: false, wasOpen: false });
  });

  it("uses EmptyState when there are no positions", () => {
    const empty = render({ positions: [], meta: {} });
    expect(empty).toContain(renderToStaticMarkup(createElement(EmptyState, { title: T.tabs.emptyPositions })));
    // 元数据还没到(行情 store 为空):按标的各自成组,年份显示「—」,不猜
    const bare = render({ positions: [position("VCS-FOR-2021")], meta: {} });
    expect(bare).toContain('data-group="symbol:VCS-FOR-2021"');
    expect(rowOf(bare, "asset-VCS-FOR-2021")).toMatch(/>—<\/span><span class="truncate text-muted">VCS-FOR-2021<\/span>/);
  });
});

describe("FillsTab rows", () => {
  it("shows the SIM-TRD audit reference with the auditNote, and a signed-off role / side", () => {
    const html = renderToStaticMarkup(
      createElement(FillRow, {
        id: "clx1",
        ts: 1_790_000_000_000,
        symbol: "VCS-FOR-2021",
        side: "BUY",
        role: "MAKER",
        price: 6850,
        quantity: 10,
        notional: 68_500,
        feeCents: 0,
        auditRef: "SIM-TRD-clx1",
        precision: 2,
        onOpen: () => {},
      }),
    );
    expect(html).toContain("SIM-TRD-clx1");
    expect(html).toContain(`title="${T.tape.auditNote}"`);
    expect(html).toContain(`<span class="sr-only"> · ${T.tape.auditNote}</span>`);
    expect(html).toContain(`>${T.tabs.maker}<`);
    expect(html).toContain("text-(--terminal-up)");
    expect(html).toContain(">68.50<");
    expect(html).toContain(">685.00<");
    expect(html).toContain(">0.00<");
  });

  it("the container renders the fills EmptyState on the server (no account yet) and does not load the detail dialog", () => {
    const html = renderToStaticMarkup(createElement(FillsTab));
    expect(html).toContain(`>${T.tabs.colAuditRef}</span>`);
    expect(html).toContain(`aria-label="${T.a11y.fillsRegion}"`); // 区域名是成交表,不是「委托表」
    expect(html).not.toContain(`aria-label="${T.a11y.ordersRegion}"`);
    expect(html).toContain(renderToStaticMarkup(createElement(EmptyState, { title: T.tabs.emptyFills })));
    expect(html).not.toContain("<dialog");
  });

  it("shows the auditNote as visible text under a table that has rows (touch users never see a title)", () => {
    const table = (items: Fill[]) =>
      renderToStaticMarkup(
        createElement(TabTable<Fill>, {
          columns: { template: "1fr", minWidth: "10rem" },
          headers: [{ label: T.tabs.colAuditRef }],
          items,
          getKey: (f) => f.id,
          renderRow: (f) => f.auditRef,
          label: T.tabs.fills,
          empty: createElement(EmptyState, { title: T.tabs.emptyFills }),
          footnote: T.tape.auditNote,
        } satisfies TabTableProps<Fill>) as ReactElement,
      );
    const withRows = table([fill("clx1", 2), fill("clx2", 1)]);
    expect(count(withRows, `>${T.tape.auditNote}</p>`)).toBe(1); // 每张表一次,不是每行
    expect(withRows).toContain('<p class="shrink-0 px-gap text-t-2xs text-muted">');
    expect(table([])).not.toContain(T.tape.auditNote); // 空表只有 EmptyState
  });

  it("orders fills newest first with id as the tie-break", () => {
    const sorted = [fill("a", 1), fill("c", 2), fill("b", 2)].sort(newestFillFirst).map((f) => f.id);
    expect(sorted).toEqual(["c", "b", "a"]);
  });
});

describe("FillDetailDialog (FillDetailView)", () => {
  const detail: FillDetailResponse = {
    fill: fill("clx9", 1_790_000_000_000, { side: "SELL", role: "TAKER" }),
    ledger: [
      { id: "l1", account: "CASH", delta: 68_500, reason: "TRADE_SETTLE", createdAt: 1_790_000_000_000 },
      { id: "l2", account: "HOLDING", delta: -10, reason: "TRADE_SETTLE", createdAt: 1_790_000_000_000 },
      { id: "l3", account: "HOLDING_LOCKED", delta: -10, reason: "TRADE_SETTLE", createdAt: 1_790_000_000_000 },
    ],
    counterpartyIsBot: true,
    disclosure: FILL_DISCLOSURE,
  };
  const html = renderToStaticMarkup(createElement(FillDetailView, { detail, precision: 2 }));

  it("shows the audit reference with the auditNote and the disclosure text", () => {
    expect(html).toContain("SIM-TRD-clx9");
    expect(html).toContain(T.tape.auditNote);
    expect(html).toContain(`role="note"`);
    expect(html).toContain(`>${T.tabs.disclosure}</p>`);
  });

  it("lists every ledger line with account, signed delta and reason", () => {
    // 表头:账户 / 变动 / 原因 / 时间(D20 补的键),表格经标题「账本行」命名
    for (const label of [T.tabs.colAccount, T.tabs.colDelta, T.tabs.colReason, T.tabs.colTime]) expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${label}</th>`));
    expect(html).toMatch(/<h3 id="([^"]+)"[^>]*>[^<]+<\/h3>[\s\S]*<table aria-labelledby="\1"/);
    expect(count(html, "data-ledger-line")).toBe(3);
    expect(html).toContain(">CASH<");
    expect(html).toContain(">+685.00<");
    expect(html).toContain(">HOLDING_LOCKED<");
    expect(count(html, ">-10<")).toBe(2);
    expect(count(html, ">TRADE_SETTLE<")).toBe(3);
    expect(html).toContain(`>${T.tabs.ledger}<`);
  });

  it("shows ledger deltas with a sign and the neutral foreground, like the Ledger tab — never the up / down direction tokens", () => {
    // 账本变动是账户的增减,不是价格方向:正负号 + 读屏的增 / 减,文字中性色(红涨模式下涨跌色对调,含义会反转)
    const cells = [...html.matchAll(/<td data-direction="(in|out|none)" class="([^"]*)">(.*?)<\/td>/g)].map((m) => [m[1], m[2], m[3]]);
    expect(cells).toEqual([
      ["in", "truncate px-0.5 py-gap whitespace-nowrap tnum text-end text-foreground", `<span class="sr-only">${T.ledger.increase} </span>+685.00`],
      ["out", "truncate px-0.5 py-gap whitespace-nowrap tnum text-end text-foreground", `<span class="sr-only">${T.ledger.decrease} </span>-10`],
      ["out", "truncate px-0.5 py-gap whitespace-nowrap tnum text-end text-foreground", `<span class="sr-only">${T.ledger.decrease} </span>-10`],
    ]);
    const zero = renderToStaticMarkup(createElement(FillDetailView, { detail: { ...detail, ledger: [{ ...detail.ledger[0], delta: 0 }] }, precision: 2 }));
    expect(zero).toContain('<td data-direction="none" class="truncate px-0.5 py-gap whitespace-nowrap tnum text-end text-muted">0.00</td>');
    // 账本表里没有涨跌色;成交字段里的方向(卖出)仍是方向色,不受影响
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table).not.toContain("--terminal-up");
    expect(table).not.toContain("--terminal-down");
    expect(html).toContain(`<dd class="tnum text-end text-(--terminal-down)">${T.order.sell}</dd>`);
  });

  it("names the counterparty type only", () => {
    expect(html).toContain(T.tabs.counterpartyBot);
    const human = renderToStaticMarkup(createElement(FillDetailView, { detail: { ...detail, counterpartyIsBot: false }, precision: 2 }));
    expect(human).toContain(T.tabs.counterpartyUser);
    expect(human).not.toContain(T.tabs.counterpartyBot);
  });

  it("the dialog subscribes to one precision, not the whole instruments record (polling replaces it every 2 s)", () => {
    // 行为:selector 选出的是原始值;整张 instruments 换了引用而精度没变 → 前后 Object.is 相等(zustand 不通知重渲染)
    const inst = (symbol: string, pricePrecision: number) => ({ symbol, pricePrecision }) as Instrument;
    const state = (instruments: Record<string, Instrument>) => ({ ...createInitialState(), instruments });
    const select = fillPrecisionSelector("VCS-FOR-2021");
    const before = select(state({ "VCS-FOR-2021": inst("VCS-FOR-2021", 3), "GS-REN-2020": inst("GS-REN-2020", 2) }));
    const after = select(state({ "VCS-FOR-2021": inst("VCS-FOR-2021", 3), "GS-REN-2020": inst("GS-REN-2020", 1) }));
    expect(before).toBe(3);
    expect(Object.is(before, after)).toBe(true);
    expect(select(state({}))).toBeUndefined();
    expect(fillPrecisionSelector(null)(state({ "VCS-FOR-2021": inst("VCS-FOR-2021", 3) }))).toBeUndefined();
    // 源码里不出现订阅整张表的写法(任何变量名 / 解构都算)
    const src = readFileSync(fileURLToPath(new URL("./FillDetailDialog.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/useMarketStore\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.instruments\s*\)/);
    expect(src).not.toMatch(/useMarketStore\(\s*\(\s*\{\s*instruments\s*\}\s*\)\s*=>/);
    expect(src).toContain("useMarketStore(fillPrecisionSelector(symbol))");
  });

  // 账本变动的格式化(现金按分、持仓按整数数量)在 TabTable 的 fmtLedgerDelta,与流水页签共用,测试在 ledger.ssr.test.ts
  it("builds the private fill detail URL with the id encoded", () => {
    expect(fillDetailUrl("a b")).toBe("/api/account/fills/a%20b");
  });
});

describe("OpenOrdersTab", () => {
  const view = (orders: Order[], armedId: string | null = null, busyIds: ReadonlySet<string> = new Set()) =>
    renderToStaticMarkup(
      createElement(OpenOrdersView, {
        symbol: "VCS-FOR-2021",
        scope: "all",
        onScope: () => {},
        orders,
        precisions: PRECISIONS,
        armedId,
        busyIds,
        onCancel: () => {},
      }),
    );

  it("uses EmptyState for no open orders", () => {
    const html = view([]);
    expect(html).toContain(renderToStaticMarkup(createElement(EmptyState, { title: T.tabs.emptyOpen })));
  });

  it("offers All / current-symbol scope and one cancel button per order", () => {
    const html = view([order("o1", 2), order("o2", 1, { status: "OPEN", filledQuantity: 0 })]);
    // 按钮组有可访问名(读屏不念成无名的 group)
    expect(html).toContain(`<div role="group" aria-label="${T.tabs.scopeLabel}"`);
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${T.instruments.all}<`));
    expect(html).toMatch(/aria-pressed="false"[^>]*>VCS-FOR-2021</);
    expect(count(html, "data-cancel-for=")).toBe(2);
    expect(html).toContain(`>${T.tabs.status.PARTIAL}<`);
    expect(html).toContain("text-warning");
    expect(html).toContain(">70.00<");
  });

  it("the armed row turns its own button into the confirm step (same element, danger colour)", () => {
    const armed = renderToStaticMarkup(
      createElement(OpenOrderRow, {
        id: "o1",
        createdAt: 1,
        symbol: "VCS-FOR-2021",
        side: "BUY",
        type: "LIMIT",
        price: 6800,
        quantity: 5,
        filledQuantity: 0,
        status: "OPEN",
        precision: 2,
        armed: true,
        busy: false,
        onCancel: () => {},
      }),
    );
    expect(armed).toMatch(new RegExp(`data-cancel-for="o1" data-armed=""[^>]*>${T.tabs.cancelConfirm}</button>`));
    expect(armed).toContain("text-danger");
    // 可访问名按行说清撤哪一张;武装后说明这一下是确认(看得见的字不变)
    expect(armed).toContain('aria-label="Confirm cancel buy order VCS-FOR-2021"');
    const idle = view([order("o1", 1)]);
    expect(idle).toMatch(new RegExp(`data-cancel-for="o1"[^>]*>${T.tabs.cancel}</button>`));
    expect(idle).not.toContain("data-armed");
    expect(idle).toContain(`data-cancel-for="o1" aria-label="Cancel sell order VCS-FOR-2021"`);
  });

  it("marks every order with a cancel in flight as busy, not just the latest one", () => {
    const html = view([order("o1", 3), order("o2", 2), order("o3", 1)], null, new Set(["o1", "o2"]));
    const busy = (id: string) => new RegExp(`data-cancel-for="${id}" aria-label="[^"]*" aria-disabled="true" aria-busy="true"`).test(html);
    expect(busy("o1")).toBe(true);
    expect(busy("o2")).toBe(true);
    expect(busy("o3")).toBe(false);
  });
});

describe("liveArmedId", () => {
  it("stays armed only while the armed order is still listed (filled by the bot, cancelled elsewhere or hidden by the scope → disarmed)", () => {
    const orders = [order("o1", 2), order("o2", 1)];
    expect(liveArmedId("o1", orders)).toBe("o1");
    expect(liveArmedId("o1", [order("o2", 1)])).toBeNull();
    expect(liveArmedId(null, orders)).toBeNull();
    // 视图拿到的是派生值:行不在了就没有 data-armed,也就没有「确认撤单」
    expect(renderToStaticMarkup(
      createElement(OpenOrdersView, {
        symbol: "VCS-FOR-2021",
        scope: "all",
        onScope: () => {},
        orders: [order("o2", 1)],
        precisions: PRECISIONS,
        armedId: liveArmedId("o1", [order("o2", 1)]),
        busyIds: new Set<string>(),
        onCancel: () => {},
      }),
    )).not.toContain("data-armed");
  });
});

describe("reconcileArmed (render-phase state adjustment in OpenOrdersTab)", () => {
  it("clears the armed state once the order leaves the list, and does not re-arm when the same id comes back", () => {
    // 按 OpenOrdersTab 的写法模拟几次渲染:vanished 时把返回的 armedId 写回 state
    let armedId: string | null = "o1";
    let vanishedCount = 0;
    const render = (orders: Order[]) => {
      const r = reconcileArmed(armedId, orders);
      if (r.vanished) {
        armedId = r.armedId;
        vanishedCount++;
      }
      return liveArmedId(armedId, orders);
    };
    expect(render([order("o1", 2), order("o2", 1)])).toBe("o1");
    expect(vanishedCount).toBe(0);
    // 机器人吃完了 o1:武装作废,记一次消失
    expect(render([order("o2", 1)])).toBeNull();
    expect(armedId).toBeNull();
    expect(vanishedCount).toBe(1);
    // D16 快照与终态事件赛跑,o1 又被 upsert 回来:不重新武装,也不再记消失(条件只成立一次,不会循环)
    expect(render([order("o1", 2), order("o2", 1)])).toBeNull();
    expect(render([order("o2", 1)])).toBeNull();
    expect(vanishedCount).toBe(1);
  });

  it("leaves an unarmed or still-listed state alone", () => {
    expect(reconcileArmed(null, [])).toEqual({ armedId: null, vanished: false });
    expect(reconcileArmed("o1", [order("o1", 1)])).toEqual({ armedId: "o1", vanished: false });
  });
});

describe("armedEscapeAction", () => {
  // node 环境没有 DOM:只实现 closest / contains 的假元素
  const fake = (opts: { inDialog?: boolean; inert?: boolean; contains?: unknown[] } = {}): Element => {
    const self: { closest: (selector: string) => object | null; contains: (other: unknown) => boolean } = {
      closest: (selector) => ((selector === "dialog[open]" && opts.inDialog) || (selector === "[inert]" && opts.inert) ? {} : null),
      contains: (other) => other === self || (opts.contains ?? []).includes(other),
    };
    return self as unknown as Element;
  };
  const button = fake();
  const root = fake({ contains: [button] });
  const body = fake();
  const search = fake();
  const confirm = fake({ inDialog: true });

  it("leaves Esc to an open dialog that has focus, and to a modal drawer that made the panel inert", () => {
    expect(armedEscapeAction(confirm, root, body)).toBe("ignore");
    expect(armedEscapeAction(button, fake({ inert: true, contains: [button] }), body)).toBe("ignore");
  });

  it("returns focus to the trigger when focus is in the panel or was lost to body", () => {
    expect(armedEscapeAction(button, root, body)).toBe("disarm-and-focus");
    expect(armedEscapeAction(body, root, body)).toBe("disarm-and-focus");
    expect(armedEscapeAction(null, root, body)).toBe("disarm-and-focus");
  });

  it("disarms without stealing focus from elsewhere (the search box)", () => {
    expect(armedEscapeAction(search, root, body)).toBe("disarm");
  });
});

describe("cancelOrderRequest", () => {
  const response = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

  it("DELETEs /api/orders/[id] and returns the cancelled order", async () => {
    const cancelled = order("o 1", 1, { status: "CANCELLED", cancelReason: "USER" });
    const fetchImpl = vi.fn(async () => response(200, { ok: true, data: { order: cancelled } }));
    await expect(cancelOrderRequest("o 1", fetchImpl as unknown as typeof fetch)).resolves.toEqual({ ok: true, order: cancelled });
    expect(fetchImpl).toHaveBeenCalledWith("/api/orders/o%201", { method: "DELETE" });
  });

  it("reads Retry-After on 429 and maps a network failure to status 0", async () => {
    const limited = vi.fn(async () => response(429, { ok: false, error: "Too many requests, please retry later" }, { "Retry-After": "17" }));
    await expect(cancelOrderRequest("o1", limited as unknown as typeof fetch)).resolves.toEqual({ ok: false, status: 429, retryAfter: 17 });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(cancelOrderRequest("o1", offline as unknown as typeof fetch)).resolves.toEqual({ ok: false, status: 0, retryAfter: null });
    const gone = vi.fn(async () => response(404, { ok: false, error: "Order not found" }));
    await expect(cancelOrderRequest("o1", gone as unknown as typeof fetch)).resolves.toEqual({ ok: false, status: 404, retryAfter: null });
  });
});

describe("OrderHistoryTab rows", () => {
  it("shows the status with the cancel reason as its title, and — for a market order's price", () => {
    const html = renderToStaticMarkup(
      createElement(HistoryRow, {
        createdAt: 1,
        symbol: "VCS-FOR-2021",
        side: "BUY",
        type: "MARKET",
        price: null,
        quantity: 30,
        filledQuantity: 12,
        avgFillPrice: 6810,
        status: "CANCELLED",
        cancelReason: "MARKET_REMAINDER",
        precision: 2,
      }),
    );
    expect(html).toContain(`title="${T.tabs.cancelReason.MARKET_REMAINDER}"`);
    expect(html).toContain(`>${T.tabs.status.CANCELLED}<`);
    expect(html).toContain(`>${T.order.market}<`);
    expect(html).toContain(">—<");
    expect(html).toContain(">68.10<");
  });

  it("a limit order cancelled by self-trade prevention is not labelled 'Cancelled by you'", () => {
    const row = (cancelReason: "USER" | "SELF_TRADE") =>
      renderToStaticMarkup(
        createElement(HistoryRow, {
          createdAt: 1,
          symbol: "VCS-FOR-2021",
          side: "SELL",
          type: "LIMIT",
          price: 7083,
          quantity: 5,
          filledQuantity: 0,
          avgFillPrice: null,
          status: "CANCELLED",
          cancelReason,
          precision: 2,
        }),
      );
    expect(row("USER")).toContain(`title="${T.tabs.cancelReason.USER}"`);
    const stp = row("SELF_TRADE");
    expect(stp).toContain(`>${T.tabs.status.CANCELLED}<`);
    expect(stp).not.toContain(T.tabs.cancelReason.USER);
    // 文案键 terminal.tabs.cancelReason.SELF_TRADE 定义后自动取到;没有时不给 title
    const selfTrade = (T.tabs.cancelReason as Partial<Record<string, string>>).SELF_TRADE;
    if (selfTrade) expect(stp).toContain(`title="${selfTrade}"`);
    else expect(stp).not.toContain("title=");
    expect(cancelReasonText(T.tabs.cancelReason, null)).toBeUndefined();
    expect(cancelReasonText(T.tabs.cancelReason, "MARKET_REMAINDER")).toBe(T.tabs.cancelReason.MARKET_REMAINDER);
  });

  // P1-25d 终审修复:撤单原因原来只在 title(悬停)与 sr-only 里,触屏与键盘用户看不到「是被自成交防护撤掉的」。
  // 状态格在状态之后可见地写一段短原因(tabs.cancelReasonShort),读屏仍念完整原因(tabs.cancelReason),悬停提示照旧。
  it("shows the cancel reason visibly after the status (short form), with the full reason for screen readers", () => {
    const row = (cancelReason: "USER" | "MARKET_REMAINDER" | "SELF_TRADE" | null, status: "CANCELLED" | "FILLED" = "CANCELLED") =>
      renderToStaticMarkup(
        createElement(HistoryRow, {
          createdAt: 1,
          symbol: "VCS-FOR-2021",
          side: "SELL",
          type: "LIMIT",
          price: 7083,
          quantity: 5,
          filledQuantity: 0,
          avgFillPrice: null,
          status,
          cancelReason,
          precision: 2,
        }),
      );
    const visible = (html: string) => html.replace(/<span class="sr-only">[^<]*<\/span>/g, "");
    for (const reason of ["USER", "MARKET_REMAINDER", "SELF_TRADE"] as const) {
      const html = row(reason);
      const short = T.tabs.cancelReasonShort[reason];
      expect(short.length, reason).toBeGreaterThan(0);
      expect(visible(html), reason).toContain(`>· ${short}<`);
      expect(html, reason).toContain(`<span class="sr-only"> · ${T.tabs.cancelReason[reason]}</span>`);
      expect(html, reason).toContain(`title="${T.tabs.cancelReason[reason]}"`);
    }
    const filled = row(null, "FILLED");
    expect(filled).not.toContain("·");
    expect(filled).not.toContain("title=");
  });

  it("builds keyset page URLs and sorts like the server", () => {
    expect(historyPageUrl(null)).toBe("/api/account/orders?status=history&limit=50");
    expect(historyPageUrl("eyJ4Ijox")).toBe("/api/account/orders?status=history&limit=50&cursor=eyJ4Ijox");
    expect(fillsPageUrl(null)).toBe("/api/account/fills?limit=50");
    expect([order("a", 1), order("c", 2), order("b", 2)].sort(newestOrderFirst).map((o) => o.id)).toEqual(["c", "b", "a"]);
  });
});

describe("MobileTabs", () => {
  it("names the tablist (terminal.mobile.tabsLabel) and wires the three tabs to the panel", () => {
    const html = renderToStaticMarkup(
      createElement(MobileTabs, { symbol: "VCS-FOR-2021", tab: "book", onTabChange: () => {}, panels: { chart: "chart-panel", book: "book-panel", order: "order-panel" } }),
    );
    expect(html).toContain(`role="tablist" aria-label="${T.mobile.tabsLabel}"`);
    expect(count(html, 'role="tab"')).toBe(3);
    expect(html).toContain("book-panel");
    expect(html).not.toContain("order-panel");
  });
});

describe("BottomTabs", () => {
  afterEach(() => {
    useAccountStore.setState(createInitialAccountState(), true);
  });

  it("server-renders a tablist with the default Open orders tab selected and only its panel populated", () => {
    const html = renderToStaticMarkup(createElement(BottomTabs, { symbol: "VCS-FOR-2021" }));
    expect(html).toContain('data-area="tabs"');
    expect(html).toContain('role="tablist"');
    // 面板区域有名字:aria-labelledby 指向 tablist
    const labelledBy = /<section data-area="tabs" aria-labelledby="([^"]+)"/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`<div id="${labelledBy}" role="tablist"`);
    // tablist 自己有名字(P1-25d):读屏不只念「标签列表」;面板区域经 aria-labelledby 取到同一个名字
    expect(html).toContain(`<div id="${labelledBy}" role="tablist" aria-label="${T.tabs.tablistLabel}"`);
    // 六个页签(P2-07 加「流水」,P3-07 在当前委托之后加「条件单」),标题与顺序:当前委托 / 条件单 / 历史委托 / 成交记录 / 持仓 / 流水
    expect(count(html, 'role="tab"')).toBe(6);
    const titles = [...html.matchAll(/<button type="button" role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    expect(titles).toEqual([T.tabs.open, T.tabs.triggers, T.tabs.history, T.tabs.fills, T.tabs.positions, T.ledger.tab]);
    expect(html).toMatch(new RegExp(`aria-selected="true"[^>]*tabindex="0"[^>]*>${T.tabs.open}<`));
    expect(count(html, 'aria-selected="false"')).toBe(5);
    expect(count(html, 'role="tabpanel"')).toBe(6);
    // 非激活面板:hidden + content-visibility:auto,没有内容
    expect(count(html, "content-visibility:auto")).toBe(5);
    expect(html).toMatch(/data-tab="triggers" hidden="" style="content-visibility:auto"><\/div>/);
    expect(html).toMatch(/data-tab="history" hidden="" style="content-visibility:auto"><\/div>/);
    // 流水页签的面板也在(空的、hidden):它的代码是懒加载的,没选中时不渲染、不取数
    expect(html).toMatch(/data-tab="ledger" hidden="" style="content-visibility:auto"><\/div>/);
    // 账户状态在服务端恒为 idle:激活面板是 Skeleton,不渲染任何表格
    expect(html).toMatch(/data-tab="open" class="flex min-h-0 flex-1 flex-col"><div role="status" aria-busy="true"/);
    expect(html).not.toContain("data-cancel-for");
  });

  it("the server output does not depend on the account store (SSR reads the initial state only)", () => {
    const before = renderToStaticMarkup(createElement(BottomTabs, { symbol: "VCS-FOR-2021" }));
    useAccountStore.setState({ status: "anon", me: null });
    expect(renderToStaticMarkup(createElement(BottomTabs, { symbol: "VCS-FOR-2021" }))).toBe(before);
  });

  it("moves between tabs with the arrow keys, Home and End", () => {
    expect(BOTTOM_TABS).toEqual(["open", "triggers", "history", "fills", "positions", "ledger"]);
    expect(nextTab("open", "ArrowRight")).toBe("triggers");
    expect(nextTab("triggers", "ArrowRight")).toBe("history");
    expect(nextTab("history", "ArrowLeft")).toBe("triggers");
    // 循环经过第五个页签:第一个往左到「流水」,「持仓」往右到「流水」,「流水」往右回到第一个
    expect(nextTab("open", "ArrowLeft")).toBe("ledger");
    expect(nextTab("positions", "ArrowRight")).toBe("ledger");
    expect(nextTab("ledger", "ArrowRight")).toBe("open");
    expect(nextTab("ledger", "ArrowLeft")).toBe("positions");
    expect(nextTab("fills", "Home")).toBe("open");
    expect(nextTab("history", "End")).toBe("ledger");
    expect(nextTab("ledger", "Home")).toBe("open");
    expect(nextTab("history", "Enter")).toBeNull();
  });

  it("statically imports only the default Open orders tab; the other five load with next/dynamic when selected (P2-06: out of the terminal's first load; P3-07 adds the Conditional tab)", () => {
    const source = readFileSync(fileURLToPath(new URL("./BottomTabs.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/^import \{ OpenOrdersTab \} from "\.\/OpenOrdersTab";$/m);
    for (const name of ["TriggersTab", "OrderHistoryTab", "FillsTab", "PositionsTab", "LedgerTab"]) {
      expect(source, name).toMatch(new RegExp(`^const ${name} = dynamic\\(\\(\\) => import\\("\\./${name}"\\)\\.then\\(\\(m\\) => m\\.${name}\\), \\{ ssr: false, loading: tabLoading \\}\\);$`, "m"));
      expect(source, name).not.toMatch(new RegExp(`from "\\./${name}"`));
    }
    // 加载中是统一的 Skeleton,与账户状态未知时同一个占位
    expect(source).toMatch(/^const tabLoading = \(\) => <Skeleton rows=\{5\} \/>;$/m);
  });
});

describe("CSV export entries (P2-06)", () => {
  /** 查询参数(去掉分页用的 limit / cursor)按顺序列出 */
  const filterParams = (url: string) => {
    const params = new URL(url, "http://localhost").searchParams;
    params.delete("limit");
    params.delete("cursor");
    return [...params];
  };

  it("point at the .csv twin of each tab's JSON query, with the same filters and no limit / cursor", () => {
    expect(new URL(HISTORY_CSV_HREF, "http://localhost").pathname).toBe("/api/account/orders.csv");
    expect(filterParams(HISTORY_CSV_HREF)).toEqual(filterParams(historyPageUrl("some-cursor")));
    expect(filterParams(HISTORY_CSV_HREF)).toEqual([["status", "history"]]);
    expect(FILLS_CSV_HREF).toBe("/api/account/fills.csv");
    expect(filterParams(fillsPageUrl("some-cursor"))).toEqual([]);
  });

  it.each([
    ["history", () => renderToStaticMarkup(createElement(OrderHistoryTab)), HISTORY_CSV_HREF, T.tabs.colStatus],
    ["fills", () => renderToStaticMarkup(createElement(FillsTab)), FILLS_CSV_HREF, T.tabs.colAuditRef],
  ] as const)("%s: a plain download link (not a button that fetches) in a toolbar row above the table", (_name, render, href, lastHeader) => {
    const html = render();
    expect(count(html, "data-export-csv")).toBe(1);
    expect(html).toContain(`<a href="${esc(href)}" download="" data-export-csv="" title="${esc(T.exportCsv.hint)}"`);
    expect(html).toMatch(new RegExp(`data-export-csv=""[^>]*>${T.exportCsv.label}</a>`));
    // 工具行在表头之前,不在表格里
    expect(html.indexOf("data-export-csv")).toBeLessThan(html.indexOf(`>${lastHeader}</span>`));
    expect(html).not.toContain("<button type=\"button\" data-export-csv");
    // 手机上这一行不显示(入口并进页签条,见下一条),≥ 48rem 照旧
    expect(html).toContain(`<div class="hidden shrink-0 items-center justify-end p-0.5 md:flex"><a href="${esc(href)}"`);
  });

  it("on phones, the History and Fills links sit at the end of the tab strip, outside the tablist, once the account is ready (P2-12)", () => {
    expect(stripExportHref("history", "ready")).toBe(HISTORY_CSV_HREF);
    expect(stripExportHref("fills", "ready")).toBe(FILLS_CSV_HREF);
    // 流水页签的入口在它自己的筛选行里;当前委托与持仓没有导出
    for (const tab of ["open", "positions", "ledger"] as const) expect(stripExportHref(tab, "ready"), tab).toBeNull();
    for (const status of ["idle", "loading", "anon"] as const) {
      expect(stripExportHref("history", status), status).toBeNull();
      expect(stripExportHref("fills", status), status).toBeNull();
    }
    // 标记:tablist 里只有 tab;入口(有的话)是 tablist 的兄弟节点、只在手机上显示
    const source = readFileSync(fileURLToPath(new URL("./BottomTabs.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/<\/div>\s*\{stripExport \? \(\s*<div className="[^"]*\bmd:hidden\b[^"]*">\s*<ExportCsvLink href=\{stripExport\} compact \/>/);
    // 默认页签(当前委托)的服务端标记里没有它
    useAccountStore.setState({ status: "ready", me: { id: "u1", email: "u1@example.test", name: "U" } as never });
    expect(renderToStaticMarkup(createElement(BottomTabs, { symbol: "VCS-FOR-2021" }))).not.toContain("data-export-csv");
    useAccountStore.setState(createInitialAccountState(), true);
  });

  it("on phones, the strip keeps one height whichever tab is selected: the link shares the tabs' vertical box and adds no padding of its own (P2-12 fix round)", () => {
    const source = readFileSync(fileURLToPath(new URL("./BottomTabs.tsx", import.meta.url)), "utf8");
    // tab 与入口共用同一个纵向盒子:行高、下内边距、下边框一样
    expect(STRIP_ITEM_BOX.split(" ").sort()).toEqual(["-mb-px", "border-b-2", "leading-t-tight", "pb-gap"]);
    expect(source).toMatch(/role="tab"[\s\S]*?className=\{`\$\{STRIP_ITEM_BOX\} shrink-0 px-1\.5 text-t-sm /);
    // 入口外层贴底对齐、没有上下内边距(原来的 pb-gap + 带边框的 py-1 小按钮把页签条撑高约 10 px,tab 随之下移)
    const wrapper = /\{stripExport \? \(\s*<div className="([^"]*)">/.exec(source)?.[1] ?? "";
    expect(wrapper.split(" ")).toEqual(expect.arrayContaining(["flex", "items-end", "border-b", "md:hidden"]));
    expect(wrapper).not.toMatch(/\b(?:p|py|pt|pb)-/);
    // 入口:同一个纵向盒子,字号不大于 tab(text-t-xs ≤ text-t-sm),没有边框小按钮的上下内边距与触控最小高度
    const link = renderToStaticMarkup(createElement(ExportCsvLink, { href: HISTORY_CSV_HREF, compact: true }));
    const cls = (/class="([^"]*)"/.exec(link)?.[1] ?? "").split(" ");
    expect(cls).toEqual(expect.arrayContaining([...STRIP_ITEM_BOX.split(" "), "border-transparent", "text-t-xs"]));
    expect(cls.filter((c) => /^(?:py-|pt-|min-h-|border$|text-t-(?:sm|base|md|lg))/.test(c))).toEqual([]);
    // 命中区只伸进旁边的空白(那里没有别的可点的东西):向上伸进面板的上内边距,向下伸进页签条与表格之间的间隙,左右各一个 gap;
    // 可见的盒子不变高(P2-12 第二轮修复:原来只向上伸,命中区约 31 px)
    expect(cls).toEqual(expect.arrayContaining(["relative", "before:absolute", "before:-top-panel", "before:-bottom-[calc(var(--spacing-gap)+0.125rem)]", "before:-inset-x-gap"]));
    expect(cls.filter((c) => c.startsWith("before:"))).toHaveLength(4);
    // 伸出的下沿正好是页签条与表格之间的间隙:外层 section 的 gap-gap;绝对定位从内边距盒量起,所以再加上下边框的宽度。
    // 边框与下沿成对定义在 STRIP_RULE(P2-12 收尾):盒子里的下边框只有 STRIP_RULE.border 这一个类,入口用的就是 STRIP_RULE.hitBelow,
    // 而且二者的数一致 —— Tailwind 的 border-b-N 是 N px,即 N/16 rem,下沿里加的正是这个数(border-b-2 ↔ 0.125rem)
    expect(STRIP_ITEM_BOX.split(" ").filter((c) => /^border-b(?:-|$)/.test(c))).toEqual([STRIP_RULE.border]);
    expect(STRIP_RULE.border).toBe("border-b-2");
    const ruleWidth = Number(/^border-b-(\d+)$/.exec(STRIP_RULE.border)?.[1]);
    expect(STRIP_RULE.hitBelow).toBe(`before:-bottom-[calc(var(--spacing-gap)+${ruleWidth / 16}rem)]`);
    expect(STRIP_RULE.hitBelow).toBe("before:-bottom-[calc(var(--spacing-gap)+0.125rem)]");
    expect(cls).toContain(STRIP_RULE.hitBelow);
    expect(source).toMatch(/<section\s[^>]*className="flex [^"]*\bgap-gap\b[^"]*\bp-panel\b/);
    // 左边伸出的 gap 正好是外层的 ps-gap
    expect(wrapper.split(" ")).toContain("ps-gap");
    expect(link).toMatch(new RegExp(`>${T.exportCsv.label}</a>$`));
    // 桌面与流水页签的那一版不变
    const full = renderToStaticMarkup(createElement(ExportCsvLink, { href: HISTORY_CSV_HREF }));
    expect(full).toContain('class="inline-flex shrink-0 items-center rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-2 text-t-xs font-medium text-foreground hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus min-h-touch lg:min-h-0 lg:py-0.5"');
  });

  it("the tab container never shows it before the account is ready (tabs are not mounted for anonymous or unknown users)", () => {
    const idle = renderToStaticMarkup(createElement(BottomTabs, { symbol: "VCS-FOR-2021" }));
    expect(idle).not.toContain("data-export-csv");
    useAccountStore.setState({ status: "anon", me: null });
    expect(renderToStaticMarkup(createElement(BottomTabs, { symbol: "VCS-FOR-2021" }))).not.toContain("data-export-csv");
    useAccountStore.setState(createInitialAccountState(), true);
  });
});

describe("TabTable pinEdges (P2-12)", () => {
  const columns = { template: "1fr 1fr", minWidth: "30rem" };
  const base: TabTableProps<string> = {
    columns,
    headers: [{ label: "A" }, { label: "B", align: "end" }],
    items: ["x", "y"],
    getKey: (item) => item,
    renderRow: (item) => createElement("span", { "data-item": item }, item),
    label: "Table",
    empty: createElement("p", { "data-empty": "" }, "nothing"),
  };
  const plain = renderToStaticMarkup(createElement(TabTable<string>, base));
  const pinned = renderToStaticMarkup(createElement(TabTable<string>, { ...base, pinEdges: true }));

  it("default: the outer wrapper scrolls sideways, the header sits above the list, the list only scrolls vertically (the other tabs, unchanged)", () => {
    expect(plain).toContain('class="flex min-h-0 flex-1 flex-col overflow-x-auto overflow-y-hidden"');
    expect(plain).toContain('style="min-width:30rem"');
    expect(plain.indexOf(">A</span>")).toBeLessThan(plain.indexOf('role="region"'));
    expect(plain).not.toContain("sticky top-0");
    expect(plain).not.toContain("t-pin");
  });

  it("pinEdges: the header moves into the list's scroll container (sticky top, opaque), which scrolls both ways; track and header carry the minimum width", () => {
    expect(pinned).not.toContain("overflow-x-auto");
    const region = pinned.slice(pinned.indexOf('role="region"'));
    expect(region).toMatch(/^role="region"[^>]*class="relative overflow-auto /);
    // 贴顶表头(--z-sticky)关在 region 自己的层叠上下文里:页面滚动时不压到终端头部上(P2-12 收尾)
    expect(/^role="region"[^>]*class="([^"]*)"/.exec(region)?.[1].split(" ")).toContain("isolate");
    expect(plain).not.toContain("isolate");
    expect(region).toContain('<div class="sticky top-0 z-(--z-sticky)" style="min-width:30rem"><div class="grid h-row ');
    expect(region).toMatch(/bg-\(--terminal-panel\)" style="grid-template-columns:1fr 1fr"><span class="truncate">A<\/span>/);
    expect(region).toContain('style="height:calc(var(--spacing-row) * 2);min-width:30rem"');
    expect(region).toContain('data-item="x"');
  });

  it("pinEdges: an empty list still shows the header above the empty state", () => {
    const empty = renderToStaticMarkup(createElement(TabTable<string>, { ...base, items: [], pinEdges: true }));
    expect(empty.indexOf(">A</span>")).toBeGreaterThan(empty.indexOf('role="region"'));
    expect(empty.indexOf(">A</span>")).toBeLessThan(empty.indexOf("data-empty"));
  });
});

describe("TabTable helpers", () => {
  it("appends the scroll hint to the focusable region's aria-describedby, keeping the list hint and never twice", () => {
    const attrs = new Map<string, string>([["aria-describedby", "list-hint"]]);
    const el = { getAttribute: (name: string) => attrs.get(name) ?? null, setAttribute: (name: string, value: string) => void attrs.set(name, value) };
    appendDescribedBy(el, "scroll-hint");
    expect(attrs.get("aria-describedby")).toBe("list-hint scroll-hint");
    appendDescribedBy(el, "scroll-hint");
    expect(attrs.get("aria-describedby")).toBe("list-hint scroll-hint");
    const bare = new Map<string, string>();
    appendDescribedBy({ getAttribute: (n: string) => bare.get(n) ?? null, setAttribute: (n: string, v: string) => void bare.set(n, v) }, "scroll-hint");
    expect(bare.get("aria-describedby")).toBe("scroll-hint");
    expect(() => appendDescribedBy(null, "x")).not.toThrow();
  });

  it("derives a primitive precision map, shallow-equal when polling replaces the instruments with equal data; the positions tab's metadata keeps its reference", () => {
    expect(PRECISIONS).toEqual({ "VCS-FOR-2021": 2, "GS-WIND-2022": 2, "CEA-SCEN-2026": 2 });
    const meta = positionMetaOf(INSTRUMENTS);
    expect(Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.vintage]))).toEqual({ "VCS-FOR-2021": 2021, "GS-WIND-2022": 2022, "CEA-SCEN-2026": 2026 });
    // 轮询:instruments 整体换新(每个 Instrument 也是新对象,lastPrice 变了),精度与元数据没变 → 精度表浅比较相等、元数据是同一个对象,Tab 不重渲染
    const polled = Object.fromEntries(Object.entries(INSTRUMENTS).map(([k, v]) => [k, { ...v, lastPrice: 7100 }]));
    expect(polled).not.toBe(INSTRUMENTS);
    expect(shallow(pricePrecisionsOf(polled), PRECISIONS)).toBe(true);
    expect(positionMetaOf(polled)).toBe(meta);
    const repriced = { ...polled, "GS-WIND-2022": { ...polled["GS-WIND-2022"], pricePrecision: 3 } };
    expect(shallow(pricePrecisionsOf(repriced), PRECISIONS)).toBe(false);
  });
});

describe("per-user paged caches", () => {
  it("are one instance per user and do not touch the cache when there is no user", () => {
    const history = historyQueries.forUser("u1");
    expect(history?.key).toBe("history:u1");
    expect(historyQueries.forUser("u1")).toBe(history);
    expect(historyQueries.forUser(null)).toBeNull();
    expect(historyQueries.forUser("u1")).toBe(history);
    expect(fillsQueries.forUser("u1")?.key).toBe("fills:u1");
  });

  it("drop the previous user's pages on sign-out (the tabs are not mounted when anon, so the account store does it)", async () => {
    // 模块级订阅只在浏览器里挂(typeof window !== "undefined"):给一个 window,换一套新的模块实例再导入
    vi.resetModules();
    vi.stubGlobal("window", {});
    try {
      const { historyQueries: history } = await import("./OrderHistoryTab");
      const { fillsQueries: fills } = await import("./FillsTab");
      const { useAccountStore: store } = await import("@/lib/market/account-store");
      store.setState({ me: { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 0, lockedCash: 0, unreadNotices: 0 }, status: "ready" });
      const h1 = history.forUser("u1");
      const f1 = fills.forUser("u1");
      store.setState({ me: null, status: "anon" });
      expect(history.forUser("u1")).not.toBe(h1);
      expect(fills.forUser("u1")).not.toBe(f1);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  it("marks an order that leaves the open orders as stale in an already-opened history (it enters history at its own createdAt)", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {});
    try {
      const { historyQueries: history } = await import("./OrderHistoryTab");
      const { useAccountStore: store, accountActions } = await import("@/lib/market/account-store");
      const me = { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 0, lockedCash: 0, unreadNotices: 0 };
      const old = order("o-old", 5, { status: "OPEN", filledQuantity: 0 });
      store.setState({ me, status: "ready", openOrders: new Map([["o-old", old], ["o-new", order("o-new", 9)]]) });

      // 历史还没打开过:不为它新建查询
      accountActions.applyAccountEvent({ t: "order", topic: "account", seq: 0, order: { ...order("o-new", 9), status: "FILLED" } });
      expect(history.peek("u1")).toBeNull();

      const q = history.forUser("u1")!;
      const markStale = vi.spyOn(q, "markStale");
      // 机器人吃完这张旧挂单(WS 终态事件,或轮询快照里不见了):报它离开前那一版,refresh 按 createdAt 定位
      accountActions.applyAccountEvent({ t: "order", topic: "account", seq: 0, order: { ...old, filledQuantity: 30, status: "FILLED" } });
      expect(markStale).toHaveBeenCalledTimes(1);
      expect(markStale.mock.calls[0][0]).toEqual([old]);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
