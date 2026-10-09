// 本人订单与成交的筛选参数和一页数据的读取(计划 §3.4 路由表、§6.2.2 C5)。
// GET /api/account/orders、GET /api/account/fills 用它;CSV 导出(csv-export.ts)用同一组筛选、同一个读取函数一页页取,
// 所以「CSV 的行 = 同筛选下 JSON 接口翻到底的行」不靠两份查询保持一致。流水的对应模块是 ledger-activity-page.ts。
// 只在服务端用(Prisma)。
//
// 每页的成本(P2-13,终审 P2-SRV-3 / SEC-2 / P2-OPS-4):
//   - 成交:买方、卖方各一条原始查询,各走自己的 (buyerId, createdAt) / (sellerId, createdAt) 索引、从游标处倒着取够一页就停,
//     在 JS 里归并(readFillsPage)。原先的 Prisma 写法是 (buyerId = ? OR sellerId = ?) 加 OR 形式的游标,SQLite 只能把两边
//     比游标旧的行全读出来再排序,导出每一页都这样,整份导出是平方级;
//   - 订单:Order 没有 (userId, createdAt) 索引(Phase 2 不改库),每页仍要把该用户的订单读一遍再排序;CSV 导出因此用大页
//    (csv-export.ts 的 CSV_ORDER_PAGE_ROWS),全量读的次数少一个数量级。索引留给下一个允许迁移的阶段(计划 §9.1)。
//
// 条件单(P3-03):未完结行的读取(openTriggersRead / triggersFromRows)也在这里 —— 账户快照(发布器)要用它,
// 而条件单服务 triggers.ts 依赖触发引擎与 matching(matching ↔ 发布器本来就成环),放在这个只依赖 db 与映射的模块里不再加环。
import type { PrismaClient, Trigger as TriggerRow } from "@/generated/prisma";
import type { Fill, Order, Trigger } from "@/shared/types";
import { avgFillPricesByOrder, ledgerIdsByTrade, selfTradeCancelledIds, toFill, toOrder, toTrigger } from "./account-mappers";
import type { Cursor } from "./cursor";
import { prisma } from "./db";

// Map 而不是对象字面量: ?status=toString 这类原型链上的名字不能算合法状态
const STATUS_SETS = new Map<string, readonly string[]>([["open", ["OPEN", "PARTIAL"]], ["history", ["FILLED", "CANCELLED"]]]);

/** statuses:null = 不筛状态;symbol:null = 不筛标的(未知的 symbol 不算非法,查不到就是空结果) */
export type OrderFilters = { statuses: readonly string[] | null; symbol: string | null };

/** 读 ?status=open|history&symbol=。status 空串视为未传;不认识的 status → { error }(路由回 400) */
export function readOrderFilters(params: URLSearchParams): OrderFilters | { error: string } {
  const status = params.get("status") || null;
  const statuses = status ? STATUS_SETS.get(status) : undefined;
  if (status && !statuses) return { error: "Invalid status" };
  return { statuses: statuses ?? null, symbol: params.get("symbol") || null };
}

/** 键集分页 createdAt desc, id desc:取 (createdAt, id) 严格小于游标的行(条件单列表 triggers.ts 也用它) */
export const beforeCursor = (cursor: Cursor) => ({
  OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }],
});

type PageQuery = { limit: number; cursor: Cursor | null };

/**
 * 本人订单的一页。next 指向本页最后一行,没有下一页为 null(多取一行只为判断有没有下一页)。
 * 挂单方成交不更新行上的 avgFillPrice,按实际成交重算(与 GET /api/orders 同一规则);
 * 被自成交防护撤掉的限价单从 SELF_TRADE_UNLOCK 流水认出来(cancelReason SELF_TRADE,不显示成「用户撤单」)。
 */
export async function readOrdersPage(userId: string, filters: OrderFilters, page: PageQuery): Promise<{ orders: Order[]; next: Cursor | null }> {
  const rows = await prisma.order.findMany({
    where: {
      userId,
      ...(filters.statuses ? { status: { in: [...filters.statuses] } } : {}),
      ...(filters.symbol ? { asset: { symbol: filters.symbol } } : {}),
      ...(page.cursor ? beforeCursor(page.cursor) : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: page.limit + 1,
    include: { asset: { select: { symbol: true } } },
  });
  const pageRows = rows.slice(0, page.limit);
  const last = rows.length > page.limit ? pageRows[pageRows.length - 1] : null;
  const [avg, selfTraded] = await Promise.all([avgFillPricesByOrder(prisma, pageRows), selfTradeCancelledIds(prisma, pageRows)]);
  return {
    orders: pageRows.map((row) => toOrder(row, avg.has(row.id) ? avg.get(row.id) : undefined, selfTraded)),
    next: last ? { createdAt: last.createdAt.getTime(), id: last.id } : null,
  };
}

/** toFill 需要的形状(TradeRow):symbol + 买卖两张订单的存根,takerSide 由 takerSideOf 派生,不落列 */
const TRADE_ROW_INCLUDE = {
  asset: { select: { symbol: true } },
  buyOrder: { select: { id: true, type: true, price: true, createdAt: true } },
  sellOrder: { select: { id: true, type: true, price: true, createdAt: true } },
} as const;

/** Date 能表示的最大毫秒数 + 1:没有游标时的「无上界」(与 cursor.ts、ledger-activity-page.ts 同一个数) */
const NO_UPPER = 8.64e15 + 1;

type FillKey = { id: string; ts: bigint | number };
type FillKeyQuery = {
  userId: string;
  /** createdAt 唯一的上界(不含):游标时刻 + 1,没有游标为 NO_UPPER。只绑一个上界,索引才按它定位(见 ledger-activity-page.ts) */
  upper: number;
  /** 游标那一毫秒里已经给过的行由 (createdAt < cursorTs OR id < cursorId) 过滤掉;这一条只是过滤,不参与定位 */
  cursorTs: number;
  cursorId: string;
  /** null = 不筛标的 */
  assetId: string | null;
  take: number;
};

/**
 * 本人作为买方 / 卖方的成交,各一条:(buyerId | sellerId, createdAt) 索引从 upper 起按时间倒着走,够 take 行就停,
 * 成本只跟页大小有关,跟这个用户的成交总数、翻到第几页都无关(同一毫秒里的 id 排序只在那一毫秒的几行里做)。
 * 两条写成两份而不是拼列名:原始 SQL 只用扁平参数,不嵌套 Prisma.sql 片段(跨打包产物会失效)。createdAt 是整数毫秒,直接和数字比。
 */
const buyerFillKeys = (q: FillKeyQuery) => prisma.$queryRaw<FillKey[]>`
  SELECT t."id" AS id, CAST(t."createdAt" AS INTEGER) AS ts FROM "Trade" t
  WHERE t."buyerId" = ${q.userId} AND t."createdAt" < ${q.upper}
    AND (t."createdAt" < ${q.cursorTs} OR t."id" < ${q.cursorId})
    AND (${q.assetId} IS NULL OR t."assetId" = ${q.assetId})
  ORDER BY t."createdAt" DESC, t."id" DESC
  LIMIT ${q.take}`;
const sellerFillKeys = (q: FillKeyQuery) => prisma.$queryRaw<FillKey[]>`
  SELECT t."id" AS id, CAST(t."createdAt" AS INTEGER) AS ts FROM "Trade" t
  WHERE t."sellerId" = ${q.userId} AND t."createdAt" < ${q.upper}
    AND (t."createdAt" < ${q.cursorTs} OR t."id" < ${q.cursorId})
    AND (${q.assetId} IS NULL OR t."assetId" = ${q.assetId})
  ORDER BY t."createdAt" DESC, t."id" DESC
  LIMIT ${q.take}`;

/**
 * 两边各自的前 take 行 → 全局的前 take 行(createdAt desc, id desc)。同一笔成交两边都有(买卖双方都是本人)时只留一次。
 * 每一边的前 take 行里一定包含全局前 take 行中属于这一边的那些,所以归并结果就是全局的前 take 行;
 * id 是 cuid(ASCII),JS 的字符串比较与 SQLite 的 BINARY 排序一致。
 */
export function mergeFillKeys(buyer: readonly FillKey[], seller: readonly FillKey[], take: number): { id: string; ts: number }[] {
  const byId = new Map<string, number>();
  for (const row of [...buyer, ...seller]) byId.set(row.id, Number(row.ts));
  return [...byId]
    .map(([id, ts]) => ({ id, ts }))
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
    .slice(0, take);
}

/**
 * 本人是买方或卖方的成交的一页,从本人视角映射(side / role / orderId)。
 * 先按两边的键集查询取出这一页的 id(见 buyerFillKeys),再按主键取整行(≤ limit 行),顺序以归并结果为准。
 * ledgerRefs:要不要查本人在这些成交下的账本行 id(一批一次查询)。JSON 接口要;CSV 没有这一列,不查,Fill.ledgerRefs 为 []。
 * 未知的 symbol 不算非法:查不到这个标的就是空结果(与 /api/account/orders 一致)。
 */
export async function readFillsPage(
  userId: string,
  filters: { symbol: string | null },
  page: PageQuery,
  options: { ledgerRefs: boolean },
): Promise<{ fills: Fill[]; next: Cursor | null }> {
  const asset = filters.symbol ? await prisma.asset.findUnique({ where: { symbol: filters.symbol }, select: { id: true } }) : null;
  if (filters.symbol && !asset) return { fills: [], next: null };
  const query: FillKeyQuery = {
    userId,
    upper: page.cursor ? page.cursor.createdAt + 1 : NO_UPPER,
    cursorTs: page.cursor?.createdAt ?? NO_UPPER,
    cursorId: page.cursor?.id ?? "",
    assetId: asset?.id ?? null,
    take: page.limit + 1, // 多取一行只为判断有没有下一页
  };
  // 一个批量事务里读:两边看到的是同一个提交点
  const [buyer, seller] = await prisma.$transaction([buyerFillKeys(query), sellerFillKeys(query)]);
  const keys = mergeFillKeys(buyer, seller, page.limit + 1);
  const pageKeys = keys.slice(0, page.limit);
  const last = keys.length > page.limit ? pageKeys[pageKeys.length - 1] : null;
  const rows = pageKeys.length ? await prisma.trade.findMany({ where: { id: { in: pageKeys.map((key) => key.id) } }, include: TRADE_ROW_INCLUDE }) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  // 成交行不改不删(机器人清理只删买卖双方都是机器人的成交),取整行时这一页的 id 都还在;万一缺了就跳过,不让整页失败
  const pageRows = pageKeys.flatMap((key) => {
    const row = byId.get(key.id);
    return row ? [row] : [];
  });
  const ledgerIds = options.ledgerRefs ? await ledgerIdsByTrade(prisma, userId, pageRows.map((trade) => trade.id)) : null;
  return {
    fills: pageRows.map((trade) => toFill(trade, userId, ledgerIds?.get(trade.id))),
    next: last ? { createdAt: last.ts, id: last.id } : null,
  };
}

// ---- 条件单(P3-03,计划 §6.3.2 C2 / C3)----

/** 未完结的条件单状态:GET /api/account/triggers?status=open、账户快照与「每人至多 50 条」同一口径 */
export const OPEN_TRIGGER_STATUSES: readonly string[] = ["PENDING", "TRIGGERING"];

/** 条件单行带上标的 symbol(toTrigger 要它):快照、条件单服务与触发引擎的查询都用这一个 include */
export const TRIGGER_WITH_SYMBOL = { asset: { select: { symbol: true } } } as const;
export type TriggerRowWithSymbol = TriggerRow & { asset: { symbol: string } };

/** 未完结的条件单,新的在前(与 ?status=open 同序);返回未执行的查询,账户快照把它和余额、挂单、持仓放进同一个批量事务 */
export function openTriggersRead(db: PrismaClient, userId: string) {
  return db.trigger.findMany({
    where: { userId, status: { in: [...OPEN_TRIGGER_STATUSES] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: TRIGGER_WITH_SYMBOL,
  });
}

export const triggersFromRows = (rows: readonly TriggerRowWithSymbol[]): Trigger[] => rows.map((row) => toTrigger(row, row.asset.symbol));
