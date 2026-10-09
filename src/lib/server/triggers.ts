// 条件单与价格提醒的服务(计划 §6.3.2 C3):POST / GET /api/account/triggers、POST /api/account/triggers/oco、DELETE /api/account/triggers/[id]
// 调这里。账户订阅快照(发布器的 loadAccountSnapshot)用 account-pages.ts 的 openTriggersRead,把未完结的条件单与余额、挂单读在同一个事务里
//(发布器不导入本模块:本模块依赖触发引擎与 matching,而 matching ↔ 发布器本来就成环)。
// 请求体的类型与上下限由路由的 zod 先校验(与 POST /api/orders 同一组常量),这里做依赖库里状态的校验:
//   - direction 与当前 Asset.lastPrice 一致(ABOVE 要求触发价 > 最新价,BELOW 要求 <;最新价为空时放行),否则 400 wouldTriggerNow;
//   - 每个用户未完结(PENDING + TRIGGERING)的条件单与提醒合计 ≤ 50,否则 400 tooManyTriggers;
//   - OCO:takeProfit > 最新价 > stopLoss(给了哪个查哪个,至少给一个),quantity ≤ 持仓数量(否则 400 overPosition)。创建时不锁资金、不锁持仓。
//   三个错误码与客户端共用(@/shared/constants 的 TRIGGER_ERROR)。
// 幂等:clientKey 必填;同一 clientKey 同样参数重发返回既有行,参数不同 409。OCO 两行的键由请求的 clientKey 派生(<clientKey>:tp / :sl)。
// 每次状态变化给主人发 trigger 账户事件;校验通过后(写库前)与提交后各置一次触发引擎的「可能有 PENDING」标志(引擎在另一个 bundle,经 globalThis)。
import { randomUUID } from "node:crypto";
import type { Prisma, Trigger as TriggerRow } from "@/generated/prisma";
import type { CreateOcoRequest, CreateTriggerRequest } from "@/shared/api-shapes";
import type { OrderType, Side, Trigger, TriggerDirection, TriggerKind } from "@/shared/types";
import { TRIGGER_ERROR } from "@/shared/constants";
import { MAX_NOTIONAL_CENTS, MAX_PRICE_CENTS } from "../exchange/limits";
import { BusyError, isContentionError, MAX_ORDER_QUANTITY, TradingError } from "../exchange/matching";
import { toTrigger } from "./account-mappers";
import { beforeCursor, OPEN_TRIGGER_STATUSES, openTriggersRead, TRIGGER_WITH_SYMBOL, triggersFromRows, type TriggerRowWithSymbol } from "./account-pages";
import type { Cursor, PageQuery } from "./cursor";
import { prisma } from "./db";
import { markTriggersPending, publishTriggerEvent } from "./trigger-engine";

/** 每个用户未完结的条件单与提醒合计上限 */
const MAX_OPEN_TRIGGERS = 50;

const STATUS_SETS = new Map<string, readonly string[]>([["open", OPEN_TRIGGER_STATUSES], ["history", ["TRIGGERED", "REJECTED", "CANCELLED"]]]);

/**
 * 409:同一 clientKey 配了不同参数;撤一条已经不是 PENDING 的条件单。不继承 TradingError(handle() 会把它当 400),路由先判它。
 * 其余校验失败抛 TradingError(handle() → 400)。
 */
export class TriggerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TriggerConflictError";
  }
}

/** 要落库的一行(不含 userId);幂等比对看的就是这些字段(ocoGroupId 每次新生成,不比) */
type Planned = {
  clientKey: string;
  kind: TriggerKind;
  assetId: string;
  direction: TriggerDirection;
  triggerPrice: number;
  side: Side | null;
  orderType: OrderType | null;
  limitPrice: number | null;
  quantity: number | null;
  ocoGroupId: string | null;
};

const sameParams = (row: TriggerRow, p: Planned): boolean =>
  row.kind === p.kind &&
  row.assetId === p.assetId &&
  row.direction === p.direction &&
  row.triggerPrice === p.triggerPrice &&
  row.side === p.side &&
  row.orderType === p.orderType &&
  row.limitPrice === p.limitPrice &&
  row.quantity === p.quantity;

/** 同一个请求 clientKey 可能落成的全部行键:单条用它本身,OCO 用派生的两个;一并查,单条与 OCO 撞了同一个 clientKey 也算参数不同 */
const keysOf = (clientKey: string): string[] => [clientKey, `${clientKey}:tp`, `${clientKey}:sl`];

/** 既有行就是这次请求的那几行(键一一对应、参数相同)→ 按请求的顺序返回;否则 409 */
function replayOf(existing: TriggerRowWithSymbol[], planned: Planned[]): TriggerRowWithSymbol[] {
  const byKey = new Map(existing.map((row) => [row.clientKey, row]));
  const rows = planned.map((p) => byKey.get(p.clientKey));
  if (existing.length !== planned.length || rows.some((row, i) => !row || !sameParams(row, planned[i]))) {
    throw new TriggerConflictError("clientKey already used with a different trigger");
  }
  return rows.filter((row) => row !== undefined);
}

function assertPrice(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TradingError(`${label} must be a positive integer amount in cents`);
  if (value > MAX_PRICE_CENTS) throw new TradingError(`${label} exceeds maximum`);
}

function assertQuantity(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TradingError("Quantity must be a positive integer");
  if (value > MAX_ORDER_QUANTITY) throw new TradingError("Quantity exceeds maximum");
}

/** ABOVE 要求触发价 > 最新价,BELOW 要求 <;最新价为空(还没成交过)时放行 */
function assertWaits(direction: TriggerDirection, triggerPrice: number, lastPrice: number | null): void {
  if (lastPrice == null) return;
  if (direction === "ABOVE" ? triggerPrice <= lastPrice : triggerPrice >= lastPrice) throw new TradingError(TRIGGER_ERROR.wouldTriggerNow);
}

/**
 * 幂等创建:一个事务里先按 clientKey 找既有行(找到就比对后原样返回,不再校验市场状态),否则读标的、跑 check(方向 / 持仓)、
 * 数未完结的行,再逐行创建。SQLite 单连接下交互事务串行,上限与唯一键不会被并发绕过;万一撞上写冲突 / 超时 / 唯一键,
 * 按键重读:读到就当重放,读不到 503(与下单的并发兜底同一写法)。
 */
async function createRows(userId: string, clientKey: string, planned: Planned[], check: (tx: Prisma.TransactionClient, lastPrice: number | null) => Promise<void>): Promise<Trigger[]> {
  const keys = keysOf(clientKey);
  const assetId = planned[0].assetId;
  let rows: TriggerRowWithSymbol[];
  let created: boolean;
  try {
    ({ rows, created } = await prisma.$transaction(async (tx) => {
      const existing = await tx.trigger.findMany({ where: { userId, clientKey: { in: keys } }, include: TRIGGER_WITH_SYMBOL });
      if (existing.length > 0) return { rows: replayOf(existing, planned), created: false };
      const asset = await tx.asset.findUnique({ where: { id: assetId }, select: { lastPrice: true } });
      if (!asset) throw new TradingError("Instrument not found");
      await check(tx, asset.lastPrice);
      const open = await tx.trigger.count({ where: { userId, status: { in: [...OPEN_TRIGGER_STATUSES] } } });
      if (open + planned.length > MAX_OPEN_TRIGGERS) throw new TradingError(TRIGGER_ERROR.tooManyTriggers);
      markTriggersPending(); // 校验都过了、写库之前:提交与提交后置真之间到达的成交照样会被引擎查到
      const fresh: TriggerRowWithSymbol[] = [];
      for (const p of planned) fresh.push(await tx.trigger.create({ data: { userId, ...p }, include: TRIGGER_WITH_SYMBOL }));
      return { rows: fresh, created: true };
    }));
  } catch (err) {
    if (!isContentionError(err)) throw err;
    const existing = await prisma.trigger.findMany({ where: { userId, clientKey: { in: keys } }, include: TRIGGER_WITH_SYMBOL });
    if (existing.length === 0) throw new BusyError();
    rows = replayOf(existing, planned);
    created = false;
  }
  const triggers = triggersFromRows(rows);
  if (created) {
    markTriggersPending(); // 提交后:见 markTriggersPending
    for (const trigger of triggers) publishTriggerEvent(userId, trigger);
  }
  return triggers;
}

/** POST /api/account/triggers:一条条件单(ORDER,触发后以 MARKET / LIMIT 下单)或价格提醒(ALERT) */
export async function createTrigger(userId: string, body: CreateTriggerRequest): Promise<Trigger> {
  assertPrice(body.triggerPrice, "Trigger price");
  let planned: Planned;
  if (body.kind === "ORDER") {
    assertQuantity(body.quantity);
    // MARKET 单忽略请求里的限价、落库 null(与 placeOrderTx 对 MARKET 价格的处理一致);LIMIT 必须给,名义额上限与下单同一条
    const limitPrice = body.orderType === "LIMIT" ? (body.limitPrice ?? null) : null;
    if (body.orderType === "LIMIT") {
      if (limitPrice == null) throw new TradingError("Limit orders require a price greater than 0");
      assertPrice(limitPrice, "Price");
      if (limitPrice * body.quantity > MAX_NOTIONAL_CENTS) throw new TradingError("Order notional exceeds maximum");
    }
    planned = {
      clientKey: body.clientKey,
      kind: "ORDER",
      assetId: body.assetId,
      direction: body.direction,
      triggerPrice: body.triggerPrice,
      side: body.side,
      orderType: body.orderType,
      limitPrice,
      quantity: body.quantity,
      ocoGroupId: null,
    };
  } else {
    planned = { clientKey: body.clientKey, kind: "ALERT", assetId: body.assetId, direction: body.direction, triggerPrice: body.triggerPrice, side: null, orderType: null, limitPrice: null, quantity: null, ocoGroupId: null };
  }
  const [trigger] = await createRows(userId, body.clientKey, [planned], async (_tx, lastPrice) => assertWaits(planned.direction, planned.triggerPrice, lastPrice));
  return trigger;
}

/** POST /api/account/triggers/oco:止盈(ABOVE)/ 止损(BELOW)各一条 SELL MARKET,同一 ocoGroupId;返回 1 或 2 条(止盈在前) */
export async function createOco(userId: string, body: CreateOcoRequest): Promise<Trigger[]> {
  const takeProfit = body.takeProfit ?? null;
  const stopLoss = body.stopLoss ?? null;
  if (takeProfit == null && stopLoss == null) throw new TradingError("Give a take-profit price, a stop-loss price, or both");
  if (takeProfit != null) assertPrice(takeProfit, "Take-profit price");
  if (stopLoss != null) assertPrice(stopLoss, "Stop-loss price");
  if (takeProfit != null && stopLoss != null && takeProfit <= stopLoss) throw new TradingError("Take-profit price must be above the stop-loss price");
  assertQuantity(body.quantity);
  const ocoGroupId = randomUUID();
  const leg = (key: "tp" | "sl", direction: TriggerDirection, triggerPrice: number): Planned => ({
    clientKey: `${body.clientKey}:${key}`,
    kind: "ORDER",
    assetId: body.assetId,
    direction,
    triggerPrice,
    side: "SELL",
    orderType: "MARKET",
    limitPrice: null,
    quantity: body.quantity,
    ocoGroupId,
  });
  const planned = [...(takeProfit != null ? [leg("tp", "ABOVE", takeProfit)] : []), ...(stopLoss != null ? [leg("sl", "BELOW", stopLoss)] : [])];
  return createRows(userId, body.clientKey, planned, async (tx, lastPrice) => {
    for (const p of planned) assertWaits(p.direction, p.triggerPrice, lastPrice);
    // 持仓数量(含挂卖单 / 场外锁着的部分):创建时不锁,触发时可用持仓不够由下单拒掉(REJECTED / INSUFFICIENT_QTY)
    const holding = await tx.holding.findUnique({ where: { userId_assetId: { userId, assetId: body.assetId } }, select: { quantity: true } });
    if ((holding?.quantity ?? 0) < body.quantity) throw new TradingError(TRIGGER_ERROR.overPosition);
  });
}

/** DELETE /api/account/triggers/[id]:只有 PENDING 能撤(条件更新,与引擎的抢占互斥),否则 409;不存在或不是本人的 → 400 */
export async function cancelTrigger(userId: string, id: string): Promise<Trigger> {
  let count: number;
  let row: TriggerRowWithSymbol | null;
  try {
    ({ count } = await prisma.trigger.updateMany({ where: { id, userId, status: "PENDING" }, data: { status: "CANCELLED", reason: "USER" } }));
    row = await prisma.trigger.findUnique({ where: { id }, include: TRIGGER_WITH_SYMBOL });
  } catch (err) {
    if (isContentionError(err)) throw new BusyError();
    throw err;
  }
  // 不是本人的与不存在的同一个回答:不让别人探测 id
  if (!row || row.userId !== userId) throw new TradingError("Trigger not found");
  if (count !== 1) throw new TriggerConflictError("Trigger can no longer be cancelled");
  const trigger = toTrigger(row, row.asset.symbol);
  publishTriggerEvent(userId, trigger);
  return trigger;
}

export type TriggerStatusFilter = "open" | "history" | null;

/** 读 ?status=open|history;空串视为未传(不筛状态);不认识的 → { error }(路由回 400) */
export function readTriggerStatus(params: URLSearchParams): { status: TriggerStatusFilter } | { error: string } {
  const status = params.get("status") || null;
  if (status == null) return { status: null };
  if (status === "open" || status === "history") return { status };
  return { error: "Invalid status" };
}

/** GET /api/account/triggers 的一页:createdAt desc, id desc 键集分页(游标与 /api/account/orders 同一种);next 指向本页最后一行 */
export async function listTriggers(userId: string, query: { status: TriggerStatusFilter } & PageQuery): Promise<{ triggers: Trigger[]; next: Cursor | null }> {
  const statuses = query.status ? STATUS_SETS.get(query.status) : undefined;
  const rows = await prisma.trigger.findMany({
    where: {
      userId,
      ...(statuses ? { status: { in: [...statuses] } } : {}),
      ...(query.cursor ? beforeCursor(query.cursor) : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1, // 多取一行只为判断有没有下一页
    include: TRIGGER_WITH_SYMBOL,
  });
  const pageRows = rows.slice(0, query.limit);
  const last = rows.length > query.limit ? pageRows[pageRows.length - 1] : null;
  return { triggers: triggersFromRows(pageRows), next: last ? { createdAt: last.createdAt.getTime(), id: last.id } : null };
}

/** 未完结(PENDING / TRIGGERING)的条件单,新的在前(与 ?status=open 同序)。账户快照经 account-pages 的 openTriggersRead 读同一份,放在自己的批量事务里 */
export async function loadOpenTriggers(userId: string): Promise<Trigger[]> {
  return triggersFromRows(await openTriggersRead(prisma, userId));
}
