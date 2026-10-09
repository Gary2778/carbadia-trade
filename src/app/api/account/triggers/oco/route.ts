// POST /api/account/triggers/oco:止盈止损成对(计划 §6.3.2 C3)。1 或 2 条 SELL MARKET,同一 ocoGroupId,一条触发另一条撤销。
// 私有:requireUser + private, no-store;与 POST /api/account/triggers 共用 triggers:user:<id> 限流桶(60/min);TRIGGERS_DISABLED=1 时答 503 triggersDisabled。
// 价格关系、持仓数量、上限与幂等在 src/lib/server/triggers.ts 的 createOco。
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { ok, parseBody } from "@/lib/server/api";
import { PRIVATE, rateLimited } from "@/lib/server/private-route";
import { centsSchema, clientKeySchema, quantitySchema, triggerFailure, triggersDisabled } from "@/lib/server/trigger-routes";
import { createOco } from "@/lib/server/triggers";
import type { CreateOcoResponse } from "@/shared/api-shapes";

const schema = z.object({
  assetId: z.string().min(1),
  quantity: quantitySchema,
  // 至少给一个(服务里查)
  takeProfit: centsSchema.nullable().optional(),
  stopLoss: centsSchema.nullable().optional(),
  // 两行的键由它派生(<clientKey>:tp / :sl)
  clientKey: clientKeySchema,
});

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const disabled = triggersDisabled();
    if (disabled) return disabled;
    const limited = rateLimited(`triggers:user:${user.id}`);
    if (limited) return limited;
    const body = await parseBody(req, schema);
    const data: CreateOcoResponse = { triggers: await createOco(user.id, body) };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return triggerFailure(err);
  }
}
