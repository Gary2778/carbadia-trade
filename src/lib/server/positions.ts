// 持仓读取(计划 §6.2.2 C1):REST(GET /api/account/positions)、WS 的 account 订阅快照、position 事件共用这一份查询与映射,
// 四处(加上客户端 store)的口径因此相同:
//   - 行 = 数量 > 0 的持仓,加上整仓注销的持仓(数量 0、retired > 0;注销只减 Holding.quantity,行还在);
//     卖光且从没注销过的行(数量 0、retired 0)不在列表里,只有事件路径(includeEmpty)带上它,客户端靠这一行把持仓清掉;
//   - retired = Retirement 按 assetId 汇总;
//   - lockedBy = locked 的来源拆分,直接读 Order 与 OtcListing(不回放账本,D31);
//   - 成本经 reconstructPositionBasis 从本人账本重建(account-mappers 的 toPosition)。
// 五个读取是未执行的 PrismaPromise(positionReads),由调用方放进同一个批量事务:看到的是同一个提交点,持仓、账本、注销与锁定来源之间
// 不夹进别的成交;REST 与快照还把余额(快照另有挂单)放进同一个事务。批量事务(不是交互式事务):SQLite 单连接下交互式事务每条语句
// 之间都要回一次事件循环,占着唯一的连接。
// 查询只用 Prisma 的查询构造器,没有原始 SQL(本仓库的规矩:若要写 $queryRaw,只用扁平参数,不嵌套 Prisma.sql)。
import type { PrismaClient } from "../../generated/prisma";
import type { Position } from "../../shared/types";
import { toPosition } from "./account-mappers";

export type LoadPositionsOptions = {
  /** 只读这些标的(事件路径:成交 / 撤单 / OTC / 注销之后的那一行);不传 = 该用户的全部持仓 */
  assetIds?: readonly string[];
  /** 连空行(数量 0、retired 0)也返回:position 事件要用这一行让客户端把卖光的持仓清掉。默认 false(列表口径) */
  includeEmpty?: boolean;
};

/** 成本重建用到的现金结算行的 reason(与 /api/portfolio 同一筛选) */
const COST_BASIS_CASH_REASONS = ["TRADE_SETTLE", "OTC_SETTLE", "PRICE_IMPROVE_REFUND"];
const LEDGER_LINE_SELECT = { id: true, account: true, assetId: true, delta: true, reason: true, refType: true, refId: true, createdAt: true } as const;
/** 按引用取现金行时每批的 id 数:SQLite 的绑定参数有上限,IN 列表分批 */
const CASH_REF_CHUNK = 500;
/** 未完结的挂单状态(Order.status 是自由 TEXT,matching.ts 只写这几个字面量) */
const RESTING_STATUSES = ["OPEN", "PARTIAL"];

/**
 * 持仓的五个读取,未执行(由调用方放进批量事务):
 *   0 持仓行(不按数量筛:一个用户最多十几行,数量 0 的行在映射时按 retired 取舍 —— Retirement 与 Holding 之间没有关系,查询里筛不了);
 *   1 成本重建需要的账本行。不传 assetIds = 全部持仓行 + 全部现金结算行;传 assetIds = 只取这些标的的持仓行,
 *     现金行随后由 settlementCashRows 按这些行的引用去取(终审 P1-25a:不为一笔成交整本读用户的现金账);
 *   2 注销按标的汇总;
 *   3 本人未完结 SELL 挂单按标的汇总(数量与已成交数量之和,差 = 挂单锁定;走 (userId, status) 或 (assetId, side, status) 索引);
 *   4 本人 ACTIVE 场外挂牌按标的汇总(OtcListing 没有 sellerId 索引:不传 assetIds 时是一次全表扫描,与 GET /api/otc 列出全部
 *     ACTIVE 挂牌同一量级 —— 挂牌只由用户手动创建,表很小;Phase 2 不改数据库结构)。
 */
export function positionReads(db: PrismaClient, userId: string, opts: LoadPositionsOptions = {}) {
  const asset = opts.assetIds ? { assetId: { in: [...opts.assetIds] } } : {};
  return [
    db.holding.findMany({
      where: { userId, ...asset },
      include: { asset: { select: { symbol: true, lastPrice: true, isScenario: true } } },
      orderBy: { asset: { symbol: "asc" } },
    }),
    db.ledgerEntry.findMany({
      where: opts.assetIds
        ? { userId, account: "HOLDING", ...asset }
        : { userId, OR: [{ account: "HOLDING" }, { account: { in: ["CASH", "CASH_LOCKED"] }, reason: { in: COST_BASIS_CASH_REASONS } }] },
      select: LEDGER_LINE_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    db.retirement.groupBy({ by: ["assetId"], where: { userId, ...asset }, _sum: { quantity: true }, orderBy: { assetId: "asc" } }),
    db.order.groupBy({
      by: ["assetId"],
      where: { userId, side: "SELL", status: { in: RESTING_STATUSES }, ...asset },
      _sum: { quantity: true, filledQuantity: true },
      orderBy: { assetId: "asc" },
    }),
    db.otcListing.groupBy({ by: ["assetId"], where: { sellerId: userId, status: "ACTIVE", ...asset }, _sum: { quantity: true }, orderBy: { assetId: "asc" } }),
  ] as const;
}

type PositionReads = ReturnType<typeof positionReads>;
/** positionReads 的五个结果(批量事务返回的那一段) */
export type PositionRows = [Awaited<PositionReads[0]>, Awaited<PositionReads[1]>, Awaited<PositionReads[2]>, Awaited<PositionReads[3]>, Awaited<PositionReads[4]>];
type LedgerLine = PositionRows[1][number];

/**
 * 这些标的的买入(正向持仓行,引用 TRADE / DEAL)对应的现金结算行:reconstructPositionBasis 只用引用出现在该标的买入里的现金行,
 * 所以按这些引用去取,结果与整本现金账逐字段一致。不必和持仓行放进同一个批量事务:同一引用的现金行与持仓行在同一个事务里写入,
 * 账本只追加不改,看得到持仓行就看得到它的现金行;之后才提交的引用本来就不在要取的列表里。
 * 查询计划(P1-25a 复审):where 里只有 (refType, refId) 这一组能用上索引,userId 在 JS 里筛 —— where 带着 userId 时,SQLite 在
 * 没有 sqlite_stat1(生产丢过一次)的库上会选 (userId, account, createdAt) 索引,把用户的整本现金账走一遍;加上 refType 也不改变这个选择
 *(P1-25e 用 EXPLAIN QUERY PLAN 实测,见 market-publisher.integration.test.ts)。refId 引用的是同一笔成交 / OTC 成交,多取回来的
 * 只是对手方在这几笔上的现金行(每笔一两行),筛掉即可;refType 条件不改变结果(这些 refId 只出现在 TRADE / DEAL 流水上)。
 */
async function settlementCashRows(db: PrismaClient, userId: string, holdingLines: readonly LedgerLine[]): Promise<LedgerLine[]> {
  const refIds = [
    ...new Set(
      holdingLines.flatMap((line) => (Number(line.delta) > 0 && (line.refType === "TRADE" || line.refType === "DEAL") && line.refId ? [line.refId] : [])),
    ),
  ];
  const chunks: string[][] = [];
  for (let i = 0; i < refIds.length; i += CASH_REF_CHUNK) chunks.push(refIds.slice(i, i + CASH_REF_CHUNK));
  const rows = await Promise.all(
    chunks.map((ids) =>
      db.ledgerEntry.findMany({
        where: { refType: { in: ["TRADE", "DEAL"] }, refId: { in: ids }, account: { in: ["CASH", "CASH_LOCKED"] }, reason: { in: COST_BASIS_CASH_REASONS } },
        select: { ...LEDGER_LINE_SELECT, userId: true },
      }),
    ),
  );
  return rows.flat().flatMap(({ userId: owner, ...line }) => (owner === userId ? [line] : []));
}

/** 同一 (用户, 标的) 的 lockedBy 不一致日志至少隔这么久才再记一行(每 5 s 一轮的轮询不该刷屏);全进程一份,见 __carbadiaLockMismatchLog */
const LOCK_MISMATCH_LOG_MS = 10 * 60_000;
/** 记过的键的上限;超出即清空重来(只影响日志频率) */
const LOCK_MISMATCH_KEYS_MAX = 512;

declare global {
  /**
   * lockedBy 不一致日志的节流表:key = "userId:assetId",值 = 上次记日志的时刻(ms)。本模块被打进 instrumentation、route handler
   * 等几个 bundle,模块级的 Map 每个 bundle 一份、各节流各的;挂 globalThis 才是同一(用户, 标的)全进程每 10 分钟一行。
   * 纯数据,只有本模块读写
   */
  var __carbadiaLockMismatchLog: Map<string, number> | undefined;
}

function lockMismatchLog(): Map<string, number> {
  return (globalThis.__carbadiaLockMismatchLog ??= new Map());
}

/**
 * orders + otc 与 Holding.locked 对不上:五个读取在同一个事务里,所以不是读到一半的中间态,而是数据本身不一致(历史遗留或缺陷)。
 * 以 locked 为准(available 照旧按它算),不抛错,记一行:只带 userId 尾号与 assetId,不带数量与别的字段。
 */
function warnLockMismatch(userId: string, assetId: string): void {
  const log = lockMismatchLog();
  const key = `${userId}:${assetId}`;
  const now = Date.now();
  const last = log.get(key);
  if (last !== undefined && now - last < LOCK_MISMATCH_LOG_MS) return;
  if (log.size >= LOCK_MISMATCH_KEYS_MAX) log.clear();
  log.set(key, now);
  console.warn(`[positions] lockedBy does not add up to locked user=…${userId.slice(-6)} asset=${assetId}`);
}

/**
 * positionReads 的结果 → Position[](按 symbol 升序,与查询同序)。传了 assetIds 时另按引用补取现金结算行(所以是异步的)。
 * 行的取舍见文件头:默认只留 quantity > 0 或 retired > 0 的行;includeEmpty 时空行也留。
 */
export async function positionsFromRows(db: PrismaClient, userId: string, rows: PositionRows, opts: LoadPositionsOptions = {}): Promise<Position[]> {
  const [holdings, holdingLedger, retired, sellOrders, listings] = rows;
  const ledger = opts.assetIds ? [...holdingLedger, ...(await settlementCashRows(db, userId, holdingLedger))] : holdingLedger;
  const retiredByAsset = new Map(retired.map((row) => [row.assetId, row._sum?.quantity ?? 0]));
  const ordersByAsset = new Map(sellOrders.map((row) => [row.assetId, (row._sum?.quantity ?? 0) - (row._sum?.filledQuantity ?? 0)]));
  const otcByAsset = new Map(listings.map((row) => [row.assetId, row._sum?.quantity ?? 0]));
  const positions: Position[] = [];
  for (const holding of holdings) {
    const retiredQty = retiredByAsset.get(holding.assetId) ?? 0;
    if (!opts.includeEmpty && holding.quantity <= 0 && retiredQty <= 0) continue;
    const lockedBy = { orders: ordersByAsset.get(holding.assetId) ?? 0, otc: otcByAsset.get(holding.assetId) ?? 0 };
    if (lockedBy.orders + lockedBy.otc !== holding.locked) warnLockMismatch(userId, holding.assetId);
    positions.push(toPosition(holding, retiredQty, ledger, lockedBy));
  }
  return positions;
}

/**
 * 一个用户的持仓(含整仓注销的行与锁定来源)。REST、WS 快照与 position 事件都经这里或经 positionReads + positionsFromRows
 *(要把余额 / 挂单放进同一个事务的调用方用后者)。
 */
export async function loadPositions(db: PrismaClient, userId: string, opts: LoadPositionsOptions = {}): Promise<Position[]> {
  const rows = await db.$transaction([...positionReads(db, userId, opts)]);
  return positionsFromRows(db, userId, rows, opts);
}
