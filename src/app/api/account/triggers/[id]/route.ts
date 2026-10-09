// DELETE /api/account/triggers/[id]:撤一条条件单或提醒(计划 §6.3.2 C3、§9.1 第 60 条)。只有 PENDING 能撤(→ CANCELLED / USER),否则 409;
// 不存在或不是本人的 → 400(与 DELETE /api/orders/[id] 的「找不到」同一个状态码)。按用户限流 60/min,private, no-store。
import { requireUser } from "@/lib/server/auth";
import { ok } from "@/lib/server/api";
import { PRIVATE, rateLimited } from "@/lib/server/private-route";
import { triggerFailure } from "@/lib/server/trigger-routes";
import { cancelTrigger } from "@/lib/server/triggers";
import type { TriggerResponse } from "@/shared/api-shapes";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const limited = rateLimited(`triggers:cancel:user:${user.id}`);
    if (limited) return limited;
    const { id } = await ctx.params;
    const data: TriggerResponse = { trigger: await cancelTrigger(user.id, id) };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return triggerFailure(err);
  }
}
