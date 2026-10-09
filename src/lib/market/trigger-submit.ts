// 条件单的提交(P3-06;计划 §6.3.2 C3):创建条件单 / 价格提醒 / 止盈止损(OCO)、撤销;P3-07 的界面按这里导出的名字接。
// 沿用 order-submit.ts 的做法:信封请求(postEnvelope / deleteEnvelope,从不抛错)、应答形状按请求核对、
// 成功后把返回的行写进账户 store(applyAccountEvents,seq 0:账户 store 不看 seq)。本文件不出任何用户可见的文案:
// 失败只给一个 TriggerSubmitError 字面量,界面按它取 i18n 文案(带 retryAfter 给 429 的秒数)。
//
// 幂等:服务端按 userId + clientKey 去重(同一 clientKey 同样参数重发返回既有行,参数不同 409)。键不由调用方管 —— 模块级登记簿
// 按「请求参数」记下尚未确认结果的键:断网 / 5xx / 应答对不上(请求可能已经生效)之后,用同样的参数再提交沿用同一个键,
// 服务端因此不会建出第二条;服务端确认了(ok)或明确拒绝了(4xx,什么都没建)就移除,之后同样参数的提交是有意的新条件单、换新键。
// 在途时又提交同样的参数(连点)同样沿用那个键。登记只保留 UNSETTLED_TTL_MS(同 order-submit):隔了很久再提交同样参数多半是有意的新单。
// 整页刷新会清空登记簿(模块重新求值),这一步只能靠用户先去条件单列表核对。
//
// 条件单事件可能先于它下出的委托的 order 事件到(P3-03):这里只管条件单行,不假设委托已经在 store 里。
// 单位:价格与金额整数分,数量整数吨。
import type { AlertFields, OcoFields, OrderTriggerFields, OrderType, Side, Trigger, TriggerDirection, TriggerKind, TriggerReason, TriggerStatus } from "@/shared";
import { TRIGGER_ERROR } from "@/shared/constants";
import { applyAccountEvents, type AccountEvent } from "./account-store";
import { newClientOrderId } from "./order-draft";
import { UNSETTLED_TTL_MS, deleteEnvelope, postEnvelope, type PostOutcome } from "./order-submit";

export const TRIGGERS_URL = "/api/account/triggers";
export const OCO_URL = "/api/account/triggers/oco";
const cancelUrl = (id: string): string => `${TRIGGERS_URL}/${encodeURIComponent(id)}`;

/**
 * 提交失败的原因(界面按它取文案;未知的服务端错误一律 invalid):
 * wouldTriggerNow = 触发价已被最新价穿过(创建就会触发);tooManyTriggers = 未完结的条件单与提醒已有 50 条;
 * insufficientQty = 止盈止损的数量超过持仓;triggersDisabled = 服务端暂时停用了条件单(TRIGGERS_DISABLED=1,创建答 503,什么都没建);
 * invalid = 其它被拒(参数不对、标的 / 条件单不存在或不是本人的、幂等键撞了不同参数……);
 * notCancellable = 撤销时它已经不是 PENDING(409:正在触发或已触发 / 已被撤 / 被拒);rateLimited = 429(retryAfter 秒后再来);
 * unauthorized = 401(会话失效);network = 断网(fetch 抛错);uncertain = 5xx,或 2xx 但应答与请求对不上 —— 请求可能已经生效,
 * 用同样的参数再提交是安全的(幂等键),也可以先去条件单列表看。
 */
export type TriggerSubmitError =
  | "wouldTriggerNow"
  | "tooManyTriggers"
  | "insufficientQty"
  | "triggersDisabled"
  | "invalid"
  | "notCancellable"
  | "rateLimited"
  | "unauthorized"
  | "network"
  | "uncertain";

export type TriggerSubmitFailure = { ok: false; code: TriggerSubmitError; /** 只有 rateLimited 且服务端给了 Retry-After 时非 null(秒) */ retryAfter: number | null };
export type SubmitTriggerResult = { ok: true; trigger: Trigger } | TriggerSubmitFailure;
export type SubmitOcoResult = { ok: true; triggers: Trigger[] } | TriggerSubmitFailure;
export type CancelTriggerResult = { ok: true; trigger: Trigger } | TriggerSubmitFailure;

// ------------------------------------------------------------------ 服务端错误 → TriggerSubmitError

/** 创建的 400 里信封 error 的错误码(与服务端共用 @/shared/constants 的 TRIGGER_ERROR) */
function creationRejection(message: string | null): TriggerSubmitError {
  if (message === TRIGGER_ERROR.wouldTriggerNow) return "wouldTriggerNow";
  if (message === TRIGGER_ERROR.tooManyTriggers) return "tooManyTriggers";
  if (message === TRIGGER_ERROR.overPosition) return "insufficientQty";
  return "invalid";
}

/** 创建的 503 triggersDisabled:明确的拒绝(什么都没建),不是「忙 / 结果未确认」 */
const isDisabled = (outcome: PostOutcome): boolean => outcome.kind === "uncertain" && outcome.status === 503 && outcome.message === TRIGGER_ERROR.triggersDisabled;

/**
 * 没成功的结果 → 失败。创建:409 = 同一 clientKey 配了不同参数(invalid),503 triggersDisabled → triggersDisabled;撤销:409 = 已经不是
 * PENDING(notCancellable),400 = 不存在或不是本人的(invalid,与撤委托同一个状态码)。其余 4xx 一律 invalid,断网 network,其余 5xx uncertain。
 */
function failureOf(outcome: Exclude<PostOutcome, { kind: "ok" }>, op: "create" | "cancel"): TriggerSubmitFailure {
  const fail = (code: TriggerSubmitError, retryAfter: number | null = null): TriggerSubmitFailure => ({ ok: false, code, retryAfter });
  if (op === "create" && isDisabled(outcome)) return fail("triggersDisabled");
  if (outcome.kind === "uncertain") return fail(outcome.status === 0 ? "network" : "uncertain");
  if (outcome.status === 401) return fail("unauthorized");
  if (outcome.status === 429) return fail("rateLimited", outcome.retryAfter);
  if (outcome.status === 409 && op === "cancel") return fail("notCancellable");
  if (outcome.status === 400 && op === "create") return fail(creationRejection(outcome.message));
  return fail("invalid");
}

// ------------------------------------------------------------------ 应答校验(不用 as:逐个字段收窄,重建一个 Trigger)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isPositiveInt = (v: unknown): v is number => isInt(v) && v > 0;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** 在允许的字面量里找 v;不是 → null(find 返回的就是联合类型里的那个值,不需要断言) */
function literal<T extends string>(allowed: readonly T[], v: unknown): T | null {
  return allowed.find((a) => a === v) ?? null;
}
const KINDS: readonly TriggerKind[] = ["ORDER", "ALERT"];
const DIRECTIONS: readonly TriggerDirection[] = ["ABOVE", "BELOW"];
const STATUSES: readonly TriggerStatus[] = ["PENDING", "TRIGGERING", "TRIGGERED", "REJECTED", "CANCELLED"];
const REASONS: readonly TriggerReason[] = ["USER", "OCO", "INSUFFICIENT_CASH", "INSUFFICIENT_QTY", "NO_FILL", "INVALID"];
const SIDES: readonly Side[] = ["BUY", "SELL"];
const ORDER_TYPES: readonly OrderType[] = ["LIMIT", "MARKET"];

/** 可空字段:null 通过(得 null),有值必须过 ok;都不是 → undefined(整行作废) */
function nullable<T>(v: unknown, read: (x: unknown) => T | null): T | null | undefined {
  if (v === null) return null;
  return read(v) ?? undefined;
}

/**
 * 应答里的一条 Trigger:每个字段都按类型核对,ORDER 必有 side / orderType / quantity,ALERT 这三个与 limitPrice 必为 null;
 * 对不上 → null。返回新对象(不借用响应里的对象,多出来的字段也不带进 store)。
 */
export function readTrigger(v: unknown): Trigger | null {
  if (!isRecord(v)) return null;
  const kind = literal(KINDS, v.kind);
  const direction = literal(DIRECTIONS, v.direction);
  const status = literal(STATUSES, v.status);
  const side = nullable(v.side, (x) => literal(SIDES, x));
  const orderType = nullable(v.orderType, (x) => literal(ORDER_TYPES, x));
  const reason = nullable(v.reason, (x) => literal(REASONS, x));
  const limitPrice = nullable(v.limitPrice, (x) => (isPositiveInt(x) ? x : null));
  const quantity = nullable(v.quantity, (x) => (isPositiveInt(x) ? x : null));
  const firedPrice = nullable(v.firedPrice, (x) => (isPositiveInt(x) ? x : null));
  const firedAt = nullable(v.firedAt, (x) => (isInt(x) && x >= 0 ? x : null));
  const ocoGroupId = nullable(v.ocoGroupId, (x) => (nonEmpty(x) ? x : null));
  const orderId = nullable(v.orderId, (x) => (nonEmpty(x) ? x : null));
  if (!kind || !direction || !status) return null;
  if (side === undefined || orderType === undefined || reason === undefined || limitPrice === undefined || quantity === undefined) return null;
  if (firedPrice === undefined || firedAt === undefined || ocoGroupId === undefined || orderId === undefined) return null;
  if (!nonEmpty(v.id) || !nonEmpty(v.assetId) || !nonEmpty(v.symbol) || !isPositiveInt(v.triggerPrice)) return null;
  if (!isInt(v.createdAt) || !isInt(v.updatedAt) || v.createdAt < 0 || v.updatedAt < 0) return null;
  if (kind === "ORDER" ? side === null || orderType === null || quantity === null : side !== null || orderType !== null || quantity !== null || limitPrice !== null) return null;
  return {
    id: v.id,
    kind,
    assetId: v.assetId,
    symbol: v.symbol,
    direction,
    triggerPrice: v.triggerPrice,
    side,
    orderType,
    limitPrice,
    quantity,
    ocoGroupId,
    status,
    reason,
    orderId,
    firedPrice,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    firedAt,
  };
}

/** 创建条件单的应答是不是这次请求建出来的那一条(重放同一个键返回既有行,状态可以已经往前走了,参数必须一致) */
const isOrderTriggerOf = (t: Trigger, f: OrderTriggerFields): boolean =>
  t.kind === "ORDER" &&
  t.assetId === f.assetId &&
  t.direction === f.direction &&
  t.triggerPrice === f.triggerPrice &&
  t.side === f.side &&
  t.orderType === f.orderType &&
  t.limitPrice === f.limitPrice &&
  t.quantity === f.quantity &&
  t.ocoGroupId === null;

const isAlertOf = (t: Trigger, f: AlertFields): boolean => t.kind === "ALERT" && t.assetId === f.assetId && t.direction === f.direction && t.triggerPrice === f.triggerPrice && t.ocoGroupId === null;

/** OCO 的一条腿:止盈 = ABOVE、止损 = BELOW,都是 SELL MARKET、同一数量 */
const isOcoLegOf = (t: Trigger, f: OcoFields, direction: TriggerDirection, price: number): boolean =>
  t.kind === "ORDER" &&
  t.assetId === f.assetId &&
  t.direction === direction &&
  t.triggerPrice === price &&
  t.side === "SELL" &&
  t.orderType === "MARKET" &&
  t.limitPrice === null &&
  t.quantity === f.quantity &&
  t.ocoGroupId !== null;

/** POST /api/account/triggers 的 data({ trigger })是不是这次请求的结果;不是 → null */
export function verifyTriggerResponse(data: unknown, matches: (t: Trigger) => boolean): Trigger | null {
  if (!isRecord(data)) return null;
  const trigger = readTrigger(data.trigger);
  return trigger && matches(trigger) ? trigger : null;
}

/** POST /api/account/triggers/oco 的 data({ triggers }):条数 = 给了几个价(止盈在前),每条对得上,同一个 ocoGroupId;不是 → null */
export function verifyOcoResponse(data: unknown, fields: OcoFields): Trigger[] | null {
  if (!isRecord(data) || !Array.isArray(data.triggers)) return null;
  const legs: { direction: TriggerDirection; price: number }[] = [];
  if (fields.takeProfit !== null) legs.push({ direction: "ABOVE", price: fields.takeProfit });
  if (fields.stopLoss !== null) legs.push({ direction: "BELOW", price: fields.stopLoss });
  if (legs.length === 0 || data.triggers.length !== legs.length) return null;
  const triggers: Trigger[] = [];
  for (const [i, raw] of data.triggers.entries()) {
    const trigger = readTrigger(raw);
    if (!trigger || !isOcoLegOf(trigger, fields, legs[i].direction, legs[i].price)) return null;
    triggers.push(trigger);
  }
  if (new Set(triggers.map((t) => t.ocoGroupId)).size !== 1) return null;
  return triggers;
}

/** DELETE 的 data({ trigger }):就是这一条,而且已经是 CANCELLED(只有撤成功才会 200) */
export function verifyCancelResponse(data: unknown, id: string): Trigger | null {
  return verifyTriggerResponse(data, (t) => t.id === id && t.status === "CANCELLED");
}

// ------------------------------------------------------------------ 结果未确认的幂等键(模块级)

/** 登记簿上限:只防无界增长,正常使用远到不了 */
const MAX_PENDING_KEYS = 32;
/** 请求参数的签名 → 尚未确认结果的 clientKey 与最近一次提交的时刻;插入顺序即时间顺序 */
const pendingKeys = new Map<string, { key: string; at: number }>();

/** 这组参数该用的 clientKey:登记簿里有(且没过期)就沿用,否则新生成;同时刷新登记。过期的顺手移除 */
function keyFor(signature: string, now: number): string {
  for (const [sig, entry] of pendingKeys) if (now - entry.at > UNSETTLED_TTL_MS) pendingKeys.delete(sig);
  const key = pendingKeys.get(signature)?.key ?? newClientOrderId();
  pendingKeys.delete(signature);
  pendingKeys.set(signature, { key, at: now });
  for (const oldest of pendingKeys.keys()) {
    if (pendingKeys.size <= MAX_PENDING_KEYS) break;
    pendingKeys.delete(oldest);
  }
  return key;
}

/** 测试用:清空登记簿 */
export function clearPendingTriggerKeys(): void {
  pendingKeys.clear();
}

const orderSignature = (f: OrderTriggerFields): string => JSON.stringify(["ORDER", f.assetId, f.direction, f.triggerPrice, f.side, f.orderType, f.limitPrice, f.quantity]);
const alertSignature = (f: AlertFields): string => JSON.stringify(["ALERT", f.assetId, f.direction, f.triggerPrice]);
const ocoSignature = (f: OcoFields): string => JSON.stringify(["OCO", f.assetId, f.quantity, f.takeProfit, f.stopLoss]);

/** 服务端有了确定的答复(ok、4xx 或 503 triggersDisabled:什么都没建)才把键放掉;断网 / 其余 5xx / 应答对不上留着,下一次同样参数的提交沿用 */
function settle(signature: string, outcome: PostOutcome, verified: boolean): void {
  if (outcome.kind === "rejected" || isDisabled(outcome) || (outcome.kind === "ok" && verified)) pendingKeys.delete(signature);
}

// ------------------------------------------------------------------ 写进账户 store

function applyTriggers(triggers: readonly Trigger[]): void {
  const events: AccountEvent[] = triggers.map((trigger) => ({ t: "trigger", topic: "account", seq: 0, trigger }));
  applyAccountEvents(events);
}

// ------------------------------------------------------------------ 提交

/** 条件单(ORDER):触发后以 MARKET / LIMIT 下单;MARKET 的限价不发(发 null)。成功后写进 openTriggers(PENDING 或已往前走的行) */
export async function submitOrderTrigger(input: OrderTriggerFields, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<SubmitTriggerResult> {
  const fields: OrderTriggerFields = {
    assetId: input.assetId,
    direction: input.direction,
    triggerPrice: input.triggerPrice,
    side: input.side,
    orderType: input.orderType,
    limitPrice: input.orderType === "LIMIT" ? input.limitPrice : null,
    quantity: input.quantity,
  };
  const signature = orderSignature(fields);
  const outcome = await postEnvelope(TRIGGERS_URL, { kind: "ORDER", ...fields, clientKey: keyFor(signature, now) }, fetchImpl);
  if (outcome.kind !== "ok") {
    settle(signature, outcome, false);
    return failureOf(outcome, "create");
  }
  const trigger = verifyTriggerResponse(outcome.data, (t) => isOrderTriggerOf(t, fields));
  settle(signature, outcome, trigger !== null);
  if (!trigger) return { ok: false, code: "uncertain", retryAfter: null };
  applyTriggers([trigger]);
  return { ok: true, trigger };
}

/** 价格提醒(ALERT):到价只发通知,不下单 */
export async function submitAlert(input: AlertFields, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<SubmitTriggerResult> {
  const signature = alertSignature(input);
  const outcome = await postEnvelope(TRIGGERS_URL, { kind: "ALERT", assetId: input.assetId, direction: input.direction, triggerPrice: input.triggerPrice, clientKey: keyFor(signature, now) }, fetchImpl);
  if (outcome.kind !== "ok") {
    settle(signature, outcome, false);
    return failureOf(outcome, "create");
  }
  const trigger = verifyTriggerResponse(outcome.data, (t) => isAlertOf(t, input));
  settle(signature, outcome, trigger !== null);
  if (!trigger) return { ok: false, code: "uncertain", retryAfter: null };
  applyTriggers([trigger]);
  return { ok: true, trigger };
}

/** 止盈止损(OCO):给了几个价就建几条 SELL MARKET(止盈在前),同一 ocoGroupId;成功后全部写进 openTriggers(一次 set()) */
export async function submitOco(input: OcoFields, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<SubmitOcoResult> {
  const signature = ocoSignature(input);
  const body = { assetId: input.assetId, quantity: input.quantity, takeProfit: input.takeProfit, stopLoss: input.stopLoss, clientKey: keyFor(signature, now) };
  const outcome = await postEnvelope(OCO_URL, body, fetchImpl);
  if (outcome.kind !== "ok") {
    settle(signature, outcome, false);
    return failureOf(outcome, "create");
  }
  const triggers = verifyOcoResponse(outcome.data, input);
  settle(signature, outcome, triggers !== null);
  if (!triggers) return { ok: false, code: "uncertain", retryAfter: null };
  applyTriggers(triggers);
  return { ok: true, triggers };
}

/**
 * 撤销一条条件单或提醒(DELETE /api/account/triggers/[id];只有 PENDING 能撤)。成功后把返回的 CANCELLED 行写进 store
 * (账户 store 把它移出 openTriggers,并记住「已终结」,迟到的 PENDING 回不来)。撤销天然幂等,不用键:
 * 重试时它若已经撤掉了会得到 notCancellable(409),界面可以当作已完成对待。
 */
export async function cancelTrigger(id: string, fetchImpl: typeof fetch = fetch): Promise<CancelTriggerResult> {
  const outcome = await deleteEnvelope(cancelUrl(id), fetchImpl);
  if (outcome.kind !== "ok") return failureOf(outcome, "cancel");
  const trigger = verifyCancelResponse(outcome.data, id);
  if (!trigger) return { ok: false, code: "uncertain", retryAfter: null };
  applyTriggers([trigger]);
  return { ok: true, trigger };
}
