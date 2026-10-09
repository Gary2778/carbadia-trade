// POST /api/account/notices/read(计划 §6.3.2 C3):请求体恰好二选一 —— { ids: string[] }(1–100 条)或 { all: true };应答 { unread }(标完之后的本人未读数)。
// 只改本人 readAt 为空的行:别人的 / 不存在的 id 忽略,已读的保持原来的读取时刻(src/lib/server/notices.ts 的 markNoticesRead)。
// 私有:requireUser + private, no-store(错误响应也带),按用户限流 60/min(与读取分开的桶)。
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { ok, parseBody } from "@/lib/server/api";
import { markNoticesRead } from "@/lib/server/notices";
import { PRIVATE, privateFailure, rateLimited } from "@/lib/server/private-route";
import type { MarkNoticesReadResponse } from "@/shared/api-shapes";

// strictObject:两个键都给、或带多余键都不匹配任何一支 → 400,「恰好二选一」不靠约定
const schema = z.union(
  [z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(100) }), z.strictObject({ all: z.literal(true) })],
  { error: "Give ids (1 to 100) or all: true" },
);

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const limited = rateLimited(`notices:read:user:${user.id}`);
    if (limited) return limited;
    const body = await parseBody(req, schema);
    const data: MarkNoticesReadResponse = await markNoticesRead(user.id, body);
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return privateFailure(err);
  }
}
