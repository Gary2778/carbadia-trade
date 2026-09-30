import { requireUser } from "@/lib/server/auth";
import { cancelOrder } from "@/lib/exchange/matching";
import { ok, fail, handle } from "@/lib/server/api";
import { rateLimit, retryAfterSeconds } from "@/lib/server/rate-limit";
import { toOrder } from "@/lib/server/account-mappers";
import type { Order } from "@/shared/types";

const WINDOW_MS = 60_000;

/** 撤单:按用户 60/min 限流,429 带 Retry-After;响应 data = { order: Order }(计划 §3.4 路由表) */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const key = `cancel:user:${user.id}`;
    if (!rateLimit(key, 60, WINDOW_MS)) {
      // 429 文案沿用全站既有句式(见 orders/route.ts 的 tooMany 注释;计划 §3.4 缩写为 "Too many requests",已记偏离)
      return fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, WINDOW_MS)) });
    }
    const { id } = await ctx.params;
    const result = await cancelOrder(user.id, id);
    const data: { order: Order } = { order: toOrder(result.order) };
    return ok(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handle(err);
  }
}
