// GET /api/account/notices?cursor=&limit=50(计划 §6.3.2 C3):本人的站内通知,新的在前,键集分页 createdAt desc, id desc,游标同 /api/account/orders;
// 应答 { items, nextCursor, unread }(unread = 本人全部未读,不只本页)。私有:requireUser + Cache-Control: private, no-store(错误响应也带),
// 按用户限流 60/min。读取在 src/lib/server/notices.ts(payload 读不回来的行跳过)。Nav 的铃铛平时只看 /api/auth/me 的 unreadNotices,点开才取这一页。
import { requireUser } from "@/lib/server/auth";
import { ok } from "@/lib/server/api";
import { readPageQuery } from "@/lib/server/cursor";
import { listNotices } from "@/lib/server/notices";
import { badRequest, PRIVATE, privateFailure, rateLimited } from "@/lib/server/private-route";
import type { NoticesResponse } from "@/shared/api-shapes";

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const limited = rateLimited(`notices:user:${user.id}`);
    if (limited) return limited;
    const page = readPageQuery(new URL(req.url).searchParams);
    if ("error" in page) return badRequest(page.error);
    const data: NoticesResponse = await listNotices(user.id, page);
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return privateFailure(err);
  }
}
