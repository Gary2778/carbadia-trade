import { NextResponse } from "next/server";
import { fail } from "@/lib/server/api";
import { DEFAULT_REGISTRY_UPSTREAM, registryUpstreamUrl } from "@/lib/registry-proxy";

// 登记簿数据代理:只读、白名单、5 分钟缓存。上游不通时回 502,前端沿用已有的错误态。
const UPSTREAM_TIMEOUT_MS = 10_000;
const CACHE_SECONDS = 300;

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const base = process.env.REGISTRY_UPSTREAM || DEFAULT_REGISTRY_UPSTREAM;
  const upstream = registryUpstreamUrl(path, new URL(request.url).search, base);
  if (!upstream) return fail("Not found", 404);
  try {
    const res = await fetch(upstream, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      next: { revalidate: CACHE_SECONDS },
    });
    if (!res.ok) return fail("registry data unavailable", 502);
    const body = await res.text();
    return new NextResponse(body, {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
    });
  } catch {
    return fail("registry data unavailable", 502);
  }
}
