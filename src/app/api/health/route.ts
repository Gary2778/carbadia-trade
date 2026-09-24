import { prisma } from "@/lib/server/db";
import { ok, fail } from "@/lib/server/api";
import { clientIp } from "@/lib/server/rate-limit";

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
    return ok({ db: true });
  } catch {
    return fail("db unavailable", 500);
  }
}
