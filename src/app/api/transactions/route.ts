// GET /api/transactions?limit=50&cursor=&account=&type=&symbol=&from=&to=(计划 §6.2.2 C4、§9.2 D30)
// 私有:本人的账户流水(账本行,不是第二本成交账——同一笔交易的现金腿与持仓腿共用 refType / refId)。
// 键集分页 createdAt desc, id desc,游标同 /api/account/orders(src/lib/server/cursor.ts 的 base64url,旧的裸 id 游标回 400);
// 筛选:account(四个账本账户之一)、type(ActivityType)、symbol、from ≤ ts < to(毫秒)。非法值 400;不返回总数。
import { requireUser } from "@/lib/server/auth";
import { fail, handle, ok } from "@/lib/server/api";
import { decodeCursor, type Cursor } from "@/lib/server/cursor";
import { readLedgerActivityPage, readLedgerFilters, readLedgerLimit } from "@/lib/server/ledger-activity-page";
import type { LedgerActivityResponse } from "@/shared/api-shapes";

const PRIVATE = { "Cache-Control": "private, no-store" } as const;

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;

    // limit 的规则(1..100,缺省 50,越界 400 不夹)在 ledger-activity-page.ts,与筛选参数放在一处
    const limit = readLedgerLimit(params);
    if (typeof limit !== "number") return fail(limit.error, 400, PRIVATE);
    let cursor: Cursor | null = null;
    const rawCursor = params.get("cursor");
    if (rawCursor) {
      cursor = decodeCursor(rawCursor);
      if (!cursor) return fail("Invalid cursor", 400, PRIVATE);
    }
    const filters = readLedgerFilters(params);
    if ("error" in filters) return fail(filters.error, 400, PRIVATE);

    const data: LedgerActivityResponse = await readLedgerActivityPage(user.id, filters, { limit, cursor });
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    const res = handle(err);
    res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
    return res;
  }
}
