import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server 的同名函数 + /trade 布局登记终端文案的那层 Provider(P2-01)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstrumentListItem, Position, Trigger } from "@/shared";
import en from "@/i18n/messages/en";
import type { AccountStatus } from "@/lib/market/account-store";
import { EMPTY_PAGED_SNAPSHOT, type PagedSnapshot } from "@/lib/market/paged-query";
import { ConditionalFields, type ConditionalFieldsProps } from "./ConditionalFields";
import { PositionsView, type PositionsViewProps } from "./PositionsTab";
import { PriceAlertDialog } from "./PriceAlertDialog";
import { TakeProfitStopLossDialog, tpslPlacedType } from "./TakeProfitStopLossDialog";
import { TerminalHeader } from "./TerminalHeader";
import { VintageSelector } from "./VintageSelector";
import { fmtTs } from "./TabTable";
import { FailureNotice } from "./TriggerDialogParts";
import { INITIAL_COND_DRAFT } from "./trigger-ticket";
import { OpenTriggersView, TriggerHistoryView, TriggersTab, actionText, newestTriggerFirst, triggerHistoryUrl, triggerReasonText, triggerStatusText, triggerStatusTone, triggerTypeOf } from "./TriggersTab";

// 条件单界面(P3-07)的服务端标记测试:下单面板的条件单三行、底部「条件单」页签(进行中 / 历史 / 两步撤销)、止盈止损与价格提醒两个对话框、
// 持仓行与终端头部的入口。node 环境,不引 jsdom;zustand 在服务端读初始 state(行情与账户都是空的),所以带数据的断言渲染纯展示件。
//
// 最新成交价:服务端的行情 store 是空的(最新价未知),要画出「达到或高于 / 达到或低于」那一行,在模块边界替换 lastPriceOf(@/lib/market/last-price)。
// 账户登录态:同 order.ssr.test.ts,替换 useAccountStatus(价格提醒对话框的未登录分支)。
const market = vi.hoisted(() => ({ last: null as number | null }));
vi.mock("@/lib/market/last-price", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/market/last-price")>();
  return { lastPriceOf: (...args: Parameters<typeof real.lastPriceOf>) => market.last ?? real.lastPriceOf(...args) };
});
const account = vi.hoisted(() => ({ status: null as AccountStatus | null }));
vi.mock("@/lib/market/account-store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/market/account-store")>();
  return { ...real, useAccountStatus: () => account.status ?? real.useAccountStatus() };
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/trade/VCS-FOR-2021",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

afterEach(() => {
  market.last = null;
  account.status = null;
});

const T = en.terminal;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const count = (html: string, needle: string) => html.split(needle).length - 1;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** 正则里原样匹配一段文本 */
const re = (s: string) => esc(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function trigger(id: string, patch: Partial<Trigger> = {}): Trigger {
  return {
    id,
    kind: "ORDER",
    assetId: "asset-VCS-FOR-2021",
    symbol: "VCS-FOR-2021",
    direction: "ABOVE",
    triggerPrice: 7000,
    side: "BUY",
    orderType: "MARKET",
    limitPrice: null,
    quantity: 10,
    ocoGroupId: null,
    status: "PENDING",
    reason: null,
    orderId: null,
    firedPrice: null,
    createdAt: 1_790_000_000_000,
    updatedAt: 1_790_000_000_000,
    firedAt: null,
    ...patch,
  };
}
const PRECISIONS = { "VCS-FOR-2021": 2, "GS-WIND-2023": 2 };
/** 片段里最外层的 <div> 有几个(按 <div / </div> 计深度;片段里的其它标签不影响) */
const topLevelDivs = (html: string) => {
  let depth = 0;
  let top = 0;
  for (const m of html.matchAll(/<(\/?)div\b/g)) {
    if (m[1]) depth--;
    else if (depth++ === 0) top++;
  }
  return top;
};
/** 某一行(data-trigger-id 起到下一行之前) */
const rowOf = (html: string, id: string) => {
  const start = html.indexOf(`data-trigger-id="${id}"`);
  const next = html.indexOf("data-trigger-id=", start + 1);
  return html.slice(start, next === -1 ? undefined : next);
};

describe("条件单页签:类型、条件、触发后、状态", () => {
  it("类型按种类与成对推:提醒 → 价格提醒;成对的 ORDER:ABOVE 止盈、BELOW 止损;其余条件单", () => {
    expect(triggerTypeOf({ kind: "ALERT", ocoGroupId: null, direction: "ABOVE" })).toBe("alert");
    expect(triggerTypeOf({ kind: "ORDER", ocoGroupId: "g1", direction: "ABOVE" })).toBe("takeProfit");
    expect(triggerTypeOf({ kind: "ORDER", ocoGroupId: "g1", direction: "BELOW" })).toBe("stopLoss");
    expect(triggerTypeOf({ kind: "ORDER", ocoGroupId: null, direction: "BELOW" })).toBe("conditional");
  });

  it("「触发后」一列:市价买卖多少吨、限价带委托价、提醒「—」", () => {
    expect(actionText(T, { kind: "ORDER", side: "SELL", orderType: "MARKET", quantity: 10, limit: "—" }, "en-US")).toBe("Market sell 10 t");
    expect(actionText(T, { kind: "ORDER", side: "BUY", orderType: "LIMIT", quantity: 10, limit: "69.50" }, "en-US")).toBe("Limit 69.50 buy 10 t");
    expect(actionText(T, { kind: "ALERT", side: null, orderType: null, quantity: null, limit: "—" }, "en-US")).toBe("—");
  });

  it("历史分页与服务端同序(createdAt desc, id desc),地址带 status=history", () => {
    expect(triggerHistoryUrl(null)).toBe("/api/account/triggers?status=history&limit=50");
    expect(triggerHistoryUrl("abc")).toBe("/api/account/triggers?status=history&limit=50&cursor=abc");
    const rows = [trigger("a", { createdAt: 1 }), trigger("c", { createdAt: 2 }), trigger("b", { createdAt: 2 })].sort(newestTriggerFirst);
    expect(rows.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("进行中:每行的类型 / 条件 / 触发后 / 状态;只有 PENDING 有撤销按钮(正在下单的那一下撤不了)", () => {
    const rows = [
      trigger("cond"),
      trigger("limit", { side: "SELL", orderType: "LIMIT", limitPrice: 6950, direction: "BELOW", triggerPrice: 6000, quantity: 5, status: "TRIGGERING" }),
      trigger("tp", { side: "SELL", ocoGroupId: "g1", triggerPrice: 8000 }),
      trigger("sl", { side: "SELL", ocoGroupId: "g1", direction: "BELOW", triggerPrice: 5000 }),
      trigger("alert", { kind: "ALERT", side: null, orderType: null, quantity: null, direction: "BELOW", triggerPrice: 6000 }),
    ];
    const html = render(createElement(OpenTriggersView, { triggers: rows, precisions: PRECISIONS, armedId: null, busyIds: new Set<string>(), onCancel: () => {} }));
    for (const label of [T.tabs.colTime, T.tabs.colSymbol, T.tabs.colType, T.tabs.colCondition, T.triggers.after, T.tabs.colStatus]) expect(html).toContain(`>${label}</span>`);
    expect(rowOf(html, "cond")).toContain(`title="${T.triggers.types.conditional}" class="truncate">${T.triggers.types.conditional}<`);
    expect(rowOf(html, "cond")).toContain('title="≥ 70.00" class="truncate tnum">≥ 70.00<');
    expect(rowOf(html, "cond")).toMatch(/title="Market buy 10 t" class="truncate text-\(--terminal-up\)">Market buy 10 t</);
    expect(rowOf(html, "cond")).toContain(`<span class="truncate">${T.triggers.status.PENDING}</span>`);
    expect(rowOf(html, "limit")).toContain(">≤ 60.00<");
    expect(rowOf(html, "limit")).toMatch(/title="Limit 69.50 sell 5 t" class="truncate text-\(--terminal-down\)">Limit 69.50 sell 5 t</);
    expect(rowOf(html, "limit")).toMatch(new RegExp(`class="flex min-w-0 flex-col leading-t-tight text-warning"><span class="truncate">${T.triggers.status.TRIGGERING}</span>`));
    expect(rowOf(html, "limit")).not.toContain("data-cancel-for");
    expect(rowOf(html, "tp")).toContain(`>${T.triggers.types.takeProfit}<`);
    expect(rowOf(html, "sl")).toContain(`>${T.triggers.types.stopLoss}<`);
    expect(rowOf(html, "alert")).toContain(`>${T.triggers.types.alert}<`);
    expect(rowOf(html, "alert")).toMatch(/class="truncate text-muted">—</);
    expect(count(html, "data-cancel-for=")).toBe(4);
    expect(count(html, `>${T.tabs.cancel}</button>`)).toBe(4);
    // 撤销按钮按行的可访问名:类型 + 标的(看得见的仍是「撤单」)
    expect(rowOf(html, "tp")).toContain('aria-label="Cancel take-profit VCS-FOR-2021"');
    expect(rowOf(html, "cond")).toContain('aria-label="Cancel conditional order VCS-FOR-2021"');
    expect(rowOf(html, "alert")).toContain('aria-label="Cancel price alert VCS-FOR-2021"');
    // 列表有自己的可访问名,不借当前委托的
    expect(html).toContain(`aria-label="${T.a11y.triggersRegion}"`);
    expect(html).not.toContain(T.a11y.ordersRegion);
  });

  it("进行中的表比 1280 宽时的底部页签(约 660 px)宽:撤销列贴右(同持仓页签的操作列),表头在滚动容器里贴顶;历史不贴边", () => {
    const html = render(createElement(OpenTriggersView, { triggers: [trigger("a"), trigger("b", { status: "TRIGGERING" })], precisions: PRECISIONS, armedId: null, busyIds: new Set<string>(), onCancel: () => {} }));
    // 列模板:时间 7.5rem 起 / 标的 / 类型 / 条件 / 触发后 10rem 起 / 状态 / 撤销 7rem;最小宽 50.5rem(808 px > 660 px,所以要贴边)
    expect(html).toContain(
      "grid-template-columns:minmax(7.5rem,1fr) minmax(7rem,1.2fr) minmax(6.5rem,0.9fr) minmax(4.5rem,0.8fr) minmax(10rem,1.4fr) minmax(6rem,1fr) 7rem",
    );
    expect(html).toContain("min-width:50.5rem");
    expect(parseFloat(/min-width:([\d.]+)rem/.exec(html)?.[1] ?? "0") * 16).toBeGreaterThan(660);
    // 表头的撤销格与每一行的撤销格都贴右,行带悬停叠色的标记;横向滚动交给虚拟列表的滚动容器(外层不再 overflow-x-auto)
    expect(html).toContain('<span class="truncate t-pin t-pin-end"></span>');
    expect(count(html, '<span class="t-pin t-pin-end flex items-center justify-end">')).toBe(2);
    expect(rowOf(html, "a")).toMatch(/^data-trigger-id="a" class="[^"]*t-pin-row/);
    expect(html).toContain('class="sticky top-0 z-(--z-sticky)"');
    expect(html).not.toContain("overflow-x-auto");
    // 正在触发的行:贴右的格子还在(底色盖住滚过去的列),只是没有按钮
    expect(rowOf(html, "b")).toContain('<span class="t-pin t-pin-end flex items-center justify-end"></span>');
    const history = render(createElement(TriggerHistoryView, { snapshot: { items: [trigger("h", { status: "TRIGGERED" })], status: "done", error: null }, precisions: PRECISIONS }));
    expect(history).not.toContain("t-pin");
    expect(history).toContain("overflow-x-auto");
    // 历史:状态在「触发后」之前(1280 宽时先看得到结果),「触发后」同样 10rem 起
    expect(history).toContain("grid-template-columns:minmax(7.5rem,1fr) minmax(7rem,1.2fr) minmax(6.5rem,0.9fr) minmax(4.5rem,0.8fr) minmax(12.5rem,2fr) minmax(10rem,1.4fr)");
    expect(history).toContain("min-width:50rem");
    const headers = [...history.matchAll(/<span class="truncate">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(headers.indexOf(T.tabs.colStatus)).toBeGreaterThan(-1);
    expect(headers.indexOf(T.tabs.colStatus)).toBeLessThan(headers.indexOf(T.triggers.after));
    expect(rowOf(history, "h").indexOf("data-status")).toBeLessThan(rowOf(history, "h").indexOf('title="Market buy 10 t"'));
  });

  it("价格提醒不下单:正在触发说「正在触发」而不是「正在下单」", () => {
    const html = render(createElement(OpenTriggersView, { triggers: [trigger("alert", { kind: "ALERT", side: null, orderType: null, quantity: null, status: "TRIGGERING" })], precisions: PRECISIONS, armedId: null, busyIds: new Set<string>(), onCancel: () => {} }));
    expect(rowOf(html, "alert")).toContain(`<span class="truncate">${T.triggers.alertTriggering}</span>`);
    expect(html).not.toContain(T.triggers.status.TRIGGERING);
  });

  it("两步撤销:武装后同一个按钮变「确认撤单」(danger、data-armed);在途 / 等它离开列表时 aria-disabled 而不是 disabled", () => {
    const rows = [trigger("a"), trigger("b")];
    const armed = render(createElement(OpenTriggersView, { triggers: rows, precisions: PRECISIONS, armedId: "a", busyIds: new Set(["b"]), onCancel: () => {} }));
    expect(rowOf(armed, "a")).toMatch(/data-cancel-for="a" data-armed="" aria-label="Confirm cancel conditional order VCS-FOR-2021"[^>]*class="[^"]*border-danger bg-danger-soft text-danger[^"]*">Confirm cancel</);
    expect(rowOf(armed, "b")).toMatch(/data-cancel-for="b" aria-label="Cancel conditional order VCS-FOR-2021" aria-disabled="true" aria-busy="true"/);
    expect(rowOf(armed, "b")).not.toContain("disabled=\"\"");
    expect(rowOf(armed, "b")).toContain(`>${T.tabs.cancel}</button>`);
  });

  it("历史:触发了只说「委托已提交」(提醒说「已触发」);被拒 / 被撤在状态下面单独一行写原因(最多两行,不靠悬停);行高 --spacing-row-touch;没有撤销列", () => {
    const rows = [
      trigger("done", { status: "TRIGGERED", orderId: "o1", firedPrice: 7001 }),
      trigger("alert", { kind: "ALERT", side: null, orderType: null, quantity: null, status: "TRIGGERED", firedPrice: 7001 }),
      trigger("nofill", { side: "SELL", status: "REJECTED", reason: "NO_FILL", orderId: "o2" }),
      trigger("nofillbuy", { side: "BUY", status: "REJECTED", reason: "NO_FILL", orderId: "o3" }),
      trigger("failed", { side: "BUY", status: "REJECTED", reason: "INSUFFICIENT_CASH" }),
      trigger("user", { status: "CANCELLED", reason: "USER" }),
      trigger("oco", { side: "SELL", ocoGroupId: "g1", direction: "BELOW", status: "CANCELLED", reason: "OCO" }),
    ];
    const snapshot: PagedSnapshot<Trigger> = { items: rows, status: "done", error: null };
    const html = render(createElement(TriggerHistoryView, { snapshot, precisions: PRECISIONS, onLoadMore: () => {} }));
    const STATUS = (tone: string) => `<span data-status="" class="flex min-w-0 flex-col leading-t-tight ${tone}"><span class="truncate">`;
    // 原因最多两行;万一被截断,悬停(title)仍是全文
    const REASON = (reason: string) => `<span title="${esc(reason)}" class="line-clamp-2 whitespace-normal text-t-2xs text-muted">`;
    expect(rowOf(html, "done")).toContain(`${STATUS("text-success")}${esc(T.triggers.status.TRIGGERED)}</span></span>`);
    expect(T.triggers.status.TRIGGERED).not.toMatch(/fill/i);
    expect(rowOf(html, "alert")).toContain(`${STATUS("text-success")}${T.triggers.alertTriggered}</span></span>`);
    // NO_FILL:委托交上去了、一吨都没成交 —— 不是「下单失败」:状态「已触发 · 没有成交」(warning),原因按方向(卖:没人买;买:没钱或没人卖)
    expect(rowOf(html, "nofill")).toContain(`${STATUS("text-warning")}${T.triggers.noFill.status}</span>${REASON(T.triggers.noFill.sell)}${esc(T.triggers.noFill.sell)}</span></span>`);
    expect(rowOf(html, "nofillbuy")).toContain(`${STATUS("text-warning")}${T.triggers.noFill.status}</span>${REASON(T.triggers.noFill.buy)}${esc(T.triggers.noFill.buy)}</span></span>`);
    expect(rowOf(html, "nofill")).not.toContain(T.triggers.status.REJECTED);
    // 别的被拒的原因仍是「下单失败」(danger)
    expect(rowOf(html, "failed")).toContain(`${STATUS("text-danger")}${T.triggers.status.REJECTED}</span>${REASON(T.triggers.reason.INSUFFICIENT_CASH)}${esc(T.triggers.reason.INSUFFICIENT_CASH)}</span></span>`);
    // 本人撤销:状态「已撤销」已经说了,不另起一行原因
    expect(rowOf(html, "user")).toContain(`${STATUS("text-muted")}${T.triggers.status.CANCELLED}</span></span>`);
    expect(rowOf(html, "user")).not.toContain(T.triggers.reason.USER);
    expect(rowOf(html, "oco")).toContain(`${REASON(T.triggers.reason.OCO)}${T.triggers.reason.OCO}</span>`);
    expect(html).not.toContain("data-cancel-for");
    // 行高:虚拟列表的滚动容器把 --spacing-row 换成 --spacing-row-touch(表头不在里面,仍是一行高)
    expect(html).toMatch(/role="region"[^>]*class="[^"]*\[--spacing-row:var\(--spacing-row-touch\)\]/);
    // 进行中没有原因行,行高不变
    const open = render(createElement(OpenTriggersView, { triggers: [trigger("a")], precisions: PRECISIONS, armedId: null, busyIds: new Set<string>(), onCancel: () => {} }));
    expect(open).not.toContain("--spacing-row-touch");
  });

  it("时间列:进行中是创建时间;历史是结束的时间(触发的 firedAt,被撤 / 没触发就结束的 updatedAt)", () => {
    const day = 86_400_000;
    const created = 1_790_000_000_000;
    const shown = (ms: number) => `>${fmtTs(ms, "en-US", "local")}</span>`;
    const rows = [
      trigger("fired", { status: "TRIGGERED", createdAt: created, firedAt: created + 2 * day, updatedAt: created + 3 * day }),
      trigger("cancelled", { status: "CANCELLED", reason: "USER", createdAt: created, firedAt: null, updatedAt: created + 4 * day }),
    ];
    const history = render(createElement(TriggerHistoryView, { snapshot: { items: rows, status: "done", error: null }, precisions: PRECISIONS }));
    expect(rowOf(history, "fired")).toContain(shown(created + 2 * day));
    expect(rowOf(history, "fired")).not.toContain(shown(created));
    expect(rowOf(history, "cancelled")).toContain(shown(created + 4 * day));
    const open = render(createElement(OpenTriggersView, { triggers: [trigger("p", { createdAt: created, updatedAt: created + day })], precisions: PRECISIONS, armedId: null, busyIds: new Set<string>(), onCancel: () => {} }));
    expect(rowOf(open, "p")).toContain(shown(created));
  });

  it("空态:进行中与历史各一句;页签容器在服务端渲染进行中(按下)与空表", () => {
    const empty = render(createElement(OpenTriggersView, { triggers: [], precisions: PRECISIONS, armedId: null, busyIds: new Set<string>(), onCancel: () => {} }));
    expect(empty).toContain(`>${T.tabs.emptyTriggers}<`);
    const emptyHistory = render(createElement(TriggerHistoryView, { snapshot: { ...EMPTY_PAGED_SNAPSHOT, status: "done" }, precisions: PRECISIONS }));
    expect(emptyHistory).toContain(`>${T.tabs.emptyTriggerHistory}<`);
    const tab = render(createElement(TriggersTab));
    // 进行中 / 历史 开关有自己的可访问名,不借当前委托的「显示哪些委托」
    expect(tab).toContain(`<div role="group" aria-label="${T.tabs.triggerScopeLabel}"`);
    expect(tab).not.toContain(T.tabs.scopeLabel);
    expect(tab).toMatch(new RegExp(`aria-pressed="true"[^>]*>${T.tabs.triggerOpen}</button>`));
    expect(tab).toMatch(new RegExp(`aria-pressed="false"[^>]*>${T.tabs.triggerHistory}</button>`));
    expect(tab).toContain(`>${T.tabs.emptyTriggers}<`);
  });
});

describe("下单面板的条件单三行(ConditionalFields)", () => {
  const props = (patch: Partial<ConditionalFieldsProps> = {}): ConditionalFieldsProps => ({
    ids: "f",
    symbol: "VCS-FOR-2021",
    precision: 2,
    cond: INITIAL_COND_DRAFT,
    qtyText: "",
    invalidField: null,
    errorId: "f-error",
    inputClass: "input",
    onChange: () => {},
    ...patch,
  });

  it("三个顶层行(与限价票据的价格 / 数量 / 金额三行一一对应):触发价 + 一行说明、「触发后」开关(没有标签行)、数量(限价时左边并排委托价);两个价格框都不带 data-price-field", () => {
    const html = render(createElement(ConditionalFields, props({ cond: { ...INITIAL_COND_DRAFT, then: "LIMIT" } })));
    expect(html).toContain(`<label for="f-trigger" class="text-t-xs text-muted">${T.order.triggerPrice}</label>`);
    expect(html).toContain(`<label for="f-qty" class="text-t-xs text-muted">${esc(T.order.qty)}</label>`);
    expect(html).not.toContain("data-price-field");
    // 顶层恰好三个块:触发价那一格、「触发后」一行、委托价 + 数量那一行
    expect(topLevelDivs(html)).toBe(3);
    expect(topLevelDivs(render(createElement(ConditionalFields, props())))).toBe(3);
    // 触发价框的说明行经 aria-describedby 指过去;说明只占一行(截断,全文在 title 里)
    expect(html).toMatch(/<input id="f-trigger"[^>]*aria-describedby="f-trigger-hint"/);
    expect(html).toMatch(/<p id="f-trigger-hint" data-trigger-hint="" title="[^"]+" class="text-t-xs text-muted truncate">/);
  });

  it("「触发后」是两项开关(名字与确认框、页签表头同一个),默认市价;限价时委托价有可见标签,与数量并排;市价时没有这个框", () => {
    const marketHtml = render(createElement(ConditionalFields, props()));
    expect(marketHtml).toMatch(/role="group" aria-labelledby="f-after"/);
    expect(marketHtml).toContain(`<span id="f-after" class="self-center text-t-xs text-muted">${T.triggers.after}</span>`);
    expect(marketHtml).toMatch(new RegExp(`aria-pressed="true"[^>]*>${T.order.market}</button>`));
    expect(marketHtml).toMatch(new RegExp(`aria-pressed="false"[^>]*>${T.order.limit}</button>`));
    expect(marketHtml).not.toContain('id="f-limit"');
    const limit = render(createElement(ConditionalFields, props({ cond: { ...INITIAL_COND_DRAFT, then: "LIMIT", limitText: "69.5" } })));
    expect(limit).toContain(`<div class="grid grid-cols-2 gap-gap"><div class="flex flex-col gap-1"><label for="f-limit" class="text-t-xs text-muted">${T.order.limitPrice}</label><input id="f-limit"`);
    expect(limit).toMatch(/<input id="f-limit"[^>]*value="69.5"/);
    // 分段开关:外框 rounded-control,选项 rounded-chip(§4.3);与输入框同高(手机 min-h-touch,≥ lg 收紧)
    expect(limit).toMatch(/class="grid min-h-touch flex-1 grid-cols-2 gap-0\.5 rounded-control border/);
  });

  it("方向说成话:最新成交价已知时「达到或高于 X / 达到或低于 X」(按触发价与最新价现推);没填好或等于最新价时显示最新成交价", () => {
    market.last = 6500;
    expect(render(createElement(ConditionalFields, props({ cond: { ...INITIAL_COND_DRAFT, triggerText: "70" } })))).toContain(`>${esc(T.triggers.whenAbove("70.00"))}</p>`);
    expect(render(createElement(ConditionalFields, props({ cond: { ...INITIAL_COND_DRAFT, triggerText: "60" } })))).toContain(`>${esc(T.triggers.whenBelow("60.00"))}</p>`);
    expect(render(createElement(ConditionalFields, props({ cond: { ...INITIAL_COND_DRAFT, triggerText: "65" } })))).toContain(`>${T.triggers.lastTrade} 65.00</p>`);
    expect(render(createElement(ConditionalFields, props()))).toContain(`>${T.triggers.lastTrade} 65.00</p>`);
  });

  it("最新成交价未知(从未成交)而触发价填了:给「涨到此价 / 跌到此价」两个按钮,按下的是用户选的那个", () => {
    const html = render(createElement(ConditionalFields, props({ cond: { ...INITIAL_COND_DRAFT, triggerText: "70", direction: "BELOW" } })));
    expect(html).toMatch(new RegExp(`id="f-trigger-hint" role="group" aria-label="${esc(T.triggers.pickLabel)}"`));
    expect(html).toMatch(new RegExp(`aria-pressed="false"[^>]*>${T.triggers.pickAbove}</button>`));
    expect(html).toMatch(new RegExp(`aria-pressed="true"[^>]*>${T.triggers.pickBelow}</button>`));
    // 没填触发价时只说最新成交价(未知「—」)
    expect(render(createElement(ConditionalFields, props()))).toContain(`>${T.triggers.lastTrade} —</p>`);
  });

  it("校验失败归到哪个框:aria-invalid 并指向错误说明;触发价框同时保留说明行", () => {
    const trig = render(createElement(ConditionalFields, props({ invalidField: "triggerPrice" })));
    expect(trig).toMatch(/<input id="f-trigger"[^>]*aria-invalid="true" aria-describedby="f-trigger-hint f-error"/);
    const qty = render(createElement(ConditionalFields, props({ invalidField: "quantity" })));
    expect(qty).toMatch(/<input id="f-qty"[^>]*aria-invalid="true" aria-describedby="f-error"/);
    expect(qty).not.toMatch(/<input id="f-trigger"[^>]*aria-invalid="true"/);
    const lim = render(createElement(ConditionalFields, props({ invalidField: "limitPrice", cond: { ...INITIAL_COND_DRAFT, then: "LIMIT" } })));
    expect(lim).toMatch(/<input id="f-limit"[^>]*aria-invalid="true" aria-describedby="f-error"/);
  });
});

describe("止盈止损对话框与持仓行入口", () => {
  const position = (patch: Partial<Position> = {}): Position => ({
    assetId: "asset-GS-WIND-2023",
    symbol: "GS-WIND-2023",
    quantity: 120,
    locked: 20,
    lockedBy: { orders: 20, otc: 0 },
    available: 100,
    retired: 0,
    lastPrice: 4600,
    marketValue: 552_000,
    averagePurchasePrice: 4500,
    unrealisedPnl: 12_000,
    costBasisStatus: "complete",
    isScenario: false,
    ...patch,
  });

  it("对话框:标题是按钮上的同一句话加代码;最新成交价、可交易 / 锁定;止盈价与止损价两个框;数量默认可交易数量;一段说明 + 合规行", () => {
    market.last = 4612;
    const html = render(createElement(TakeProfitStopLossDialog, { position: position(), onClose: () => {} }));
    expect(html).toContain("<dialog");
    expect(html).toContain(`>${T.triggers.tpsl} · GS-WIND-2023</h2>`);
    expect(html).toContain(`<p>${T.triggers.lastTrade} 46.12</p>`);
    expect(html).toContain(`<p class="text-t-xs text-muted">${T.tabs.tradable} 100 · ${T.tabs.locked} 20</p>`);
    // 输入框的标签说的是价格(止盈价 / 止损价),与别处的价格框一致
    expect(html).toMatch(new RegExp(`>${T.triggers.takeProfitPrice}</label><input[^>]*value=""`));
    expect(html).toMatch(new RegExp(`>${T.triggers.stopLossPrice}</label><input[^>]*value=""`));
    expect([T.triggers.takeProfitPrice, T.triggers.stopLossPrice]).toEqual(["Take-profit price", "Stop-loss price"]);
    expect(html).toMatch(new RegExp(`>${re(T.order.qty)}</label><input[^>]*value="100"`));
    expect(html).toContain(esc(T.triggers.tpslBody));
    expect(html).toContain(esc(en.compliance.text));
    // 说明是对话框的描述(aria-describedby 指向它)
    const describedBy = /<dialog[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${describedBy}" class="text-t-sm text-foreground">${esc(T.triggers.tpslBody)}`);
    // 服务端的行情 store 里没有这个标的:提交按钮禁用,不会拿默认精度去提交
    expect(html).toMatch(new RegExp(`<button type="submit" disabled=""[^>]*>${T.order.confirm}</button>`));
  });

  it("成功 toast 说清设了什么:只有止盈、只有止损,或两个都设了", () => {
    expect(T.triggers.placed({ type: tpslPlacedType({ takeProfit: 8000, stopLoss: null }, T.triggers), symbol: "X" })).toBe("Take-profit set for X");
    expect(T.triggers.placed({ type: tpslPlacedType({ takeProfit: null, stopLoss: 5000 }, T.triggers), symbol: "X" })).toBe("Stop-loss set for X");
    expect(T.triggers.placed({ type: tpslPlacedType({ takeProfit: 8000, stopLoss: 5000 }, T.triggers), symbol: "X" })).toBe("Take-profit and stop-loss set for X");
  });

  it("可交易为 0(全被挂单锁着)时数量框空着,不默认成 0", () => {
    const html = render(createElement(TakeProfitStopLossDialog, { position: position({ available: 0, locked: 120 }), onClose: () => {} }));
    expect(html).toMatch(new RegExp(`>${re(T.order.qty)}</label><input[^>]*value=""`));
  });

  it("持仓行:数量 > 0 的行有「止盈止损」按钮(英文用整词,可折两行;可访问名 = 这句话 + 代码);整仓注销的行没有", () => {
    const base: PositionsViewProps = {
      positions: [position(), position({ assetId: "asset-VCS-FOR-2021", symbol: "VCS-FOR-2021", quantity: 0, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 0, retired: 40 })],
      meta: {},
      onSell: () => {},
      onRetire: () => {},
      onProtect: () => {},
      retiredOpen: true,
      onToggleRetired: () => {},
    };
    const html = render(createElement(PositionsView, base));
    expect(count(html, "data-tpsl=")).toBe(1);
    expect(T.triggers.tpsl).toBe("Take-profit / stop-loss");
    expect(html).toMatch(new RegExp(`data-tpsl="" aria-label="${re(T.triggers.tpsl)} GS-WIND-2023" aria-haspopup="dialog" class="[^"]*whitespace-normal[^"]*">${re(T.triggers.tpsl)}</button>`));
  });
});

describe("价格提醒:头部入口与对话框", () => {
  const initial: InstrumentListItem = {
    instrument: {
      id: "asset-VCS-FOR-2021",
      symbol: "VCS-FOR-2021",
      name: "Forest",
      standard: "VCS",
      projectType: "forestry",
      vintage: 2021,
      country: "CN",
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
      lastPrice: 6800,
    },
    ticker: { symbol: "VCS-FOR-2021", lastPrice: 6800, bestBid: 6790, bestAsk: 6810, change24h: 1.2, high24h: 6900, low24h: 6700, volume24h: 1000, ts: 0 },
  };

  it("头部:「提醒」按钮在价格组里、紧跟 Demo 徽标(徽标仍贴着价格);服务端不渲染对话框", () => {
    const html = render(createElement(TerminalHeader, { symbol: "VCS-FOR-2021", initial }));
    const group = html.slice(html.indexOf("data-price-group"));
    expect(group.indexOf("data-demo-badge")).toBeLessThan(group.indexOf("data-price-alert"));
    expect(group.indexOf("data-price-alert")).toBeLessThan(group.indexOf("data-connection") === -1 ? Infinity : group.indexOf("data-connection"));
    // 100rem 以下只有图标(字 max-[100rem]:hidden、图标 min-[100rem]:hidden);名字在 aria-label 与 title 里
    expect(html).toMatch(new RegExp(`data-price-alert="" aria-haspopup="dialog" aria-label="${T.triggers.types.alert} VCS-FOR-2021" title="${T.triggers.types.alert} VCS-FOR-2021"`));
    expect(html).toMatch(new RegExp(`<svg aria-hidden="true"[^>]*class="size-3\\.5 shrink-0 min-\\[100rem\\]:hidden"[\\s\\S]*?</svg><span class="max-\\[100rem\\]:hidden">${T.triggers.alert}</span></button>`));
    expect(html).toMatch(/data-price-alert=""[^>]*class="[^"]*\bmin-w-touch\b[^"]*\blg:min-w-0\b/);
    expect(html).not.toContain("<dialog");
    // 买一 / 卖一在 100rem 以下隐藏(盘口与价差条里就有):英文头部在 1280 / 1366 宽放得进一行;其余 24h 数据 < 48rem 隐藏,涨跌一直在
    expect(html).toContain('data-stat="bid" class="flex flex-col max-[100rem]:hidden"');
    expect(html).toContain('data-stat="ask" class="flex flex-col max-[100rem]:hidden"');
    for (const key of ["high", "low", "volume"]) expect(html).toContain(`data-stat="${key}" class="flex flex-col max-md:hidden"`);
    expect(html).toContain('data-stat="change" class="flex flex-col"');
    // 同项目年份 chip(TerminalShell 经 vintageSlot 传入):前面那行「本项目其它年份」100rem 以下只留给读屏(nav 的 aria-label),chip 照常在
    const sibling = { ...initial.instrument, id: "asset-VCS-FOR-2022", symbol: "VCS-FOR-2022", vintage: 2022, projectId: "SIM-PRJ-VCS-FOR" };
    const withVintages = render(
      createElement(TerminalHeader, {
        symbol: "VCS-FOR-2021",
        initial,
        vintageSlot: createElement(VintageSelector, { projectId: "SIM-PRJ-VCS-FOR", current: "VCS-FOR-2021", initialItems: [{ ...initial, instrument: { ...initial.instrument, projectId: "SIM-PRJ-VCS-FOR" } }, { instrument: sibling, ticker: { ...initial.ticker, symbol: "VCS-FOR-2022" } }] }),
      }),
    );
    expect(withVintages).toContain(`<nav aria-label="${T.instruments.vintages}" data-vintage-selector=""`);
    expect(withVintages).toContain(`<span aria-hidden="true" class="text-t-2xs text-muted-2 max-[100rem]:hidden">${T.instruments.vintages}</span>`);
    expect(withVintages).toMatch(/data-symbol="VCS-FOR-2022"[^>]*>2022<\/a>/);
  });

  it("对话框(已登录态未知):一个价格框 + 方向说成话 + 说明 + 合规行;登录态没就绪时提交禁用", () => {
    market.last = 6500;
    const html = render(createElement(PriceAlertDialog, { symbol: "VCS-FOR-2021", onClose: () => {} }));
    expect(html).toContain(`>${T.triggers.types.alert} · VCS-FOR-2021</h2>`);
    expect(html).toMatch(new RegExp(`>${T.triggers.alertPrice}</label><input[^>]*aria-describedby="[^"]*-hint"`));
    expect(T.triggers.alertPrice).toBe("Alert price");
    expect(html).toContain(`>${T.triggers.lastTrade} 65.00</p>`);
    expect(html).toContain(esc(T.triggers.alertBody));
    expect(html).toContain(esc(en.compliance.text));
    expect(html).toMatch(new RegExp(`<button type="submit" disabled=""[^>]*>${T.order.confirm}</button>`));
  });

  it("未登录:只给登录入口(returnTo 回到本标的),不出表单", () => {
    account.status = "anon";
    const html = render(createElement(PriceAlertDialog, { symbol: "VCS-FOR-2021", onClose: () => {} }));
    expect(html).toContain(`>${T.toast.loginRequired}</p>`);
    expect(html).toContain(`href="/login?returnTo=${encodeURIComponent("/trade/VCS-FOR-2021")}"`);
    expect(html).not.toContain("<form");
  });
});

describe("「打开条件单页签」(P3 终审:点了要看得到)", () => {
  it("新建条件单、止盈止损、价格提醒成功的 toast 都带这个动作;两个对话框结果未确认时(含对话框已关、改用 toast)也带", () => {
    const action = "{ action: { label: t.triggers.checkTab, onClick: showTriggersTab } }";
    expect(source("./OrderPanel.tsx")).toContain(`push("ok", t.triggers.placed({ type: t.triggers.types.conditional, symbol }), ${action});`);
    expect(source("./TakeProfitStopLossDialog.tsx")).toContain(`push("ok", t.triggers.placed({ type: tpslPlacedType(oco, t.triggers), symbol }), ${action});`);
    expect(source("./PriceAlertDialog.tsx")).toContain(`push("ok", t.triggers.placed({ type: t.triggers.types.alert, symbol }), ${action});`);
    for (const file of ["./TakeProfitStopLossDialog.tsx", "./PriceAlertDialog.tsx"]) {
      expect(source(file)).toContain(`failed.uncertain ? ${action} : undefined`);
      expect(source(file)).toContain("<FailureNotice failure={failure} onCheckTab={onClose} />");
    }
  });

  it("对话框里结果未确认的说明带一个「打开条件单页签」按钮(切页签并关掉对话框);被拒的说明没有", () => {
    const uncertain = render(createElement(FailureNotice, { failure: { message: "m", uncertain: true, loginHref: null }, onCheckTab: () => {} }));
    expect(uncertain).toMatch(new RegExp(`<button type="button" data-check-tab=""[^>]*>${T.triggers.checkTab}</button>`));
    const rejected = render(createElement(FailureNotice, { failure: { message: "m", uncertain: false, loginHref: null }, onCheckTab: () => {} }));
    expect(rejected).not.toContain("data-check-tab");
    expect(source("./TriggerDialogParts.tsx")).toMatch(/onClick=\{\(\) => \{\s*showTriggersTab\(\);\s*onCheckTab\(\);\s*\}\}/);
  });
});

describe("懒加载与快捷键的约定(源码)", () => {
  it("页签与两个对话框都经 next/dynamic 懒加载;下单面板只动态取条件单的提交函数,新价格框不带 data-price-field", () => {
    expect(source("./BottomTabs.tsx")).toMatch(/const TriggersTab = dynamic\(\(\) => import\("\.\/TriggersTab"\)/);
    expect(source("./PositionsTab.tsx")).toMatch(/dynamic\(\(\) => import\("\.\/TakeProfitStopLossDialog"\)[\s\S]{0,120}ssr: false/);
    expect(source("./TerminalHeader.tsx")).toMatch(/dynamic\(\(\) => import\("\.\/PriceAlertDialog"\)[\s\S]{0,120}ssr: false/);
    // 条件单的提交函数只在 useConditionalTicket 里动态取;下单面板与它都不静态引入
    const panel = source("./OrderPanel.tsx");
    const hook = source("./useConditionalTicket.ts");
    expect(panel).not.toMatch(/from "@\/lib\/market\/trigger-submit"/);
    expect(hook).not.toMatch(/from "@\/lib\/market\/trigger-submit"/);
    expect(hook).toMatch(/import\("@\/lib\/market\/trigger-submit"\)/);
    // 两个对话框才用的校验在 @/shared/trigger-drafts,下单面板这一侧(面板、hook、票据)都不引它
    for (const name of ["./OrderPanel.tsx", "./useConditionalTicket.ts", "./trigger-ticket.ts", "./ConditionalFields.tsx", "./TriggerHint.tsx"]) {
      expect(source(name), name).not.toMatch(/trigger-drafts/);
    }
    expect(source("./TakeProfitStopLossDialog.tsx")).toMatch(/from "@\/shared\/trigger-drafts"/);
    expect(source("./PriceAlertDialog.tsx")).toMatch(/from "@\/shared\/trigger-drafts"/);
    // l / m 快捷键点的是限价 / 市价按钮:它们的处理函数先把条件单票据切回去(reducer 的 leave,trigger-ticket.test.ts 测语义)
    expect(panel).toMatch(/const handleType = \(orderType: OrderType\) => \{\s*ticket\.leave\(\);/);
    // 整个面板只有限价单的价格框带 data-price-field(↑↓ 步进与 Enter 提交)
    expect(count(panel, "data-price-field=")).toBe(1);
  });
});

describe("条件单状态 / 原因文案的纯函数(NO_FILL 与通知说同一件事)", () => {
  it("被拒且原因是 NO_FILL:状态说「已触发 · 没有成交」,warning;原因按方向;没有方向不编原因;别的状态 / 原因照旧", () => {
    expect(triggerStatusText(T, "ORDER", "REJECTED", "NO_FILL")).toBe(T.triggers.noFill.status);
    expect(triggerStatusText(T, "ORDER", "REJECTED", "INSUFFICIENT_CASH")).toBe(T.triggers.status.REJECTED);
    expect(triggerStatusText(T, "ORDER", "REJECTED")).toBe(T.triggers.status.REJECTED);
    expect(triggerStatusText(T, "ORDER", "CANCELLED", "NO_FILL")).toBe(T.triggers.status.CANCELLED);
    expect(triggerStatusTone("REJECTED", "NO_FILL")).toBe("text-warning");
    expect(triggerStatusTone("REJECTED", "INVALID")).toBe("text-danger");
    expect(triggerStatusTone("REJECTED")).toBe("text-danger");
    expect(triggerReasonText(T, "REJECTED", "NO_FILL", "BUY")).toBe(T.triggers.noFill.buy);
    expect(triggerReasonText(T, "REJECTED", "NO_FILL", "SELL")).toBe(T.triggers.noFill.sell);
    expect(triggerReasonText(T, "REJECTED", "NO_FILL", null)).toBeUndefined();
    expect(triggerReasonText(T, "CANCELLED", "NO_FILL", "BUY")).toBeUndefined();
    expect(triggerReasonText(T, "REJECTED", "INSUFFICIENT_QTY", "SELL")).toBe(T.triggers.reason.INSUFFICIENT_QTY);
    expect(triggerReasonText(T, "CANCELLED", "OCO", "SELL")).toBe(T.triggers.reason.OCO);
    expect(triggerReasonText(T, "PENDING", null, "BUY")).toBeUndefined();
  });
});
