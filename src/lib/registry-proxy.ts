// Projects 与 Market data 两页读的是 Atlas 的登记簿数据(carbadia.io 的公开接口 /api/real/*)。
// 本站不存登记簿表,由 app/api/real/[...path] 路由代理并缓存;这里只放纯函数,方便测试。
export const REGISTRY_ALLOWLIST = new Set(["overview", "projects"]);
export const DEFAULT_REGISTRY_UPSTREAM = "https://carbadia.io";

/** 白名单内的单段路径 → 上游完整地址;其它一律 null(调用方回 404) */
export function registryUpstreamUrl(pathSegments: string[], search: string, base: string): string | null {
  if (pathSegments.length !== 1 || !REGISTRY_ALLOWLIST.has(pathSegments[0])) return null;
  return `${base.replace(/\/+$/, "")}/api/real/${pathSegments[0]}${search}`;
}
