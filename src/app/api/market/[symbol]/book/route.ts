import { ok, fail, handle } from "@/lib/server/api";
import { clampInt, DEFAULT_BOOK_DEPTH, findAssetRef, getBookSnapshot, MAX_BOOK_DEPTH, topicSeq } from "@/lib/server/market-snapshots";
import type { BookResponse } from "@/shared/api-shapes";

// 公开盘口快照(计划 §3.4 路由表):?depth=50(1..50);seq = hub 的 __carbadiaTopicSeq["book:SYM"],无 hub 时 0。
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=1, stale-while-revalidate=2" } };

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = await ctx.params;
    const asset = await findAssetRef(symbol);
    if (!asset) return fail("Instrument not found", 404);
    const depth = clampInt(new URL(req.url).searchParams.get("depth"), DEFAULT_BOOK_DEPTH, 1, MAX_BOOK_DEPTH);
    // seq 必须在查库之前读:hub 若在「查库」与「读 seq」之间发布了一条 delta,先读则 seq 落后一位,客户端把已含在快照里的那条
    // delta 再应用一次(档位是绝对量,幂等);后读则 seq 领先一位,客户端把真正缺的那条当成已应用而丢掉,盘口从此错位。
    const seq = topicSeq(`book:${asset.symbol}`);
    const snapshot = await getBookSnapshot(asset, depth);
    const data: BookResponse = { ...snapshot, seq };
    return ok(data, PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
