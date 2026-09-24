import { prisma } from "@/lib/server/db";
import { ok, handle } from "@/lib/server/api";
import { sparkline } from "@/lib/exchange/sparkline";

// 进程内 TTL 缓存: 行情列表对所有访客相同, 单实例部署下把 N 个访客的查询坍缩为每 2s 一次
const CACHE_TTL_MS = 2000;
const cache = new Map<"base", { data: unknown; ts: number }>();

// 行情列表对所有访客相同 → 允许 CDN(Cloudflare)吸收轮询流量, 减少打到源站的请求数
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=4" } };

export async function GET() {
  try {
    const hit = cache.get("base");
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return ok(hit.data, PUBLIC_CACHE);

    const assets = await prisma.asset.findMany({ orderBy: { symbol: "asc" } });

    // 计算每个标的最优买卖价 + 24h 成交量 + 火花线(索引定位抽样,不再把一天的成交读进内存)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await Promise.all(
      assets.map(async (a) => {
        const [bestBid, bestAsk, vol, supply, spark] = await Promise.all([
          prisma.order.findFirst({
            where: { assetId: a.id, side: "BUY", status: { in: ["OPEN", "PARTIAL"] } },
            orderBy: { price: "desc" },
            select: { price: true },
          }),
          prisma.order.findFirst({
            where: { assetId: a.id, side: "SELL", status: { in: ["OPEN", "PARTIAL"] } },
            orderBy: { price: "asc" },
            select: { price: true },
          }),
          // 成交量交给数据库聚合
          prisma.trade.aggregate({
            where: { assetId: a.id, createdAt: { gte: since } },
            _sum: { quantity: true },
          }),
          prisma.order.aggregate({
            where: { assetId: a.id, side: "SELL", type: "LIMIT", status: { in: ["OPEN", "PARTIAL"] } },
            _sum: { quantity: true, filledQuantity: true },
          }),
          sparkline(prisma, a.id, since),
        ]);
        // 火花线首点就是窗口内最早的成交价,涨跌幅拿它对比 lastPrice
        const change24h = spark.length > 0 && a.lastPrice != null ? ((a.lastPrice - spark[0]) / spark[0]) * 100 : null;
        return {
          ...a,
          bestBid: bestBid?.price ?? null,
          bestAsk: bestAsk?.price ?? null,
          volume24h: vol._sum.quantity ?? 0,
          // Executable simulated asks; not project issuance or registry inventory.
          availableSupply: (supply._sum.quantity ?? 0) - (supply._sum.filledQuantity ?? 0),
          change24h,
          spark,
        };
      })
    );
    cache.set("base", { data: result, ts: Date.now() });
    return ok(result, PUBLIC_CACHE);
  } catch (err) {
    return handle(err);
  }
}
