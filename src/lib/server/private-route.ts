// 私有路由共用的件:private, no-store 响应头、按用户 60/min 的限流应答、400 应答、把异常映射成响应(handle)并补上缓存头。
// 条件单三个路由、通知两个路由(/api/account/notices、/api/account/notices/read)与 /api/auth/me 都直接从这里取,没有第二条路径;
// 放在这个只依赖 api / rate-limit 的叶子模块里,通知路由不必为它引进条件单服务与触发引擎。
import { fail, handle } from "./api";
import { rateLimit, retryAfterSeconds } from "./rate-limit";

export const PRIVATE = { "Cache-Control": "private, no-store" } as const;
const WINDOW_MS = 60_000;

/** key 在 60 s 窗口里超过 60 次 → 429(全站既有文案,见 orders/route.ts 的 tooMany 注释;带 Retry-After);没超 → null */
export function rateLimited(key: string): Response | null {
  if (rateLimit(key, 60, WINDOW_MS)) return null;
  return fail("Too many requests, please retry later", 429, { ...PRIVATE, "Retry-After": String(retryAfterSeconds(key, WINDOW_MS)) });
}

/** 查询参数不合法之类的 400(带 private, no-store) */
export const badRequest = (message: string): Response => fail(message, 400, PRIVATE);

/** 失败响应交给 handle()(未登录 401、zod / TradingError 400、忙 503、其余 500),一律带 private, no-store */
export function privateFailure(err: unknown): Response {
  const res = handle(err);
  res.headers.set("Cache-Control", PRIVATE["Cache-Control"]);
  return res;
}
