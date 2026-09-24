import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError } from "./auth";
import { TradingError } from "../exchange/matching";
import { OtcError } from "../exchange/otc";

export function ok<T>(data: T, init?: number | { status?: number; headers?: Record<string, string> }) {
  const opts = typeof init === "number" ? { status: init } : init;
  return NextResponse.json({ ok: true, data }, { status: opts?.status ?? 200, headers: opts?.headers });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

/** 统一异常处理: 把领域错误映射为 HTTP 响应 */
export function handle(err: unknown) {
  if (err instanceof AuthError) return fail(err.message || "Not logged in", 401);
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
