import { prisma } from "@/lib/server/db";
import { ok, fail } from "@/lib/server/api";
import { clientIp } from "@/lib/server/rate-limit";
import { readWsStats } from "@/lib/server/ws-stats";
import { touchHeartbeat } from "@/lib/server/heartbeat";
import { deepProbe, isWatchdogRequest } from "@/lib/server/watchdog-probe";
import type { HealthResponse } from "@/shared/api-shapes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // 诊断(仅当显式带 ?probe 时):把限流实际解析出的客户端 IP 与信任状态打到服务端日志,
  // 用来确认 Cloudflare Worker 是否把 cf-connecting-ip 与 x-proxy-secret 正确转发到源站。
  // 不改变响应体、不对外泄露;平时(健康检查无 probe)零开销。确认完可保留或删除。
  if (new URL(req.url).searchParams.has("probe")) {
    console.log(
      "[health-probe] clientIp=%s cf=%s xff=%s proxySecret(header/env)=%s/%s",
      clientIp(req),
      req.headers.get("cf-connecting-ip") ?? "-",
      req.headers.get("x-forwarded-for") ?? "-",
      req.headers.get("x-proxy-secret") ? "present" : "absent",
      process.env.PROXY_SECRET ? "set" : "unset",
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    return fail("db unavailable", 500);
  }
  // 计划 §3.4:bot = instrumentation 是否拉起了做市机器人;ws = hub 的统计(WS_DISABLED 时 enabled: false 的零计数);
  // startMode 由「有没有 hub 初始化过 __carbadiaWsStats」推断——next start(START_MODE=next)下 server.mjs 不跑,恒为 null。
  const ws = readWsStats();
  const body: HealthResponse = { db: true, bot: globalThis.__carbadiaBot === true, startMode: ws ? "custom" : "next", ws };
  // 看门狗深探(设计 docs/superpowers/specs/2026-10-09-watchdog-alerts-design.md §3.1):只在 x-watchdog-secret 与
  // WATCHDOG_SECRET 定长相等时写一次 Heartbeat、读卷用量;其余请求(Railway 健康检查、任何人直接访问)响应与原来逐字节相同。
  // 写入失败仍 200,判定交给看门狗。
  if (isWatchdogRequest(req)) {
    const probe = await deepProbe(() => touchHeartbeat());
    return ok({ ...body, ...probe } satisfies HealthResponse, { headers: { "Cache-Control": "no-store" } });
  }
  return ok(body);
}
