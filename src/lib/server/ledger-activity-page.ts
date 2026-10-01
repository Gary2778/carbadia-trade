// 流水的筛选参数、limit 规则与一页数据的读取(计划 §6.2.2 C4)。GET /api/transactions 用它;CSV 导出(C5,P2-06)用同一组筛选、同一个读取函数一页页取。
// 只在服务端用(Prisma);分类规则在 src/lib/exchange/ledger-activity.ts。
import { z } from "zod";
import type { LedgerActivity, LedgerActivityResponse } from "@/shared/api-shapes";
import { ACTIVITY_TYPES, LEDGER_ACCOUNTS, activityFilter, activityOf, type ActivityType, type LedgerAccount } from "../exchange/ledger-activity";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, encodeCursor, type Cursor } from "./cursor";
import { prisma } from "./db";

/** Date 能表示的最大毫秒数;from / to 超出即非法(与 cursor.ts 对游标的上界同一个数) */
const MAX_DATE_MS = 8.64e15;

export type LedgerFilters = { account?: LedgerAccount; type?: ActivityType; symbol?: string; from?: number; to?: number };

const msParam = (name: "from" | "to") => {
  const message = `Invalid ${name}: must be a millisecond timestamp (integer, 0 to 8.64e15)`;
  return z.string().regex(/^\d{1,16}$/, message).transform(Number).refine((ms) => ms <= MAX_DATE_MS, message).optional();
};

const filtersSchema = z
  .object({
    account: z.enum(LEDGER_ACCOUNTS, `Invalid account: must be one of ${LEDGER_ACCOUNTS.join(", ")}`).optional(),
    type: z.enum(ACTIVITY_TYPES, `Invalid type: must be one of ${ACTIVITY_TYPES.join(", ")}`).optional(),
    symbol: z.string().max(64, "Invalid symbol: at most 64 characters").optional(),
    from: msParam("from"),
    to: msParam("to"),
  })
  .refine(({ from, to }) => from === undefined || to === undefined || from < to, "Invalid from / to: from must be earlier than to");

/** 空串视为没传(与 /api/account/orders 对 status 的处理一致) */
const given = (params: URLSearchParams, name: string) => params.get(name) || undefined;

/**
 * 读 ?account=&type=&symbol=&from=&to=。非法值 → { error }(路由回 400,信息点名是哪个参数):
 * account / type 不在枚举里、from / to 不是 0..8.64e15 的整数毫秒、from 不早于 to、symbol 超长。
 * 未知的 symbol 不算非法:查不到这个标的就是空结果(与 /api/account/orders、fills 一致)。
 */
export function readLedgerFilters(params: URLSearchParams): LedgerFilters | { error: string } {
  const parsed = filtersSchema.safeParse({
    account: given(params, "account"),
    type: given(params, "type"),
    symbol: given(params, "symbol"),
    from: given(params, "from"),
    to: given(params, "to"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" };
  return parsed.data;
}

/**
 * 读 ?limit=:缺省(或空串)→ 50;必须是 1..100 的整数,越界或不是整数 → { error }(路由回 400)。
 * 不夹:这个接口一直是 400,不像 /api/account/orders、fills(cursor.ts 的 readPageQuery)那样夹到 1..100。
 * 规则只写在这里,路由与后续复用本模块的接口(CSV 导出)都调它,不各写一份。
 */
export function readLedgerLimit(params: URLSearchParams): number | { error: string } {
  const raw = given(params, "limit");
  if (raw === undefined) return DEFAULT_PAGE_LIMIT;
  const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
  if (limit < 1 || limit > MAX_PAGE_LIMIT) return { error: `Invalid limit: must be an integer between 1 and ${MAX_PAGE_LIMIT}` };
  return limit;
}

type PageRow = {
  id: string; account: string; assetId: string | null; delta: bigint | number; reason: string;
  refType: string | null; refId: string | null; ts: bigint | number;
};

type AccountQuery = {
  /** createdAt 的范围 from ≤ createdAt < upper;upper 已经把 to 与游标合成一个上界(见 accountPage) */
  userId: string; from: number; upper: number; cursorTs: number; cursorId: string;
  /** 0 = 不限 reason;1 = reason 在 reasons 里;2 = reason 不在 reasons 里(ADJUSTMENT) */
  reasonMode: 0 | 1 | 2; reasons: string;
  /** 1 = delta > 0;0 = delta ≤ 0;null = 不限 */
  positive: 0 | 1 | null;
  assetId: string | null; take: number;
};

/**
 * 一个账户上的一页:(userId, account, createdAt) 索引从 upper 起按时间倒着走,够 take 行就停——成本只跟页大小有关,
 * 跟这个用户的流水总量、跟翻到第几页都无关。
 * 所以不给 account 时是四个账户各查一次再归并(见 readLedgerActivityPage),而不是一条不带 account 的查询:
 * 那样只能用索引的 userId 前缀,每页都要把该用户的全部行读出来排序,没有统计信息(sqlite_stat1 丢失)时还可能被规划成沿 createdAt 扫全表。
 * createdAt 只绑一个上界 upper = min(to, 游标时刻 + 1),在 JS 里算好:SQLite 的索引范围查找只拿一个上界去定位,
 * 同一列上再多写一个上界只会被当成逐行过滤——早先 `< to` 与 `<= 游标时刻` 并列时,定位用的是 to,
 * 每翻一页都要从 to(没给就是最新一行)走到游标处,比游标新多少行就多读多少行。
 * 游标那一毫秒里已经给过的行由 (createdAt < 游标时刻 OR id < 游标 id) 过滤掉,这一条只是过滤,不参与定位。
 * 上下界与游标永远带着(没给时是 0 / 最大值),查询文本只有一种,查询计划不随参数变。
 * createdAt 是整数毫秒(Prisma 在 SQLite 里就这样存 DateTime),直接和数字比;参数全是扁平标量,reason 集合用 JSON + json_each,
 * 不用嵌套的 Prisma.sql 片段(跨打包产物会失效,见 sparkline.ts 的事故说明)。
 * symbol 筛选:持仓行看行上的 assetId;现金行本身没有 assetId,看它引用的订单,或同一引用下本人带 assetId 的行(与 resolveSymbols 的补法同一口径)。
 */
function accountPage(account: LedgerAccount, q: AccountQuery) {
  return prisma.$queryRaw<PageRow[]>`
    SELECT l."id" AS id, l."account" AS account, l."assetId" AS assetId, l."delta" AS delta, l."reason" AS reason,
      l."refType" AS refType, l."refId" AS refId, CAST(l."createdAt" AS INTEGER) AS ts
    FROM "LedgerEntry" l
    WHERE l."userId" = ${q.userId} AND l."account" = ${account}
      AND l."createdAt" >= ${q.from} AND l."createdAt" < ${q.upper}
      AND (l."createdAt" < ${q.cursorTs} OR l."id" < ${q.cursorId})
      AND (${q.reasonMode} = 0
        OR (${q.reasonMode} = 1 AND l."reason" IN (SELECT value FROM json_each(${q.reasons})))
        OR (${q.reasonMode} = 2 AND l."reason" NOT IN (SELECT value FROM json_each(${q.reasons}))))
      AND (${q.positive} IS NULL OR (l."delta" > 0) = ${q.positive})
      AND (${q.assetId} IS NULL OR l."assetId" = ${q.assetId} OR (l."assetId" IS NULL AND l."refType" IS NOT NULL AND l."refId" IS NOT NULL AND (
        (l."refType" = 'ORDER' AND EXISTS (SELECT 1 FROM "Order" o WHERE o."id" = l."refId" AND o."userId" = l."userId" AND o."assetId" = ${q.assetId}))
        OR EXISTS (SELECT 1 FROM "LedgerEntry" c WHERE c."refType" = l."refType" AND c."refId" = l."refId" AND c."userId" = l."userId" AND c."assetId" = ${q.assetId}))))
    ORDER BY l."createdAt" DESC, l."id" DESC
    LIMIT ${q.take}`;
}

const refKey = (refType: string, refId: string) => `${refType}:${refId}`;

/**
 * 给一页里没有 assetId 的行(现金行)补标的:挂单冻结 / 解冻看本人的订单,成交与 OTC 的现金腿看同一引用下本人带 assetId 的行。
 * 返回 refType:refId → assetId。补不出来(赠金、期初余额这类没有引用的行)就不在表里。
 */
async function resolveAssetsByRef(userId: string, rows: PageRow[]): Promise<Map<string, string>> {
  const refs = new Map<string, [string, string]>();
  for (const row of rows) {
    if (row.assetId == null && row.refType && row.refId) refs.set(refKey(row.refType, row.refId), [row.refType, row.refId]);
  }
  const byRef = new Map<string, string>();
  if (refs.size === 0) return byRef;
  const orderIds = [...refs.values()].filter(([refType]) => refType === "ORDER").map(([, refId]) => refId);
  const [companions, orders] = await Promise.all([
    // json_each 在外层、LedgerEntry 按 (refType, refId) 索引逐个引用去查;CROSS JOIN 把这个连接顺序钉死,不靠统计信息
    prisma.$queryRaw<{ refType: string; refId: string; assetId: string }[]>`
      SELECT DISTINCT c."refType" AS refType, c."refId" AS refId, c."assetId" AS assetId
      FROM json_each(${JSON.stringify([...refs.values()])}) r
      CROSS JOIN "LedgerEntry" c ON c."refType" = json_extract(r.value, '$[0]') AND c."refId" = json_extract(r.value, '$[1]')
      WHERE c."userId" = ${userId} AND c."assetId" IS NOT NULL`,
    // 只按主键取,属主在 JS 里筛(P2-13):where 里同时写 userId 时,IN 列表一长(几十个 id),没有 sqlite_stat1 的 SQLite 就改走
    // (userId, …) 索引、把该用户的全部订单读一遍 —— 一个有 5 万张订单的用户,流水导出每页都这样,整份导出从 0.6 s 变成 3.6 s
    //(EXPLAIN QUERY PLAN:60 个 id 时 SEARCH Order USING INDEX Order_userId_clientOrderId_key (userId=?))
    orderIds.length
      ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, assetId: true, userId: true } })
      : Promise.resolve([]),
  ]);
  for (const row of companions) byRef.set(refKey(row.refType, row.refId), row.assetId);
  for (const order of orders) if (order.userId === userId) byRef.set(refKey("ORDER", order.id), order.assetId);
  return byRef;
}

/**
 * 一页流水:createdAt desc, id desc 的键集分页,nextCursor 指向本页最后一行(没有下一页为 null)。不数总数。
 * 只读本人的行。账户只认 LEDGER_ACCOUNTS 里的四个(账本写入器的类型也只有这四个)。
 * delta 转成 number:分与吨都远在安全整数之内(单笔名义金额有上限,见 src/shared/order-math.ts 的 MAX_NOTIONAL_CENTS)。
 */
export async function readLedgerActivityPage(userId: string, filters: LedgerFilters, page: { limit: number; cursor: Cursor | null }): Promise<LedgerActivityResponse> {
  const empty: LedgerActivityResponse = { items: [], nextCursor: null };
  const asset = filters.symbol ? await prisma.asset.findUnique({ where: { symbol: filters.symbol }, select: { id: true, symbol: true, isScenario: true } }) : null;
  if (filters.symbol && !asset) return empty;

  const byType = filters.type ? activityFilter(filters.type) : null;
  // type 对账户的要求(买卖只在 HOLDING 上、结算腿在 HOLDING 之外)与 account 参数取交集;交集为空就是空结果
  const accounts = LEDGER_ACCOUNTS.filter((account) =>
    (!filters.account || account === filters.account) && (byType?.holding == null || (account === "HOLDING") === byType.holding));
  if (accounts.length === 0) return empty;

  const query: AccountQuery = {
    userId,
    from: filters.from ?? 0,
    // 唯一的时间上界(不含):to 与「游标时刻 + 1」里较小的那个;游标那一毫秒本身还在范围里,靠 cursorId 去掉已经给过的行
    upper: Math.min(filters.to ?? MAX_DATE_MS + 1, page.cursor ? page.cursor.createdAt + 1 : MAX_DATE_MS + 1),
    cursorTs: page.cursor?.createdAt ?? MAX_DATE_MS + 1,
    cursorId: page.cursor?.id ?? "",
    reasonMode: byType ? (byType.exclude ? 2 : 1) : 0,
    reasons: JSON.stringify(byType?.reasons ?? []),
    positive: byType?.positive == null ? null : byType.positive ? 1 : 0,
    assetId: asset?.id ?? null,
    take: page.limit + 1, // 多取一行只为判断有没有下一页
  };
  // 一个事务里读:四个账户看到的是同一个时刻的账本
  const perAccount = await prisma.$transaction(accounts.map((account) => accountPage(account, query)));
  // 每个账户各自的前 limit + 1 行里一定包含全局的前 limit + 1 行;id 是 cuid(ASCII),JS 的字符串比较与 SQLite 的 BINARY 排序一致
  const merged = perAccount
    .flat()
    .map((row) => ({ ...row, ts: Number(row.ts) }))
    .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const rows = merged.slice(0, page.limit);
  const last = merged.length > page.limit ? rows[rows.length - 1] : null;

  // 带 symbol 筛选时每一行的标的都是它;否则现金行要补
  const byRef = asset ? new Map<string, string>() : await resolveAssetsByRef(userId, rows);
  const assetIdOf = (row: PageRow) => asset?.id ?? row.assetId ?? (row.refType && row.refId ? byRef.get(refKey(row.refType, row.refId)) : undefined) ?? null;
  const assetIds = [...new Set(rows.map(assetIdOf).filter((id): id is string => id !== null))];
  const assets = new Map<string, { symbol: string; isScenario: boolean }>(
    asset ? [[asset.id, asset]]
      : assetIds.length ? (await prisma.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, symbol: true, isScenario: true } })).map((a) => [a.id, a])
      : [],
  );

  const items: LedgerActivity[] = rows.map((row) => {
    const assetId = assetIdOf(row);
    const resolved = assetId ? assets.get(assetId) : undefined;
    return {
      id: row.id,
      ts: row.ts,
      account: row.account as LedgerAccount, // 查询按 LEDGER_ACCOUNTS 里的账户取,取回来的只会是这四个
      ...activityOf(row),
      reason: row.reason,
      assetId,
      symbol: resolved?.symbol ?? null,
      // 只有解析出情景标的的行是 true;没有标的的行(赠金、期初余额)是 false
      isScenario: resolved?.isScenario ?? false,
      delta: Number(row.delta),
      refType: row.refType,
      refId: row.refId,
    };
  });
  return { items, nextCursor: last ? encodeCursor({ createdAt: last.ts, id: last.id }) : null };
}
