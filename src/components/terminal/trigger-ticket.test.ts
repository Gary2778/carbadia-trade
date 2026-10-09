import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import { validateTriggerDraft } from "@/shared/order-math";
import { lastPriceOf } from "@/lib/market/last-price";
import {
  INITIAL_COND_DRAFT,
  condRefPrice,
  condTriggerDraft,
  condView,
  initialCondTicket,
  priceOf,
  reduceCondTicket,
  submitFailure,
  triggerErrorText,
  type CondDraft,
  type CondTicketAction,
  type CondTicketState,
  type TriggerReview,
} from "./trigger-ticket";

const draft = (patch: Partial<CondDraft> = {}): CondDraft => ({ ...INITIAL_COND_DRAFT, ...patch });
const AVAIL = { cashCents: 100_000, qty: 40 };
const INSTRUMENT = { id: "asset-1", tickSize: 1, qtyStep: 1, minQty: 1 };

describe("条件单票据:参考价与派生值", () => {
  it("参考价:市价单取触发价,限价单取委托价;空、非法、≤ 0 为 null", () => {
    expect(condRefPrice(draft({ triggerText: "70", limitText: "69.5" }))).toBe(7000);
    expect(condRefPrice(draft({ then: "LIMIT", triggerText: "70", limitText: "69.5" }))).toBe(6950);
    expect(condRefPrice(draft({ then: "LIMIT", triggerText: "70" }))).toBeNull();
    for (const text of ["", "abc", "0", "1.234", "-5"]) expect(priceOf(text), text).toBeNull();
    expect(priceOf("1,000.5")).toBe(100_050);
  });

  it("数量是最后动的:滑杆 = 买入金额占可用现金(按参考价)/ 卖出数量占可用持仓,预估合计 = 参考价 × 数量", () => {
    expect(condView(draft({ triggerText: "50", qtyText: "10" }), "BUY", AVAIL, 1)).toEqual({ qtyText: "10", pct: 50, estNotional: 50_000 });
    expect(condView(draft({ triggerText: "50", qtyText: "10" }), "SELL", AVAIL, 1)).toEqual({ qtyText: "10", pct: 25, estNotional: 50_000 });
    // 限价单按委托价算
    expect(condView(draft({ then: "LIMIT", triggerText: "50", limitText: "40", qtyText: "10" }), "BUY", AVAIL, 1).estNotional).toBe(40_000);
    // 没有参考价或数量不合法:合计为空、滑杆 0,数量框保留用户输入
    expect(condView(draft({ qtyText: "10" }), "BUY", AVAIL, 1)).toEqual({ qtyText: "10", pct: 0, estNotional: null });
    expect(condView(draft({ triggerText: "50", qtyText: "1.5" }), "SELL", AVAIL, 1)).toEqual({ qtyText: "1.5", pct: 0, estNotional: null });
  });

  it("滑杆是最后动的:买按可用现金在参考价下能买的整吨,卖按可用持仓;0% 清空数量", () => {
    expect(condView(draft({ triggerText: "30", pct: 50, lastEdited: "pct" }), "BUY", AVAIL, 1)).toEqual({ qtyText: "16", pct: 50, estNotional: 48_000 });
    expect(condView(draft({ triggerText: "30", pct: 50, lastEdited: "pct" }), "SELL", AVAIL, 1)).toEqual({ qtyText: "20", pct: 50, estNotional: 60_000 });
    // 参考价随触发价变:同一个滑杆位置,换算的数量跟着变(不需要 effect)
    expect(condView(draft({ triggerText: "60", pct: 50, lastEdited: "pct" }), "BUY", AVAIL, 1).qtyText).toBe("8");
    // 买单没有参考价换不出数量
    expect(condView(draft({ pct: 50, lastEdited: "pct" }), "BUY", AVAIL, 1)).toEqual({ qtyText: "", pct: 50, estNotional: null });
    expect(condView(draft({ triggerText: "30", pct: 0, lastEdited: "pct" }), "SELL", AVAIL, 1)).toEqual({ qtyText: "", pct: 0, estNotional: null });
  });

  it("草稿 → validateTriggerDraft:方向由触发价与最新成交价现推,最新价未知时用用户选的方向;市价单不带委托价", () => {
    const market = condTriggerDraft(draft({ triggerText: "70", limitText: "69.5" }), "BUY", "10");
    expect(market).toEqual({ side: "BUY", orderType: "MARKET", triggerPrice: 7000, limitPrice: null, quantity: 10, direction: null });
    expect(validateTriggerDraft(market, INSTRUMENT, 6500)).toEqual({
      ok: true,
      trigger: { assetId: "asset-1", direction: "ABOVE", triggerPrice: 7000, side: "BUY", orderType: "MARKET", limitPrice: null, quantity: 10 },
    });
    const limit = condTriggerDraft(draft({ then: "LIMIT", triggerText: "60", limitText: "59.5" }), "SELL", "5");
    expect(validateTriggerDraft(limit, INSTRUMENT, 6500)).toMatchObject({ ok: true, trigger: { direction: "BELOW", orderType: "LIMIT", limitPrice: 5950 } });
    expect(validateTriggerDraft(condTriggerDraft(draft({ triggerText: "65" }), "BUY", "5"), INSTRUMENT, 6500)).toEqual({ ok: false, reason: "wouldTriggerNow", field: "triggerPrice" });
    expect(validateTriggerDraft(condTriggerDraft(draft({ triggerText: "65" }), "BUY", "5"), INSTRUMENT, null)).toEqual({ ok: false, reason: "directionNeeded", field: "direction" });
    expect(validateTriggerDraft(condTriggerDraft(draft({ triggerText: "65", direction: "BELOW" }), "BUY", "5"), INSTRUMENT, null)).toMatchObject({ ok: true, trigger: { direction: "BELOW" } });
  });

  it("最新成交价(@/lib/market/last-price,持仓估值与条件单共用这一个):ticker 优先,没有就用标的列表里的,都没有为 null", () => {
    const state = { tickers: { A: { lastPrice: 101 }, B: { lastPrice: null } }, instruments: { A: { lastPrice: 99 }, B: { lastPrice: 98 }, C: { lastPrice: null } } };
    expect(lastPriceOf(state, "A")).toBe(101);
    expect(lastPriceOf(state, "B")).toBe(98);
    expect(lastPriceOf(state, "C")).toBeNull();
    expect(lastPriceOf(state, "D")).toBeNull();
  });
});

describe("条件单的错误文案", () => {
  it("每个 TriggerDraftError 都有文案;tick / 最小数量 / 步长按标的精度填", () => {
    for (const m of [en, zhCN]) {
      for (const reason of Object.keys(m.terminal.triggers.errors) as (keyof typeof m.terminal.triggers.errors)[]) {
        expect(triggerErrorText(m.terminal.triggers.errors, reason, { minQty: 5, qtyStep: 10 }, "0.05").trim().length, reason).toBeGreaterThan(0);
      }
    }
    expect(triggerErrorText(en.terminal.triggers.errors, "offTick", { minQty: 5, qtyStep: 10 }, "0.05")).toBe("Price must be a multiple of 0.05");
    expect(triggerErrorText(en.terminal.triggers.errors, "belowMinQty", { minQty: 5, qtyStep: 10 }, "0.05")).toBe("Minimum quantity is 5 t");
    expect(triggerErrorText(en.terminal.triggers.errors, "offStep", { minQty: 5, qtyStep: 10 }, "0.05")).toBe("Quantity must be a multiple of 10 t");
  });

  it("提交失败:断网与 5xx 都算结果未确认(可原样重试);429 有秒数用 toast.rateLimited;401 带登录入口;服务端原文不上界面", () => {
    const T = en.terminal;
    expect(submitFailure({ code: "uncertain", retryAfter: null }, T, "/login")).toEqual({ message: T.triggers.submitErrors.uncertain, uncertain: true, loginHref: null });
    expect(submitFailure({ code: "network", retryAfter: null }, T, "/login")).toEqual({ message: T.triggers.submitErrors.network, uncertain: true, loginHref: null });
    expect(submitFailure({ code: "rateLimited", retryAfter: 12 }, T, "/login")).toEqual({ message: T.toast.rateLimited(12), uncertain: false, loginHref: null });
    expect(submitFailure({ code: "rateLimited", retryAfter: null }, T, "/login").message).toBe(T.triggers.submitErrors.rateLimited);
    expect(submitFailure({ code: "unauthorized", retryAfter: null }, T, "/login?x")).toEqual({ message: T.triggers.submitErrors.unauthorized, uncertain: false, loginHref: "/login?x" });
    for (const code of ["wouldTriggerNow", "tooManyTriggers", "insufficientQty", "invalid", "notCancellable"] as const) {
      expect(submitFailure({ code, retryAfter: null }, T, "/login"), code).toEqual({ message: T.triggers.submitErrors[code], uncertain: false, loginHref: null });
    }
  });
});

describe("条件单票据的 reducer(useConditionalTicket 接进下单面板)", () => {
  const run = (state: CondTicketState, ...actions: CondTicketAction[]) => actions.reduce(reduceCondTicket, state);
  const REVIEW: TriggerReview = {
    fields: { assetId: "asset-1", direction: "ABOVE", triggerPrice: 7000, side: "BUY", orderType: "MARKET", limitPrice: null, quantity: 10 },
    estNotional: 70_000,
    lastPrice: 6500,
  };
  const filled = run(initialCondTicket(3), { kind: "enter" }, { kind: "edit", patch: { triggerText: "70", then: "LIMIT", limitText: "69.5", qtyText: "10" } });

  it("进入 / 离开条件单票据:离开时草稿留着(再切回来还在),「核对过」与打开着的确认单清掉;无变化时同一引用", () => {
    const start = initialCondTicket(3);
    expect(start).toEqual({ active: false, draft: INITIAL_COND_DRAFT, attempted: false, review: null, seedNonce: 3 });
    expect(reduceCondTicket(start, { kind: "leave" })).toBe(start);
    expect(filled.active).toBe(true);
    expect(reduceCondTicket(filled, { kind: "enter" })).toBe(filled);
    const left = run(filled, { kind: "attempt" }, { kind: "review", review: REVIEW }, { kind: "leave" });
    expect(left).toMatchObject({ active: false, attempted: false, review: null, draft: { triggerText: "70", then: "LIMIT", limitText: "69.5", qtyText: "10" } });
    expect(run(left, { kind: "enter" })).toMatchObject({ active: true, draft: { triggerText: "70", qtyText: "10" } });
  });

  it("滑杆:记为最后动的那一项并夹到 0..100 的整数;数量框的输入记为 qty", () => {
    expect(run(filled, { kind: "pct", pct: 140 }).draft).toMatchObject({ pct: 100, lastEdited: "pct" });
    expect(run(filled, { kind: "pct", pct: 33.6 }).draft.pct).toBe(34);
    expect(run(filled, { kind: "pct", pct: NaN }).draft.pct).toBe(0);
    expect(run(filled, { kind: "pct", pct: 50 }, { kind: "edit", patch: { qtyText: "7", lastEdited: "qty" } }).draft).toMatchObject({ qtyText: "7", lastEdited: "qty" });
  });

  it("核对 → 确认 → 复位:没通过只记「核对过」;通过打开确认框;提交成功关框、清数量与滑杆和「核对过」,触发价 / 触发后的单 / 委托价留着", () => {
    const attempted = run(filled, { kind: "attempt" });
    expect(attempted).toMatchObject({ attempted: true, review: null });
    expect(reduceCondTicket(attempted, { kind: "attempt" })).toBe(attempted);
    const reviewing = run(filled, { kind: "pct", pct: 40 }, { kind: "review", review: REVIEW });
    expect(reviewing).toMatchObject({ attempted: true, review: REVIEW });
    const placed = run(reviewing, { kind: "placed" });
    expect(placed).toMatchObject({ active: true, attempted: false, review: null });
    expect(placed.draft).toEqual({ ...reviewing.draft, qtyText: "", pct: 0, lastEdited: "qty" });
    // 取消 / Esc:只关确认框,草稿与「核对过」都在;已经关着时同一引用
    const closed = run(reviewing, { kind: "close" });
    expect(closed).toMatchObject({ review: null, attempted: true, draft: reviewing.draft });
    expect(reduceCondTicket(closed, { kind: "close" })).toBe(closed);
  });

  it("盘口点价(新种子带价格、当前标的)把票据切回限价;只带方向的种子、别的标的、看过的 nonce 都不切", () => {
    const priced = run(filled, { kind: "review", review: REVIEW }, { kind: "seed", nonce: 4, symbol: "VCS-FOR-2021", price: 6800, currentSymbol: "VCS-FOR-2021" });
    expect(priced).toMatchObject({ active: false, attempted: false, review: null, seedNonce: 4 });
    expect(priced.draft).toBe(filled.draft);
    const sideOnly = run(filled, { kind: "seed", nonce: 4, symbol: "VCS-FOR-2021", price: undefined, currentSymbol: "VCS-FOR-2021" });
    expect(sideOnly).toMatchObject({ active: true, seedNonce: 4 });
    const otherSymbol = run(filled, { kind: "seed", nonce: 4, symbol: "GS-WIND-2023", price: 4600, currentSymbol: "VCS-FOR-2021" });
    expect(otherSymbol).toMatchObject({ active: true, seedNonce: 4 });
    expect(reduceCondTicket(filled, { kind: "seed", nonce: 3, symbol: "VCS-FOR-2021", price: 6800, currentSymbol: "VCS-FOR-2021" })).toBe(filled);
    // 不在条件单票据上时只记下 nonce
    expect(run(initialCondTicket(3), { kind: "seed", nonce: 5, symbol: "VCS-FOR-2021", price: 6800, currentSymbol: "VCS-FOR-2021" })).toMatchObject({ active: false, seedNonce: 5 });
  });
});
