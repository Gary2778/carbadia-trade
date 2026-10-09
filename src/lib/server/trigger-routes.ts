// 条件单三个路由(/api/account/triggers、/api/account/triggers/oco、/api/account/triggers/[id])共用的件(计划 §6.3.2 C3):
// 错误映射(409 / 交给 handle() 的 400 / 401 / 503 / 500)、TRIGGERS_DISABLED=1 时两个创建接口的 503,与请求体的价格、数量与幂等键字段;
// private, no-store 头与限流应答在 private-route.ts。
// 字段的上下限与 POST /api/orders 同一组常量;依赖库里状态的校验在 triggers.ts。
import { z } from "zod";
import { TRIGGER_ERROR } from "@/shared/constants";
import { MAX_PRICE_CENTS } from "../exchange/limits";
import { MAX_ORDER_QUANTITY } from "../exchange/matching";
import { fail, handle } from "./api";
import { PRIVATE } from "./private-route";
import { TriggerConflictError } from "./triggers";

/** 失败响应:TriggerConflictError → 409,其余交给 handle()(TradingError / zod → 400,未登录 401,忙 503);一律带 private, no-store */
export function triggerFailure(err: unknown): Response {
  const res = err instanceof TriggerConflictError ? fail(err.message, 409) : handle(err);
  res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
  return res;
}

/**
 * TRIGGERS_DISABLED=1(引擎不启动)时两个创建接口答 503 triggersDisabled:不收永远不会触发的条件单。列表与撤销照常。
 * 每次请求读环境变量(与引擎启动时的判断同一个开关)
 */
export function triggersDisabled(): Response | null {
  return process.env.TRIGGERS_DISABLED === "1" ? fail(TRIGGER_ERROR.triggersDisabled, 503, PRIVATE) : null;
}

/** 价格:整数分,1..MAX_PRICE_CENTS */
export const centsSchema = z.number().int("Price must be an integer amount in cents").positive().max(MAX_PRICE_CENTS, "Price exceeds maximum");
/** 数量:整数吨,1..MAX_ORDER_QUANTITY(与下单同一个上限) */
export const quantitySchema = z.number().int().positive("Quantity must be a positive integer").max(MAX_ORDER_QUANTITY, "Quantity exceeds maximum");
/** 创建幂等键:同一用户重发同一个返回同样的行(参数不同 409) */
export const clientKeySchema = z.uuid("clientKey must be a UUID");
