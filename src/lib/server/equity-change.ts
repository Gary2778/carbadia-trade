// 账户 24 小时资产变化(计划 §6.2.2 C6、§9.2 D29):请求时从账本倒推,不建表、不写库、没有后台循环。
//
// 记 T = since(现在往前 24 小时,再向下对齐到 10 分钟)。某个账户量在 T 时刻的值 = 现值 − T 之后该账户的账本 delta 之和
//(人类用户的账本行永久保留、只追加,所以是精确的):
//   E(T)   = cash(T) + lockedCash(T) + Σ qty_a(T) × price_a(T)      price_a(T) = 标的 a 在 T 及之前最后一笔撮合成交价
//   E(now) = cash + lockedCash + Σ qty_a × Asset.lastPrice          与 computeAccountTotals 的 totalAssets 同一口径
//   G      = T 之后的赠予:reason GRANT / SEED / MIGRATION_BASELINE 的正行 —— CASH 与 CASH_LOCKED 两个账户都算、按面额
//            (MIGRATION_BASELINE 给冻结现金也写了基线行,只算 CASH 会把它当成盈利),HOLDING 按现价折算
//   R      = T 之后注销的数量 × 现价(注销减了持仓、不收现金,不算亏损)。数量取自账本的 SIMULATED_RETIREMENT 行
//            (正是倒推时加回去的那一行),不读 Retirement 表
//   amount = (E(now) + R) − (E(T) + G),baseline = E(T) + G,pct = baseline > 0 ? amount / baseline : null
// 需要的价格有一个取不到 → 整个结果为 null;倒推出负的余额或数量(账本与列对不上)→ null,不给一个错的数;
// 机器人与没有任何账本行的用户 → null。
//
// 已确认的口径(2026-10-01,计划 §6.2.2 C6 同步写明):
//   - T 对齐到 10 分钟:price_a(T) 于是可以按 (T, 标的) 在进程内缓存、所有用户共用(历史成交不会变),数量与价格取的也是同一个时刻;
//     对齐后的 T 作为 since 返回。窗口因此是 24 小时到 24 小时 10 分之间。
//   - pct 是小数比例(0.0123 = +1.23%),与 Ticker.change24h 的百分数不同,界面渲染时乘 100。
//   - R 按现价折算,所以窗口内注销掉的份额在注销后最多 24 小时里仍随价格浮动(满 24 小时后退出窗口)。这个数是账户的
//     「24 小时变化」,界面文案不能把它叫成持仓盈亏。
//   - 现在与 T 时刻用的是两种价格定义(已知偏差,P2-13 只写明、不改算法;终审 P2-SRV-1):现在的价是 Asset.lastPrice ——
//     撮合时写入的是整张 taker 单的成交均价(matching.ts),OTC 成交写入挂牌价(otc.ts);T 时刻的价是 T 及之前最后一笔
//     Trade 行的价格(单笔)。一张 taker 单在多个价位成交时两者不同(本地库实测:成交价不同的 taker 单里平均差约 0.14%,
//     最大约 1.5%),所以没有任何交易的持有者也可能看到一个不来自价格变动的小幅非零变化,方向不定(买方扫单的末笔高于均价,
//     卖方低于)。这与 Phase 1 行情 change24h 的做法一致(stats24h:窗口首笔成交价对 Asset.lastPrice)。后续若要同一定义:
//     T 时刻也按 taker 单均价取(找 T 及之前最后一笔成交的 taker 单 —— buyOrderId / sellOrderId 里较晚创建的那张,与
//     takerSideOf 同一判定 —— 取它在 T 及之前的成交的 round(Σ价 × 量 / Σ量)),仍用扁平参数、仍按 (T, 标的) 缓存。
//
// 查询(都只用现有索引,EXPLAIN QUERY PLAN 见 equity-change.integration.test.ts):
//   - 窗口内账本按(账户, 标的, 类别)汇总:LedgerEntry (userId, account, createdAt);
//   - 有没有账本行:同一个索引的 userId 前缀;
//   - 各标的 T 时刻的价格:json_each 逐个标的去 Trade (assetId, createdAt) 上取最后一行。
// 原始 SQL 只用扁平参数(标的集合走 JSON + json_each),不嵌套 Prisma.sql;createdAt 在 SQLite 里是整数毫秒,直接和数字比
//(上线前用 scripts/prod/postflight.cjs 的 ledgerCreatedAtTypes 核对 LedgerEntry 与 Trade 两张表只有 integer)。
import type { PrismaClient } from "../../generated/prisma";
import type { EquityChange } from "../../shared/api-shapes";
import type { Balance } from "../../shared/types";

export const EQUITY_WINDOW_MS = 24 * 3_600_000;
export const EQUITY_BUCKET_MS = 10 * 60_000;
/** 价格缓存的条目上限:正常只有「当前这个桶 × 被人持有的标的」十几条;超出即清空重来(只影响多查一次库) */
export const EQUITY_PRICE_CACHE_MAX = 1024;

declare global {
  /**
   * 各标的在某个基准时刻的价格:key = "<since>:<assetId>",值 = 该时刻及之前最后一笔成交价(分),没有成交为 null。
   * 本模块会被打进不止一个 bundle,模块级的 Map 每个 bundle 一份;挂 globalThis 才是全进程一份。纯数据,只有本模块读写
   */
  var __carbadiaEquityPrices: Map<string, number | null> | undefined;
}

/** 基准时刻:now − 24 h,向下对齐到 10 分钟 */
export function equitySince(now: number): number {
  return Math.floor((now - EQUITY_WINDOW_MS) / EQUITY_BUCKET_MS) * EQUITY_BUCKET_MS;
}

/** 窗口内一组账本行的类别:GRANT(赠予的正行)、RETIRE(注销)、OTHER(其余一切);equityReads 的 CASE 只产出这三个 */
export type EquityWindowKind = "GRANT" | "RETIRE" | "OTHER";
const WINDOW_KINDS: ReadonlySet<string> = new Set<EquityWindowKind>(["GRANT", "RETIRE", "OTHER"]);
/**
 * 窗口内账本的一组汇总;delta 是这一组的和(分或吨)。
 * 行来自原始 SQL,类型只是声明:运行时 kind 若不是这三个值之一(SQL 与这里的类型走岔了),foldWindow 判定整个倒推不可用 → null,
 * 不把认不得的类别悄悄当成 OTHER。
 */
export type EquityWindowRow = { account: string; assetId: string | null; kind: EquityWindowKind; delta: number | bigint };
/** 一行持仓的现值:数量含锁定部分;lastPrice 是 Asset.lastPrice */
export type EquityHolding = { assetId: string; quantity: number; lastPrice: number | null };
export type EquityInputs = {
  since: number;
  balance: Balance;
  /** 该用户的全部 Holding 行(数量为 0 的也要:窗口内卖光 / 注销光的标的在 T 时刻还持有) */
  holdings: readonly EquityHolding[];
  windowRows: readonly EquityWindowRow[];
  /** 该用户有没有任何账本行;没有就无从倒推 */
  hasLedger: boolean;
};
/** 倒推的四个分量(整数分);EquityChange 由它们得出,测试也直接对 equityThen 断言 */
export type EquityReplay = { since: number; equityNow: number; equityThen: number; grants: number; retired: number };

/**
 * 倒推需要的两个读取,未执行(由调用方放进批量事务,与余额、持仓同一个提交点):
 *   0 since 之后本人 CASH / CASH_LOCKED / HOLDING 三个账户的账本,按(账户, 标的, 类别)汇总。不设上界:现值包含读取那一刻之前的
 *     全部变动,要减掉的就是 since 之后的全部;HOLDING_LOCKED 不参与(Holding.quantity 已含锁定部分);
 *   1 本人任意一行账本(只看有没有)。
 */
export function equityReads(db: PrismaClient, userId: string, since: number) {
  return [
    db.$queryRaw<EquityWindowRow[]>`
      SELECT l."account" AS account, l."assetId" AS assetId,
        CASE WHEN l."reason" IN ('GRANT', 'SEED', 'MIGRATION_BASELINE') AND l."delta" > 0 THEN 'GRANT'
             WHEN l."reason" = 'SIMULATED_RETIREMENT' THEN 'RETIRE'
             ELSE 'OTHER' END AS kind,
        SUM(l."delta") AS delta
      FROM "LedgerEntry" l
      WHERE l."userId" = ${userId} AND l."account" IN ('CASH', 'CASH_LOCKED', 'HOLDING') AND l."createdAt" > ${since}
      GROUP BY l."account", l."assetId", kind`,
    db.ledgerEntry.findFirst({ where: { userId }, select: { id: true } }),
  ] as const;
}

type AssetReplay = { qtyNow: number; qtyThen: number; granted: number; retired: number; priceNow: number | null };
type Folded = { cashThen: number; lockedThen: number; grantedCash: number; assets: Map<string, AssetReplay> };

/** 现值减去窗口内的变动 → T 时刻的现金与各标的数量,连同窗口内的赠予与注销。类别认不得、任何一个数不是安全整数、或倒推出负数 → null */
function foldWindow(input: EquityInputs): Folded | null {
  const assets = new Map<string, AssetReplay>();
  const assetOf = (assetId: string): AssetReplay => {
    let entry = assets.get(assetId);
    if (!entry) {
      entry = { qtyNow: 0, qtyThen: 0, granted: 0, retired: 0, priceNow: null };
      assets.set(assetId, entry);
    }
    return entry;
  };
  for (const holding of input.holdings) {
    const entry = assetOf(holding.assetId);
    entry.qtyNow = holding.quantity;
    entry.qtyThen = holding.quantity;
    entry.priceNow = holding.lastPrice;
  }

  let cashThen = input.balance.cashBalance;
  let lockedThen = input.balance.lockedCash;
  let grantedCash = 0;
  for (const row of input.windowRows) {
    if (!WINDOW_KINDS.has(row.kind)) return null; // 认不得的类别:不知道该不该算赠予 / 注销,整个倒推不可用
    const delta = Number(row.delta);
    if (!Number.isSafeInteger(delta)) return null;
    if (row.account === "CASH" || row.account === "CASH_LOCKED") {
      if (row.account === "CASH") cashThen -= delta;
      else lockedThen -= delta;
      if (row.kind === "GRANT") grantedCash += delta;
    } else if (row.account === "HOLDING" && row.assetId != null) {
      const entry = assetOf(row.assetId);
      entry.qtyThen -= delta;
      if (row.kind === "GRANT") entry.granted += delta;
      else if (row.kind === "RETIRE") entry.retired -= delta; // 注销是负行
    }
  }

  const numbers = [cashThen, lockedThen, grantedCash, ...[...assets.values()].flatMap((a) => [a.qtyNow, a.qtyThen, a.granted, a.retired])];
  if (numbers.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return { cashThen, lockedThen, grantedCash, assets };
}

/** 估值:现在持有、窗口内获赠或注销过的标的要有现价;T 时刻持有的标的要有 T 时刻的价格。缺一个就是 null */
function valueReplay(input: EquityInputs, folded: Folded, priceThen: ReadonlyMap<string, number | null>): EquityReplay | null {
  let equityNow = input.balance.cashBalance + input.balance.lockedCash;
  let equityThen = folded.cashThen + folded.lockedThen;
  let grants = folded.grantedCash;
  let retired = 0;
  for (const [assetId, asset] of folded.assets) {
    if (asset.qtyNow > 0 || asset.granted > 0 || asset.retired > 0) {
      if (asset.priceNow == null) return null;
      equityNow += asset.qtyNow * asset.priceNow;
      grants += asset.granted * asset.priceNow;
      retired += asset.retired * asset.priceNow;
    }
    if (asset.qtyThen > 0) {
      const price = priceThen.get(assetId) ?? null;
      if (price == null) return null;
      equityThen += asset.qtyThen * price;
    }
  }
  if (![equityNow, equityThen, grants, retired].every(Number.isSafeInteger)) return null;
  return { since: input.since, equityNow, equityThen, grants, retired };
}

/**
 * 各标的在 since 及之前的最后一笔撮合成交价(同一毫秒多笔时取 id 最大的,与 stats24h 取首笔的排序相反);没有成交为 null。
 * 先看进程内缓存,缺的一次查出:json_each 在外层,每个标的在 Trade (assetId, createdAt) 索引上取一行。
 * 查询在事务之外:since 之前的成交是历史,不会再变(null 也缓存:since 之前没有成交,以后也不会有)。
 */
async function pricesAt(db: PrismaClient, assetIds: readonly string[], since: number): Promise<Map<string, number | null>> {
  const cache = (globalThis.__carbadiaEquityPrices ??= new Map());
  const prices = new Map<string, number | null>();
  const missing: string[] = [];
  for (const assetId of assetIds) {
    const key = `${since}:${assetId}`;
    if (cache.has(key)) prices.set(assetId, cache.get(key) ?? null);
    else missing.push(assetId);
  }
  if (missing.length === 0) return prices;

  const rows = await db.$queryRaw<{ assetId: string; price: number | bigint | null }[]>`
    SELECT a.value AS assetId,
      (SELECT t."price" FROM "Trade" t WHERE t."assetId" = a.value AND t."createdAt" <= ${since}
        ORDER BY t."createdAt" DESC, t."id" DESC LIMIT 1) AS price
    FROM json_each(${JSON.stringify(missing)}) a`;
  if (cache.size + rows.length > EQUITY_PRICE_CACHE_MAX) cache.clear();
  for (const row of rows) {
    const price = row.price == null ? null : Number(row.price);
    cache.set(`${since}:${row.assetId}`, price);
    prices.set(row.assetId, price);
  }
  return prices;
}

/** 已经读好的现值与窗口汇总 → 倒推的四个分量。只为 T 时刻持有的标的查价格(走缓存) */
export async function equityReplayFrom(db: PrismaClient, input: EquityInputs): Promise<EquityReplay | null> {
  if (!input.hasLedger) return null;
  const folded = foldWindow(input);
  if (!folded) return null;
  const heldThen = [...folded.assets].flatMap(([assetId, asset]) => (asset.qtyThen > 0 ? [assetId] : []));
  return valueReplay(input, folded, await pricesAt(db, heldThen, input.since));
}

/** 四个分量 → EquityChange。pct 是小数比例(amount / baseline),不是百分数 */
export function toEquityChange(replay: EquityReplay | null): EquityChange | null {
  if (!replay) return null;
  const baseline = replay.equityThen + replay.grants;
  const amount = replay.equityNow + replay.retired - baseline;
  return { amount, pct: baseline > 0 ? amount / baseline : null, baseline, since: replay.since };
}

/**
 * 一个用户的倒推分量:余额、全部持仓行(带现价)与窗口汇总在同一个批量事务里读(同一个提交点)。
 * 用户不存在、是机器人(成交与账本只保留 7 天,而且不是会话主体)→ null。
 */
export async function loadEquityReplay(db: PrismaClient, userId: string, now: number = Date.now()): Promise<EquityReplay | null> {
  const since = equitySince(now);
  const [user, holdings, windowRows, anyLedger] = await db.$transaction([
    db.user.findUnique({ where: { id: userId }, select: { cashBalance: true, lockedCash: true, isBot: true } }),
    db.holding.findMany({ where: { userId }, select: { assetId: true, quantity: true, asset: { select: { lastPrice: true } } } }),
    ...equityReads(db, userId, since),
  ]);
  if (!user || user.isBot) return null;
  return equityReplayFrom(db, {
    since,
    balance: { cashBalance: Number(user.cashBalance), lockedCash: Number(user.lockedCash) }, // BigInt → number
    holdings: holdings.map((holding) => ({ assetId: holding.assetId, quantity: holding.quantity, lastPrice: holding.asset.lastPrice })),
    windowRows,
    hasLedger: anyLedger != null,
  });
}

/** 一个用户的 24 小时资产变化;算不出为 null(见文件头)。GET /api/account/overview 把读取并进自己的事务,用的是 equityReads + equityReplayFrom */
export async function loadEquityChange(db: PrismaClient, userId: string, now: number = Date.now()): Promise<EquityChange | null> {
  return toEquityChange(await loadEquityReplay(db, userId, now));
}
