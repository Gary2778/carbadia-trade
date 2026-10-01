// 资产总览的读取与请求处理(计划 §6.2.2 C6):GET /api/account/overview 的全量与精简两种模式、每用户限流、
// 同一用户的并发请求共用一次读取。路由文件(src/app/api/account/overview/route.ts)只有一行转调:Next 的 route.ts 只能导出
// HTTP 方法与路由配置,限流数值这类要给测试读的常量放不进去。
//
//   - 全量(默认):余额、持仓(含整仓注销的行)、合计、24 小时变化、本人 ACTIVE 的场外挂牌 —— 资产页第一次取它落账户 store;
//   - 精简(?parts=extras,P2-13):只有 24 小时变化与挂牌(AccountOverviewExtras)。资产页之后的重取只要这两样,
//     所以不读成本回放要的账本行、不做 positionsFromRows(大账本的一次全量读要几十到上百毫秒,占着唯一的 SQLite 连接);
//     只读余额、持仓行与现价、24 小时窗口、ACTIVE 挂牌,一个批量事务。两种模式的 change24h 与挂牌同一份计算;
//   - 限流:每用户 OVERVIEW_RATE_LIMIT 次 / 分钟(两种模式共用一个桶),429 带 Retry-After 与 private, no-store。资产页正常每 60 s
//     取一次,账户事件之后的去抖重取(1 s)也远低于此;超了页面保留上一份、标记「刷新失败」(useAccountOverview);
//   - single-flight:同一用户、同一模式同时在途的请求共用一次读取(键 = 用户 + 模式,Promise 放 globalThis,结束即删;
//     不缓存结果,见 single-flight.ts)。
// 只读,不写库。响应含用户数据:private, no-store,路径不在边缘缓存名单里。
import type { AccountOverview, AccountOverviewExtras, OtcListingView } from "@/shared/api-shapes";
import type { Balance } from "@/shared/types";
import { computeAccountTotals } from "@/shared/account-totals";
import { fail, handle, ok } from "./api";
import { requireUser, sessionUserId } from "./auth";
import { prisma } from "./db";
import { equityReads, equityReplayFrom, equitySince, toEquityChange, type EquityHolding, type EquityWindowRow } from "./equity-change";
import { positionReads, positionsFromRows } from "./positions";
import { rateLimit, retryAfterSeconds } from "./rate-limit";
import { singleFlight } from "./single-flight";

/** 每个用户每分钟最多这么多次总览请求(全量与精简共用一个桶;P2-13 按 P2-11 负载发现 F1 定为 30) */
export const OVERVIEW_RATE_LIMIT = 30;
export const OVERVIEW_RATE_WINDOW_MS = 60_000;
/** 精简模式的查询参数值 */
export const OVERVIEW_EXTRAS = "extras";

export type OverviewMode = "full" | "extras";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

/** 读 ?parts=:缺省或空串 = 全量;extras = 精简;其它值 → { error }(路由回 400) */
export function readOverviewMode(params: URLSearchParams): OverviewMode | { error: string } {
  const parts = params.get("parts") || null;
  if (parts === null) return "full";
  if (parts === OVERVIEW_EXTRAS) return "extras";
  return { error: `Invalid parts: must be ${OVERVIEW_EXTRAS}` };
}

/** 日志用:只有错误的名字与消息(压成一行、截到 200 字),不带用户、余额或持仓 */
function errorSummary(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : typeof err;
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

type ListingRow = { id: string; assetId: string; quantity: number; pricePerUnit: number; minQuantity: number; createdAt: Date; asset: { symbol: string } };

/** 本人 ACTIVE 的场外挂牌,新的在前(OtcListing 没有 sellerId 索引:一次小表扫描,与 positions.ts 的第 4 个读取同一量级) */
const listingsRead = (userId: string) =>
  prisma.otcListing.findMany({
    where: { sellerId: userId, status: "ACTIVE" },
    include: { asset: { select: { symbol: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

const listingView = (listing: ListingRow): OtcListingView => ({
  id: listing.id,
  assetId: listing.assetId,
  symbol: listing.asset.symbol,
  quantity: listing.quantity,
  pricePerUnit: listing.pricePerUnit,
  minQuantity: listing.minQuantity,
  createdAt: listing.createdAt.getTime(),
});

const balanceOf = (row: { cashBalance: bigint; lockedCash: bigint }): Balance => ({ cashBalance: Number(row.cashBalance), lockedCash: Number(row.lockedCash) }); // BigInt → number

/**
 * 24 小时变化(已经读好的现值与窗口汇总 → EquityChange)。它是可有可无的一个数,不能拖垮整页:T 时刻的价格在批量事务之外查
 *(缓存未命中时第二次占用唯一的 SQLite 连接),超时 / 忙时会抛。这时给 null(界面显示「—」),只记一行日志。
 */
async function changeOf(since: number, balance: Balance, holdings: readonly EquityHolding[], windowRows: readonly EquityWindowRow[], hasLedger: boolean): Promise<AccountOverview["change24h"]> {
  try {
    return toEquityChange(await equityReplayFrom(prisma, { since, balance, holdings, windowRows, hasLedger }));
  } catch (err) {
    console.warn("[overview] equity change unavailable", errorSummary(err));
    return null;
  }
}

/**
 * 全量总览:一个批量事务读完(同一个提交点,余额、持仓、挂牌与窗口内的账本之间不夹进一笔成交)。
 * 持仓的五个读取与映射是 positions.ts 的那一份(与 GET /api/account/positions 同形);合计由 computeAccountTotals 按持仓行上的
 * 最新价算出,客户端之后用同一个函数按行情重算;24 小时变化的现值用的就是这里读到的余额与持仓行。
 */
export async function readAccountOverview(userId: string): Promise<AccountOverview> {
  const since = equitySince(Date.now());
  const [balances, listings, windowRows, anyLedger, ...rows] = await prisma.$transaction([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { cashBalance: true, lockedCash: true } }),
    listingsRead(userId),
    ...equityReads(prisma, userId, since),
    ...positionReads(prisma, userId),
  ]);
  const balance = balanceOf(balances);
  const positions = await positionsFromRows(prisma, userId, rows);
  // rows[0] 是该用户的全部持仓行(数量为 0 的也在):倒推要用窗口内卖光 / 注销光的那几行
  const holdings = rows[0].map((holding) => ({ assetId: holding.assetId, quantity: holding.quantity, lastPrice: holding.asset.lastPrice }));
  return {
    balance,
    positions,
    totals: computeAccountTotals(balance, positions, (position) => position.lastPrice),
    change24h: await changeOf(since, balance, holdings, windowRows, anyLedger != null),
    otcListings: listings.map(listingView),
  };
}

/**
 * 精简总览:只有 24 小时变化与挂牌。读余额、全部持仓行(数量与现价,倒推用)、窗口汇总、ACTIVE 挂牌,一个批量事务;
 * 不读成本回放要的账本行,不做 positionsFromRows。结果与全量里的同名两项相同(同一个提交点下)。
 */
export async function readAccountOverviewExtras(userId: string): Promise<AccountOverviewExtras> {
  const since = equitySince(Date.now());
  const [balances, listings, holdingRows, windowRows, anyLedger] = await prisma.$transaction([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { cashBalance: true, lockedCash: true } }),
    listingsRead(userId),
    prisma.holding.findMany({ where: { userId }, select: { assetId: true, quantity: true, asset: { select: { lastPrice: true } } } }),
    ...equityReads(prisma, userId, since),
  ]);
  const holdings = holdingRows.map((holding) => ({ assetId: holding.assetId, quantity: holding.quantity, lastPrice: holding.asset.lastPrice }));
  return {
    change24h: await changeOf(since, balanceOf(balances), holdings, windowRows, anyLedger != null),
    otcListings: listings.map(listingView),
  };
}

/**
 * GET /api/account/overview[?parts=extras]:限流 → 登录 → 读模式(非法 400)→ 同一用户同一模式的在途读取共用一次。
 * 限流在查库之前:键用会话 cookie 里签过名的 userId(sessionUserId,不查库),超了直接 429 —— 不退避的客户端被拒的请求不占 SQLite。
 * 没有有效会话的请求不计数,由 requireUser 回 401。
 */
export async function overviewResponse(req: Request): Promise<Response> {
  try {
    const sessionId = await sessionUserId();
    const key = `overview:user:${sessionId}`;
    if (sessionId && !rateLimit(key, OVERVIEW_RATE_LIMIT, OVERVIEW_RATE_WINDOW_MS)) {
      return fail("Too many requests, please retry later", 429, { ...PRIVATE, "Retry-After": String(retryAfterSeconds(key, OVERVIEW_RATE_WINDOW_MS)) });
    }
    const user = await requireUser();
    const mode = readOverviewMode(new URL(req.url).searchParams);
    if (typeof mode !== "string") return fail(mode.error, 400, PRIVATE);
    const data =
      mode === "extras"
        ? await singleFlight(`overview:${user.id}:extras`, () => readAccountOverviewExtras(user.id))
        : await singleFlight(`overview:${user.id}:full`, () => readAccountOverview(user.id));
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
