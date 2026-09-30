// GET /api/account/fills/[id](计划 §3.4 路由表、§3.5 FillDetailResponse):每笔成交可追溯到 SIM-TRD 引用与账本行。
// 非买卖双方 404(不泄露成交是否存在);ledger = 本人在该成交下的账本行(refType TRADE, refId = id, userId = 本人),
// 对手方的行不外露;counterpartyIsBot 只说对手是不是做市机器人,不带对手身份;disclosure 恒为 FILL_DISCLOSURE(模拟成交,不是登记机构记录)。
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { ok, fail, handle } from "@/lib/server/api";
import { toFill, toLedgerLineView } from "@/lib/server/account-mappers";
import { FILL_DISCLOSURE } from "@/shared/constants";
import type { FillDetailResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const trade = await prisma.trade.findUnique({
      where: { id },
      include: {
        asset: { select: { symbol: true } },
        buyOrder: { select: { id: true, type: true, price: true, createdAt: true } },
        sellOrder: { select: { id: true, type: true, price: true, createdAt: true } },
        buyer: { select: { isBot: true } },
        seller: { select: { isBot: true } },
      },
    });
    if (!trade || (trade.buyerId !== user.id && trade.sellerId !== user.id)) return fail("Fill not found", 404, PRIVATE);
    const ledgerRows = await prisma.ledgerEntry.findMany({
      where: { userId: user.id, refType: "TRADE", refId: trade.id },
      select: { id: true, account: true, delta: true, reason: true, createdAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const data: FillDetailResponse = {
      fill: toFill(trade, user.id, ledgerRows.map((row) => row.id)),
      ledger: ledgerRows.map(toLedgerLineView),
      counterpartyIsBot: trade.buyerId === user.id ? trade.seller.isBot : trade.buyer.isBot,
      disclosure: FILL_DISCLOSURE,
    };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
