// Prisma 行 → 共享类型(计划 §3.5 Order / Fill / Position / LedgerLineView)。REST 与发布器共用同一份映射,时间转 unix ms,不外露 userId。
// P1-07 提供 toOrder / toFill / ledgerIdsByTrade;P1-09 补 toPosition / toLedgerLineView / avgFillPricesByOrder;P1-22d 补 selfTradeCancelledIds;
// P2-03 给 toPosition 加 lockedBy(持仓的查询在 positions.ts)。
import type { Holding, LedgerEntry, Prisma } from "@/generated/prisma";
import type { OrderRow, TradeRow } from "../exchange/matching";
import { reconstructPositionBasis, type CostBasisLedgerLine } from "../exchange/portfolio-analysis";
import { auditRefOf } from "@/shared/constants";
import { takerSideOf } from "@/shared/taker";
import type { CancelReason, Fill, LedgerLineView, Order, OrderStatus, OrderType, Position, Side } from "@/shared/types";

/**
 * cancelReason 不落库,由映射派生(计划 §9.1 第 24、41 条):
 * MARKET 单未吃满被撤的余量 → MARKET_REMAINDER;LIMIT 单在 selfTraded 里(被自成交防护撤掉,见 selfTradeCancelledIds)→ SELF_TRADE;
 * 其余 CANCELLED 是用户主动撤单 → USER;未撤销为 null。
 */
function cancelReasonOf(row: Pick<OrderRow, "id" | "type" | "status" | "filledQuantity" | "quantity">, selfTraded: ReadonlySet<string> | undefined): CancelReason | null {
  if (row.status !== "CANCELLED") return null;
  if (row.type === "MARKET") return row.filledQuantity < row.quantity ? "MARKET_REMAINDER" : "USER";
  return selfTraded?.has(row.id) ? "SELF_TRADE" : "USER";
}

/**
 * 被自成交防护(STP,计划 §9.1 第 41 条)撤掉的订单 id。订单表没有撤单原因列(不加迁移);matching.ts 的 releaseAndCancel
 * 撤 STP 挂单时写的解冻流水 reason = SELF_TRADE_UNLOCK、refType = ORDER、refId = 订单 id,是库里唯一的记号 ——
 * 挂单一定是限价单、被撤时一定还有剩余量,所以每张 STP 撤单至少有一行这样的流水。
 * 只查 CANCELLED 的 LIMIT 单(市价单不挂单,不会被 STP 撤);一批一次查询,走 (refType, refId) 索引;没有候选时不查库。
 * 结果交给 toOrder 的 selfTraded 参数。
 */
export async function selfTradeCancelledIds(
  db: Pick<Prisma.TransactionClient, "ledgerEntry">,
  orders: readonly Pick<OrderRow, "id" | "type" | "status">[],
): Promise<Set<string>> {
  const ids = orders.filter((order) => order.status === "CANCELLED" && order.type === "LIMIT").map((order) => order.id);
  const out = new Set<string>();
  if (ids.length === 0) return out;
  const rows = await db.ledgerEntry.findMany({
    where: { refType: "ORDER", refId: { in: ids }, reason: "SELF_TRADE_UNLOCK" },
    select: { refId: true },
  });
  for (const row of rows) if (row.refId != null) out.add(row.refId);
  return out;
}

/**
 * @param avg 调用方按实际成交重算的均价(如 /api/orders 的 withExecutionPrices);不传则用行上的 avgFillPrice。
 * @param selfTraded selfTradeCancelledIds 的结果;不传时被 STP 撤掉的 LIMIT 单也按 USER 派生(调用方没查流水)。
 * updatedAt 在迁移前的旧行为 NULL(@updatedAt 是客户端语义,迁移不回填),回退到 createdAt(P1-06 交接)。
 */
export function toOrder(row: OrderRow, avg?: number | null, selfTraded?: ReadonlySet<string>): Order {
  return {
    id: row.id,
    clientOrderId: row.clientOrderId,
    assetId: row.assetId,
    symbol: row.asset.symbol,
    // side / type / status 列是自由 TEXT,但只有 matching.ts 用这几个字面量写入
    side: row.side as Side,
    type: row.type as OrderType,
    price: row.price,
    quantity: row.quantity,
    filledQuantity: row.filledQuantity,
    status: row.status as OrderStatus,
    avgFillPrice: avg === undefined ? row.avgFillPrice : avg,
    cancelReason: cancelReasonOf(row, selfTraded),
    createdAt: row.createdAt.getTime(),
    updatedAt: (row.updatedAt ?? row.createdAt).getTime(),
  };
}

/**
 * 成交从 viewer 一方看:side 取 viewer 在该成交里的方向(viewer 须是买卖双方之一,非买方即视为卖方),
 * role 由 takerSideOf 派生(MARKET → 价 ≠ 成交价 → createdAt 晚 → id 大),feeCents 恒 0(计划 §9.1 第 1 条),
 * ledgerRefs = 本人在该成交下的账本行 id(计划 §3.5 的 Fill 注释),由调用方经 ledgerIdsByTrade 一次查出后传入;
 * 纯映射本身不查库,不传即 [](发布器等没有账本 id 的场合)。
 */
export function toFill(trade: TradeRow, viewerUserId: string, ledgerIds: readonly string[] = []): Fill {
  const side: Side = trade.buyerId === viewerUserId ? "BUY" : "SELL";
  const takerSide = takerSideOf({
    price: trade.price,
    buyOrder: { ...trade.buyOrder, type: trade.buyOrder.type as OrderType, createdAt: trade.buyOrder.createdAt.getTime() },
    sellOrder: { ...trade.sellOrder, type: trade.sellOrder.type as OrderType, createdAt: trade.sellOrder.createdAt.getTime() },
  });
  return {
    id: trade.id,
    orderId: side === "BUY" ? trade.buyOrderId : trade.sellOrderId,
    symbol: trade.asset.symbol,
    side,
    role: takerSide === side ? "TAKER" : "MAKER",
    price: trade.price,
    quantity: trade.quantity,
    notional: trade.price * trade.quantity,
    feeCents: 0,
    ts: trade.createdAt.getTime(),
    auditRef: auditRefOf(trade.id),
    ledgerRefs: [...ledgerIds],
  };
}

/**
 * 本人在这些成交下的账本行 id,按 tradeId 分组(refType = TRADE, refId = tradeId,userId = 本人;走 (refType, refId) 索引)。
 * 一批 fills 一次查询;tradeIds 为空时不查库。POST /api/orders 与 P1-09 的 /api/account/fills 共用。
 */
export async function ledgerIdsByTrade(
  db: Pick<Prisma.TransactionClient, "ledgerEntry">,
  userId: string,
  tradeIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byTrade = new Map<string, string[]>();
  if (tradeIds.length === 0) return byTrade;
  const rows = await db.ledgerEntry.findMany({
    where: { userId, refType: "TRADE", refId: { in: [...tradeIds] } },
    select: { id: true, refId: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const row of rows) {
    if (row.refId == null) continue;
    const ids = byTrade.get(row.refId) ?? [];
    ids.push(row.id);
    byTrade.set(row.refId, ids);
  }
  return byTrade;
}

/** 持仓行 + 标的的最小字段:positions.ts 按 include: { asset: { select: { symbol, lastPrice, isScenario } } } 查出 */
export type HoldingRow = Pick<Holding, "assetId" | "quantity" | "locked"> & { asset: { symbol: string; lastPrice: number | null; isScenario: boolean } };

/**
 * 持仓三态(计划 §3.5 Position、§6.2.2 C1):available = quantity − locked(可交易),retired = Retirement 按 assetId 汇总,
 * lockedBy = locked 的来源拆分(未完结 SELL 挂单的剩余量 / ACTIVE 场外挂牌),两者都由调用方查(src/lib/server/positions.ts,唯一的调用方);
 * lockedBy 与 locked 对不上时这里不改任何一个数:locked 与 available 以 Holding 行为准,lockedBy 照实给出。
 * 成本用 reconstructPositionBasis 从本人账本重建——costBasisStatus 非 complete 时 averagePurchasePrice / unrealisedPnl 为 null,
 * 永不把缺失的成本当零。marketValue = (lastPrice ?? 0) × quantity(分 × 吨 → 分,与 /api/portfolio 一致)。纯映射,不查库。
 */
export function toPosition(holding: HoldingRow, retiredQty: number, ledgerRows: readonly CostBasisLedgerLine[], lockedBy: Position["lockedBy"]): Position {
  const basis = reconstructPositionBasis(holding.assetId, holding.quantity, holding.asset.lastPrice, ledgerRows);
  return {
    assetId: holding.assetId,
    symbol: holding.asset.symbol,
    quantity: holding.quantity,
    locked: holding.locked,
    lockedBy: { orders: lockedBy.orders, otc: lockedBy.otc },
    available: Math.max(0, holding.quantity - holding.locked),
    retired: retiredQty,
    lastPrice: holding.asset.lastPrice,
    marketValue: (holding.asset.lastPrice ?? 0) * holding.quantity,
    averagePurchasePrice: basis.averagePurchasePrice,
    unrealisedPnl: basis.unrealisedPnl,
    costBasisStatus: basis.costBasisStatus,
    isScenario: holding.asset.isScenario,
  };
}

/** 账本行 → 成交详情里的账本视图(计划 §3.5 LedgerLineView):delta BigInt → number,时间转 unix ms,不外露 userId / refId */
export function toLedgerLineView(row: Pick<LedgerEntry, "id" | "account" | "delta" | "reason" | "createdAt">): LedgerLineView {
  return { id: row.id, account: row.account, delta: Number(row.delta), reason: row.reason, createdAt: row.createdAt.getTime() };
}

/**
 * avgFillPricesByOrder 每次查询带的订单 id 数(P2-13):查询是 buyOrderId IN (…) OR sellOrderId IN (…),两个列表各带这么多个参数。
 * 列表超过 Prisma 在 SQLite 上的绑定参数上限(999)时,Prisma 会把 IN 自动拆批,而这个 OR 形状拆批之后同一笔成交会被返回不止一次
 *(实测:1,000 张订单取回 1,511 行、2,000 张取回 3,967 行,应为约 1,000 / 2,000),均价因此对不上、变成 null。
 * 订单 CSV 一页 2,000 张(csv-export.ts 的 CSV_ORDER_PAGE_ROWS),所以在这里自己分批、按成交 id 去重。
 */
const AVG_FILL_CHUNK = 400;

/**
 * 按实际成交重算一批订单的均价(与 GET /api/orders 的 withExecutionPrices 同一规则):
 * 挂单方成交时 matching.ts 不更新其 avgFillPrice(行上是 null 或 taker 时的旧值),所以历史 Tab 不能直接信行;
 * 成交量与 filledQuantity 对得上才给均价,旧成交被清理或金额溢出 → null(未知,不伪造)。
 * 只查 filledQuantity > 0 的订单,每 AVG_FILL_CHUNK 张一次查询(通常一批就一次);没有则不查库。
 * 返回 Map<orderId, avg | null>,未成交的订单不在 Map 里。
 */
export async function avgFillPricesByOrder(
  db: Pick<Prisma.TransactionClient, "trade">,
  orders: readonly Pick<OrderRow, "id" | "filledQuantity">[],
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const ids = orders.filter((order) => order.filledQuantity > 0).map((order) => order.id);
  if (ids.length === 0) return result;
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += AVG_FILL_CHUNK) chunks.push(ids.slice(i, i + AVG_FILL_CHUNK));
  const found = await Promise.all(
    chunks.map((chunk) =>
      db.trade.findMany({
        where: { OR: [{ buyOrderId: { in: chunk } }, { sellOrderId: { in: chunk } }] },
        select: { id: true, buyOrderId: true, sellOrderId: true, quantity: true, price: true },
      }),
    ),
  );
  // 同一笔成交的买卖两张单可能落在不同的批里(两批都会取到它):按成交 id 去重,每笔只算一次
  const executions = new Map(found.flat().map((execution) => [execution.id, execution]));
  const totals = new Map<string, { quantity: number; cost: number }>();
  for (const execution of executions.values()) {
    for (const id of [execution.buyOrderId, execution.sellOrderId]) {
      const total = totals.get(id) ?? { quantity: 0, cost: 0 };
      total.quantity += execution.quantity;
      total.cost += execution.quantity * execution.price;
      totals.set(id, total);
    }
  }
  for (const order of orders) {
    if (order.filledQuantity <= 0) continue;
    const total = totals.get(order.id);
    const complete = total != null && total.quantity === order.filledQuantity && Number.isSafeInteger(total.cost);
    result.set(order.id, complete ? Math.round(total.cost / total.quantity) : null);
  }
  return result;
}
