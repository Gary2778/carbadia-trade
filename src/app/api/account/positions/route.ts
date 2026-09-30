// GET /api/account/positions(计划 §3.4 路由表、§3.5 PositionsResponse):持仓三态 tradable / locked / retired + 现金余额。
// retired = Retirement 按 assetId 聚合;成本经 reconstructPositionBasis 从本人账本重建(非 complete 时均价 / 浮盈为 null);
// 非情景与情景标的都返回并带 isScenario。一次读快照(交互式事务外的批量 $transaction),避免持仓与账本之间夹进一笔成交。
// 行 = 数量 > 0 的持仓,加上已经全部注销的持仓(数量 0、retired > 0;注销只减 Holding.quantity,行还在)——
// 否则整仓注销后这个标的从持仓里消失,注销总量再也看不到(P1-25b;计划 §3.1 PositionsTab 三态 tradable / locked / retired)。
// 卖光且从没注销过的行(数量 0、retired 0)照旧不返回。
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { ok, handle } from "@/lib/server/api";
import { toPosition } from "@/lib/server/account-mappers";
import type { PositionsResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function GET() {
  try {
    const user = await requireUser();
    const [balances, holdings, ledger, retired] = await prisma.$transaction([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { cashBalance: true, lockedCash: true } }),
      // 不按数量筛:一个用户最多十几行持仓,数量 0 的行在下面按 retired 取舍(Retirement 与 Holding 之间没有关系,查询里筛不了)
      prisma.holding.findMany({
        where: { userId: user.id },
        include: { asset: { select: { symbol: true, lastPrice: true, isScenario: true } } },
        orderBy: { asset: { symbol: "asc" } },
      }),
      // 成本重建需要的账本行(与 /api/portfolio 同一筛选):持仓变动 + 按成交 / 场外引用净额的现金支付
      prisma.ledgerEntry.findMany({
        where: {
          userId: user.id,
          OR: [
            { account: "HOLDING" },
            { account: { in: ["CASH", "CASH_LOCKED"] }, reason: { in: ["TRADE_SETTLE", "OTC_SETTLE", "PRICE_IMPROVE_REFUND"] } },
          ],
        },
        select: { id: true, account: true, assetId: true, delta: true, reason: true, refType: true, refId: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.retirement.groupBy({ by: ["assetId"], where: { userId: user.id }, _sum: { quantity: true }, orderBy: { assetId: "asc" } }),
    ]);
    const retiredByAsset = new Map(retired.map((row) => [row.assetId, row._sum?.quantity ?? 0]));
    const data: PositionsResponse = {
      positions: holdings
        .filter((holding) => holding.quantity > 0 || (retiredByAsset.get(holding.assetId) ?? 0) > 0)
        .map((holding) => toPosition(holding, retiredByAsset.get(holding.assetId) ?? 0, ledger)),
      balance: { cashBalance: Number(balances.cashBalance), lockedCash: Number(balances.lockedCash) }, // BigInt → number
    };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
