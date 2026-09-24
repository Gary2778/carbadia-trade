import { prisma } from "@/lib/server/db";
import { ok, fail, handle } from "@/lib/server/api";
import { bucketTrades, INTERVALS, type IntervalKey, type Candle } from "@/lib/exchange/candles";

// 进程内 K 线缓存: 同一标的+周期的聚合结果 5s 内复用, 轮询访客共享同一份
const CACHE_TTL_MS = 5000;
const cache = new Map<string, { data: { candles: Candle[] }; ts: number }>();

// K 线对所有访客相同 → 允许 CDN 吸收轮询流量
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=5, stale-while-revalidate=10" } };

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = await ctx.params;
    const interval = new URL(req.url).searchParams.get("interval") ?? "1m";
    if (!Object.hasOwn(INTERVALS, interval)) return fail("interval must be one of 1m/5m/1h/1d", 400);
    const cfg = INTERVALS[interval as IntervalKey];

    const asset = await prisma.asset.findUnique({ where: { symbol }, select: { id: true } });
    if (!asset) return fail("Instrument not found", 404);

    const key = `${asset.id}:${interval}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return ok(hit.data, PUBLIC_CACHE);

    const trades = await prisma.trade.findMany({
      where: { assetId: asset.id, createdAt: { gte: new Date(Date.now() - cfg.lookbackMs) } },
      select: { price: true, quantity: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const data = { candles: bucketTrades(trades, cfg.ms) };
    cache.set(key, { data, ts: Date.now() });
    return ok(data, PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
