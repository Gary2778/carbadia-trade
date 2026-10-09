import { ok, handle } from "@/lib/server/api";
import { listInstruments } from "@/lib/server/market-snapshots";
import { computeIndices } from "@/shared/market-indices";

// 公开模拟指数(计划 §6.3.2 C3 / C6):对所有访客相同,由 listInstruments()(进程缓存 2 s)现算,不另起缓存与定时器;
// 与页面客户端重算用同一个纯函数。边缘名单 /^\/api\/market\// 已覆盖,响应里没有用户数据。
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=5, stale-while-revalidate=10" } };

export async function GET() {
  try {
    const { instruments } = await listInstruments();
    return ok(computeIndices(instruments, Date.now()), PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
