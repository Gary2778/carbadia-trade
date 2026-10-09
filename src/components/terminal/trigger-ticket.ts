// 下单面板「条件单」票据的本地草稿与派生值(P3-07;计划 §6.3.2 C3 / C4)。纯函数,node 环境可测(trigger-ticket.test.ts)。
// - 草稿存输入框文本:触发价、触发后下的单(市价 / 限价)与它的限价、数量;滑杆百分比;lastEdited 记数量与滑杆哪个是用户最后动的,另一个派生。
// - 买卖方向与限价 / 市价票据共用 OrderPanel 的草稿(这里只收 side 参数)。
// - 方向(高于 / 低于最新成交价)不进草稿:提交前由触发价与最新成交价现推(validateTriggerDraft);最新价未知时才用用户选的 direction。
// - 参考价 = 限价单的限价、市价单的触发价:滑杆按它换算买入数量,预估合计 = 参考价 × 数量(市价单只是按触发价的粗估,界面上明说)。
// - 票据本身的状态(是不是条件单票据、草稿、核对过没有、打开着的确认单、看过的盘口种子)是一个 reducer(reduceCondTicket),
//   useConditionalTicket.ts 把它接进 OrderPanel;最新成交价取自 @/lib/market/last-price(与持仓估值同一口径)。
// 单位:价格与金额整数分,数量整数吨。
import type { OrderTriggerFields, OrderType, Side, TriggerDirection, TriggerDraftError } from "@/shared";
import { amountFromQty, qtyFromPercent, type TriggerDraft } from "@/shared/order-math";
import type { Messages } from "@/i18n";
import type { TriggerSubmitFailure } from "@/lib/market/trigger-submit";
import { parseCents, parseQty, type DraftAvail, type DraftInstrumentInfo } from "@/lib/market/order-draft";

export type CondDraft = {
  /** 触发价输入框文本 */
  triggerText: string;
  /** 触发后下的单:市价或限价 */
  then: OrderType;
  /** 限价输入框文本(then = LIMIT 时用) */
  limitText: string;
  qtyText: string;
  /** 滑杆 0..100:买按可用现金在参考价下能买的数量、卖按可用持仓 */
  pct: number;
  lastEdited: "qty" | "pct";
  /** 最新成交价未知时用户选的方向;最新价已知时不用 */
  direction: TriggerDirection | null;
};

export const INITIAL_COND_DRAFT: CondDraft = Object.freeze({ triggerText: "", then: "MARKET", limitText: "", qtyText: "", pct: 0, lastEdited: "qty", direction: null });

/** 核对时交给确认框的东西:可直接提交的字段、预估合计、核对那一刻的最新成交价 */
export type TriggerReview = { fields: OrderTriggerFields; estNotional: number | null; lastPrice: number | null };

/** 输入框文本 → 正整数分;空、非法、≤ 0 为 null */
export function priceOf(text: string): number | null {
  const p = parseCents(text);
  return p !== null && Number.isSafeInteger(p) && p > 0 ? p : null;
}

/** 参考价:限价单取限价,市价单取触发价 */
export const condRefPrice = (d: CondDraft): number | null => priceOf(d.then === "LIMIT" ? d.limitText : d.triggerText);

const ratioPct = (part: number | null, whole: number): number => (part !== null && whole > 0 && part > 0 ? Math.min(100, Math.floor((part * 100) / whole)) : 0);

export type CondView = { qtyText: string; pct: number; estNotional: number | null };

/** 数量 / 滑杆 / 预估合计:按 lastEdited 派生(渲染期调用;可用资源或参考价变了,下一次渲染自然跟着变) */
export function condView(d: CondDraft, side: Side, avail: DraftAvail, qtyStep: number): CondView {
  const ref = condRefPrice(d);
  if (d.lastEdited === "pct") {
    const qty = d.pct > 0 ? qtyFromPercent(d.pct, side, avail, ref, qtyStep) : null;
    return { qtyText: qty === null ? "" : String(qty), pct: d.pct, estNotional: qty !== null && ref !== null ? amountFromQty(qty, ref) : null };
  }
  const qty = parseQty(d.qtyText);
  const est = qty !== null && Number.isSafeInteger(qty) && ref !== null ? amountFromQty(qty, ref) : null;
  return { qtyText: d.qtyText, pct: side === "SELL" ? ratioPct(qty !== null && Number.isSafeInteger(qty) ? qty : null, avail.qty) : ratioPct(est, avail.cashCents), estNotional: est };
}

/** 草稿 → validateTriggerDraft 的输入(空框 null,垃圾 NaN);qtyText 用派生后的数量 */
export function condTriggerDraft(d: CondDraft, side: Side, qtyText: string): TriggerDraft {
  return {
    side,
    orderType: d.then,
    triggerPrice: parseCents(d.triggerText),
    limitPrice: d.then === "LIMIT" ? parseCents(d.limitText) : null,
    quantity: parseQty(qtyText),
    direction: d.direction,
  };
}

/** 校验失败的文案(terminal.triggers.errors 的键 = TriggerDraftError):带参数的三条按标的精度填,tickText 是格式化好的 tick */
export function triggerErrorText(errors: Messages["terminal"]["triggers"]["errors"], reason: TriggerDraftError, info: Pick<DraftInstrumentInfo, "minQty" | "qtyStep">, tickText: string): string {
  switch (reason) {
    case "offTick":
      return errors.offTick(tickText);
    case "belowMinQty":
      return errors.belowMinQty(info.minQty);
    case "offStep":
      return errors.offStep(info.qtyStep);
    default:
      return errors[reason];
  }
}

/** 条件单 / 止盈止损 / 价格提醒提交失败时给用户看的:已本地化的说明;uncertain = 结果未确认(可原样重试,先去条件单页签核对);loginHref = 401 的登录入口 */
export type SubmitFailure = { message: string; uncertain: boolean; loginHref: string | null };

/** TriggerSubmitError → terminal.triggers.submitErrors;429 带了秒数时用 toast.rateLimited;断网与 5xx 都算结果未确认(同一个幂等键,重试安全) */
export function submitFailure(res: Pick<TriggerSubmitFailure, "code" | "retryAfter">, text: Messages["terminal"], loginHref: string): SubmitFailure {
  return {
    message: res.code === "rateLimited" && res.retryAfter !== null ? text.toast.rateLimited(res.retryAfter) : text.triggers.submitErrors[res.code],
    uncertain: res.code === "uncertain" || res.code === "network",
    loginHref: res.code === "unauthorized" ? loginHref : null,
  };
}

// ------------------------------------------------------------------ 票据状态(reducer;useConditionalTicket 接进 OrderPanel)

export type CondTicketState = {
  /** 当前画的是不是条件单票据(否则是限价 / 市价) */
  active: boolean;
  draft: CondDraft;
  /** 点过「核对订单」:之后校验结果随输入与最新价实时显示 */
  attempted: boolean;
  /** 打开着的确认单;null = 确认框关着 */
  review: TriggerReview | null;
  /** 已经看过的草稿种子 nonce:只有新的盘口点价才把票据切回限价 */
  seedNonce: number;
};

export type CondTicketAction =
  | { kind: "enter" }
  /** 限价 / 市价按钮、l / m 快捷键:切回那种票据(草稿留着,再切回来还在) */
  | { kind: "leave" }
  | { kind: "edit"; patch: Partial<CondDraft> }
  | { kind: "pct"; pct: number }
  /** 点了「核对订单」(校验没通过时只记这一下,之后实时显示错误) */
  | { kind: "attempt" }
  /** 校验通过:打开确认框 */
  | { kind: "review"; review: TriggerReview }
  /** 关掉确认框(取消 / Esc / 在途时要关、结果出来后改在面板里显示) */
  | { kind: "close" }
  /** 提交成功:关确认框,数量与滑杆清空,「核对过」清掉;触发价、触发后的单、委托价与方向留着(同下单成功后的 reset) */
  | { kind: "placed" }
  /** 新的草稿种子(store.draft):带价格的盘口点价按原约定是一张限价单,正在条件单票据上就切回限价;只带方向的种子不切 */
  | { kind: "seed"; nonce: number; symbol: string; price: number | null | undefined; currentSymbol: string };

export const initialCondTicket = (seedNonce: number): CondTicketState => ({ active: false, draft: INITIAL_COND_DRAFT, attempted: false, review: null, seedNonce });

const clampPct = (pct: number): number => (Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : 0);

/** 条件单票据的 reducer(纯函数,trigger-ticket.test.ts 直接测);无变化时返回同一引用 */
export function reduceCondTicket(s: CondTicketState, a: CondTicketAction): CondTicketState {
  switch (a.kind) {
    case "enter":
      return s.active ? s : { ...s, active: true, attempted: false };
    case "leave":
      return s.active ? { ...s, active: false, attempted: false, review: null } : s;
    case "edit":
      return { ...s, draft: { ...s.draft, ...a.patch } };
    case "pct":
      return { ...s, draft: { ...s.draft, pct: clampPct(a.pct), lastEdited: "pct" } };
    case "attempt":
      return s.attempted ? s : { ...s, attempted: true };
    case "review":
      return { ...s, attempted: true, review: a.review };
    case "close":
      return s.review ? { ...s, review: null } : s;
    case "placed":
      return { ...s, review: null, attempted: false, draft: { ...s.draft, qtyText: "", pct: 0, lastEdited: "qty" } };
    case "seed": {
      if (a.nonce === s.seedNonce) return s;
      const priced = a.price != null && Number.isFinite(a.price) && a.price > 0;
      if (s.active && priced && a.symbol === a.currentSymbol) return { ...s, seedNonce: a.nonce, active: false, attempted: false, review: null };
      return { ...s, seedNonce: a.nonce };
    }
  }
}
