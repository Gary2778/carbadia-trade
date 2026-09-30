import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
import { FILL_DISCLOSURE, type Fill, type FillDetailResponse, type Instrument, type Order, type Position } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import en from "@/i18n/messages/en";
import { createInitialAccountState, useAccountStore } from "@/lib/market/account-store";
import { createInitialState, marketActions, useMarketStore } from "@/lib/market/store";
import { BOTTOM_TABS, BottomTabs, nextTab } from "./BottomTabs";
import { MobileTabs } from "./MobileTabs";
import { FillDetailView, fillPrecisionSelector, fmtLedgerDelta, fillDetailUrl } from "./FillDetailDialog";
import { FillRow, FillsTab, fillsPageUrl, fillsQueries, newestFillFirst } from "./FillsTab";
import { armedEscapeAction, cancelOrderRequest, liveArmedId, OpenOrderRow, OpenOrdersView, reconcileArmed } from "./OpenOrdersTab";
import { HistoryRow, cancelReasonText, historyPageUrl, historyQueries, newestOrderFirst } from "./OrderHistoryTab";
import { handlePositionSell, PositionsView, retirementHref, vintagesOf } from "./PositionsTab";
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
const VINTAGES = vintagesOf(INSTRUMENTS);

function position(symbol: string, patch: Partial<Position> = {}): Position {
  return {
    assetId: `asset-${symbol}`,
    symbol,
    quantity: 120,
    locked: 20,
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
  const positions = [
    position("VCS-FOR-2021"),
    position("GS-WIND-2022", { costBasisStatus: "unknown_acquisition_cost", unrealisedPnl: 999, averagePurchasePrice: null }),
    position("CEA-SCEN-2026", { isScenario: true, costBasisStatus: "incomplete_ledger", unrealisedPnl: null }),
  ];
  const rowOf = (markup: string, assetId: string) => {
    const start = markup.indexOf(`data-asset-id="${assetId}"`);
    const next = markup.indexOf("data-asset-id=", start + 1);
    return markup.slice(start, next === -1 ? undefined : next);
  };
  const html = renderToStaticMarkup(createElement(PositionsView, { positions, precisions: PRECISIONS, vintages: VINTAGES, onSell: () => {} }));

  it("has the tradable / locked / retired column titles", () => {
    for (const label of [T.tabs.tradable, T.tabs.locked, T.tabs.retired, T.tabs.colAvgCost, T.tabs.colMarketValue, T.tabs.colPnl]) {
      expect(html).toContain(`>${esc(label)}</span>`);
    }
    expect(html).toContain(`>${T.meta.vintage}</span>`);
  });

  it("shows tradable = available, locked and retired as separate numbers", () => {
    const row = html.slice(html.indexOf('data-asset-id="asset-VCS-FOR-2021"'));
    expect(row).toMatch(/>100<\/span>[\s\S]*?>20<\/span>[\s\S]*?>5<\/span>/);
    expect(row).toContain(">2021</span>");
  });

  it("shows a signed P&L only when the cost basis is complete, otherwise the — placeholder with the reason as title", () => {
    expect(html).toContain("+120.00");
    expect(html).not.toContain("9.99"); // unknown_acquisition_cost:服务端给了数也不显示
    expect(count(html, `title="${T.tabs.pnlUnavailable}"`)).toBe(4); // 两行 × (均价 + 盈亏)
    expect(html).toMatch(new RegExp(`data-pnl=""[^>]*title="${T.tabs.pnlUnavailable}"[^>]*>—<span class="sr-only">`));
  });

  it("links Retire to the retirement wizard for real credits and disables it for scenario instruments", () => {
    expect(html).toContain(`href="${esc(retirementHref("asset-VCS-FOR-2021"))}"`);
    expect(html).toContain(`title="${T.tabs.retireHint}"`);
    expect(html).not.toContain(`href="${esc(retirementHref("asset-CEA-SCEN-2026"))}"`);
    // 情景标的:真正的 disabled 按钮(读屏会报不可用),不是带 aria-disabled 的 span
    expect(rowOf(html, "asset-CEA-SCEN-2026")).toMatch(new RegExp(`<button type="button" disabled=""[^>]*>${T.tabs.retire}</button>`));
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).toContain(`>${T.tabs.scenarioTag}<`);
    expect(count(html, `>${T.order.sell}</button>`)).toBe(3);
  });

  it("shows — for market value when the instrument has never traded (lastPrice null), not the server's (0 × qty) zero", () => {
    const markup = renderToStaticMarkup(
      createElement(PositionsView, {
        positions: [position("VCS-FOR-2021"), position("GS-WIND-2022", { lastPrice: null, marketValue: 0, unrealisedPnl: null })],
        precisions: PRECISIONS,
        vintages: VINTAGES,
        onSell: () => {},
      }),
    );
    expect(rowOf(markup, "asset-VCS-FOR-2021")).toContain('data-market-value="" class="tnum truncate text-end">8,280.00</span>');
    const unpriced = rowOf(markup, "asset-GS-WIND-2022");
    expect(unpriced).toContain('data-market-value="" class="tnum truncate text-end">—</span>');
    expect(unpriced).not.toContain(">0.00<");
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

  it("uses EmptyState when there are no positions", () => {
    const empty = renderToStaticMarkup(createElement(PositionsView, { positions: [], precisions: {}, vintages: {}, onSell: () => {} }));
    expect(empty).toContain(renderToStaticMarkup(createElement(EmptyState, { title: T.tabs.emptyPositions })));
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

  it("formats ledger deltas as cents for cash accounts and tonnes for holdings", () => {
    expect(fmtLedgerDelta({ account: "CASH_LOCKED", delta: -123_456 }, "en-US")).toBe("-1,234.56");
    expect(fmtLedgerDelta({ account: "HOLDING", delta: 1200 }, "en-US")).toBe("+1,200");
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
    const idle = view([order("o1", 1)]);
    expect(idle).toMatch(new RegExp(`data-cancel-for="o1"[^>]*>${T.tabs.cancel}</button>`));
    expect(idle).not.toContain("data-armed");
  });

  it("marks every order with a cancel in flight as busy, not just the latest one", () => {
    const html = view([order("o1", 3), order("o2", 2), order("o3", 1)], null, new Set(["o1", "o2"]));
    const busy = (id: string) => new RegExp(`data-cancel-for="${id}" aria-disabled="true" aria-busy="true"`).test(html);
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
    expect(count(html, 'role="tab"')).toBe(4);
    for (const label of [T.tabs.open, T.tabs.history, T.tabs.fills, T.tabs.positions]) expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(new RegExp(`aria-selected="true"[^>]*tabindex="0"[^>]*>${T.tabs.open}<`));
    expect(count(html, 'aria-selected="false"')).toBe(3);
    expect(count(html, 'role="tabpanel"')).toBe(4);
    // 非激活面板:hidden + content-visibility:auto,没有内容
    expect(count(html, "content-visibility:auto")).toBe(3);
    expect(html).toMatch(/data-tab="history" hidden="" style="content-visibility:auto"><\/div>/);
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
    expect(BOTTOM_TABS).toEqual(["open", "history", "fills", "positions"]);
    expect(nextTab("open", "ArrowRight")).toBe("history");
    expect(nextTab("open", "ArrowLeft")).toBe("positions");
    expect(nextTab("positions", "ArrowRight")).toBe("open");
    expect(nextTab("fills", "Home")).toBe("open");
    expect(nextTab("history", "End")).toBe("positions");
    expect(nextTab("history", "Enter")).toBeNull();
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

  it("derives primitive precision / vintage maps, shallow-equal when polling replaces the instruments with equal data", () => {
    expect(PRECISIONS).toEqual({ "VCS-FOR-2021": 2, "GS-WIND-2022": 2, "CEA-SCEN-2026": 2 });
    expect(VINTAGES).toEqual({ "VCS-FOR-2021": 2021, "GS-WIND-2022": 2022, "CEA-SCEN-2026": 2026 });
    // 轮询:instruments 整体换新(每个 Instrument 也是新对象,lastPrice 变了),精度与 vintage 没变 → 浅比较相等,Tab 不重渲染
    const polled = Object.fromEntries(Object.entries(INSTRUMENTS).map(([k, v]) => [k, { ...v, lastPrice: 7100 }]));
    expect(polled).not.toBe(INSTRUMENTS);
    expect(shallow(pricePrecisionsOf(polled), PRECISIONS)).toBe(true);
    expect(shallow(vintagesOf(polled), VINTAGES)).toBe(true);
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
      store.setState({ me: { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 0, lockedCash: 0 }, status: "ready" });
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
      const me = { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 0, lockedCash: 0 };
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
