import { getCurrentUser } from "@/lib/server/auth";
import { ok, handle } from "@/lib/server/api";
import { countUnread } from "@/lib/server/notices";
import { PRIVATE } from "@/lib/server/private-route";
import type { Me } from "@/shared/types";

/** 未读数是附带的:数不出来(库忙等)记一行日志、按 0 答,不让整个 /me 失败(登录态、余额照常返回) */
async function unreadOrZero(userId: string): Promise<number> {
  try {
    return await countUnread(userId);
  } catch (err) {
    console.error(JSON.stringify({ src: "notices", ev: "count_unread_failed", userId, error: err instanceof Error ? err.message : String(err) }));
    return 0;
  }
}

// 响应按 cookie 因人而异(含余额), 任何共享缓存(CDN / 浏览器)都不得存储; 未登录的 null 也一样, 否则登录后可能拿到缓存的 null(头见 private-route.ts)
export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return ok(null, { headers: PRIVATE });
    const data: NonNullable<Me> = {
      id: user.id,
      email: user.email,
      name: user.name,
      cashBalance: Number(user.cashBalance), // BigInt → number, 否则 JSON 序列化 throw
      lockedCash: Number(user.lockedCash),
      unreadNotices: await unreadOrZero(user.id), // 一次 count;Nav 的铃铛靠它显示未读数,不另发请求
    };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return handle(err);
  }
}
