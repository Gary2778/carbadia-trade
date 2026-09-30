// @ts-check
// 客户端 IP 解析的唯一实现(计划 §3.4 契约表、§3.3 连接上限、§9.2 D3):src/lib/server/rate-limit.ts 的 clientIp(req)
// 与 server/ws-hub.mjs 的每 IP 连接上限都调用这里,信任链只有一份。纯 JS、零模块级状态。
//
// 部署拓扑:公网流量走 Cloudflare Worker 反代到 Railway 源站,但源站(*.up.railway.app)本身公网可直连。
// 若直接信任 cf-connecting-ip / x-forwarded-for,攻击者绕过 Cloudflare 直连源站就能自报任意 IP、为每次请求换一个新桶,限流失效。
//
// 防线:Worker 转发时注入 x-proxy-secret(值 = 环境变量 PROXY_SECRET)。
//   - 设了 PROXY_SECRET 且请求头匹配 → 可信(经我们的 Worker)→ 取 cf-connecting-ip,
//     其次 x-forwarded-for 最后一段(离源站最近的代理追加,非客户端可控),再回退 "local";
//   - 设了 PROXY_SECRET 但不匹配 → 直连 / 伪造 → 一律落入同一个 "untrusted" 桶,伪造 IP 换不到新桶,直连洪泛会被这一个桶快速限住;
//   - 未设 PROXY_SECRET(本地开发或尚未配置)→ 沿用旧行为,不影响本地与灰度前的部署。
// "untrusted" 与 "local" 不是真实客户端 IP:限流照旧按桶计数;hub 的连接上限不按 maxPerIp 算这两个桶(否则全部直连 / 本地流量共用一个桶、
// 第 9 个即被拒):"untrusted" 有自己的小上限(WS_MAX_UNTRUSTED,默认 16,终审 P1-25a),"local" 豁免、只受总上限约束。
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/** 直连源站或 x-proxy-secret 不匹配:所有这类请求共用的桶 */
export const IP_BUCKET_UNTRUSTED = "untrusted";
/** 没有任何 IP 头(本地开发、无 PROXY_SECRET 的直连) */
export const IP_BUCKET_LOCAL = "local";

/**
 * @param {string | null} provided
 * @param {string} expected
 */
function secretMatches(provided, expected) {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {(name: string) => string | null} getHeader 按小写头名取值;Request.headers.get 与 IncomingMessage 的适配都能给
 * @param {string | undefined} proxySecret 通常是 process.env.PROXY_SECRET
 * @returns {string} 客户端 IP,或 "untrusted" / "local" 桶
 */
export function clientIpFromHeaders(getHeader, proxySecret) {
  const trusted = !proxySecret || secretMatches(getHeader("x-proxy-secret"), proxySecret);
  if (!trusted) return IP_BUCKET_UNTRUSTED;
  const cf = getHeader("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const fwd = getHeader("x-forwarded-for");
  const parts = fwd?.split(",").map((p) => p.trim()).filter(Boolean) ?? [];
  return parts[parts.length - 1] || IP_BUCKET_LOCAL;
}

/**
 * 该值是不是共享桶(不是单个客户端的 IP)。hub 用它决定不按 maxPerIp 限("untrusted" 另有 maxUntrusted,"local" 豁免)。
 * @param {string} ip
 */
export function isSharedIpBucket(ip) {
  return ip === IP_BUCKET_UNTRUSTED || ip === IP_BUCKET_LOCAL;
}
