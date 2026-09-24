import { timingSafeEqual } from "node:crypto";

// 进程内滑动窗口限流。本应用是结构性单实例(SQLite 卷 + 进程内机器人),
// 进程内状态即全局状态;若未来多实例化,需换外部存储。
const buckets = new Map<string, number[]>();
const MAX_KEYS = 10_000; // 防内存无限增长:超限时全量清一次(限流是尽力而为,不是账本)

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  if (buckets.size > MAX_KEYS) buckets.clear();
  const cutoff = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 客户端 IP 解析 —— 用于限流分桶,必须防伪造。
//
// 部署拓扑:公网流量走 Cloudflare Worker 反代到 Railway 源站,但源站
// (*.up.railway.app)本身公网可直连。若直接信任 cf-connecting-ip / x-forwarded-for,
// 攻击者绕过 Cloudflare 直连源站就能自报任意 IP、为每次请求换一个新限流桶,限流失效。
//
// 防线:Worker 转发时注入 x-proxy-secret(值 = 环境变量 PROXY_SECRET)。
//   - 设了 PROXY_SECRET 且请求头匹配 → 可信(经我们的 Worker)→ 取 cf-connecting-ip,
//     其次 x-forwarded-for 最后一段(离源站最近的代理追加,非客户端可控),再回退 "local";
//   - 设了 PROXY_SECRET 但不匹配 → 直连/伪造 → 一律落入同一个 "untrusted" 桶,
//     伪造 IP 换不到新桶,直连洪泛会被这一个桶快速限住;
//   - 未设 PROXY_SECRET(本地开发或尚未配置)→ 沿用旧行为,不影响本地与灰度前的部署。
export function clientIp(req: Request): string {
  const secret = process.env.PROXY_SECRET;
  const trusted = !secret || secretMatches(req.headers.get("x-proxy-secret"), secret);
  if (!trusted) return "untrusted";
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const fwd = req.headers.get("x-forwarded-for");
  const parts = fwd?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
  return parts[parts.length - 1] || "local";
}
