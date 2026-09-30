// 下单提交(计划 §3.1 OrderPanel / OrderConfirmDialog):POST /api/orders、响应形状校验、成功后写进账户 store 的事件,
// 以及「结果未确认」的确认单登记簿。草稿本身的纯函数(Draft / reduceDraft / toReview)在 order-draft.ts,本文件管网络与 I/O。
//
// - submitOrder / verifyOrderResponse 沿用 SimpleTrade 的思路:HTTP 成功本身证明不了执行了什么,
//   形状对不上、断网、5xx 一律按「结果未确认」处理,引导用户先去看委托;
// - 结果未确认的确认单记在模块级登记簿里(不在组件 state / ref 里):下单表单换标的、手机页签来回切、离开 /trade 再回来都会重挂载,
//   重挂载之后以同样参数再核对,openReview 仍能沿用那张确认单的 clientOrderId(服务端按 userId + clientOrderId 幂等,不会下出第二单)。
//   整页刷新会清空登记簿(模块重新求值),这一步只能靠用户按提示先去委托记录核对。
//   登记只保留 UNSETTLED_TTL_MS:离那次「结果未确认」很久之后再下同样参数的单,多半是有意的新单,换新 id;
//   就算沿用了旧 id 被服务端重放(replayed: true),placedNotice 也会明说「没有下新单」,不当成新单报喜
//   (对话框里对「结果未确认」的重试被重放则是预期的完成,照常清空草稿,见 placedNotice)。
// - 面板对提交结果怎么处理(通知、清不清草稿、失败显示在哪里)也是这里的纯函数,OrderPanel 照做。
// 单位:价格与金额整数分,数量整数吨。
import type { DraftError, FeeSchedule, Fill, Order, OrderStatus, PlaceOrderResponse, ServerEvent } from "@/shared";
import { toReview, type Draft, type DraftCtx, type OrderReview } from "./order-draft";

export const ORDERS_URL = "/api/orders";
/** 委托记录页(全部状态):结果未确认时先去这里核对,避免重复下单 */
export const ORDERS_HISTORY_HREF = "/orders?status=ALL";

// ------------------------------------------------------------------ 结果未确认的确认单(模块级)

/** 登记簿上限:只防无界增长,正常使用远到不了 */
const MAX_UNSETTLED = 32;
/**
 * 登记的有效期(从最近一次提交这张确认单算起):覆盖「断网 → 关掉对话框 → 去委托记录核对 → 回来重下」这一轮;
 * 超过之后同样参数再核对换新 id。对话框里的「重试」直接用手上那张确认单,不经登记簿,不受它影响。
 */
export const UNSETTLED_TTL_MS = 10 * 60_000;
/** clientOrderId → 确认单与最近一次提交时刻;插入顺序即时间顺序 */
const unsettled = new Map<string, { review: OrderReview; at: number }>();

/** 提交前登记:结果出来之前它就是「未确认」的(请求可能已到服务端);同一张再提交会刷新时刻 */
export function markUnsettled(review: OrderReview, now: number = Date.now()): void {
  const id = review.request.clientOrderId;
  unsettled.delete(id);
  unsettled.set(id, { review, at: now });
  for (const oldest of unsettled.keys()) {
    if (unsettled.size <= MAX_UNSETTLED) break;
    unsettled.delete(oldest);
  }
}

/** 服务端确认了结果(ok,含重放):从登记簿移除,之后同样参数的新单换新 id */
export function settleReview(review: OrderReview): void {
  unsettled.delete(review.request.clientOrderId);
}

/** 当前仍在有效期内的未确认确认单(传给 toReview 的 opts.reuse:参数完全相同的那张沿用它的 clientOrderId);过期的顺手移除 */
export function unsettledReviews(now: number = Date.now()): OrderReview[] {
  for (const [id, entry] of unsettled) if (now - entry.at > UNSETTLED_TTL_MS) unsettled.delete(id);
  return [...unsettled.values()].map((entry) => entry.review);
}

/** 测试用:清空登记簿 */
export function clearUnsettledReviews(): void {
  unsettled.clear();
}

/**
 * 打开确认框(OrderPanel 的「核对订单」):toReview,登记簿里有同样参数、结果未确认的确认单时沿用它的 clientOrderId
 * (表单重挂载过也一样)。validateDraft 不通过返回 { error }。
 */
export function openReview(d: Draft, ctx: DraftCtx, fees: FeeSchedule, now: number = Date.now()): OrderReview | { error: DraftError } {
  return toReview(d, ctx, fees, { reuse: unsettledReviews(now) });
}

// ------------------------------------------------------------------ 信封请求

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export type PostOutcome =
  | { kind: "ok"; status: number; data: unknown }
  /** 结果未确认:断网(status 0)、5xx、2xx 但信封不是 { ok: true }。请求可能已经生效 */
  | { kind: "uncertain"; status: number }
  /**
   * 服务端明确拒绝(4xx):没有生效。message 是信封里的 error 原文(英文,不走 i18n,只供排查,界面不直接显示;
   * 界面按状态码取文案,见 rejectionReason);429 带 Retry-After 秒数。
   */
  | { kind: "rejected"; status: number; message: string | null; retryAfter: number | null };

export function retryAfterSeconds(header: string | null): number | null {
  if (header === null || header.trim() === "") return null;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

/**
 * POST 一个 JSON(或空)请求体,按 {ok,data}/{ok,error} 信封分三类结果;从不抛错。
 * 不经 @/lib/http/client 的 api():要读 429 的 Retry-After 头,还要把断网 / 5xx 与 4xx 分开。fetchImpl 可注入(测试)。
 */
export async function postEnvelope(url: string, body: unknown, fetchImpl: typeof fetch = fetch): Promise<PostOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    return { kind: "uncertain", status: 0 };
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // 响应体读不出:按状态码判断
  }
  const envelope = isRecord(parsed) ? parsed : null;
  if (res.ok) return envelope?.ok === true ? { kind: "ok", status: res.status, data: envelope.data } : { kind: "uncertain", status: res.status };
  if (res.status < 400 || res.status >= 500) return { kind: "uncertain", status: res.status };
  const message = typeof envelope?.error === "string" && envelope.error ? envelope.error : null;
  return { kind: "rejected", status: res.status, message, retryAfter: retryAfterSeconds(res.headers.get("Retry-After")) };
}

/** 明确被拒时界面取哪条文案:429 → toast.rateLimited(秒数);401 → toast.loginRequired + 登录入口;400 → 按最新可用资源重新校验(order.errors),校验通过则 ui.error;其余 → ui.error */
export type RejectionReason = { kind: "rateLimited"; retryAfter: number } | { kind: "loginRequired" } | { kind: "invalid" } | { kind: "other" };

export function rejectionReason(outcome: { status: number; retryAfter: number | null }): RejectionReason {
  if (outcome.status === 429 && outcome.retryAfter !== null) return { kind: "rateLimited", retryAfter: outcome.retryAfter };
  if (outcome.status === 401) return { kind: "loginRequired" };
  if (outcome.status === 400) return { kind: "invalid" };
  return { kind: "other" };
}

// ------------------------------------------------------------------ 下单与响应校验

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const ORDER_STATUSES: readonly OrderStatus[] = ["OPEN", "PARTIAL", "FILLED", "CANCELLED"];

/**
 * POST /api/orders 的 data 是否就是这张确认单的结果(不符 → null,调用方按「结果未确认」处理):
 * 同一 clientOrderId、同一标的 / 方向 / 类型 / 数量(限价同价),成交量 0..数量且与订单的 filledQuantity 一致,
 * 成交额是非负整数且「有成交 ⇔ 成交额 > 0」,状态与成交量相符 —— 全部成交 FILLED;市价未成交完的余量撤销(CANCELLED);
 * 限价未成交完挂在簿上(OPEN / PARTIAL),只有重放(之前那次已下单、之后被撤)才可能是 CANCELLED。
 */
export function verifyOrderResponse(review: OrderReview, data: unknown): PlaceOrderResponse | null {
  if (!isRecord(data) || !isRecord(data.order) || !Array.isArray(data.fills) || typeof data.replayed !== "boolean") return null;
  const req = review.request;
  const order = data.order;
  const { filledQty, filledCost } = data;
  if (typeof order.id !== "string" || order.id === "") return null;
  if (order.clientOrderId !== req.clientOrderId || order.assetId !== req.assetId) return null;
  if (order.side !== req.side || order.type !== req.type || order.quantity !== req.quantity) return null;
  if (req.type === "LIMIT" && order.price !== req.price) return null;
  if (!isCount(filledQty) || filledQty > req.quantity || order.filledQuantity !== filledQty) return null;
  if (!isCount(filledCost) || (filledQty === 0) !== (filledCost === 0)) return null;
  const status = order.status as OrderStatus;
  if (!ORDER_STATUSES.includes(status)) return null;
  const full = filledQty === req.quantity;
  if (full ? status !== "FILLED" : status === "FILLED") return null;
  if (!full) {
    if (req.type === "MARKET" && status !== "CANCELLED") return null;
    if (req.type === "LIMIT") {
      const resting: OrderStatus = filledQty === 0 ? "OPEN" : "PARTIAL";
      if (status !== resting && !(data.replayed && status === "CANCELLED")) return null;
    }
  }
  return data as unknown as PlaceOrderResponse;
}

export type SubmitOutcome =
  | { kind: "ok"; data: PlaceOrderResponse }
  /** 结果未确认:断网(status 0)、5xx、2xx 但信封 / 形状对不上。可能已经下单 —— 引导去看委托;用同一 clientOrderId 重试是安全的 */
  | { kind: "uncertain"; status: number }
  /** 服务端明确拒绝(4xx):没有下单 */
  | Extract<PostOutcome, { kind: "rejected" }>;

/** 提交一张确认单:postEnvelope + verifyOrderResponse。从不抛错,结果三分:ok(形状校验通过)/ uncertain / rejected */
export async function submitOrder(review: OrderReview, fetchImpl: typeof fetch = fetch): Promise<SubmitOutcome> {
  const outcome = await postEnvelope(ORDERS_URL, review.request, fetchImpl);
  if (outcome.kind !== "ok") return outcome;
  const data = verifyOrderResponse(review, outcome.data);
  return data ? { kind: "ok", data } : { kind: "uncertain", status: outcome.status };
}

/**
 * OrderPanel 的「确认」:提交一张确认单并维护登记簿 —— 提交前登记(请求可能到了服务端而响应丢了,之后同样参数再核对要沿用这个 id),
 * 服务端确认了结果(ok,含重放)才移除;结果未确认、明确被拒都留着(之前若有过一次结果未确认,重试仍要沿用同一个 id;
 * 没有过也无害 —— 服务端没有这个 id 的单,复用它就是一张新单)。
 */
export async function submitReview(review: OrderReview, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<SubmitOutcome> {
  markUnsettled(review, now);
  const outcome = await submitOrder(review, fetchImpl);
  if (outcome.kind === "ok") settleReview(review);
  return outcome;
}

/**
 * 下单成功后 toast 的状态后缀:
 * filled 全部成交;partialResting 限价部分成交、余量挂着(toast.orderPartial);partialCancelled 市价部分成交、余量撤销(order.partial);
 * cancelled 一吨没成交就撤了(市价空吃 / 重放到已撤的限价单,toast.orderCancelled,warning);resting 限价整单挂着(order.resting)。
 */
export type PlacedState = "filled" | "partialResting" | "partialCancelled" | "cancelled" | "resting";

export function placedState(data: Pick<PlaceOrderResponse, "order" | "filledQty">): PlacedState {
  switch (data.order.status) {
    case "FILLED":
      return "filled";
    case "PARTIAL":
      return "partialResting";
    case "CANCELLED":
      return data.filledQty > 0 ? "partialCancelled" : "cancelled";
    case "OPEN":
      return "resting";
  }
}

// ------------------------------------------------------------------ 面板怎么处理提交结果(纯函数,OrderPanel 照做)

/**
 * 服务端确认了结果(ok)之后的通知。replayed = 服务端按 clientOrderId 找到了之前那张单,**这次没有下新单**(文案 toast.orderReplayed,
 * 不说「已提交」)。重放分两种,按 opts.retryOfUncertain(这次确认是不是对话框里对「结果未确认」那一次的「重试」)区分:
 * - 重试:用户要下的那张单确实已经在了 —— 这就是预期的完成,与新单同样处理:ok(一吨没成交就撤了用 warning)、清空草稿;
 * - 否则是登记簿沿用了未确认那张的 id,而用户其实是在有意再下一张同样的单(关掉对话框后重新核对)—— warning、草稿不清空
 *   (登记已移除,用户要是确实想再下一张,再核对一次就是新 id 的新单),并给「去委托记录」动作;
 * - 不是重放:新单,ok(一吨没成交就撤了用 warning),清空数量 / 金额 / 滑杆。
 * selfTradeCancelled:自成交防护(计划 §9.1 第 41 条,EXPIRE_MAKER)下单前撤掉的本人挂单条数;缺省、0、非法值都按 0(不另外提示)。
 */
export type PlacedNotice = {
  replayed: boolean;
  state: PlacedState;
  tone: "ok" | "warning";
  resetDraft: boolean;
  /** 给「去委托记录」动作:只有有意再下同样的单却被重放时 */
  showOrdersAction: boolean;
  /** > 0 时另弹一条 info:toast.selfTradeCancelled(count) */
  selfTradeCancelled: number;
};

export type PlacedNoticeOptions = {
  /** 这次确认是对话框里对「结果未确认」那一次的重试(同一张确认单、同一 clientOrderId) */
  retryOfUncertain?: boolean;
};

const selfTradeCount = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);

export function placedNotice(
  data: Pick<PlaceOrderResponse, "order" | "filledQty" | "replayed" | "selfTradeCancelled">,
  opts: PlacedNoticeOptions = {},
): PlacedNotice {
  const state = placedState(data);
  const selfTradeCancelled = selfTradeCount(data.selfTradeCancelled);
  const tone = state === "cancelled" ? "warning" : "ok";
  if (data.replayed && !opts.retryOfUncertain) return { replayed: true, state, tone: "warning", resetDraft: false, showOrdersAction: true, selfTradeCancelled };
  return { replayed: data.replayed, state, tone, resetDraft: true, showOrdersAction: false, selfTradeCancelled };
}

/**
 * 没成功(结果未确认 / 被拒)的提交结果告诉用户的地方:
 * - 表单已卸载(提交在途时换了标的、手机切了页签 —— Chromium 的 close watcher 可能已先把原生 <dialog> 关了)→ toast(面板 state 没人看了);
 * - 提交在途时用户要关对话框 → 关掉,结果显示在面板里;
 * - 否则留在对话框里。
 */
export type FailureSurface = "dialog" | "panel" | "toast";

export function failureSurface({ mounted, dismissed }: { mounted: boolean; dismissed: boolean }): FailureSurface {
  if (!mounted) return "toast";
  return dismissed ? "panel" : "dialog";
}

/**
 * 关掉确认框(取消 / Esc / 关闭按钮)之后面板上还留什么:结果未确认的提示(去委托记录核对)留着 —— 那张单仍悬而未决,
 * 直到下一次核对或成功才清;其它失败(被拒)随对话框一起清掉。
 */
export function failureAfterClose<F extends { uncertain: boolean }>(failure: F | null): F | null {
  return failure?.uncertain ? failure : null;
}

// ------------------------------------------------------------------ 写进账户 store 的事件

type AccountOrderEvent = Extract<ServerEvent, { t: "order" }>;
type AccountFillEvent = Extract<ServerEvent, { t: "fill" }>;

/** 账户 store 里已知的状态(useAccountStore.getState() 结构上满足) */
export type KnownAccountState = { openOrders: ReadonlyMap<string, Order>; recentFills: readonly Fill[] };

/**
 * 这张 POST 响应里的订单是否已被 account 推送超过(应跳过它的 order 事件,否则会把推送刚更新 / 移出的单以旧状态写回):
 * - 挂单里已有它,且推送来的版本成交更多或更新得更晚;
 * - 挂单里没有它、响应里它还挂着(OPEN / PARTIAL),而 recentFills 里已有它的、不属于本次响应的成交 —— 推送已经送来后续成交
 *   并把它作为 FILLED 移出了挂单。
 * 残留窗口:推送在响应之前就把它撤掉(没有后续成交)时看不出来,由下一次快照 / resync 修正;这要求在拿到订单 id 之前就撤单,实际几乎不会发生。
 */
function supersededByPush(order: Order, ownFills: readonly Fill[], known: KnownAccountState): boolean {
  const existing = known.openOrders.get(order.id);
  if (existing) return existing.filledQuantity > order.filledQuantity || existing.updatedAt > order.updatedAt;
  if (order.status !== "OPEN" && order.status !== "PARTIAL") return false;
  const own = new Set(ownFills.map((f) => f.id));
  return known.recentFills.some((f) => f.orderId === order.id && !own.has(f.id));
}

/**
 * 下单成功后立即写进账户 store 的事件(一次 applyAccountEvents、一次 set()):订单本身 + 本次成交;
 * 余额与持仓等 account topic / 轮询补上。seq 0:账户 store 不看 seq,与轮询翻译层同一口径。
 * 传入 known(账户 store 的当前状态)时,已被推送超过的订单只写成交、不写订单(见 supersededByPush)。
 */
export function accountEventsOf(data: Pick<PlaceOrderResponse, "order" | "fills">, known?: KnownAccountState): (AccountOrderEvent | AccountFillEvent)[] {
  const order: Order = data.order;
  const fills: Fill[] = data.fills;
  const fillEvents = fills.map((fill): AccountFillEvent => ({ t: "fill", topic: "account", seq: 0, fill }));
  if (known && supersededByPush(order, fills, known)) return fillEvents;
  return [{ t: "order", topic: "account", seq: 0, order }, ...fillEvents];
}
