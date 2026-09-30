// GET /api/account/orders?status=open|history&symbol=&cursor=&limit=50(计划 §3.4 路由表、§3.5 AccountOrdersResponse)
// 私有:requireUser + Cache-Control: private, no-store,不进边缘名单。键集分页 createdAt desc, id desc,
// cursor = base64url(JSON{ createdAt, id })(src/lib/server/cursor.ts)。open → OPEN/PARTIAL,history → FILLED/CANCELLED,缺省不筛状态。
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { ok, fail, handle } from "@/lib/server/api";
import { encodeCursor, readPageQuery } from "@/lib/server/cursor";
import { avgFillPricesByOrder, selfTradeCancelledIds, toOrder } from "@/lib/server/account-mappers";
import type { AccountOrdersResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;
// Map 而不是对象字面量: ?status=toString 这类原型链上的名字不能算合法状态
const STATUS_SETS = new Map<string, readonly string[]>([["open", ["OPEN", "PARTIAL"]], ["history", ["FILLED", "CANCELLED"]]]);

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const status = params.get("status") || null; // 空串视为未传: 不筛状态
    const statuses = status ? STATUS_SETS.get(status) : undefined;
    if (status && !statuses) return fail("Invalid status", 400, PRIVATE);
    const page = readPageQuery(params);
    if ("error" in page) return fail(page.error, 400, PRIVATE);
    const symbol = params.get("symbol");

    const rows = await prisma.order.findMany({
      where: {
        userId: user.id,
        ...(statuses ? { status: { in: [...statuses] } } : {}),
        ...(symbol ? { asset: { symbol } } : {}),
        ...(page.cursor
          ? { OR: [{ createdAt: { lt: new Date(page.cursor.createdAt) } }, { createdAt: new Date(page.cursor.createdAt), id: { lt: page.cursor.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1, // 多取一行只为判断有没有下一页
      include: { asset: { select: { symbol: true } } },
    });
    const pageRows = rows.slice(0, page.limit);
    const last = rows.length > page.limit ? pageRows[pageRows.length - 1] : null;
    // 挂单方成交不更新行上的 avgFillPrice,按实际成交重算(与 GET /api/orders 同一规则);
    // 被自成交防护撤掉的限价单从 SELF_TRADE_UNLOCK 流水认出来(cancelReason SELF_TRADE,不再显示成「用户撤单」)
    const [avg, selfTraded] = await Promise.all([avgFillPricesByOrder(prisma, pageRows), selfTradeCancelledIds(prisma, pageRows)]);
    const data: AccountOrdersResponse = {
      orders: pageRows.map((row) => toOrder(row, avg.has(row.id) ? avg.get(row.id) : undefined, selfTraded)),
      nextCursor: last ? encodeCursor({ createdAt: last.createdAt.getTime(), id: last.id }) : null,
    };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
