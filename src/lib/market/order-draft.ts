// 下单草稿(计划 §3.6、§3.1 OrderPanel):OrderPanel 的本地 reducer state 与它用到的纯函数(无网络、无 I/O)。
//
// - 草稿存的是输入框文本(priceText / qtyText / amountText)与滑杆百分比;lastEdited 记住用户最后动的是哪一个,
//   其余两个由它派生(互算走 src/shared/order-math;市价单按对手盘逐档走 estimateMarketOrder / estimateMarketByAmount,
//   市价卖单按金额换数量走本文件的 sellQtyForProceeds —— 买盘价降序,见该函数)。
// - 可用资源 / 顶档 / 标的精度变了,面板派发 refresh:按 lastEdited 重算派生项,无变化返回同一引用。
// - reduceDraft 是纯函数:上下文 ctx(标的精度、可用资源、盘口顶档与逐档)由调用方在事件发生时取好传入(draftCtxOf),
//   这样盘口跳动不会让下单面板重渲染:面板不在渲染期订阅盘口,顶档变化经 store.subscribe → bookTopWatcher →
//   refreshChanges,派生项会变才派发 refresh(计划 §7.1、§9.1 第 45 条)。
// - toReview 走 validateDraft,通过时给出可直接 POST /api/orders 的请求(带 clientOrderId)与名义额 / 手续费 / 均价预估;
//   结果未确认的确认单(opts.reuse)里有参数完全相同的,沿用它的 clientOrderId(断网重试不会下出第二单,服务端按 userId + clientOrderId 幂等)。
// - shouldConsumeSeed:草稿种子按 nonce 只消费一次、只认当前标的(OrderPanel 的门)。
// - 提交、响应形状校验与「结果未确认」登记簿在 order-submit.ts。
// 单位:价格与金额整数分,数量整数吨。
import type { DraftError, FeeSchedule, Instrument, OrderBookLevel, OrderType, PlaceOrderRequest, Side } from "@/shared";
import { estimateFee } from "@/shared/fees";
import { MAX_NOTIONAL_CENTS, amountFromQty, qtyFromAmount, qtyFromPercent, roundToStep, validateDraft, type OrderDraft } from "@/shared/order-math";
import { formatPrice } from "@/shared/precision";
import { estimateMarketByAmount, estimateMarketOrder } from "@/lib/exchange/trade-estimate";
import type { DraftSeed } from "./store";

/** DraftError 联合的全部字面量(运行时列表):terminal.order.errors 的键必须与它一致(order-draft.test.ts 断言) */
export const DRAFT_ERRORS = [
  "invalidPrice",
  "invalidQty",
  "belowMinQty",
  "offTick",
  "offStep",
  "insufficientCash",
  "insufficientQty",
  "noLiquidity",
  "overMaxNotional",
  "overMaxPrice",
] as const satisfies readonly DraftError[];

/** 滑杆刻度(计划 §3.1 PositionSlider) */
export const PCT_MARKS = [0, 25, 50, 75, 100] as const;

export type DraftField = "qty" | "amount" | "pct";

export type Draft = {
  side: Side;
  type: OrderType;
  /** 价格(元)输入框文本;MARKET 时忽略 */
  priceText: string;
  /** 数量(吨)输入框文本 */
  qtyText: string;
  /** 金额(元)输入框文本 */
  amountText: string;
  /** 仓位百分比 0..100(整数):买按可用现金、卖按可用持仓 */
  pct: number;
  /** 用户最后编辑的那一项;另外两项由它派生 */
  lastEdited: DraftField;
  /**
   * 面板的「预估合计」(分,派生值,与确认框同一口径):限价 = 价 × 量;市价 = 按当前数量沿对手盘走档的金额。
   * 市价按金额(预算)输入时,数量向下取整到 qtyStep,这里是那个数量真实要花的钱,不是金额框里的预算。算不出为 null。
   */
  estNotional: number | null;
};

export type DraftAction =
  | { kind: "setSide"; side: Side }
  | { kind: "setType"; orderType: OrderType }
  | { kind: "setPrice"; text: string }
  | { kind: "setQty"; text: string }
  | { kind: "setAmount"; text: string }
  | { kind: "setPct"; pct: number }
  /** 盘口点价 / 手机底部买卖条 / 持仓 Sell 经 store.draft 注入的种子(调用方已核对 symbol 与 nonce) */
  | { kind: "applySeed"; seed: DraftSeed }
  /**
   * 上下文变了(可用现金 / 持仓到了或变了、顶档移动、标的精度到了):按 lastEdited 重算金额 / 数量 / 滑杆 / 预估合计,
   * 不填价格、不改用户输入的那一项;无变化返回同一引用(面板的 effect 每次依赖变化都派发,不引起多余渲染)
   */
  | { kind: "refresh" }
  /** 下单成功后清空数量 / 金额 / 滑杆;方向、类型、价格保留(连续下同价单不用重填) */
  | { kind: "reset" };

/** 草稿只用到标的的这几个字段;完整 Instrument 结构上满足 */
export type DraftInstrumentInfo = Pick<Instrument, "id" | "symbol" | "tickSize" | "pricePrecision" | "qtyStep" | "minQty">;
export type DraftBookTop = { bestBid: number | null; bestAsk: number | null };
export type DraftAvail = { cashCents: number; qty: number };

/** 渲染期校验只需要这些(不需要逐档) */
export type DraftValidationCtx = {
  instrument: DraftInstrumentInfo;
  /** cashCents = 可用现金(Balance.cashBalance,不含已冻结);qty = 可用持仓(Position.available) */
  avail: DraftAvail;
  bookTop: DraftBookTop;
};

export type DraftCtx = DraftValidationCtx & {
  /** 卖盘,最优(价低)在前 */
  asks: OrderBookLevel[];
  /** 买盘,最优(价高)在前 */
  bids: OrderBookLevel[];
};

export function initialDraft(side: Side = "BUY"): Draft {
  return { side, type: "LIMIT", priceText: "", qtyText: "", amountText: "", pct: 0, lastEdited: "qty", estNotional: null };
}

// ------------------------------------------------------------------ 文本 ↔ 整数

/**
 * 金额 / 价格输入框文本 → 整数分:空串(含只有空白、千分位)为 null;不是非负十进制数、或超过两位小数(不是整数分)为 NaN
 * —— validateDraft 把 NaN 判成 invalidPrice / invalidQty,计算函数把它当作「无值」。
 */
export function parseCents(text: string): number | null {
  const s = text.replace(/[,\s]/g, "");
  if (s === "") return null;
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) return NaN;
  const frac = m[2] ?? "";
  if (/[1-9]/.test(frac.slice(2))) return NaN;
  const cents = Number(m[1] || "0") * 100 + Number(`${frac}00`.slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : NaN;
}

/** 数量输入框文本 → 整数吨:空串为 null;小数、负数、非数字为 NaN */
export function parseQty(text: string): number | null {
  const s = text.replace(/[,\s]/g, "");
  if (s === "") return null;
  if (!/^\d+$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : NaN;
}

/** 整数分 → 价格输入框文本:按标的精度(formatPrice,钳到 0..2),去掉千分位便于继续编辑 */
export const priceInputText = (cents: number, precision: number): string => formatPrice(cents, precision, "en-US").replace(/,/g, "");
/** 整数分 → 金额输入框文本:USD 两位小数、无千分位 */
export const amountInputText = (cents: number): string => formatPrice(cents, 2, "en-US").replace(/,/g, "");

const usable = (n: number | null): n is number => n !== null && Number.isFinite(n);

// ------------------------------------------------------------------ 派生计算

/** 限价单的有效价格(正整数分);空、非法、非整数分为 null */
function limitPrice(d: Draft): number | null {
  const p = parseCents(d.priceText);
  return usable(p) && p > 0 ? p : null;
}

/** 吃单方向的对手盘:买吃卖盘、卖吃买盘(最优在前) */
const levelsFor = (side: Side, ctx: Pick<DraftCtx, "asks" | "bids">): OrderBookLevel[] => (side === "BUY" ? ctx.asks : ctx.bids);

/** 限价单价格框为空时的参考价:买看卖一、卖看买一,一侧没有挂单用另一侧 */
function referencePrice(side: Side, top: DraftBookTop): number | null {
  return side === "BUY" ? (top.bestAsk ?? top.bestBid) : (top.bestBid ?? top.bestAsk);
}

/**
 * 用户动数量 / 金额 / 滑杆而限价单价格框还空着时,先用盘口参考价填上(互算需要价格);
 * 只在这三种动作里填 —— 用户自己清空价格框不会被立刻填回去。盘口两侧都空时保持空。
 */
function withDefaultPrice(d: Draft, ctx: DraftValidationCtx): Draft {
  if (d.type !== "LIMIT" || d.priceText.trim() !== "") return d;
  const ref = referencePrice(d.side, ctx.bookTop);
  return ref === null ? d : { ...d, priceText: priceInputText(ref, ctx.instrument.pricePrecision) };
}

/**
 * 数量 → 金额(分)。限价 = 价 × 量;市价 = 沿对手盘逐档累计(不按现金封顶:显示这笔量要花 / 能收多少,
 * 够不够由校验与确认框说;盘口吃不满时只累计吃得到的部分,确认框另有 partialFill 提示)。算不出为 null。
 */
function amountForQty(d: Draft, qty: number, ctx: DraftCtx): number | null {
  if (d.type === "LIMIT") {
    const price = limitPrice(d);
    return price === null ? null : amountFromQty(qty, price);
  }
  if (qty === 0) return 0;
  return estimateMarketOrder(levelsFor(d.side, ctx), qty)?.totalCents ?? null;
}

/**
 * 市价卖单按金额(想收到的钱,分)沿买盘(价高在前)逐档:每档卖 min(该档数量, floor(剩余金额 / 该档价)),
 * 该档没卖完就停 —— 市价单按价格优先逐档成交,下一吨仍落在这一档,不能跳去更低的档;该档卖完才看下一档。
 * 不用 estimateMarketByAmount:它为价升序的卖盘而写,「剩余 < 本档价」就停,在买盘上会在吃完的高价档之后早停
 * (买盘 [100 × 1, 40 × 5]、金额 150:它给 1 吨,正确是 2 吨 = 100 + 40 ≤ 150)。档位非法为 null;不向下取整到 qtyStep(调用方做)。
 */
export function sellQtyForProceeds(bids: readonly OrderBookLevel[], amountCents: number): number | null {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) return null;
  let remaining = amountCents;
  let quantity = 0;
  for (const level of bids) {
    if (!Number.isSafeInteger(level.price) || level.price <= 0 || !Number.isSafeInteger(level.quantity) || level.quantity < 0) return null;
    const take = Math.min(level.quantity, Math.floor(remaining / level.price));
    quantity += take;
    remaining -= take * level.price;
    if (take < level.quantity) break;
  }
  return quantity;
}

/**
 * 金额(分)→ 数量:限价 floor(金额 / 价) 向下取整到 qtyStep;市价买沿卖盘逐档能买到的整吨数(estimateMarketByAmount),
 * 市价卖沿买盘逐档、卖出所得不超过金额的整吨数(sellQtyForProceeds),都再向下取整到 qtyStep
 */
function qtyForAmount(d: Draft, amount: number, ctx: DraftCtx): number | null {
  const step = ctx.instrument.qtyStep;
  if (d.type === "LIMIT") {
    const price = limitPrice(d);
    return price === null ? null : qtyFromAmount(amount, price, step);
  }
  if (amount === 0) return 0;
  const qty = d.side === "SELL" ? sellQtyForProceeds(ctx.bids, amount) : (estimateMarketByAmount(ctx.asks, amount)?.quantity ?? null);
  return qty === null ? null : roundToStep(qty, step);
}

/** 百分比 → 数量:卖按可用持仓;限价买按可用现金在该价下能买的吨数;市价买按可用现金 × pct% 沿卖盘逐档能买到的吨数 */
function qtyForPct(d: Draft, pct: number, ctx: DraftCtx): number | null {
  const step = ctx.instrument.qtyStep;
  if (d.side === "SELL") return qtyFromPercent(pct, "SELL", ctx.avail, null, step);
  if (d.type === "LIMIT") return qtyFromPercent(pct, "BUY", ctx.avail, limitPrice(d), step);
  const cash = Number.isFinite(ctx.avail.cashCents) && ctx.avail.cashCents > 0 ? ctx.avail.cashCents : 0;
  return qtyForAmount(d, Math.min(Math.floor((cash * pct) / 100), MAX_NOTIONAL_CENTS), ctx);
}

/** part / whole 的百分比,向下取整、夹到 0..100;whole ≤ 0 为 0 */
const ratioPct = (part: number, whole: number): number => (whole > 0 && part > 0 ? Math.min(100, Math.floor((part * 100) / whole)) : 0);

/** 由数量(与金额)反推滑杆位置:买看金额占可用现金,卖看数量占可用持仓 */
function pctFor(d: Draft, qty: number, amount: number | null, ctx: DraftCtx): number {
  if (d.side === "SELL") return ratioPct(qty, ctx.avail.qty);
  return amount === null ? 0 : ratioPct(amount, ctx.avail.cashCents);
}

const clampPct = (pct: number): number => (Number.isFinite(pct) ? Math.min(100, Math.max(0, Math.round(pct))) : 0);

/** 按 lastEdited 重算另外两项与预估合计 */
function recompute(d: Draft, ctx: DraftCtx): Draft {
  switch (d.lastEdited) {
    case "qty": {
      const qty = parseQty(d.qtyText);
      if (!usable(qty)) return { ...d, amountText: "", pct: 0, estNotional: null };
      const amount = amountForQty(d, qty, ctx);
      return { ...d, amountText: amount === null ? "" : amountInputText(amount), pct: pctFor(d, qty, amount, ctx), estNotional: amount };
    }
    case "amount": {
      const amount = parseCents(d.amountText);
      if (!usable(amount)) return { ...d, qtyText: "", pct: 0, estNotional: null };
      const qty = qtyForAmount(d, amount, ctx);
      if (qty === null) return { ...d, qtyText: "", pct: 0, estNotional: null };
      // 金额框保持用户输入(预算);数量已向下取整到 qtyStep,预估合计按这个数量重算(限价 = 价 × 量,市价走档)
      return { ...d, qtyText: String(qty), pct: pctFor(d, qty, amount, ctx), estNotional: amountForQty(d, qty, ctx) };
    }
    case "pct": {
      if (d.pct <= 0) return { ...d, pct: 0, qtyText: "", amountText: "", estNotional: null };
      const qty = qtyForPct(d, d.pct, ctx);
      if (qty === null) return { ...d, qtyText: "", amountText: "", estNotional: null };
      const amount = amountForQty(d, qty, ctx);
      return { ...d, qtyText: String(qty), amountText: amount === null ? "" : amountInputText(amount), estNotional: amount };
    }
  }
}

/** 重算只会改这四项:它们都没变就是「无变化」(Object.is:NaN 与 NaN 视为相同) */
const sameDerived = (a: Draft, b: Draft): boolean =>
  a.qtyText === b.qtyText && a.amountText === b.amountText && a.pct === b.pct && Object.is(a.estNotional, b.estNotional);

/**
 * 草稿 reducer(纯函数)。互算规则:
 * - setQty / setAmount / setPct:记为 lastEdited,另外两项派生;限价价格框空着时先按盘口参考价填上;
 * - setPrice / setType:按 lastEdited 重算(改价时:上次动的是数量就重算金额,动的是金额就重算数量,动的是滑杆就按新价重算数量);
 * - setSide:数量保留、lastEdited 记为 qty,金额与仓位百分比按新方向重算(买看现金、卖看持仓;市价换一侧盘口走档);
 * - applySeed:有 side 按 setSide 处理;有 price 则切到限价并按标的精度填价(formatPrice);没有 price(undefined)就不碰价格与类型
 *   —— store 的 setDraft 每次整颗替换种子,只带 side 的种子不会带回上一次盘口点价的价格;symbol 不符时原样返回;
 * - refresh:上下文(可用资源、顶档、逐档、精度)变了,按 lastEdited 重算派生项;
 * - reset:清空数量 / 金额 / 滑杆,方向、类型、价格保留;
 * - estNotional(预估合计)随每次重算一起派生。
 * 无变化时返回同一引用。
 */
export function reduceDraft(d: Draft, action: DraftAction, ctx: DraftCtx): Draft {
  switch (action.kind) {
    case "setSide":
      return action.side === d.side ? d : recompute({ ...d, side: action.side, lastEdited: "qty" }, ctx);
    case "setType":
      return action.orderType === d.type ? d : recompute({ ...d, type: action.orderType }, ctx);
    case "setPrice":
      return action.text === d.priceText ? d : recompute({ ...d, priceText: action.text }, ctx);
    case "setQty":
      return recompute(withDefaultPrice({ ...d, qtyText: action.text, lastEdited: "qty" }, ctx), ctx);
    case "setAmount":
      return recompute(withDefaultPrice({ ...d, amountText: action.text, lastEdited: "amount" }, ctx), ctx);
    case "setPct":
      return recompute(withDefaultPrice({ ...d, pct: clampPct(action.pct), lastEdited: "pct" }, ctx), ctx);
    case "applySeed": {
      const { seed } = action;
      if (seed.symbol !== ctx.instrument.symbol) return d;
      let next = d;
      if (seed.side && seed.side !== next.side) next = { ...next, side: seed.side, lastEdited: "qty" };
      if (seed.price != null && Number.isFinite(seed.price) && seed.price > 0) {
        next = { ...next, type: "LIMIT", priceText: priceInputText(seed.price, ctx.instrument.pricePrecision) };
      }
      return next === d ? d : recompute(next, ctx);
    }
    case "refresh": {
      const next = recompute(d, ctx);
      return sameDerived(next, d) ? d : next;
    }
    case "reset":
      return { ...d, qtyText: "", amountText: "", pct: 0, lastEdited: "qty", estNotional: null };
  }
}

/**
 * 面板该不该消费这颗草稿种子(盘口点价 / 手机底部买卖条 / 持仓 Sell 经 store.draft 写入):
 * 只认比「已消费」更新的 nonce(每颗种子只用一次;面板重挂载不重放旧种子,面板晚于种子挂载时照样消费),
 * 且只认当前标的的种子(P1-13 交接)。store 的初始种子 nonce 0、symbol "",永远不消费。
 */
export function shouldConsumeSeed(seed: Pick<DraftSeed, "symbol" | "nonce">, symbol: string, consumedNonce: number): boolean {
  return seed.nonce > consumedNonce && seed.symbol === symbol;
}

// ------------------------------------------------------------------ 校验与确认单

/** 草稿 → order-math 的 OrderDraft(输入框解析后的值;空框 null,非法 NaN) */
function toOrderDraft(d: Draft): OrderDraft {
  return { side: d.side, type: d.type, price: d.type === "LIMIT" ? parseCents(d.priceText) : null, quantity: parseQty(d.qtyText) };
}

/** 渲染期用的校验:第一条不通过的规则(validateDraft 的固定顺序),通过为 null */
export function draftError(d: Draft, ctx: DraftValidationCtx): DraftError | null {
  const result = validateDraft(toOrderDraft(d), ctx.instrument, { ...ctx.avail, ...ctx.bookTop });
  return result.ok ? null : result.reason;
}

/**
 * 已提交的请求按最新的可用资源 / 顶档重新校验:服务端 400 拒单时(多半是确认框打开期间可用现金 / 持仓变了)
 * 把原因映射回 terminal.order.errors[DraftError];仍然通过为 null(调用方显示通用的 ui.error)。
 */
export function requestError(request: PlaceOrderRequest, ctx: DraftValidationCtx): DraftError | null {
  const draft: OrderDraft = { side: request.side, type: request.type, price: request.type === "LIMIT" ? (request.price ?? null) : null, quantity: request.quantity };
  const result = validateDraft(draft, ctx.instrument, { ...ctx.avail, ...ctx.bookTop });
  return result.ok ? null : result.reason;
}

/** 确认框的提示:市价单按当前盘口(买单再按可用现金封顶)估计吃不满全部数量,余量会被撤销 */
export type OrderWarning = "partialFill";

export type OrderReview = {
  request: PlaceOrderRequest & { clientOrderId: string };
  /** 预估名义额(分):限价 = 价 × 量;市价 = 按当前盘口逐档(买单按可用现金封顶)能成交部分的金额 */
  estNotional: number;
  /** 预估手续费(分):FeeSchedule 默认全零 → 0(显示 terminal.order.feeDemo) */
  estFee: number;
  /** 预估成交均价(分):限价取限价;市价 = 名义额 / 可成交量,一吨都吃不到为 null */
  estAvgPrice: number | null;
  warnings: OrderWarning[];
};

export type ReviewOptions = {
  /**
   * 结果未确认(断网 / 5xx / 响应对不上)的确认单(一张或多张,通常是 order-submit 的 unsettledReviews()):
   * 其中有与本次请求参数完全相同的,复用它的 clientOrderId
   */
  reuse?: OrderReview | readonly OrderReview[] | null;
  /** 生成 clientOrderId(测试注入);默认 crypto.randomUUID */
  newId?: () => string;
};

/** 同一笔订单的请求参数(不含 clientOrderId)是否一致 —— 与服务端 assertSameOrder 同一口径 */
function sameOrder(a: PlaceOrderRequest, b: PlaceOrderRequest): boolean {
  return a.assetId === b.assetId && a.side === b.side && a.type === b.type && (a.price ?? null) === (b.price ?? null) && a.quantity === b.quantity;
}

/** RFC 4122 v4 uuid:优先 crypto.randomUUID;非安全上下文(局域网 http)没有它时用 getRandomValues 拼 */
export function newClientOrderId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 手续费预估:限价可能是 maker 也可能是 taker,取两者较高的费率(预估取上界,不低估) */
export function estimateOrderFee(notionalCents: number, fees: FeeSchedule): number {
  return estimateFee(notionalCents, Math.max(fees.makerBps, fees.takerBps), fees.minFeeCents);
}

/**
 * 打开确认框时调用:validateDraft 不通过返回 { error };通过则给出带 clientOrderId 的请求与预估。
 * clientOrderId 在这里生成(= 打开确认框时);opts.reuse 里有与本次参数一致的确认单时沿用它的 id(结果未确认后的重试)。
 */
export function toReview(d: Draft, ctx: DraftCtx, fees: FeeSchedule, opts: ReviewOptions = {}): OrderReview | { error: DraftError } {
  const result = validateDraft(toOrderDraft(d), ctx.instrument, { ...ctx.avail, ...ctx.bookTop });
  if (!result.ok) return { error: result.reason };
  const order = result.order;
  const candidates: readonly OrderReview[] = opts.reuse == null ? [] : "request" in opts.reuse ? [opts.reuse] : opts.reuse;
  const reused = candidates.find((r) => sameOrder(r.request, order));
  const clientOrderId = reused ? reused.request.clientOrderId : (opts.newId ?? newClientOrderId)();
  const request = { ...order, clientOrderId };

  let estNotional: number;
  let estAvgPrice: number | null;
  const warnings: OrderWarning[] = [];
  if (order.type === "LIMIT") {
    estNotional = order.price! * order.quantity;
    estAvgPrice = order.price!;
  } else {
    const est = estimateMarketOrder(levelsFor(order.side, ctx), order.quantity, order.side === "BUY" ? ctx.avail.cashCents : null);
    const filled = est?.quantity ?? 0;
    estNotional = est?.totalCents ?? 0;
    estAvgPrice = filled > 0 ? Math.round(estNotional / filled) : null;
    if (filled < order.quantity) warnings.push("partialFill");
  }
  return { request, estNotional, estFee: estimateOrderFee(estNotional, fees), estAvgPrice, warnings };
}

// ------------------------------------------------------------------ 盘口逐档(事件时从 store 现取)

type BookMaps = { bids: ReadonlyMap<number, OrderBookLevel>; asks: ReadonlyMap<number, OrderBookLevel> };

/** store 的 BookState → 最优在前的两侧数组(卖盘价升序、买盘价降序);没有盘口为两个空数组 */
export function bookLevels(book: BookMaps | undefined): { asks: OrderBookLevel[]; bids: OrderBookLevel[] } {
  if (!book) return { asks: [], bids: [] };
  return {
    asks: [...book.asks.values()].sort((a, b) => a.price - b.price),
    bids: [...book.bids.values()].sort((a, b) => b.price - a.price),
  };
}

/**
 * 原始最优买卖价(聚合前):买盘最高价、卖盘最低价;没有盘口或该侧没有挂单为 null。
 * 「顶档」的唯一定义 —— selectors.ts 的 useBookTop(盘口面板的价差行)也调它,不另写一份。
 */
export function bookTopOf(book: BookMaps | undefined): DraftBookTop {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  if (book) {
    for (const price of book.bids.keys()) if (bestBid === null || price > bestBid) bestBid = price;
    for (const price of book.asks.keys()) if (bestAsk === null || price < bestAsk) bestAsk = price;
  }
  return { bestBid, bestAsk };
}

/** 市场 store 里校验用得到的那一片(结构类型:本文件对 store 只有类型引用,MarketState 在结构上满足) */
export type DraftBooksSlice = { books: Readonly<Record<string, BookMaps | undefined>> };

/**
 * 下单表单渲染期挂在市场 store 上的唯一一个读盘口的 selector(纯工厂,OrderPanel 把返回值交给 useMarketStore):
 * 只返回校验结果(DraftError | null,原始值)—— 顶档怎么动,结果不变就不重渲染。还没点过「核对订单」(attempted = false)恒为 null。
 * 校验里依赖顶档的只有市价单:对手盘空了 → noLiquidity,可用现金买不起卖一 → insufficientCash;限价草稿的结果与盘口无关。
 */
export function errorSelector(
  d: Draft,
  instrument: DraftInstrumentInfo,
  avail: DraftAvail,
  symbol: string,
  attempted: boolean,
): (state: DraftBooksSlice) => DraftError | null {
  return (state) => (attempted ? draftError(d, { instrument, avail, bookTop: bookTopOf(state.books[symbol]) }) : null);
}

/** 事件(或 store 订阅回调)发生时的完整上下文:顶档与逐档取自同一份盘口(store.books[symbol],没有为 undefined) */
export function draftCtxOf(instrument: DraftInstrumentInfo, avail: DraftAvail, book: BookMaps | undefined): DraftCtx {
  return { instrument, avail, bookTop: bookTopOf(book), ...bookLevels(book) };
}

// ------------------------------------------------------------------ 顶档变化 → 要不要重算(不经渲染)

/**
 * 顶档变化探测(闭包,不碰 React 与 store;OrderPanel 把它接在 store.subscribe 上):每次喂当前的盘口,
 * 最优买价或最优卖价与上一次不同才返回 true。同一个对象(store 在改别的标的 / 别的切片)与只改深度、数量、单数的更新都是 false
 * —— 市价单只在顶档变化时重新走档,与改动前订阅 useBookTop 时同一口径。
 */
export function bookTopWatcher(initial: BookMaps | undefined): (book: BookMaps | undefined) => boolean {
  let seen = initial;
  let top = bookTopOf(initial);
  return (book) => {
    if (book === seen) return false;
    seen = book;
    const next = bookTopOf(book);
    if (next.bestBid === top.bestBid && next.bestAsk === top.bestAsk) return false;
    top = next;
    return true;
  };
}

/**
 * 上下文(可用资源、标的精度、盘口)变了之后,草稿的派生项(数量 / 金额 / 滑杆 / 预估合计)会不会变 = 要不要派发 refresh。
 * 限价草稿与没填数量的市价草稿不随盘口变(false:面板不派发,也就不渲染);市价草稿填了数量 / 金额 / 滑杆、走档结果变了才是 true。
 */
export function refreshChanges(d: Draft, ctx: DraftCtx): boolean {
  return reduceDraft(d, { kind: "refresh" }, ctx) !== d;
}
