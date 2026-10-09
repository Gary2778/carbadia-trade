// POST /api/account/triggers(条件单 / 价格提醒)与 GET /api/account/triggers?status=open|history&cursor=&limit=(计划 §6.3.2 C3)。
// 私有:requireUser + Cache-Control: private, no-store(错误响应也带)。创建按用户限流 60/min,与 OCO 共用 triggers:user:<id> 这一个桶;
// TRIGGERS_DISABLED=1 时创建答 503 triggersDisabled(列表照常)。
// 请求体的类型与上下限在这里(字段与错误映射见 src/lib/server/trigger-routes.ts);依赖库里状态的校验、幂等与事件在 src/lib/server/triggers.ts。
// 列表:open = PENDING / TRIGGERING,history = 其余,缺省不筛;键集分页 createdAt desc, id desc,游标同 /api/account/orders。
import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { ok, parseBody } from "@/lib/server/api";
import { encodeCursor, readPageQuery } from "@/lib/server/cursor";
import { badRequest, PRIVATE, rateLimited } from "@/lib/server/private-route";
import { centsSchema, clientKeySchema, quantitySchema, triggerFailure, triggersDisabled } from "@/lib/server/trigger-routes";
import { createTrigger, listTriggers, readTriggerStatus } from "@/lib/server/triggers";
import type { AccountTriggersResponse, TriggerResponse } from "@/shared/api-shapes";

const common = {
  assetId: z.string().min(1),
  direction: z.enum(["ABOVE", "BELOW"]),
  triggerPrice: centsSchema,
  clientKey: clientKeySchema,
};
const schema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ORDER"),
    ...common,
    side: z.enum(["BUY", "SELL"]),
    orderType: z.enum(["LIMIT", "MARKET"]),
    // LIMIT 必填(服务里查);MARKET 带了只做格式校验,落库 null
    limitPrice: centsSchema.nullable().optional(),
    quantity: quantitySchema,
  }),
  z.object({ kind: z.literal("ALERT"), ...common }),
]);

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const disabled = triggersDisabled();
    if (disabled) return disabled;
    const limited = rateLimited(`triggers:user:${user.id}`);
    if (limited) return limited;
    const body = await parseBody(req, schema);
    const data: TriggerResponse = { trigger: await createTrigger(user.id, body) };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return triggerFailure(err);
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const filter = readTriggerStatus(params);
    if ("error" in filter) return badRequest(filter.error);
    const page = readPageQuery(params);
    if ("error" in page) return badRequest(page.error);
    const { triggers, next } = await listTriggers(user.id, { status: filter.status, ...page });
    const data: AccountTriggersResponse = { triggers, nextCursor: next ? encodeCursor(next) : null };
    return ok(data, { headers: PRIVATE });
  } catch (err) {
    return triggerFailure(err);
  }
}
