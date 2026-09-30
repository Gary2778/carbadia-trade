import { ok, fail, handle } from "@/lib/server/api";
import { clampInt, DEFAULT_TAPE_LIMIT, findAssetRef, getRecentTrades, readMs, topicSeq } from "@/lib/server/market-snapshots";
import { MAX_TAPE } from "@/shared/constants";
import type { TradesResponse } from "@/shared/api-shapes";

// 公开最近成交(计划 §3.4 路由表):?limit=100(1..200)&before=<unix ms>;时间升序;takerSide 经 takerSideOf 派生;
// seq = hub 的 __carbadiaTopicSeq["trades:SYM"],无 hub 时 0。
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=1, stale-while-revalidate=2" } };

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = await ctx.params;
    const asset = await findAssetRef(symbol);
    if (!asset) return fail("Instrument not found", 404);
    const query = new URL(req.url).searchParams;
    const limit = clampInt(query.get("limit"), DEFAULT_TAPE_LIMIT, 1, MAX_TAPE);
    // seq 在查库之前读(同 book 路由):宁可让客户端收到一条已在快照里的成交(按 id 去重,无害),也不能让它漏掉一条。
    const seq = topicSeq(`trades:${asset.symbol}`);
    const trades = await getRecentTrades(asset, limit, readMs(query.get("before")));
    const data: TradesResponse = { trades, seq };
    return ok(data, PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
