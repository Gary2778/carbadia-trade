import { ok, handle } from "@/lib/server/api";
import { listInstruments } from "@/lib/server/market-snapshots";

// 公开标的列表 + ticker(计划 §3.4 路由表):对所有访客相同,进程缓存 2 s,边缘名单 /^\/api\/market\// 可缓存。
// 响应里永不含用户数据;标的字段只经 INSTRUMENT_SELECT(无 anchorPrice / description / createdAt)。
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=4" } };

export async function GET() {
  try {
    return ok(await listInstruments(), PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
