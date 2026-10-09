// 触发引擎(计划 §6.3.2 C4):盯总线上的逐笔成交,把到价的条件单(PENDING)变成真委托、把到价的价格提醒标成已触发,每条恰好一次。
// 在 instrumentation.register() 里启动(排在机器人之后,不依赖 BOT_DISABLED / hub / presence);TRIGGERS_DISABLED=1 时不启动。
// 它订阅总线后 bus.hasSubscribers() 即为 true,所以 START_MODE=next(无 hub)下发布器照样发 trades。
//
// 流程:
//   ① 订阅回调只入队:按 symbol 记下自上次处理以来的最低 / 最高成交价,各带那笔成交的时间;用 setImmediate 安排处理。
//      不 await、不碰库、不抛 —— 总线在机器人的 placeOrder 里同步扇出,这里多花的每一微秒都算在下单路径上。
//      只看 trades(逐笔价;ticker 受 presence 门控,START_MODE=next 下恒不发);OTC 成交没有 trades 消息,不触发。
//   ② 处理循环单飞(state.running):全站可能没有 PENDING 时(mayHavePending 为假)整批丢掉、一条查询都不发 —— 机器人对机器人的成交
//      因此零 DB 开销;否则每个 symbol 查一次到价的 PENDING(ABOVE 且触发价 ≤ 最高价,或 BELOW 且触发价 ≥ 最低价),
//      且只取创建时间不晚于那笔最高 / 最低价成交的行(条件单不会被它创建之前的成交触发),按 createdAt 升序逐条触发。
//      保守:同一批里只记极值那一笔的时间,极值成交早于条件单、而稍后另一笔不那么极端的成交也越过了触发价时,这一批不触发,等下一笔。
//      mayHavePending:创建条件单时置真(任何 bundle,经 globalThis),处理时至多每 10 s 用一次 count 校准。
//   ③ 触发一条:一个事务里 updateMany(PENDING → TRIGGERING,同时记 firedPrice / firedAt;受影响行数不是 1 就放弃),
//      并把同 ocoGroupId 的其它 PENDING 改成 CANCELLED / OCO;然后下单(ORDER)或直接标 TRIGGERED(ALERT),见 place。
//      ORDER 走 placeOrder(要发布)且 clientOrderId = 条件单 id:重放同一条只会拿回同一张单,不会下第二张。
//      市价单一吨也没成交(撮合对市价买单不预检现金;空盘口时市价卖单也是 0 成交)记 REJECTED / NO_FILL,orderId 照记(计划 §9.1 第 60 条)。
//   ④ 恢复:启动时与之后每 30 s(unref 的定时器)把停在 TRIGGERING 超过 5 s 的行再走一遍下单那一步;触发(firedAt)已超过 10 分钟的
//      行不再下单(进程在抢占与下单之间被杀、回滚到没有引擎的旧镜像、TRIGGERS_DISABLED=1 期间留下的行,几小时后不能按当时的盘口成交),
//      直接收尾:那张单其实已经下过的按它收尾,否则 REJECTED / INVALID;不到 10 分钟但下不了单(忙)的,过了 10 分钟也这样收尾,不无限重试。
//      同一个定时器每 6 小时清一次 30 天前的通知:在单飞循环之外跑(自己一个在途标记),分批删不耽误触发。
// 引擎自己下的单产生的成交再进总线、再入队,由同一个循环的下一轮处理,不递归。恢复也排在这个单飞循环里,触发与恢复从不并发。
//
// 状态挂 globalThis.__carbadiaTriggerEngine:引擎跑在 instrumentation 那个 bundle,创建条件单的路由在另一个 bundle,
// 两边经它共用「可能有 PENDING」标志。里面除了纯数据还有计时器、在途的 Promise 与退订函数 —— 是「globalThis 只放纯数据」的
// 又一处例外(P3-03 brief 指定;别的模块只经 markTriggersPending 改两个标志字段,不碰其余)。
// 所有计时器 unref():测试与 SIGTERM 不被挂住(停机时 lifecycle 直接 exit)。
import type { Prisma } from "@/generated/prisma";
import type { NoticePayload, Trigger, TriggerReason } from "@/shared/types";
import { BusyError, placeOrder, TradingError } from "../exchange/matching";
import { toTrigger } from "./account-mappers";
import { TRIGGER_WITH_SYMBOL, type TriggerRowWithSymbol } from "./account-pages";
import { getBus } from "./bus";
import { prisma } from "./db";
import { notifyUser, pruneOldNotices } from "./notices";

/** 恢复定时器的间隔 */
export const RECOVERY_INTERVAL_MS = 30_000;
/** 停在 TRIGGERING 超过这么久才算「下单那一步没走完」(正常的一次下单远小于它) */
export const STALE_TRIGGERING_MS = 5_000;
/** 触发(firedAt)之后超过这么久就不再下单(也不再重试),收尾成 REJECTED / INVALID(那张单已经下过的按它收尾) */
export const MAX_TRIGGERING_MS = 10 * 60_000;
/** 「可能有 PENDING」标志为真时,至多这么久用一次 count 校准 */
export const PENDING_RECHECK_MS = 10_000;
/** 通知清理的间隔 */
export const PRUNE_INTERVAL_MS = 6 * 3_600_000;

/** 一个 symbol 自上次处理以来的最低 / 最高成交价,各带那笔成交的时间(unix ms;同价取较晚的一笔) */
type PriceRange = { min: number; minTs: number; max: number; maxTs: number };
type TriggerEngineState = {
  started: boolean;
  unsubscribe: (() => void) | null;
  /** symbol → 自上次处理以来的价格区间 */
  queue: Map<string, PriceRange>;
  /** 查询或抢占失败的区间(连同时间):不立刻重试(库忙时免得空转),下一笔成交或下一次定时器再并回 queue */
  retry: Map<string, PriceRange>;
  immediate: NodeJS.Immediate | null;
  /** 单飞:在途的处理循环 */
  running: Promise<void> | null;
  recoverDue: boolean;
  /** 在途的通知清理(不在单飞循环里) */
  pruning: Promise<void> | null;
  /** 假 = 全站没有 PENDING,处理循环不发任何查询 */
  mayHavePending: boolean;
  /** 每次置真加一:count 查询期间有人创建了条件单,这次 count 的 0 不作数 */
  pendingEpoch: number;
  checkedAt: number;
  prunedAt: number;
  timer: NodeJS.Timeout | null;
};

declare global {
  /** 触发引擎的状态(见文件头);创建条件单的路由经 markTriggersPending 改它的标志 */
  var __carbadiaTriggerEngine: TriggerEngineState | undefined;
}

function logError(ev: string, err: unknown, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ src: "triggers", ev, ...extra, error: err instanceof Error ? err.message : String(err) }));
}

/** 条件单状态变化发给主人(hub 对不在线的用户直接丢弃;不查库,所以不做在线门控) */
export function publishTriggerEvent(userId: string, trigger: Trigger): void {
  getBus().publish({ kind: "account", userId, event: { t: "trigger", trigger } });
}

/**
 * 创建条件单的一方(任何 bundle)在校验通过之后、写库之前与提交之后各调一次;引擎没启动时什么都不做(启动时本来就当作可能有)。
 * 写库前置真:提交与置真之间到达的成交照样会查;提交后再加一次代数:与之交错的那次 count 若读在提交之前,它的 0 不作数。
 */
export function markTriggersPending(): void {
  const s = globalThis.__carbadiaTriggerEngine;
  if (!s) return;
  s.mayHavePending = true;
  s.pendingEpoch += 1;
}

export function startTriggerEngine(): void {
  if (process.env.TRIGGERS_DISABLED === "1") return;
  if (globalThis.__carbadiaTriggerEngine?.started) return; // dev HMR 下防止重复启动
  const s: TriggerEngineState = {
    started: true,
    unsubscribe: null,
    queue: new Map(),
    retry: new Map(),
    immediate: null,
    running: null,
    recoverDue: true, // 启动即恢复一次
    pruning: null,
    mayHavePending: true, // 库里可能留着上次运行的 PENDING;第一次处理时 count 校准
    pendingEpoch: 0,
    checkedAt: 0,
    prunedAt: 0, // 0:第一次定时器就清理一次
    timer: null,
  };
  globalThis.__carbadiaTriggerEngine = s;
  s.unsubscribe = getBus().subscribe((msg) => onBusMessage(s, msg));
  s.timer = setInterval(() => onTimer(s), RECOVERY_INTERVAL_MS);
  s.timer.unref();
  schedule(s);
  console.log(JSON.stringify({ src: "triggers", ev: "start" }));
}

/** 退订、清计时器、清状态,并等在途的那一步与在途的清理做完(测试与热重载用;停机时进程直接退出,不必调) */
export async function stopTriggerEngine(): Promise<void> {
  const s = globalThis.__carbadiaTriggerEngine;
  if (!s) return;
  s.started = false;
  s.unsubscribe?.();
  s.unsubscribe = null;
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  if (s.immediate) clearImmediate(s.immediate);
  s.immediate = null;
  globalThis.__carbadiaTriggerEngine = undefined;
  await Promise.all([s.running, s.pruning]);
}

/** 等到队列空、没有处理在途、没有清理在途(测试用;排着的 setImmediate 当场执行)。失败放进 retry 的区间不等 */
export async function drainTriggerEngine(): Promise<void> {
  const s = globalThis.__carbadiaTriggerEngine;
  if (!s) return;
  for (;;) {
    if (s.immediate) clearImmediate(s.immediate);
    s.immediate = null;
    if (s.running) await s.running;
    else if (s.started && hasWork(s)) await pump(s);
    else if (s.pruning) await s.pruning;
    else return;
  }
}

// ---- ① 订阅回调:只入队 ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
/** 成交时间:Date 能表示的非负整数毫秒(与 cursor.ts 同一个上界) */
const isTs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8.64e15;

/** 把一笔(或一段)的极值并进区间:更低 / 更高的价取它的时间,同价取较晚的时间 */
function widen(range: PriceRange, other: PriceRange): void {
  if (other.min < range.min || (other.min === range.min && other.minTs > range.minTs)) {
    range.min = other.min;
    range.minTs = other.minTs;
  }
  if (other.max > range.max || (other.max === range.max && other.maxTs > range.maxTs)) {
    range.max = other.max;
    range.maxTs = other.maxTs;
  }
}

/** trades 消息 → 这一批的 symbol 与带时间的最低 / 最高价;别的消息或形状不对 → null(价格或时间不合法的单笔跳过) */
function tradeRange(msg: unknown): { symbol: string; range: PriceRange } | null {
  if (!isRecord(msg) || msg.kind !== "trades" || typeof msg.symbol !== "string" || !Array.isArray(msg.trades)) return null;
  let range: PriceRange | null = null;
  for (const trade of msg.trades) {
    if (!isRecord(trade)) continue;
    const { price, ts } = trade;
    if (typeof price !== "number" || !Number.isFinite(price) || !isTs(ts)) continue;
    const one = { min: price, minTs: ts, max: price, maxTs: ts };
    if (range) widen(range, one);
    else range = one;
  }
  return range ? { symbol: msg.symbol, range } : null;
}

function mergeRange(into: Map<string, PriceRange>, symbol: string, range: PriceRange): void {
  const known = into.get(symbol);
  if (known) widen(known, range);
  else into.set(symbol, { ...range });
}

function requeueRetries(s: TriggerEngineState): void {
  for (const [symbol, range] of s.retry) mergeRange(s.queue, symbol, range);
  s.retry.clear();
}

/** 总线订阅者:同步、不查库、不抛(包括形状不对的消息) */
function onBusMessage(s: TriggerEngineState, msg: unknown): void {
  try {
    const trades = tradeRange(msg);
    if (!trades) return;
    mergeRange(s.queue, trades.symbol, trades.range);
    requeueRetries(s);
    schedule(s);
  } catch (err) {
    logError("subscriber_failed", err);
  }
}

function onTimer(s: TriggerEngineState): void {
  s.recoverDue = true;
  requeueRetries(s);
  schedule(s);
  if (!s.pruning && Date.now() - s.prunedAt >= PRUNE_INTERVAL_MS) {
    s.prunedAt = Date.now();
    const pruning: Promise<void> = pruneOldNotices()
      .then(
        () => undefined,
        () => undefined, // pruneOldNotices 自己记日志、不拒绝;这里再兜一层,stop / drain 的等待不会因为它失败
      )
      .finally(() => {
        if (s.pruning === pruning) s.pruning = null;
      });
    s.pruning = pruning;
  }
}

// ---- ② 处理循环(单飞)----

const hasWork = (s: TriggerEngineState): boolean => s.queue.size > 0 || s.recoverDue;

function schedule(s: TriggerEngineState): void {
  if (!s.started || s.immediate) return;
  s.immediate = setImmediate(() => {
    s.immediate = null;
    void pump(s);
  });
  s.immediate.unref();
}

/** 没有在途的循环就起一个;结束时还有活(循环收尾之后才入队的)就再安排一次 */
function pump(s: TriggerEngineState): Promise<void> {
  if (s.running) return s.running;
  const run: Promise<void> = work(s)
    .catch((err) => logError("loop_failed", err))
    .finally(() => {
      if (s.running === run) s.running = null;
      if (hasWork(s)) schedule(s);
    });
  s.running = run;
  return run;
}

async function work(s: TriggerEngineState): Promise<void> {
  while (s.started) {
    if (s.queue.size > 0) {
      const batch = s.queue;
      s.queue = new Map();
      await fireCrossed(s, batch);
    } else if (s.recoverDue) {
      s.recoverDue = false;
      await recover();
    } else {
      return;
    }
  }
}

/** 标志为假 → 假;为真且距上次校准超过 10 s → 一次 count 校准(查询期间有人创建过就不改成假);count 失败按真处理 */
async function mayHavePending(s: TriggerEngineState): Promise<boolean> {
  if (!s.mayHavePending) return false;
  if (Date.now() - s.checkedAt < PENDING_RECHECK_MS) return true;
  const epoch = s.pendingEpoch;
  s.checkedAt = Date.now();
  try {
    const pending = await prisma.trigger.count({ where: { status: "PENDING" } });
    if (pending === 0 && s.pendingEpoch === epoch) s.mayHavePending = false;
  } catch (err) {
    logError("count_failed", err);
  }
  return s.mayHavePending;
}

async function fireCrossed(s: TriggerEngineState, batch: Map<string, PriceRange>): Promise<void> {
  if (!(await mayHavePending(s))) return;
  for (const [symbol, range] of batch) {
    try {
      const rows = await prisma.trigger.findMany({
        where: {
          status: "PENDING",
          asset: { symbol },
          // 到价,且创建不晚于越过它的那笔成交:条件单不会被它创建之前的成交触发
          OR: [
            { direction: "ABOVE", triggerPrice: { lte: range.max }, createdAt: { lte: new Date(range.maxTs) } },
            { direction: "BELOW", triggerPrice: { gte: range.min }, createdAt: { lte: new Date(range.minTs) } },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: TRIGGER_WITH_SYMBOL,
      });
      // 触发它的那笔成交价:ABOVE 取这一批的最高价,BELOW 取最低价
      for (const row of rows) await fire(row, row.direction === "BELOW" ? range.min : range.max);
    } catch (err) {
      // 查询或抢占失败(库忙):行还是 PENDING,区间(连同时间)留给下一次;已经抢到的行不会再被选中
      mergeRange(s.retry, symbol, range);
      logError("drain_failed", err, { symbol });
    }
  }
}

// ---- ③ 触发一条 ----

/** 抢占(一个事务):本行 PENDING → TRIGGERING,同组其余 PENDING → CANCELLED / OCO。没抢到(已被撤 / 已触发)→ null;库错误原样抛 */
async function claim(row: TriggerRowWithSymbol, firedPrice: number): Promise<{ trigger: TriggerRowWithSymbol; cancelled: TriggerRowWithSymbol[] } | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.trigger.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "TRIGGERING", firedPrice, firedAt: new Date() } });
    if (count !== 1) return null;
    let cancelledIds: string[] = [];
    if (row.ocoGroupId) {
      const siblings = await tx.trigger.findMany({
        where: { userId: row.userId, assetId: row.assetId, ocoGroupId: row.ocoGroupId, status: "PENDING", id: { not: row.id } },
        select: { id: true },
      });
      cancelledIds = siblings.map((sibling) => sibling.id);
      if (cancelledIds.length > 0) await tx.trigger.updateMany({ where: { id: { in: cancelledIds }, status: "PENDING" }, data: { status: "CANCELLED", reason: "OCO" } });
    }
    const rows = await tx.trigger.findMany({ where: { id: { in: [row.id, ...cancelledIds] } }, include: TRIGGER_WITH_SYMBOL });
    const trigger = rows.find((r) => r.id === row.id);
    return trigger ? { trigger, cancelled: rows.filter((r) => r.id !== row.id) } : null;
  });
}

/** 抢到 → 发事件 → 下单并收尾 → 最后才写同组被撤那几条的通知(通知要写库,不能挡在下单前面) */
async function fire(row: TriggerRowWithSymbol, firedPrice: number): Promise<void> {
  const claimed = await claim(row, firedPrice);
  if (!claimed) return;
  publishTriggerEvent(claimed.trigger.userId, toTrigger(claimed.trigger, claimed.trigger.asset.symbol));
  const cancelled = claimed.cancelled.map((sibling) => ({ userId: sibling.userId, view: toTrigger(sibling, sibling.asset.symbol) }));
  for (const { userId, view } of cancelled) publishTriggerEvent(userId, view);
  await place(claimed.trigger);
  for (const { userId, view } of cancelled) await notifyUser(userId, triggerNotice(view, "CANCELLED"), `trigger:${view.id}:CANCELLED`);
}

const triggerNotice = (t: Trigger, outcome: "TRIGGERED" | "REJECTED" | "CANCELLED"): NoticePayload => ({
  kind: "trigger",
  triggerId: t.id,
  symbol: t.symbol,
  outcome,
  reason: t.reason,
  side: t.side,
  quantity: t.quantity,
  triggerPrice: t.triggerPrice,
  orderId: t.orderId,
});

/** TRIGGERING → 终态(条件更新);别人已经收尾(更新 0 行)→ null */
async function settle(id: string, data: Prisma.TriggerUpdateManyMutationInput): Promise<TriggerRowWithSymbol | null> {
  const { count } = await prisma.trigger.updateMany({ where: { id, status: "TRIGGERING" }, data });
  if (count !== 1) return null;
  return prisma.trigger.findUnique({ where: { id }, include: TRIGGER_WITH_SYMBOL });
}

/**
 * 被拒原因:撮合引擎的 TradingError 没有错误码,只能认文案(matching.ts placeOrderTx 的「下单前冻结资源」两句;engine 的集成测试钉住这两条)。
 * 限价买现金不够 → INSUFFICIENT_CASH;卖单可用持仓不够 → INSUFFICIENT_QTY;其余(标的没了、超上限…)→ INVALID。
 * 市价买没有现金预检(能买多少买多少),现金不够时是「下单成功、0 成交」,由 outcomeOf 记成 NO_FILL,不走到这里。
 */
function rejectReasonOf(err: TradingError): TriggerReason {
  if (err.message === "Insufficient available cash") return "INSUFFICIENT_CASH";
  if (err.message === "Insufficient available holdings") return "INSUFFICIENT_QTY";
  return "INVALID";
}

/** 下单的结果:那张单(id 与累计成交量)、被拒原因,或 null(忙 / 未知错误,行留在 TRIGGERING) */
type Placement = { orderId: string; filledQuantity: number } | { reason: TriggerReason } | null;

/** 按条件单下单。重放(恢复时那张单已经下过)拿回的也是同一张单的当前行 */
async function orderFor(userId: string, t: Trigger): Promise<Placement> {
  const { side, orderType, quantity } = t;
  const price = orderType === "LIMIT" ? t.limitPrice : null;
  if (!side || !orderType || quantity == null || (orderType === "LIMIT" && price == null)) return { reason: "INVALID" }; // 行上的下单字段不全(只可能是手工改库)
  try {
    const result = await placeOrder({ userId, assetId: t.assetId, side, type: orderType, price, quantity, clientOrderId: t.id });
    return { orderId: result.order.id, filledQuantity: result.order.filledQuantity };
  } catch (err) {
    // BusyError 是 TradingError 的子类,先判
    if (err instanceof BusyError || !(err instanceof TradingError)) {
      logError("place_failed", err, { triggerId: t.id });
      return null;
    }
    return { reason: rejectReasonOf(err) };
  }
}

/**
 * 触发超过 MAX_TRIGGERING_MS:不再下单、不再重试。那张单若其实已经下过(某次提交之后才出的错),按它收尾;否则 REJECTED / INVALID。
 * 查单失败原样抛(行留在 TRIGGERING,下一轮再来)
 */
async function giveUp(row: TriggerRowWithSymbol): Promise<Placement> {
  const order = await prisma.order.findUnique({ where: { userId_clientOrderId: { userId: row.userId, clientOrderId: row.id } }, select: { id: true, filledQuantity: true } });
  logError("gave_up", new Error(`still TRIGGERING ${MAX_TRIGGERING_MS / 60_000} minutes after firing`), { triggerId: row.id, orderId: order?.id ?? null });
  return order ? { orderId: order.id, filledQuantity: order.filledQuantity } : { reason: "INVALID" };
}

/**
 * 下单结果 → 收尾字段。看的是那张单的累计成交量(order.filledQuantity),新下与重放同一个判据:市价单在下单事务里就终结了
 *(成交完或余量撤销),之后不会再成交,所以重放时这一列就是当时的结果。限价单 0 成交是挂在簿上,照常 TRIGGERED。
 */
function outcomeOf(t: Trigger, placed: Exclude<Placement, null>): Prisma.TriggerUpdateManyMutationInput {
  if ("reason" in placed) return { status: "REJECTED", reason: placed.reason };
  if (t.orderType === "MARKET" && placed.filledQuantity === 0) return { status: "REJECTED", reason: "NO_FILL", orderId: placed.orderId };
  return { status: "TRIGGERED", orderId: placed.orderId };
}

/**
 * 抢到之后的那一步(恢复也从这里重走):ALERT 标 TRIGGERED + price_alert 通知;ORDER 下单后标 TRIGGERED(记 orderId)、
 * REJECTED / NO_FILL(市价 0 成交,记 orderId)或 REJECTED(记原因)+ trigger 通知。任何失败都只记日志,行留在 TRIGGERING。
 */
async function place(row: TriggerRowWithSymbol): Promise<void> {
  const view = toTrigger(row, row.asset.symbol);
  try {
    if (view.kind === "ALERT") {
      const done = await settle(row.id, { status: "TRIGGERED" });
      if (!done) return;
      const fired = toTrigger(done, done.asset.symbol);
      publishTriggerEvent(done.userId, fired);
      const payload: NoticePayload = { kind: "price_alert", triggerId: fired.id, symbol: fired.symbol, direction: fired.direction, triggerPrice: fired.triggerPrice, firedPrice: fired.firedPrice ?? fired.triggerPrice };
      await notifyUser(done.userId, payload, `alert:${fired.id}`);
      return;
    }
    // 触发已超过 10 分钟:一次 placeOrder 都不调(否则会按几小时后的盘口成交),直接收尾;没超过的下单失败后再看一次
    const firedAt = (row.firedAt ?? row.updatedAt).getTime();
    const expired = () => Date.now() - firedAt > MAX_TRIGGERING_MS;
    let placed = expired() ? await giveUp(row) : await orderFor(row.userId, view);
    if (!placed && expired()) placed = await giveUp(row);
    if (!placed) return;
    const done = await settle(row.id, outcomeOf(view, placed));
    if (!done) return;
    const settled = toTrigger(done, done.asset.symbol);
    publishTriggerEvent(done.userId, settled);
    const result = settled.status === "TRIGGERED" ? "TRIGGERED" : "REJECTED";
    await notifyUser(done.userId, triggerNotice(settled, result), `trigger:${settled.id}:${result}`);
  } catch (err) {
    logError("settle_failed", err, { triggerId: row.id });
  }
}

// ---- ④ 恢复 ----

/** 停在 TRIGGERING 超过 5 s 的行再走一遍 place:下单幂等(clientOrderId = 条件单 id),收尾是条件更新,重走无害 */
async function recover(): Promise<void> {
  try {
    const rows = await prisma.trigger.findMany({
      where: { status: "TRIGGERING", updatedAt: { lt: new Date(Date.now() - STALE_TRIGGERING_MS) } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: TRIGGER_WITH_SYMBOL,
    });
    if (rows.length > 0) console.log(JSON.stringify({ src: "triggers", ev: "recover", rows: rows.length }));
    for (const row of rows) await place(row);
  } catch (err) {
    logError("recover_failed", err);
  }
}
