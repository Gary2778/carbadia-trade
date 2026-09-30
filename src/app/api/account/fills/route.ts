// GET /api/account/fills?symbol=&cursor=&limit=50(计划 §3.4 路由表、§3.5 FillsResponse)
// 私有:本人是买方或卖方的成交,从本人视角映射(side / role / orderId),ledgerRefs = 本人在该成交下的账本行 id(一批一次查询)。
// 键集分页 createdAt desc, id desc,cursor 同 /api/account/orders。
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { ok, fail, handle } from "@/lib/server/api";
import { encodeCursor, readPageQuery } from "@/lib/server/cursor";
import { ledgerIdsByTrade, toFill } from "@/lib/server/account-mappers";
import type { FillsResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;
/** toFill 需要的形状(TradeRow):symbol + 买卖两张订单的存根,takerSide 由 takerSideOf 派生,不落列 */
const TRADE_ROW_INCLUDE = {
  asset: { select: { symbol: true } },
  buyOrder: { select: { id: true, type: true, price: true, createdAt: true } },
  sellOrder: { select: { id: true, type: true, price: true, createdAt: true } },
} as const;

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const page = readPageQuery(params);
    if ("error" in page) return fail(page.error, 400, PRIVATE);
    const symbol = params.get("symbol");

    const rows = await prisma.trade.findMany({
      where: {
        AND: [
          { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
          ...(symbol ? [{ asset: { symbol } }] : []),
          ...(page.cursor
            ? [{ OR: [{ createdAt: { lt: new Date(page.cursor.createdAt) } }, { createdAt: new Date(page.cursor.createdAt), id: { lt: page.cursor.id } }] }]
            : []),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
      include: TRADE_ROW_INCLUDE,
    });
    const pageRows = rows.slice(0, page.limit);
    const last = rows.length > page.limit ? pageRows[pageRows.length - 1] : null;
    const ledgerIds = await ledgerIdsByTrade(prisma, user.id, pageRows.map((trade) => trade.id));
    const data: FillsResponse = {
      fills: pageRows.map((trade) => toFill(trade, user.id, ledgerIds.get(trade.id))),
      nextCursor: last ? encodeCursor({ createdAt: last.createdAt.getTime(), id: last.id }) : null,
    };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
