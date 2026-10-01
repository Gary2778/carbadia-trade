// GET /api/account/orders?status=open|history&symbol=&cursor=&limit=50(计划 §3.4 路由表、§3.5 AccountOrdersResponse)
// 私有:requireUser + Cache-Control: private, no-store,不进边缘名单。键集分页 createdAt desc, id desc,
// cursor = base64url(JSON{ createdAt, id })(src/lib/server/cursor.ts)。open → OPEN/PARTIAL,history → FILLED/CANCELLED,缺省不筛状态。
// 筛选与一页数据的读取在 src/lib/server/account-pages.ts,CSV 导出(/api/account/orders.csv)用的是同一份。
import { requireUser } from "@/lib/server/auth";
import { ok, fail, handle } from "@/lib/server/api";
import { encodeCursor, readPageQuery } from "@/lib/server/cursor";
import { readOrderFilters, readOrdersPage } from "@/lib/server/account-pages";
import type { AccountOrdersResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const filters = readOrderFilters(params);
    if ("error" in filters) return fail(filters.error, 400, PRIVATE);
    const page = readPageQuery(params);
    if ("error" in page) return fail(page.error, 400, PRIVATE);

    const { orders, next } = await readOrdersPage(user.id, filters, page);
    const data: AccountOrdersResponse = { orders, nextCursor: next ? encodeCursor(next) : null };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
