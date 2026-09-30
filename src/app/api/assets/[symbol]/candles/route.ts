import { prisma } from "@/lib/server/db";
import { ok, fail, handle } from "@/lib/server/api";
import { bucketTrades, INTERVALS, type IntervalKey, type Candle } from "@/lib/exchange/candles";

// 进程内 K 线缓存: 同一标的+周期的聚合结果 5s 内复用, 轮询访客共享同一份
const CACHE_TTL_MS = 5000;
const cache = new Map<string, { data: { candles: Candle[] }; ts: number }>();

// K 线对所有访客相同 → 允许 CDN 吸收轮询流量
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=5, stale-while-revalidate=10" } };

/** 旧端点只认 /market 页四个 tab 的周期(计划 §3.4「保留、不变」);15m / 4h 只在终端的 /api/market/[symbol]/candles 提供 */
const LEGACY_INTERVALS = ["1m", "5m", "1h", "1d"] as const satisfies readonly IntervalKey[];
const isLegacyInterval = (s: string): s is (typeof LEGACY_INTERVALS)[number] => (LEGACY_INTERVALS as readonly string[]).includes(s);

export async function GET(req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = await ctx.params;
    const interval = new URL(req.url).searchParams.get("interval") ?? "1m";
    if (!isLegacyInterval(interval)) return fail(`interval must be one of ${LEGACY_INTERVALS.join("/")}`, 400);
    const cfg = INTERVALS[interval];

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
