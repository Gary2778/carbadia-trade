// 下单算术纯函数(计划 §3.5、§4.4):价格取整到 tick、数量取整到 step、金额 ↔ 数量互算、仓位百分比、草稿校验。
// 单位:价格与金额整数分、数量整数吨。非法输入返回 null(算术)或 DraftError(校验),从不抛错。
import type { OrderTriggerFields, PlaceOrderRequest } from "./api-shapes";
import type { DraftError, Instrument, OrderType, Side, TriggerDirection, TriggerDraftError } from "./types";

/**
 * 交易输入护栏,与 src/lib/exchange/limits.ts 同值(shared 不得 import lib,order-math.test.ts 断言两边相等)。
 * 价格与单笔名义额上限保证所有 Int 金额字段与流水 delta 不溢出 32 位。
 */
export const MAX_PRICE_CENTS = 100_000_000; // $1,000,000 / 吨
export const MAX_NOTIONAL_CENTS = 1_000_000_000; // $10,000,000 / 单

/** 正整数步长才有效;其余按 1(tickSize / qtyStep 默认都是 1) */
export const stepOf = (n: number): number => (Number.isSafeInteger(n) && n > 0 ? n : 1);
export const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** 价格取整到 tick:BUY 向下、SELL 向上;结果必须 ≥ 1 tick,否则(含非有限输入)返回 null */
export function roundToTick(priceCents: number, tickSize: number, side: Side): number | null {
  if (!Number.isFinite(priceCents)) return null;
  const tick = stepOf(tickSize);
  const rounded = side === "BUY" ? Math.floor(priceCents / tick) * tick : Math.ceil(priceCents / tick) * tick;
  return rounded >= tick && Number.isSafeInteger(rounded) ? rounded : null;
}

/** 数量向下取整到 step;非有限或负数返回 null(0 合法,返回 0) */
export function roundToStep(qty: number, qtyStep: number): number | null {
  if (!Number.isFinite(qty) || qty < 0) return null;
  const step = stepOf(qtyStep);
  const rounded = Math.floor(qty / step) * step;
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/**
 * 金额能买多少吨:floor(amount / price) 再向下取整到 step。
 * price ≤ 0(除零)、金额为负 / 非有限、金额超 MAX_NOTIONAL_CENTS 返回 null;金额不足一步返回 0。
 */
export function qtyFromAmount(amountCents: number, priceCents: number, qtyStep: number): number | null {
  if (!Number.isFinite(amountCents) || amountCents < 0 || amountCents > MAX_NOTIONAL_CENTS) return null;
  if (!Number.isFinite(priceCents) || priceCents <= 0) return null;
  return roundToStep(Math.floor(amountCents / priceCents), qtyStep);
}

/** 数量 × 价格 = 金额(分);非整数 / 负数 / 超 MAX_NOTIONAL_CENTS 返回 null */
export function amountFromQty(qty: number, priceCents: number): number | null {
  if (!isInt(qty) || qty < 0 || !isInt(priceCents) || priceCents <= 0) return null;
  const amount = qty * priceCents;
  return Number.isSafeInteger(amount) && amount <= MAX_NOTIONAL_CENTS ? amount : null;
}

/** 仓位滑杆的可用资源:cashCents = 可用现金(分),qty = 可用持仓(吨) */
export type DraftAvailBase = { cashCents: number; qty: number };

/**
 * 仓位百分比 → 数量:BUY 按可用现金 × pct% 在 priceCents 下能买的吨数(金额先钳到 MAX_NOTIONAL_CENTS,滑杆永远给出可下的数);
 * SELL 按可用持仓 × pct%。都向下取整到 step。pct 不在 0..100、BUY 无有效价格时返回 null。
 */
export function qtyFromPercent(pct: number, side: Side, avail: DraftAvailBase, priceCents: number | null, qtyStep: number): number | null {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (side === "SELL") {
    if (!Number.isFinite(avail.qty) || avail.qty < 0) return null;
    return roundToStep(Math.floor((avail.qty * pct) / 100), qtyStep);
  }
  if (priceCents == null || !Number.isFinite(priceCents) || priceCents <= 0) return null;
  if (!Number.isFinite(avail.cashCents) || avail.cashCents < 0) return null;
  const amount = Math.min(Math.floor((avail.cashCents * pct) / 100), MAX_NOTIONAL_CENTS);
  return qtyFromAmount(amount, priceCents, qtyStep);
}

/** 数量夹到合法区间:向下取整到 step;低于 minQty 时抬到 ≥ minQty 的最小 step 倍数。非法输入返回 null */
export function clampQty(qty: number, minQty: number, qtyStep: number): number | null {
  const rounded = roundToStep(qty, qtyStep);
  if (rounded == null) return null;
  const step = stepOf(qtyStep);
  const min = Number.isFinite(minQty) && minQty > 0 ? minQty : step;
  if (rounded >= min) return rounded;
  const lifted = Math.ceil(min / step) * step;
  return Number.isSafeInteger(lifted) ? lifted : null;
}

/** 下单草稿:输入框解析后的值,空框为 null;MARKET 的 price 忽略 */
export type OrderDraft = {
  side: Side;
  type: OrderType;
  price: number | null;
  quantity: number | null;
  clientOrderId?: string;
};

/** 校验用的可用资源与盘口顶档:bestBid / bestAsk 为 null 表示该侧没有挂单(市价单据此判 noLiquidity) */
export type DraftAvail = DraftAvailBase & { bestBid: number | null; bestAsk: number | null };

/** validateDraft 只用到 Instrument 的这几个字段,结构类型便于测试与部分数据调用 */
export type DraftInstrument = Pick<Instrument, "id" | "tickSize" | "qtyStep" | "minQty">;

export type DraftResult = { ok: true; order: PlaceOrderRequest } | { ok: false; reason: DraftError };

/**
 * 草稿校验,第一条不通过的规则即返回(顺序固定,便于 UI 只显示一条):
 * 1. LIMIT 价格:invalidPrice(空 / 非整数 / ≤ 0)→ overMaxPrice(> MAX_PRICE_CENTS)→ offTick(不是 tickSize 倍数)
 * 2. 数量:invalidQty(空 / 非整数 / ≤ 0)→ belowMinQty(< minQty)→ offStep(不是 qtyStep 倍数)
 * 3. LIMIT 名义额:overMaxNotional(price × qty > MAX_NOTIONAL_CENTS,与撮合引擎同一规则;MARKET 由引擎按现金封顶,不检查)
 * 4. MARKET 对手盘:noLiquidity(BUY 无卖一 / SELL 无买一)
 * 5. 资源:BUY LIMIT 需 price × qty ≤ 可用现金,BUY MARKET 需现金 ≥ 卖一价(至少买得起 1 吨)→ insufficientCash;
 *    SELL 需 qty ≤ 可用持仓 → insufficientQty
 * 通过时给出可直接 POST /api/orders 的 PlaceOrderRequest(MARKET 的 price 为 null)。
 */
export function validateDraft(draft: OrderDraft, instrument: DraftInstrument, avail: DraftAvail): DraftResult {
  const fail = (reason: DraftError): DraftResult => ({ ok: false, reason });
  const isLimit = draft.type === "LIMIT";
  const price = draft.price;

  if (isLimit) {
    if (!isInt(price) || price <= 0) return fail("invalidPrice");
    if (price > MAX_PRICE_CENTS) return fail("overMaxPrice");
    if (price % stepOf(instrument.tickSize) !== 0) return fail("offTick");
  }

  const qty = draft.quantity;
  if (!isInt(qty) || qty <= 0) return fail("invalidQty");
  if (qty < instrument.minQty) return fail("belowMinQty");
  if (qty % stepOf(instrument.qtyStep) !== 0) return fail("offStep");

  if (isLimit && price! * qty > MAX_NOTIONAL_CENTS) return fail("overMaxNotional");

  if (!isLimit) {
    const opposite = draft.side === "BUY" ? avail.bestAsk : avail.bestBid;
    if (opposite == null || opposite <= 0) return fail("noLiquidity");
  }

  if (draft.side === "BUY") {
    const need = isLimit ? price! * qty : avail.bestAsk!;
    if (!(avail.cashCents >= need)) return fail("insufficientCash");
  } else if (!(avail.qty >= qty)) {
    return fail("insufficientQty");
  }

  const order: PlaceOrderRequest = {
    assetId: instrument.id,
    side: draft.side,
    type: draft.type,
    price: isLimit ? price! : null,
    quantity: qty,
  };
  if (draft.clientOrderId) order.clientOrderId = draft.clientOrderId;
  return { ok: true, order };
}

// ---- 条件单 / 止盈止损 / 价格提醒的草稿校验(P3-06;计划 §6.3.2 C3 的创建校验,客户端先照同样的规则拦一道)----
// 价格 / 数量输入沿用 validateDraft 的约定:空框 null,垃圾输入 NaN(都算无效)。不检查现金与持仓(创建时不锁资金、不锁持仓,触发时才检查),
// 唯一的例外是止盈止损的数量不得超过持仓(服务端同样拒)。tick / step / min / max 与 validateDraft 同一组规则
// (服务端创建条件单时只查价格与数量的上下限和限价单的名义额,下单时也不查 tick / step / min:这三条和普通下单一样是客户端自己的规则,
// 目的是不让界面产生奇怪的价位 / 数量)。
// 只有两个对话框用的止盈止损 / 价格提醒校验在 ./trigger-drafts.ts(P3-07 复审:随懒加载的对话框走,不进下单面板的首屏包);
// 这里留下单面板要用的条件单校验,以及它们共用的几条规则(priceProblem / checkTrigger / failure 等,导出给那个文件)。

/** 最新价已知:正整数(null = 还没有成交过;服务端在最新价为空时放行任意方向) */
export const isLastPrice = (n: number | null): n is number => isInt(n) && n > 0;

/**
 * 触发价相对最新价的方向:高于最新价 → ABOVE(价格涨到触发价才触发),低于 → BELOW(跌到触发价)。
 * 返回 null 的情形:触发价等于最新价(创建即触发,validateTriggerDraft 判 wouldTriggerNow);触发价不是整数;
 * 最新价未知(null:该标的还没有成交过)—— 此时方向推不出来,由调用方让用户自己选(把选择交给 validateTriggerDraft 的 draft.direction,
 * 未选则返回 directionNeeded)。
 */
export function triggerDirection(triggerPrice: number, lastPrice: number | null): TriggerDirection | null {
  if (!isInt(triggerPrice) || !isLastPrice(lastPrice)) return null;
  return triggerPrice > lastPrice ? "ABOVE" : triggerPrice < lastPrice ? "BELOW" : null;
}

/** 错误归到哪个输入框(P3-07 据此设 aria-invalid、把文案放在框下);form = 不属于某一个框 */
export type TriggerDraftField = "triggerPrice" | "direction" | "limitPrice" | "quantity" | "takeProfit" | "stopLoss" | "form";
export type TriggerDraftFailure = { ok: false; reason: TriggerDraftError; field: TriggerDraftField };
export const failure = (reason: TriggerDraftError, field: TriggerDraftField): TriggerDraftFailure => ({ ok: false, reason, field });

/** 价格输入的三条通用规则:空 / 非整数 / ≤ 0 → invalid;> MAX_PRICE_CENTS → overMaxPrice;不是 tick 倍数 → offTick;通过为 null */
export function priceProblem(price: number | null, tickSize: number, invalid: TriggerDraftError): TriggerDraftError | null {
  if (!isInt(price) || price <= 0) return invalid;
  if (price > MAX_PRICE_CENTS) return "overMaxPrice";
  if (price % stepOf(tickSize) !== 0) return "offTick";
  return null;
}

/**
 * 触发价本身的校验与方向:价格三条规则 → 方向。最新价已知时方向由触发价与最新价的大小关系定(pick 被忽略),相等 → wouldTriggerNow;
 * 最新价未知时看 pick(用户选的 ABOVE / BELOW),没选 → directionNeeded。
 */
export function checkTrigger(triggerPrice: number | null, pick: TriggerDirection | null | undefined, tickSize: number, lastPrice: number | null): { ok: true; direction: TriggerDirection } | TriggerDraftFailure {
  const problem = priceProblem(triggerPrice, tickSize, "invalidTrigger");
  if (problem) return failure(problem, "triggerPrice");
  if (!isLastPrice(lastPrice)) return pick === "ABOVE" || pick === "BELOW" ? { ok: true, direction: pick } : failure("directionNeeded", "direction");
  const direction = triggerDirection(triggerPrice!, lastPrice);
  return direction ? { ok: true, direction } : failure("wouldTriggerNow", "triggerPrice");
}

/** 条件单草稿:triggerPrice / limitPrice / quantity 是输入框解析后的值;limitPrice 只在 orderType = LIMIT 时用;direction 只在最新价未知时用 */
export type TriggerDraft = {
  side: Side;
  orderType: OrderType;
  triggerPrice: number | null;
  limitPrice: number | null;
  quantity: number | null;
  direction?: TriggerDirection | null;
};
export type TriggerDraftResult = { ok: true; trigger: OrderTriggerFields } | TriggerDraftFailure;

/**
 * 条件单草稿校验,第一条不通过的规则即返回(顺序固定,界面只显示一条):
 * 1. 触发价:invalidTrigger → overMaxPrice → offTick,再定方向(wouldTriggerNow / directionNeeded,见 checkTrigger)
 * 2. LIMIT 的限价:invalidPrice → overMaxPrice → offTick(MARKET 忽略限价)
 * 3. 数量:invalidQty → belowMinQty → offStep
 * 4. LIMIT 名义额:overMaxNotional(限价 × 数量 > MAX_NOTIONAL_CENTS,服务端创建时同样查;MARKET 不查)
 * 通过时给出 submitOrderTrigger 的输入(MARKET 的 limitPrice 为 null)。不查现金 / 持仓。
 */
export function validateTriggerDraft(draft: TriggerDraft, instrument: DraftInstrument, lastPrice: number | null): TriggerDraftResult {
  const trigger = checkTrigger(draft.triggerPrice, draft.direction, instrument.tickSize, lastPrice);
  if (!trigger.ok) return trigger;
  const isLimit = draft.orderType === "LIMIT";
  if (isLimit) {
    const problem = priceProblem(draft.limitPrice, instrument.tickSize, "invalidPrice");
    if (problem) return failure(problem, "limitPrice");
  }
  const qty = draft.quantity;
  if (!isInt(qty) || qty <= 0) return failure("invalidQty", "quantity");
  if (qty < instrument.minQty) return failure("belowMinQty", "quantity");
  if (qty % stepOf(instrument.qtyStep) !== 0) return failure("offStep", "quantity");
  if (isLimit && draft.limitPrice! * qty > MAX_NOTIONAL_CENTS) return failure("overMaxNotional", "quantity");
  return {
    ok: true,
    trigger: {
      assetId: instrument.id,
      direction: trigger.direction,
      triggerPrice: draft.triggerPrice!,
      side: draft.side,
      orderType: draft.orderType,
      limitPrice: isLimit ? draft.limitPrice! : null,
      quantity: qty,
    },
  };
}
