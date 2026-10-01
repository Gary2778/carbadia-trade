// GET /api/account/fills?symbol=&cursor=&limit=50(计划 §3.4 路由表、§3.5 FillsResponse)
// 私有:本人是买方或卖方的成交,从本人视角映射(side / role / orderId),ledgerRefs = 本人在该成交下的账本行 id(一批一次查询)。
// 键集分页 createdAt desc, id desc,cursor 同 /api/account/orders。
// 一页数据的读取在 src/lib/server/account-pages.ts,CSV 导出(/api/account/fills.csv)用的是同一份。
import { requireUser } from "@/lib/server/auth";
import { ok, fail, handle } from "@/lib/server/api";
import { encodeCursor, readPageQuery } from "@/lib/server/cursor";
import { readFillsPage } from "@/lib/server/account-pages";
import type { FillsResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const page = readPageQuery(params);
    if ("error" in page) return fail(page.error, 400, PRIVATE);

    const { fills, next } = await readFillsPage(user.id, { symbol: params.get("symbol") || null }, page, { ledgerRefs: true });
    const data: FillsResponse = { fills, nextCursor: next ? encodeCursor(next) : null };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
