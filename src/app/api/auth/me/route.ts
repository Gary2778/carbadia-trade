import { getCurrentUser } from "@/lib/server/auth";
import { ok, handle } from "@/lib/server/api";

// 响应按 cookie 因人而异(含余额), 任何共享缓存(CDN / 浏览器)都不得存储; 未登录的 null 也一样, 否则登录后可能拿到缓存的 null
const PRIVATE = { headers: { "Cache-Control": "private, no-store" } };

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return ok(null, PRIVATE);
    return ok(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        cashBalance: Number(user.cashBalance), // BigInt → number, 否则 JSON 序列化 throw
        lockedCash: Number(user.lockedCash),
      },
      PRIVATE
    );
  } catch (err) {
    return handle(err);
  }
}
