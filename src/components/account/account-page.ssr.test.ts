import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountTotals, Balance, EquityChange, OtcListingView, Position } from "@/shared";
import { renderAccountMarkup } from "@/i18n/test-support";
import en from "@/i18n/messages/en";
import { allocationOf } from "@/lib/market/account-view";
import type { PositionMeta } from "@/lib/market/position-groups";
import { AccountBody, AccountFrame, AccountPage, AccountSkeleton } from "./AccountPage";
import { AllocationView } from "./Allocation";
import { focusHoldingsTitle, HoldingsView, nextRetireState, RETIRE_IDLE, type HoldingsViewProps, type RetireState } from "./Holdings";
import { focusAfterListingGone, neighborListingId, OtcListingsView } from "./OtcListings";
import { AccountSummary } from "./Summary";

// 资产页 /trade/account 的服务端渲染(计划 §6.2.3 P2-10 的测试清单):未登录、加载中、空持仓、有持仓(分组、锁定来源、成本不完整、
// 情景标的)、已注销分组、24 小时变化为 null 与有值、OTC 挂牌有无。node 环境、不引 jsdom:容器在 SSR 里读到的是 store 的初始状态
//(骨架),各块的纯展示组件用 props 直接渲染。文案按合并对象核对(英文 SSR)。

const a = en.account;
const t = en.terminal;
const render = (node: Parameters<typeof renderAccountMarkup>[0]) => renderAccountMarkup(node);
/** HTML 实体还原成文字(& → &amp; 等),便于按文案原文断言 */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const meta = (patch: Partial<PositionMeta>): PositionMeta => ({
  name: "Test project",
  projectId: null,
  projectType: "Forestry",
  standard: "VCS",
  country: "Brazil",
  registry: "Verra",
  vintage: 2021,
  pricePrecision: 2,
  ...patch,
});

const META: Record<string, PositionMeta> = {
  "VCS-FOR-2021": meta({ projectId: "SIM-PRJ-VCS-FOR", vintage: 2021 }),
  "VCS-FOR-2023": meta({ projectId: "SIM-PRJ-VCS-FOR", vintage: 2023 }),
  "GS-WIND-2022": meta({ projectId: "SIM-PRJ-GS-WIND", projectType: "Wind", standard: "Gold Standard", country: "India", registry: "Gold Standard", vintage: 2022 }),
  "CEA-SCEN-2026": meta({ projectId: "SIM-PRJ-VCS-FOR", vintage: 2026 }),
  "VCS-FOR-2019": meta({ projectId: "SIM-PRJ-VCS-FOR", vintage: 2019 }),
};

function position(symbol: string, patch: Partial<Position> = {}): Position {
  return {
    assetId: `asset-${symbol}`,
    symbol,
    quantity: 10,
    locked: 0,
    lockedBy: { orders: 0, otc: 0 },
    available: 10,
    retired: 0,
    lastPrice: 1_000,
    marketValue: 10_000,
    averagePurchasePrice: 900,
    unrealisedPnl: 1_000,
    costBasisStatus: "complete",
    isScenario: false,
    ...patch,
  };
}

const noop = () => {};
const holdings = (patch: Partial<HoldingsViewProps>) =>
  render(createElement(HoldingsView, { positions: [], meta: META, prices: {}, query: "", onQuery: noop, retiredOpen: false, onToggleRetired: noop, onRetire: noop, ...patch }));

describe("the page shell (server render: no session, no account data)", () => {
  const html = render(createElement(AccountPage, { initialInstruments: [], transportMode: "poll" }));

  it("renders the terminal-scoped document root, the header, the demo-funds note and the entries, then a skeleton", () => {
    expect(html).toMatch(/^<div data-terminal="" data-glass="off" data-account="">/);
    expect(html).toContain(`<h1 class="text-t-2xl font-semibold text-foreground">${a.title}</h1>`);
    expect(html).toContain('data-demo-badge="regular"');
    expect(text(html)).toContain(a.intro);
    expect(text(html)).toContain(a.demoNote);
    for (const href of ["/orders", "/transactions", "/retirement", "/account", "/trade"]) expect(html).toContain(`href="${href}"`);
    expect(html).toContain("data-account-skeleton");
    // 会话与数据都在客户端:HTML 里没有登录入口、没有任何金额
    expect(html).not.toContain("data-account-gate");
    expect(html).not.toMatch(/\$\d/);
  });

  it("offers no deposit, withdrawal or transfer entry: the only mention is the fixed note that there is none", () => {
    expect(html.match(/deposit|withdraw|transfer/gi)).toEqual(["deposit", "withdraw", "transfer"]);
    expect(html).not.toMatch(/href="[^"]*(deposit|withdraw|transfer|top-?up)/i);
  });
});

describe("page states", () => {
  const body = (phase: Parameters<typeof AccountBody>[0]["phase"]) => render(createElement(AccountBody, { phase, onRetry: noop, ready: createElement("p", null, "READY") }));

  it("loading → the same skeleton as the ready layout", () => {
    expect(body("loading")).toBe(render(createElement(AccountSkeleton)));
    expect(body("loading")).toContain('role="status"');
  });

  it("signed out → a sign-in title, one-click demo account, log in / sign up that come back to /trade/account", () => {
    const html = body("anon");
    expect(html).toContain("data-account-gate");
    expect(text(html)).toContain(a.gate.title);
    expect(text(html)).toContain(en.login.tryDemo);
    expect(html).toContain('href="/login?returnTo=%2Ftrade%2Faccount"');
    expect(html).toContain('href="/register?returnTo=%2Ftrade%2Faccount"');
    expect(html).not.toContain("READY");
  });

  it("unconfirmed session and a failed first load → an error with retry, not a sign-in prompt", () => {
    for (const [phase, message] of [["unverified", a.errors.session], ["error", a.errors.load]] as const) {
      const html = body(phase);
      expect(html).toContain('role="alert"');
      expect(text(html)).toContain(message);
      expect(text(html)).toContain(en.ui.retry);
      expect(html).not.toContain("data-account-gate");
    }
  });

  it("ready → the content slot inside the frame", () => {
    const html = render(createElement(AccountFrame, null, createElement(AccountBody, { phase: "ready", onRetry: noop, ready: createElement("p", null, "READY") })));
    expect(html).toContain("<p>READY</p>");
    expect(html).not.toContain("data-account-skeleton");
  });
});

describe("summary", () => {
  const totals: AccountTotals = { holdingsValue: 25_000, totalAssets: 1_045_000, heldCredits: 30, retiredCredits: 7, unrealisedPnl: -1_234, valuationComplete: true, costBasisComplete: true };
  const balance: Balance = { cashBalance: 1_000_000, lockedCash: 20_000 };
  const stat = (html: string, id: string) => text(html.split(`data-stat="${id}"`)[1].split("data-stat=")[0]);

  it("four numbers, then the 24h change as amount and percentage (pct is a ratio), unrealised P&L, held and retired tonnes", () => {
    const change: EquityChange = { amount: 12_345, pct: 0.0123, baseline: 1_000_000, since: Date.UTC(2026, 8, 30, 6, 10) };
    const html = render(createElement(AccountSummary, { totals, balance, change24h: change, stale: false }));
    expect(stat(html, "total-assets")).toContain("$10,450.00");
    expect(stat(html, "available-cash")).toContain("$10,000.00");
    expect(stat(html, "locked-cash")).toContain("$200.00");
    expect(stat(html, "holdings-value")).toContain("$250.00");
    expect(stat(html, "change-24h")).toContain("+$123.45");
    expect(stat(html, "change-24h")).toContain("+1.23%");
    expect(stat(html, "change-24h")).toMatch(/Since \d\d\/\d\d/);
    expect(html).toContain("text-(--terminal-up)");
    expect(stat(html, "unrealised-pnl")).toContain("-$12.34");
    expect(stat(html, "held-credits")).toContain("30 t");
    expect(stat(html, "retired-credits")).toContain("7 t");
    expect(html).toContain('href="/retirement"');
    expect(html).not.toContain(a.summary.partialValuation);
    expect(html).not.toContain(a.summary.refreshFailed);
  });

  it("24h change null → a dash with the reason; unknown P&L → a dash with the reason; partial valuation and a stale refresh are said", () => {
    const html = render(createElement(AccountSummary, { totals: { ...totals, unrealisedPnl: null, valuationComplete: false }, balance, change24h: null, stale: true }));
    expect(stat(html, "change-24h")).toContain(`— ${a.summary.change24hUnavailable}`);
    expect(stat(html, "unrealised-pnl")).toContain(`— ${a.summary.pnlUnavailable}`);
    expect(stat(html, "total-assets")).toContain(a.summary.partialValuation);
    expect(text(html)).toContain(a.summary.refreshFailed);
  });

  it("a baseline of zero gives no percentage (pct null), only the amount", () => {
    const html = render(createElement(AccountSummary, { totals, balance, change24h: { amount: 0, pct: null, baseline: 0, since: 0 }, stale: false }));
    expect(stat(html, "change-24h")).toContain("$0.00");
    expect(stat(html, "change-24h")).not.toContain("%");
  });
});

describe("holdings", () => {
  it("empty account → empty state with a way to the market", () => {
    const html = holdings({ positions: [] });
    expect(text(html)).toContain(a.holdings.empty);
    expect(text(html)).toContain(a.holdings.emptyHint);
    expect(html).toContain(`href="/"`);
    expect(html).not.toContain('type="search"');
  });

  it("groups by project with one row per vintage (the terminal's groupPositions), rows carrying origin, standard and registry", () => {
    const html = holdings({ positions: [position("VCS-FOR-2023"), position("GS-WIND-2022"), position("VCS-FOR-2021")] });
    expect(html).toContain('type="search"');
    const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(["project:SIM-PRJ-GS-WIND", "project:SIM-PRJ-VCS-FOR"]);
    const rows = [...html.matchAll(/data-asset-id="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(["asset-GS-WIND-2022", "asset-VCS-FOR-2021", "asset-VCS-FOR-2023"]);
    expect(text(html)).toContain("India · Wind energy");
    expect(text(html)).toContain("Brazil · Forestry");
    expect(text(html)).toContain("VCS · Verra");
    expect(html).toContain(t.meta.simulatedProjectId);
    // 卖出跳终端并预设方向;注销开对话框
    expect(html).toContain('href="/trade/VCS-FOR-2021?side=SELL"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("values each row at the live price when there is one (same positionValue as the terminal), else at the row's own", () => {
    const html = holdings({ positions: [position("VCS-FOR-2021"), position("VCS-FOR-2023")], prices: { "VCS-FOR-2021": 1_200, "VCS-FOR-2023": null } });
    const row = (id: string) => html.split(`data-asset-id="asset-${id}"`)[1].split("data-asset-id=")[0];
    expect(row("VCS-FOR-2021")).toMatch(/data-last-price=""[^>]*>\$12\.00</);
    expect(row("VCS-FOR-2021")).toMatch(/data-market-value=""[^>]*>\$120\.00</);
    expect(row("VCS-FOR-2021")).toMatch(/data-pnl=""[^>]*>\+\$30\.00</); // 1000 + (1200 − 1000) × 10
    expect(row("VCS-FOR-2023")).toMatch(/data-market-value=""[^>]*>\$100\.00</);
  });

  it("shows where locked credits sit («sell orders n · OTC listings n»), and only the total when the server sent no split", () => {
    const withSources = position("VCS-FOR-2021", { locked: 5, available: 5, lockedBy: { orders: 3, otc: 2 } });
    const withoutSources = { ...position("VCS-FOR-2023", { locked: 4, available: 6 }), lockedBy: undefined } as unknown as Position;
    const html = holdings({ positions: [withSources, withoutSources] });
    expect(text(html)).toContain(t.retire.lockedBy({ orders: "3", otc: "2" }));
    expect(text(html)).toContain(`${t.tabs.locked} 4`);
    expect(text(html)).toContain(`${t.tabs.tradable} 5`);
  });

  it("an incomplete cost basis shows a dash for the average cost and the P&L, with the reason in words", () => {
    const html = holdings({ positions: [position("VCS-FOR-2021", { costBasisStatus: "incomplete_ledger", averagePurchasePrice: null, unrealisedPnl: null })] });
    expect(html).toMatch(/data-pnl=""[^>]*>—</);
    expect(text(html)).toContain(t.tabs.pnlUnavailable);
  });

  it("a scenario instrument is its own group, tagged, and cannot be retired (disabled, with the reason as visible text)", () => {
    const html = holdings({ positions: [position("CEA-SCEN-2026", { isScenario: true })] });
    expect(html).toContain('data-group="symbol:CEA-SCEN-2026"');
    expect(text(html)).toContain(t.tabs.scenarioTag);
    expect(html).toMatch(/<button type="button" disabled=""[^>]*>Retire<\/button>/);
    expect(text(html)).toContain(t.retire.scenarioBlocked);
    expect(html).not.toContain("data-retire=");
  });

  it("puts fully retired rows in a collapsed «retired» group with the total tonnes; expanded, each row links to the certificates", () => {
    const positions = [position("VCS-FOR-2021", { retired: 2 }), position("VCS-FOR-2019", { quantity: 0, available: 0, retired: 7, marketValue: 0 })];
    const collapsed = holdings({ positions });
    expect(collapsed).toContain('aria-expanded="false"');
    expect(text(collapsed)).toContain(t.retire.retiredGroup({ count: 1, tonnes: "7" }));
    expect(collapsed).not.toContain("data-retired-asset-id");
    // 部分注销的持仓行里另有一行「已注销 n」
    expect(collapsed).toMatch(new RegExp(`data-retired=""[^>]*>${t.tabs.retired} 2<`));
    const expanded = holdings({ positions, retiredOpen: true });
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('data-retired-asset-id="asset-VCS-FOR-2019"');
    expect(expanded).toContain(`>${t.retire.history}</a>`);
  });

  it("search filters by symbol, project or name; no match says so", () => {
    const positions = [position("VCS-FOR-2021"), position("GS-WIND-2022")];
    expect([...holdings({ positions, query: "wind" }).matchAll(/data-asset-id="([^"]+)"/g)].map((m) => m[1])).toEqual(["asset-GS-WIND-2022"]);
    expect([...holdings({ positions, query: "prj-vcs" }).matchAll(/data-asset-id="([^"]+)"/g)].map((m) => m[1])).toEqual(["asset-VCS-FOR-2021"]);
    expect(text(holdings({ positions, query: "zzz" }))).toContain(a.holdings.noMatch);
  });

  it("the holdings title is a focus target (id holdings-title, tabindex -1) whatever the list shows", () => {
    for (const html of [holdings({ positions: [] }), holdings({ positions: [position("VCS-FOR-2021")] })]) expect(html).toMatch(/<h2 id="holdings-title" tabindex="-1"/);
  });

  it("focusHoldingsTitle: moves focus to the holdings title only when focus has nowhere else to be", () => {
    const focus = vi.fn();
    const host = { querySelector: vi.fn(() => ({ focus })) } as unknown as Element;
    const body = {} as Element;
    const search = {} as Element;
    focusHoldingsTitle(host, search, body); // 焦点在搜索框(或已还给「注销」按钮):不动
    expect(focus).not.toHaveBeenCalled();
    focusHoldingsTitle(host, body, body);
    focusHoldingsTitle(host, null, body);
    expect(focus).toHaveBeenCalledTimes(2);
    expect(host.querySelector).toHaveBeenCalledWith("#holdings-title");
    expect(() => focusHoldingsTitle(null, null, body)).not.toThrow();
  });

  it("nextRetireState: an open retire dialog whose position leaves the store counts once toward the focus fallback; anything else is left as is", () => {
    const held = position("VCS-FOR-2021");
    // 没有请求:原样返回同一个对象(容器不 setState,不重渲染)
    expect(nextRetireState(RETIRE_IDLE, [held])).toBe(RETIRE_IDLE);
    expect(nextRetireState(RETIRE_IDLE, [])).toBe(RETIRE_IDLE);
    // 关着的请求(对话框关掉之后)随持仓消失:悄悄作废,不抢焦点
    const closed: RetireState = { request: { assetId: held.assetId, open: false }, orphaned: 0 };
    expect(nextRetireState(closed, [position("GS-WIND-2022")])).toEqual({ request: null, orphaned: 0 });
    // 开着的对话框:整仓注销的行(数量 0、已注销 > 0)还在 store 里,请求不作废,同一个对象
    const open: RetireState = { request: { assetId: held.assetId, open: true }, orphaned: 2 };
    expect(nextRetireState(open, [position("VCS-FOR-2021", { quantity: 0, available: 0, retired: 10 })])).toBe(open);
    // 卖光且没注销过:请求作废,焦点兜底记一次(在已有次数上加一,effect 的依赖因此变化);之后再渲染不再记
    const dropped = nextRetireState(open, [position("GS-WIND-2022")]);
    expect(dropped).toEqual({ request: null, orphaned: 3 });
    expect(nextRetireState(dropped, [])).toBe(dropped);
    expect(nextRetireState(dropped, [held])).toBe(dropped);
  });

  it("HoldingsSection applies nextRetireState whole and moves focus to the holdings title a frame after each orphaned dialog (source)", () => {
    // 容器里没有能写成只改一半的地方:渲染期只有一次 setRetireState(next);effect 以 orphaned 为依赖,下一帧 focusHoldingsTitle
    const source = readFileSync(fileURLToPath(new URL("./Holdings.tsx", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    const section = source.slice(source.indexOf("export function HoldingsSection"));
    expect(section).toMatch(/const nextState = nextRetireState\(retireState, positions\);\s*if \(nextState !== retireState\) setRetireState\(nextState\);/);
    expect(section).toMatch(/const retireOrphaned = retireState\.orphaned;\s*useEffect\(\(\) => \{\s*if \(retireOrphaned === 0\) return;\s*const frame = requestAnimationFrame\(\(\) => focusHoldingsTitle\(hostRef\.current, document\.activeElement, document\.body\)\);\s*return \(\) => cancelAnimationFrame\(frame\);\s*\}, \[retireOrphaned\]\);/);
    // 注销请求只经这个 state 改:没有单独的 retire / orphaned state,也不在别处直接调 reconcileRetireRequest
    expect(section.match(/useState</g)).toHaveLength(1);
    expect(section).toContain("useState<RetireState>(RETIRE_IDLE)");
    expect(section).not.toContain("reconcileRetireRequest(");
  });
});

describe("allocation", () => {
  const positions = [position("VCS-FOR-2021", { quantity: 30 }), position("GS-WIND-2022", { quantity: 10 }), position("CEA-SCEN-2026", { isScenario: true })];

  it("a stacked bar (graphic only) and a legend list that screen readers read: share, value and tonnes per group", () => {
    const allocation = allocationOf(positions, (p) => (p.symbol.startsWith("VCS") ? "Forestry" : "Wind energy"), () => 1_000);
    const html = render(createElement(AllocationView, { allocation, by: "type", onBy: noop }));
    expect(html).toContain('aria-hidden="true" class="flex h-3');
    expect(html).toContain("width:75%;background:var(--series)");
    expect(html).toContain("width:25%;background:var(--series-2)");
    const legend = text(html.split("<ul")[1]);
    expect(legend).toContain("Forestry 75.0% $300.00 30 t");
    expect(legend).toContain("Wind energy 25.0% $100.00 10 t");
    expect(html).toContain('aria-pressed="true"');
    for (const label of [a.allocation.byType, a.allocation.byCountry, a.allocation.byApproach]) expect(text(html)).toContain(label);
    expect(html).not.toContain("CEA-SCEN");
  });

  it("says what is left out, and shows a sentence instead of an empty bar", () => {
    const html = render(createElement(AllocationView, { allocation: { slices: [], total: 0, unpriced: 2 }, by: "country", onBy: noop }));
    expect(text(html)).toContain(a.allocation.empty);
    expect(text(html)).toContain(a.allocation.unpriced(2));
    expect(html).not.toContain("h-3");
  });
});

describe("OTC listings", () => {
  const listings: OtcListingView[] = [
    { id: "l1", assetId: "asset-VCS-FOR-2021", symbol: "VCS-FOR-2021", quantity: 12, pricePerUnit: 1_550, minQuantity: 5, createdAt: 2 },
    { id: "l2", assetId: "asset-GS-WIND-2022", symbol: "GS-WIND-2022", quantity: 3, pricePerUnit: 999, minQuantity: 1, createdAt: 1 },
  ];

  it("lists symbol, unit price, available and minimum fill, each with a cancel button", () => {
    const html = render(createElement(OtcListingsView, { listings, meta: META, armedId: null, busyIds: new Set<string>(), onCancel: noop, onKeep: noop }));
    expect(text(html)).toContain(a.otc.title);
    expect(html).toContain('href="/otc"');
    const row = (id: string) => text(html.split(`data-listing-id="${id}"`)[1].split("data-listing-id=")[0]);
    expect(row("l1")).toContain("VCS-FOR-2021");
    expect(row("l1")).toContain("$15.50");
    expect(row("l1")).toContain(`${a.otc.available} 12`);
    expect(row("l1")).toContain(`${a.otc.minQty} 5`);
    expect(html.match(/data-cancel-listing="/g)).toHaveLength(2);
    expect(html).not.toContain("data-armed");
  });

  it("arms in two steps: the armed row turns into «confirm» with a «keep» beside it", () => {
    const html = render(createElement(OtcListingsView, { listings, meta: META, armedId: "l2", busyIds: new Set(["l1"]), onCancel: noop, onKeep: noop }));
    const armed = html.split('data-listing-id="l2"')[1];
    expect(armed).toContain("data-armed");
    expect(text(armed)).toContain(a.otc.cancelConfirm);
    expect(armed).toContain('data-keep-for="l2"');
    expect(html.split('data-listing-id="l1"')[1].split('data-listing-id="l2"')[0]).toContain('aria-busy="true"');
  });

  // P2-13(终审 UI-1):下架成功后被聚焦的按钮随行消失,焦点掉到 body;下一帧放到邻近一条的「下架」按钮上,列表空了放到持仓标题
  /** 假的「下架」按钮与宿主:只有 getAttribute / focus 与 querySelector(All) */
  const button = (id: string) => ({ id, getAttribute: (name: string) => (name === "data-cancel-listing" ? id : null), focus: vi.fn() });
  const hostOf = (buttons: ReturnType<typeof button>[], title = { focus: vi.fn() }) => ({
    querySelectorAll: vi.fn(() => buttons),
    querySelector: vi.fn((selector: string) => (selector === "#holdings-title" ? title : null)),
    title,
  });

  it("neighborListingId: the next listing's id, else the previous one, else null (DOM order = list order)", () => {
    const host = hostOf([button("l1"), button("l2"), button("l3")]) as unknown as Element;
    expect(neighborListingId(host, "l1")).toBe("l2");
    expect(neighborListingId(host, "l2")).toBe("l3");
    expect(neighborListingId(host, "l3")).toBe("l2");
    expect(neighborListingId(hostOf([button("l1")]) as unknown as Element, "l1")).toBeNull();
    expect(neighborListingId(host, "nope")).toBeNull();
    expect(neighborListingId(null, "l1")).toBeNull();
  });

  it("focusAfterListingGone: only when focus fell to <body>; the neighbour's cancel button, else the holdings title", () => {
    const body = {} as Element;
    const [l1, l3] = [button("l1"), button("l3")];
    const doc = hostOf([l1, l3]);
    const root = doc as unknown as Document;
    focusAfterListingGone(root, "l3", {} as Element, body); // 用户已经把焦点移到别处:不动
    expect(l3.focus).not.toHaveBeenCalled();
    focusAfterListingGone(root, "l3", body, body);
    expect(l3.focus).toHaveBeenCalledTimes(1);
    expect(l1.focus).not.toHaveBeenCalled();
    focusAfterListingGone(root, "l3", null, body); // activeElement 为 null 也算没有着落
    expect(l3.focus).toHaveBeenCalledTimes(2);
    // 邻居也不在了、或者本来就没有邻居(列表空了,整块挂牌区已卸载):持仓标题
    focusAfterListingGone(root, "gone", body, body);
    focusAfterListingGone(hostOf([]) as unknown as Document, null, body, body);
    expect(doc.title.focus).toHaveBeenCalledTimes(1);
    expect(() => focusAfterListingGone({ querySelectorAll: () => [], querySelector: () => null } as unknown as Document, null, body, body)).not.toThrow();
  });

  it("OtcListingsSection: records the neighbour while the row is still there, then focuses it a frame after the row goes (source)", () => {
    const source = readFileSync(fileURLToPath(new URL("./OtcListings.tsx", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
    const section = source.slice(source.indexOf("export function OtcListingsSection"));
    expect(section).toMatch(/\.then\(\(\) => \{\s*neighbor = neighborListingId\(hostRef\.current, id\);[\s\S]*?onCancelled\(id\);\s*focusNextFrame\(neighbor\);/);
    expect(section).toMatch(/\.catch\(\(err: unknown\) => \{\s*neighbor = neighborListingId\(hostRef\.current, id\);/);
    expect(section).toMatch(/void onRefresh\(\)\.then\(\(\) => focusNextFrame\(neighbor\), \(\) => \{\}\);/);
    expect(source).toMatch(/requestAnimationFrame\(\(\) => focusAfterListingGone\(document, neighborId, document\.activeElement, document\.body\)\)/);
  });
});
