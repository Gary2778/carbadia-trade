import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "./auth";
import { BusyError, TradingError } from "../exchange/matching";
import { OtcError } from "../exchange/otc";

export function ok<T>(data: T, init?: number | { status?: number; headers?: Record<string, string> }) {
  const opts = typeof init === "number" ? { status: init } : init;
  return NextResponse.json({ ok: true, data }, { status: opts?.status ?? 200, headers: opts?.headers });
}

/** 失败信封;headers 给 429 的 Retry-After、503 的 Retry-After: 1 之类挂响应头(计划 §3.4「信封与限流基础件」) */
export function fail(message: string, status = 400, headers?: Record<string, string>) {
  return NextResponse.json({ ok: false, error: message }, { status, headers });
}

/** 统一异常处理: 把领域错误映射为 HTTP 响应 */
export function handle(err: unknown) {
  if (err instanceof AuthError) return fail(err.message || "Not logged in", 401);
  // 并发兜底(计划 §3.4):撮合事务写冲突 / 超时且重读不到既有单 → 503 + Retry-After: 1,客户端原样重发同一请求;须排在 TradingError 之前
  if (err instanceof BusyError) return fail(err.message, 503, { "Retry-After": "1" });
  if (err instanceof TradingError || err instanceof OtcError) return fail(err.message, 400);
  if (err instanceof z.ZodError) return fail(err.issues[0]?.message ?? "Invalid request", 400);
  console.error("[API ERROR]", err);
  return fail("Internal server error", 500);
}

export async function parseBody<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new z.ZodError([{ code: "custom", message: "Request body is not valid JSON", path: [] }]);
  }
  return schema.parse(json);
}
