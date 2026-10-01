// 客户端 IP 的信任链只有一份实现:server/client-ip.mjs(hub 的每 IP 连接上限用同一函数;计划 §3.4、§9.2 D3)
import { clientIpFromHeaders } from "../../../server/client-ip.mjs";

// 进程内滑动窗口限流。本应用是结构性单实例(SQLite 卷 + 进程内机器人),
// 进程内状态即全局状态;若未来多实例化,需换外部存储。
// 计数放 globalThis:路由处理器、instrumentation 与 server.mjs 可能各自加载一份本模块,
// 模块级 Map 会让同一个键在不同打包产物里各算各的(例如三个 CSV 路由共用的 csv:user:<id> 桶)。
declare global {
  var __carbadiaRateLimit: Map<string, number[]> | undefined;
}
const buckets: Map<string, number[]> = (globalThis.__carbadiaRateLimit ??= new Map());
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

/**
 * 被 rateLimit 拒绝后,该 key 最早可再次放行的秒数(向上取整,至少 1),用于 429 的 Retry-After:
 * 窗口内最早的一次命中过期时,计数就降到 limit 以下。桶已被清掉或窗口内没有命中时返回 1。
 */
export function retryAfterSeconds(key: string, windowMs: number, now = Date.now()): number {
  const cutoff = now - windowMs;
  const oldest = buckets.get(key)?.find((t) => t > cutoff);
  if (oldest === undefined) return 1;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

/** 限流分桶用的客户端 IP;信任链(x-proxy-secret / cf-connecting-ip / xff 末跳 / "untrusted" / "local")见 server/client-ip.mjs */
export function clientIp(req: Request): string {
  return clientIpFromHeaders((name) => req.headers.get(name), process.env.PROXY_SECRET);
}
