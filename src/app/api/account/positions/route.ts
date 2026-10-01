// GET /api/account/positions(计划 §3.4 路由表、§3.5 PositionsResponse、§6.2.2 C1):持仓三态 tradable / locked / retired + 锁定来源 + 现金余额。
// 持仓的查询与映射在 src/lib/server/positions.ts(WS 快照与 position 事件用的是同一份):retired = Retirement 按 assetId 聚合;
// lockedBy = 未完结 SELL 挂单的剩余量 / ACTIVE 场外挂牌;成本经 reconstructPositionBasis 从本人账本重建(非 complete 时均价 / 浮盈为 null);
// 非情景与情景标的都返回并带 isScenario。
// 行 = 数量 > 0 的持仓,加上已经全部注销的持仓(数量 0、retired > 0;注销只减 Holding.quantity,行还在)——
// 否则整仓注销后这个标的从持仓里消失,注销总量再也看不到(P1-25b)。卖光且从没注销过的行(数量 0、retired 0)不返回。
// 余额与持仓的五个读取放进同一个批量事务(交互式事务外的批量 $transaction):一次读快照,持仓与账本之间不夹进一笔成交,余额与持仓是同一个提交点。
// 每用户 120 次 / 分钟的宽松限流(P2-13,终审 SEC-3):一次读取要回放该用户的全部持仓流水;终端与资产页的正常用法
//(登录后一次、轮询降级下每 5 s 一次、账户订阅快照之外的补取)远低于此,429 带 Retry-After 与 private, no-store。
// 限流在查库之前,键用会话 cookie 里签过名的 userId(sessionUserId,与总览同一做法);没有有效会话的请求由 requireUser 回 401。
import { prisma } from "@/lib/server/db";
import { requireUser, sessionUserId } from "@/lib/server/auth";
import { fail, ok, handle } from "@/lib/server/api";
import { positionReads, positionsFromRows } from "@/lib/server/positions";
import { rateLimit, retryAfterSeconds } from "@/lib/server/rate-limit";
import type { PositionsResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;
/** 每用户每分钟的上限(route.ts 只能导出 HTTP 方法与路由配置,所以不导出;测试照这个数打) */
const POSITIONS_RATE_LIMIT = 120;
const POSITIONS_RATE_WINDOW_MS = 60_000;

export async function GET() {
  try {
    const sessionId = await sessionUserId();
    const key = `positions:user:${sessionId}`;
    if (sessionId && !rateLimit(key, POSITIONS_RATE_LIMIT, POSITIONS_RATE_WINDOW_MS)) {
      return fail("Too many requests, please retry later", 429, { ...PRIVATE, "Retry-After": String(retryAfterSeconds(key, POSITIONS_RATE_WINDOW_MS)) });
    }
    const user = await requireUser();
    const [balances, ...rows] = await prisma.$transaction([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { cashBalance: true, lockedCash: true } }),
      ...positionReads(prisma, user.id),
    ]);
    const data: PositionsResponse = {
      positions: await positionsFromRows(prisma, user.id, rows),
      balance: { cashBalance: Number(balances.cashBalance), lockedCash: Number(balances.lockedCash) }, // BigInt → number
    };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
