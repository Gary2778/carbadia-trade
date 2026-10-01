import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Position } from "@/shared";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import { renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server 的同名函数 + /trade 布局登记终端文案的那层 Provider
import type { RetirementRecord } from "@/lib/exchange/retirement";
import { submitRetirement } from "@/lib/exchange/retirement-form";
import { ApiError } from "@/lib/http/client";
import { canEditRetirement, INITIAL_RETIRE_FLOW, reduceRetireFlow, type RetireAction, type RetireFlow } from "@/lib/market/retire-flow";
import { clearRetireFlows, dispatchRetireFlow, retireFlowOf, submitRetireFlow, watchRetireFlow } from "@/lib/market/retire-flow-store";
import { RetireDialog, RetireDialogView, retirementFailureText, type RetireDialogViewProps, type RetireInstrument } from "./RetireDialog";

// 注销对话框的服务端标记测试(node 环境,不引 jsdom;交互在内置浏览器里验收)。
// 三步各自的渲染用纯展示件 RetireDialogView + 由状态机(retire-flow)走出来的状态;原生 <dialog> 在静态标记里没有 open 属性,内容照常输出。

const T = en.terminal.retire;
const TABS = en.terminal.tabs;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const count = (html: string, needle: string) => html.split(needle).length - 1;

// 名称走 data.assetNames 的本地化表(种子里的项目名是中文);表里没有的标的才显示原名
const INSTRUMENT: RetireInstrument = { name: "云南森林经营碳汇", registry: "Verra", standard: "VCS", vintage: 2021 };
const NAME = en.data.assetNames["VCS-FOR-2021"];

function position(patch: Partial<Position> = {}): Position {
  return {
    assetId: "asset-1",
    symbol: "VCS-FOR-2021",
    quantity: 120,
    locked: 20,
    lockedBy: { orders: 12, otc: 8 },
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

const RECORD: RetirementRecord = {
  id: "ret-1",
  reference: "SIM-RET-0F8FAD5B-D9CB-469F-A165-70867728950E",
  status: "SIMULATED",
  assetId: "asset-1",
  symbol: "VCS-FOR-2021",
  projectName: "云南森林经营碳汇",
  registry: "Verra",
  standard: "VCS",
  vintage: 2021,
  quantity: 40,
  tonnesCO2e: 40,
  reason: "Event Offset",
  beneficiary: "Acme <Corp>",
  purpose: "Annual meeting",
  publicMessage: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  certificateUrl: "/api/retirements/ret-1/certificate",
};

const run = (actions: RetireAction[], from: RetireFlow = INITIAL_RETIRE_FLOW): RetireFlow => actions.reduce(reduceRetireFlow, from);
const FILL: RetireAction[] = [
  { type: "field", name: "quantity", value: "40" },
  { type: "field", name: "reason", value: "Event Offset" },
  { type: "field", name: "beneficiary", value: "Acme <Corp>" },
  { type: "field", name: "purpose", value: "Annual meeting" },
];
const REVIEW: RetireAction = { type: "review", assetId: "asset-1", available: 100, idempotencyKey: "key-0001" };
const IN_REVIEW = run([...FILL, REVIEW]);
const READY = run([{ type: "acknowledge", value: true }], IN_REVIEW);
const DONE = run([{ type: "submit" }, { type: "succeeded", retirement: RECORD }], READY);

const noop = () => {};
function view(patch: Partial<RetireDialogViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(RetireDialogView, {
      open: true,
      onClose: noop,
      position: position(),
      instrument: INSTRUMENT,
      flow: INITIAL_RETIRE_FLOW,
      onField: noop,
      onReview: noop,
      onAcknowledge: noop,
      onEdit: noop,
      onConfirm: noop,
      onAgain: noop,
      ...patch,
    }),
  );
}
/** 一个标签(含属性)的开标签文本 */
const tag = (html: string, needle: string): string => {
  const at = html.indexOf(needle);
  if (at === -1) return "";
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(">", at) + 1);
};

afterEach(() => vi.unstubAllGlobals());

describe("RetireDialog: shell", () => {
  it("renders nothing while closed, and the details step once opened", () => {
    expect(renderToStaticMarkup(createElement(RetireDialog, { position: position(), instrument: INSTRUMENT, open: false, onClose: noop }))).toBe("");
    const open = renderToStaticMarkup(createElement(RetireDialog, { position: position(), instrument: INSTRUMENT, open: true, onClose: noop }));
    expect(open).toContain("<dialog");
    expect(open).toContain('data-retire-step="details"');
  });

  it("titles the dialog with the symbol and keeps the simulation notice on every step, as the dialog's description", () => {
    for (const flow of [INITIAL_RETIRE_FLOW, READY, DONE]) {
      const html = view({ flow });
      expect(html).toContain(`>${T.title("VCS-FOR-2021")}</h2>`);
      const note = /<div id="([^"]+)" data-simulated=""/.exec(html);
      expect(note).not.toBeNull();
      expect(tag(html, "<dialog")).toContain(`aria-describedby="${note?.[1]}"`);
      expect(html).toContain(`>${T.simulation}</p>`);
      expect(html).toContain(`<p>${esc(T.warning)}</p>`);
    }
  });

  it("marks the current step in the step list", () => {
    const steps = (flow: RetireFlow) => [...view({ flow }).matchAll(/<li( aria-current="step")? class="[^"]*"><span aria-hidden="true" class="tnum">([^<]+)<\/span>/g)].map((m) => `${m[2]}${m[1] ? "*" : ""}`);
    expect(steps(INITIAL_RETIRE_FLOW)).toEqual(["1*", "2", "3"]);
    expect(steps(READY)).toEqual(["✓", "2*", "3"]);
    expect(steps(DONE)).toEqual(["✓", "✓", "3*"]);
    expect(view()).toContain(`<ol aria-label="${T.stepsLabel}"`);
    for (const label of [T.stepDetails, T.stepReview, T.stepCertificate]) expect(view()).toContain(`<span class="truncate">${label}</span>`);
  });
});

describe("RetireDialog: details step", () => {
  const html = view();

  it("shows the position being retired: name, registry and vintage, tradable and locked with the lock sources", () => {
    const summary = html.slice(html.indexOf('data-retire-position=""'), html.indexOf("<label"));
    expect(NAME).toBeTruthy();
    expect(summary).toContain(`>${NAME}</p>`);
    expect(summary).toContain("Verra");
    expect(summary).toContain(">2021</span>");
    expect(summary).toMatch(new RegExp(`${TABS.tradable} <strong[^>]*>100</strong>`));
    expect(summary).toMatch(new RegExp(`${TABS.locked} <strong[^>]*>20</strong>`));
    expect(summary).toContain(T.lockedBy({ orders: "12", otc: "8" }));
    // 没有锁定:不出来源行
    expect(view({ position: position({ locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 120 }) })).not.toContain("Locked: sell orders");
  });

  it("tolerates a position without lockedBy (a Phase 1 server after a rollback): the locked total only, no sources line, no crash", () => {
    for (const lockedBy of [undefined, null]) {
      const old = view({ position: position({ lockedBy: lockedBy as unknown as Position["lockedBy"] }) });
      const summary = old.slice(old.indexOf('data-retire-position=""'), old.indexOf("<label"));
      expect(summary).toMatch(new RegExp(`${TABS.tradable} <strong[^>]*>100</strong>`));
      expect(summary).toMatch(new RegExp(`${TABS.locked} <strong[^>]*>20</strong>`));
      expect(summary).not.toContain("Locked: sell orders");
      expect(old).toContain('max="100"'); // 表单照常
    }
    // 后两步不读 lockedBy
    const bare = position({ lockedBy: undefined as unknown as Position["lockedBy"] });
    expect(view({ flow: READY, position: bare })).toContain('data-retire-step="review"');
    expect(view({ flow: DONE, position: bare })).toContain('data-retire-step="receipt"');
  });

  it("caps the amount input at the position's tradable quantity", () => {
    const input = tag(html, 'type="number"');
    expect(input).toContain('min="1"');
    expect(input).toContain('max="100"');
    expect(input).toContain('step="1"');
    expect(input).toContain('inputMode="numeric"');
    expect(input).toContain('required=""');
    expect(tag(view({ position: position({ available: 7, locked: 113 }) }), 'type="number"')).toContain('max="7"');
    expect(html).toContain(`>${esc(T.unit)}</p>`);
  });

  it("offers the six preset reasons, and the free-text reason only for Other", () => {
    expect([...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "",
      "Personal Carbon Offset",
      "Corporate Emissions Offset",
      "Event Offset",
      "Product Carbon Neutrality",
      "ESG Commitment",
      "Other",
    ]);
    expect(html).not.toContain(T.reasonOther);
    const other = view({ flow: run([{ type: "field", name: "reason", value: "Other" }]) });
    expect(other).toContain(`>${T.reasonOther}</label>`);
    expect(tag(other, `placeholder="${T.reasonPlaceholder}"`)).toContain('maxLength="193"');
  });

  it("limits the text fields to what the server accepts and keeps the form's own validation (noValidate)", () => {
    expect(tag(html, `placeholder="${T.beneficiaryPlaceholder}"`)).toContain('maxLength="200"');
    expect(tag(html, `placeholder="${T.purposePlaceholder}"`)).toContain('maxLength="500"');
    expect(count(html, 'maxLength="500"')).toBe(2); // 用途 + 留言
    expect(tag(html, "<form")).toContain('noValidate=""');
    expect(html).toContain(`>${esc(T.messageHelp)}</p>`);
    expect(html).toContain(`${T.message} <span class="text-muted-2">(optional)</span>`);
    expect(zhCN.terminal.retire.optional).toBe("（选填）"); // 括号随语言(中文全角),不在组件里写死
    expect(html).toMatch(new RegExp(`<button type="submit"[^>]*>${T.next}</button>`));
    expect(html).not.toContain('role="alert"');
  });

  it("shows the validation error in the form: amount out of range, or missing fields", () => {
    const over = view({ flow: run([...FILL, { ...REVIEW, available: 39 } as RetireAction]) });
    const error = /<p id="([^"]+)" role="alert" data-retire-error="invalidAmount" class="text-t-sm text-danger">([^<]+)<\/p>/.exec(over);
    expect(error?.[2]).toBe(T.invalidAmount);
    expect(tag(over, 'type="number"')).toContain('aria-invalid="true"');
    expect(tag(over, 'type="number"')).toMatch(new RegExp(`aria-describedby="[^" ]+ ${error?.[1]}"`)); // 读屏在数量框上就能听到原因
    expect(tag(over, 'type="number"')).toContain('value="40"'); // 填过的内容留着
    const missing = view({ flow: run([{ type: "field", name: "quantity", value: "5" }, REVIEW]) });
    expect(missing).toContain(`data-retire-error="missingFields" class="text-t-sm text-danger">${T.missingFields}</p>`);
    expect(tag(missing, 'type="number"')).not.toContain('aria-invalid="');
    expect(missing).toContain('data-retire-step="details"');
  });

  it("has no form for a scenario instrument, nor when nothing is tradable", () => {
    const scenario = view({ position: position({ isScenario: true }) });
    expect(scenario).toContain(`>${T.scenarioBlocked}</h3>`);
    expect(scenario).not.toContain("<form");
    expect(scenario).not.toContain("<input");
    const locked = view({ position: position({ available: 0, locked: 120, lockedBy: { orders: 120, otc: 0 } }) });
    expect(locked).toContain(`>${T.noAvailable}</h3>`);
    expect(locked).toContain(`>${T.noAvailableHelp}</p>`);
    expect(locked).toContain(T.lockedBy({ orders: "120", otc: "0" }));
    expect(locked).not.toContain("<form");
  });
});

describe("RetireDialog: review step", () => {
  it("summarises the request with the simulated badge and needs the acknowledgement before it can be confirmed", () => {
    const html = view({ flow: IN_REVIEW });
    expect(html).toContain('data-retire-step="review"');
    expect(html).toContain(`>${T.reviewTitle}</h3>`);
    expect(html).toMatch(/>40 <span[^>]*>tCO2e<\/span>/);
    expect(html).toContain(`<span data-simulated=""`);
    expect(html).toContain(`>${T.badge}</span>`);
    const review = html.slice(html.indexOf('data-retire-review=""'), html.indexOf("</dl>"));
    expect(review).toContain(`VCS-FOR-2021 · ${NAME}`);
    expect(review).toContain(`>${T.registry}</dt>`);
    expect(review).toContain(`>${T.standard}</dt>`);
    expect(review).toContain("Acme &lt;Corp&gt;");
    expect(review).toContain("Event Offset");
    expect(review).toContain("Annual meeting");
    expect(review).not.toContain(`>${T.message}</dt>`); // 没填留言就不列
    expect(html).toContain(`<span>${esc(T.acknowledgement)}</span>`);
    expect(tag(html, 'type="checkbox"')).not.toContain("checked");
    expect(html).toMatch(new RegExp(`<button type="submit" disabled=""[^>]*>${T.confirm}</button>`));
    expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*">${T.edit}</button>`));
  });

  it("shows the labels of a missing registry / standard as not provided instead of inventing them", () => {
    const html = view({ flow: IN_REVIEW, instrument: undefined });
    const review = html.slice(html.indexOf('data-retire-review=""'), html.indexOf("</dl>"));
    expect(count(review, en.terminal.meta.notProvided)).toBe(3); // 登记簿、标准、年份
    expect(review).toContain(">VCS-FOR-2021</dd>");
  });

  it("enables Confirm once acknowledged, and disables everything while the request is in flight", () => {
    const ready = view({ flow: READY });
    expect(tag(ready, 'type="checkbox"')).toContain('checked=""');
    expect(ready).toMatch(new RegExp(`<button type="submit" aria-busy="false"[^>]*>${T.confirm}</button>`));
    const busy = view({ flow: run([{ type: "submit" }], READY) });
    expect(tag(busy, "<form")).toContain('aria-busy="true"');
    expect(tag(busy, 'type="checkbox"')).toContain('disabled=""');
    expect(busy).toMatch(new RegExp(`<button type="button" disabled=""[^>]*>${T.edit}</button>`));
    expect(busy).toMatch(new RegExp(`<button type="submit" disabled="" aria-busy="true"[^>]*>${T.confirming}</button>`));
  });

  it("uncertain outcome: says so, locks Edit and leaves Confirm as the retry of the same request", () => {
    const flow = run([{ type: "submit" }, { type: "failed", error: new ApiError("The account is busy. Retry this same request to check whether it completed.", 503) }], READY);
    const html = view({ flow });
    const alert = html.slice(html.indexOf('role="alert"'), html.indexOf("</div>", html.indexOf('role="alert"')));
    expect(alert).toContain('data-retire-error="uncertain"');
    // 503:本地化的「服务器没有确认结果」;服务端的英文原文只在 title 里(P2-13,终审 UI-4)
    expect(alert).toContain(`<p title="The account is busy. Retry this same request to check whether it completed.">${T.errorUnconfirmed}</p>`);
    expect(alert).toContain(esc(T.retryHelp));
    expect(html).toMatch(new RegExp(`<button type="button" disabled=""[^>]*>${T.edit}</button>`));
    expect(html).toMatch(new RegExp(`<button type="submit" aria-busy="false"[^>]*>${T.confirm}</button>`));
    expect(flow.request?.idempotencyKey).toBe("key-0001");
  });

  it("definite rejection: localised reason, Edit stays available, no retry hint", () => {
    const flow = run([{ type: "submit" }, { type: "failed", error: new ApiError("Available holdings changed. Refresh and review the amount again.", 409) }], READY);
    const html = view({ flow });
    expect(html).toContain('data-retire-error="rejected"');
    expect(html).toContain(`<p title="Available holdings changed. Refresh and review the amount again.">${T.errorHoldingsChanged}</p>`);
    expect(html).not.toContain(esc(T.retryHelp));
    expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*">${T.edit}</button>`));
  });
});

describe("RetireDialog: review step after an uncertain attempt", () => {
  const UNCERTAIN: RetireAction[] = [{ type: "submit" }, { type: "failed", error: new ApiError("The account is busy. Retry this same request to check whether it completed.", 503) }];
  const alertOf = (html: string) => html.slice(html.indexOf('role="alert"'), html.indexOf("</div>", html.indexOf('role="alert"')));

  it("409 on the retry: its own sentence and a link to the retirement history; no 'go back' next to 'keep these details'; Edit is unlocked", () => {
    const flow = run([...UNCERTAIN, { type: "submit" }, { type: "failed", error: new ApiError("Insufficient available holdings. Credits locked in sell orders or OTC listings cannot be retired.", 409) }], READY);
    expect(flow.uncertain).toBe(false);
    const html = view({ flow });
    const alert = alertOf(html);
    expect(alert).toContain('data-retire-error="conflict"');
    expect(alert).toMatch(new RegExp(`<p title="[^"]*">${esc(T.errorConflictAfterUncertain)}</p>`));
    expect(alert).not.toContain(esc(T.retryHelp));
    expect(alert).not.toContain(esc(T.errorHoldingsChanged));
    // 服务端的原文只在 title 属性里,不在显示的文字里
    expect(alert.replace(/ title="[^"]*"/g, "")).not.toContain("Insufficient available holdings");
    // 注销记录在新标签页打开:对话框里的内容不丢
    expect(alert).toMatch(new RegExp(`<a [^>]*target="_blank"[^>]*href="/retirement"[^>]*>${T.history}</a>|<a [^>]*href="/retirement"[^>]*target="_blank"[^>]*>${T.history}</a>`));
    expect(alert).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(new RegExp(`<button type="button" class="[^"]*">${T.edit}</button>`));
    expect(html).toMatch(new RegExp(`<button type="submit" aria-busy="false"[^>]*>${T.confirm}</button>`));
    // 回去改、再复核:换新键
    const again = run([{ type: "edit" }, { type: "field", name: "quantity", value: "10" }, { ...REVIEW, idempotencyKey: "key-0002" }], flow);
    expect(again.request?.idempotencyKey).toBe("key-0002");
    expect(view({ flow: again })).not.toContain('role="alert"');
  });

  it("any other later failure (401 / 429 / 5xx) keeps the lock and the retry hint, as before", () => {
    for (const status of [401, 429, 503]) {
      const flow = run([...UNCERTAIN, { type: "submit" }, { type: "failed", error: new ApiError("Request rejected", status) }], READY);
      const html = view({ flow });
      const alert = alertOf(html);
      expect(alert, String(status)).toContain('data-retire-error="uncertain"');
      expect(alert).toContain(esc(T.retryHelp));
      expect(alert).not.toContain(esc(T.errorConflictAfterUncertain));
      expect(alert).not.toContain('href="/retirement"');
      expect(html).toMatch(new RegExp(`<button type="button" disabled=""[^>]*>${T.edit}</button>`));
    }
  });

  it("a first-attempt 409 (nothing uncertain before it) keeps the ordinary wording", () => {
    const flow = run([{ type: "submit" }, { type: "failed", error: new ApiError("Insufficient available holdings.", 409) }], READY);
    const alert = alertOf(view({ flow }));
    expect(alert).toContain('data-retire-error="rejected"');
    expect(alert).toContain(`<p title="Insufficient available holdings.">${T.errorHoldingsChanged}</p>`);
    expect(alert).not.toContain('href="/retirement"');
  });
});

describe("RetireDialog: the flow lives outside the component", () => {
  afterEach(() => clearRetireFlows());

  it("an uncertain review taken back from the store after the dialog was unmounted renders as it was: same key, Edit locked, retry hint", async () => {
    // 挂载 → 填写 → 复核 → 确认 → 503 → 卸载(换页签 / 换一行)
    let unwatch = watchRetireFlow("asset-1");
    for (const action of [...FILL, REVIEW, { type: "acknowledge", value: true } as RetireAction]) dispatchRetireFlow("asset-1", action);
    await submitRetireFlow("asset-1", async () => Promise.reject(new ApiError("The account is busy.", 503)));
    unwatch();
    // 再挂上来:RetireDialogFlow 读到的就是 retireFlowOf(assetId)
    unwatch = watchRetireFlow("asset-1");
    const flow = retireFlowOf("asset-1");
    expect(flow.request?.idempotencyKey).toBe("key-0001");
    expect(canEditRetirement(flow)).toBe(false);
    const html = view({ flow });
    expect(html).toContain('data-retire-step="review"');
    expect(html).toContain('data-retire-error="uncertain"');
    expect(html).toContain(esc(T.retryHelp));
    expect(html).toMatch(new RegExp(`<button type="button" disabled=""[^>]*>${T.edit}</button>`));
    expect(html).toMatch(/<input type="checkbox" required="" [^>]*checked=""/);
    expect(html).toMatch(new RegExp(`<button type="submit" aria-busy="false"[^>]*>${T.confirm}</button>`));
    unwatch();
  });

  it("keeps no flow state in the component: it reads the store and submits through it", () => {
    const source = readFileSync(fileURLToPath(new URL("./RetireDialog.tsx", import.meta.url)), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code).not.toMatch(/useReducer|useState/);
    expect(code).toMatch(/const flow = useRetireFlow\(assetId\);/);
    expect(code).toMatch(/submitRetireFlow\(assetId\)/);
    expect(code).not.toMatch(/submitRetirement\(/);
  });
});

describe("RetireDialog: receipt step", () => {
  const html = view({ flow: DONE, position: position({ quantity: 80, available: 60, retired: 45 }) });

  it("shows the recorded simulation with its reference and the simulated badge", () => {
    expect(html).toContain('data-retire-step="receipt"');
    expect(html).toContain(`>${T.saved}</h3>`);
    expect(html).toContain(`>${esc(T.doneBody)}</p>`);
    expect(html).toMatch(/>40 <span[^>]*>tCO2e<\/span>/);
    expect(html).toContain(`>${T.badge}</span>`);
    const receipt = html.slice(html.indexOf('data-retire-receipt=""'), html.indexOf("</dl>"));
    expect(receipt).toContain(`VCS-FOR-2021 · ${NAME}`);
    expect(receipt).toContain("Acme &lt;Corp&gt;");
    expect(receipt).toContain(`>${T.reference}</dt>`);
    expect(receipt).toContain(">SIM-RET-0F8FAD5B-D9CB-469F-A165-70867728950E</span>");
    expect(receipt).toContain(`>${T.date}</dt>`);
  });

  it("links to the certificate (view / print in a new tab, and the download variant)", () => {
    expect(html).toMatch(new RegExp(`<a href="/api/retirements/ret-1/certificate" target="_blank" rel="noopener noreferrer"[^>]*>${T.view}</a>`));
    expect(html).toMatch(new RegExp(`<a href="/api/retirements/ret-1/certificate\\?download=1"[^>]*>${T.download}</a>`));
    expect(html).toMatch(new RegExp(`<a[^>]*href="/retirement"[^>]*>${T.history}</a>`));
  });

  it("tells the user the position updates by itself and shows its live figures", () => {
    const note = html.slice(html.indexOf('data-retire-position="" role="status"'));
    expect(note).toMatch(new RegExp(`${T.positionUpdated} ${TABS.tradable} <span[^>]*>60</span> · ${TABS.retired} <span[^>]*>45</span>`));
  });

  it("offers to retire more only while something is still tradable, and always a way to close", () => {
    expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${T.another}</button>`));
    expect(html).toMatch(new RegExp(`<button type="button"[^>]*>${en.ui.close}</button>`));
    const spent = view({ flow: DONE, position: position({ quantity: 0, available: 0, locked: 0, retired: 125 }) });
    expect(spent).not.toContain(T.another);
    expect(spent).toMatch(new RegExp(`<button type="button"[^>]*>${en.ui.close}</button>`));
  });
});

describe("RetireDialog: submitting", () => {
  it("posts the same body, idempotency key included, when an uncertain attempt is retried", async () => {
    const bodies: string[] = [];
    let attempt = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      attempt += 1;
      if (attempt === 1) throw new TypeError("Connection interrupted");
      return new Response(JSON.stringify({ ok: true, data: { retirement: RECORD, replayed: true } }), { status: 200 });
    });
    // 容器的做法:取当前 flow.request 提交,结果回来再喂给状态机
    let flow = run([{ type: "submit" }], READY);
    const first = await submitRetirement(flow.request!).then(
      () => null,
      (error: unknown) => error,
    );
    flow = reduceRetireFlow(flow, { type: "failed", error: first });
    expect(flow.uncertain).toBe(true);
    flow = reduceRetireFlow(flow, { type: "submit" });
    const result = await submitRetirement(flow.request!);
    flow = reduceRetireFlow(flow, { type: "succeeded", retirement: result.retirement });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[0])).toMatchObject({ assetId: "asset-1", quantity: 40, idempotencyKey: "key-0001", acknowledged: true });
    expect(flow.step).toBe("receipt");
  });

  it("generates the idempotency key in one place only: on entering review", () => {
    const source = readFileSync(fileURLToPath(new URL("./RetireDialog.tsx", import.meta.url)), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(code.match(/randomUUID\(\)/g)).toHaveLength(1);
    expect(code).toMatch(/dispatch\(\{ type: "review", [^}]*idempotencyKey: crypto\.randomUUID\(\) \}\)/);
  });

  it("words every failure itself: 401 / 409 / 429, then connection lost (0), refused (other 4xx), not confirmed (5xx, unreadable 2xx, not an ApiError)", () => {
    const text = en.terminal;
    expect(retirementFailureText({ message: "Unauthorized", status: 401 }, text)).toBe(text.toast.loginRequired);
    expect(retirementFailureText({ message: "Insufficient available holdings.", status: 409 }, text)).toBe(T.errorHoldingsChanged);
    // 限流窗口 60 秒(api/retirements:20 次 / 分钟);沿用终端现成的限流文案
    expect(retirementFailureText({ message: "Too many requests. Please retry later.", status: 429 }, text)).toBe(text.toast.rateLimited(60));
    // P2-13(终审 UI-4):服务端 / 网络层的英文原文不再上界面(中文界面也不会冒出 Failed to fetch)
    expect(retirementFailureText({ message: "Scenario index instruments cannot be retired.", status: 400 }, text)).toBe(T.errorRefused);
    expect(retirementFailureText({ message: "Forbidden", status: 403 }, text)).toBe(T.errorRefused);
    expect(retirementFailureText({ message: "Failed to fetch", status: 0 }, text)).toBe(T.errorConnection);
    expect(retirementFailureText({ message: "Load failed", status: 0 }, zhCN.terminal)).toBe(zhCN.terminal.retire.errorConnection);
    expect(retirementFailureText({ message: "Failed to parse response", status: 502 }, text)).toBe(T.errorUnconfirmed);
    expect(retirementFailureText({ message: "The account is busy. Retry this same request to check whether it completed.", status: 503 }, zhCN.terminal)).toBe(zhCN.terminal.retire.errorUnconfirmed);
    expect(retirementFailureText({ message: "The server's response could not be read", status: 200 }, text)).toBe(T.errorUnconfirmed);
    expect(retirementFailureText({ message: "boom", status: null }, text)).toBe(T.errorUnconfirmed);
    expect(retirementFailureText({ message: "x", status: 400 }, zhCN.terminal)).toBe(zhCN.terminal.retire.errorRefused);
    // 三句都是本地化文案,中文里没有英文原文
    for (const key of ["errorConnection", "errorUnconfirmed", "errorRefused"] as const) {
      expect(zhCN.terminal.retire[key]).toMatch(/[\u4e00-\u9fff]/);
      expect(zhCN.terminal.retire[key]).not.toMatch(/[A-Za-z]/);
    }
    expect(retirementFailureText({ message: "x", status: 409 }, zhCN.terminal)).toBe(zhCN.terminal.retire.errorHoldingsChanged);
    // 结果不确定之后重试得到的 409:专门的一句(对话框已关掉时 toast 用的也是它)
    expect(retirementFailureText({ message: "x", status: 409, conflictAfterUncertain: true }, text)).toBe(T.errorConflictAfterUncertain);
    expect(retirementFailureText({ message: "x", status: 409, conflictAfterUncertain: true }, zhCN.terminal)).toBe(zhCN.terminal.retire.errorConflictAfterUncertain);
    expect(retirementFailureText({ message: "x", status: 409, conflictAfterUncertain: false }, text)).toBe(T.errorHoldingsChanged);
    expect(T.errorConflictAfterUncertain).toMatch(/retirement history/);
    expect(zhCN.terminal.retire.errorConflictAfterUncertain).toMatch(/注销记录/);
  });
});

describe("terminal.retire copy", () => {
  it("never drops the simulated labelling (both languages)", () => {
    for (const [text, word] of [
      [en.terminal.retire, /simulat/i],
      [zhCN.terminal.retire, /模拟/],
    ] as const) {
      for (const key of ["simulation", "badge", "unit", "acknowledgement", "confirm", "doneBody", "saved", "reviewTitle"] as const) {
        expect(text[key], key).toMatch(word);
      }
    }
    expect(en.terminal.retire.warning).toMatch(/No real credits are held or retired in a registry/);
    expect(zhCN.terminal.retire.warning).toMatch(/不托管真实碳信用/);
  });
});
