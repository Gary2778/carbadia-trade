import { prisma } from "@/lib/server/db";
import { ok, handle } from "@/lib/server/api";
import { INSTRUMENT_SELECT, toInstrument } from "@/lib/server/instrument-select";
import { sparkline } from "@/lib/exchange/sparkline";
import { stats24h } from "@/lib/exchange/stats24h";
import type { Instrument } from "@/shared/types";

/** 旧列表端点的行 = 公开标的字段(INSTRUMENT_SELECT 白名单, 无 anchorPrice / description / createdAt)+ 盘口与 24h 统计 */
type AssetRow = Instrument & {
  bestBid: number | null;
  bestAsk: number | null;
  volume24h: number;
  availableSupply: number;
  change24h: number | null;
  spark: number[];
};

// 进程内 TTL 缓存: 行情列表对所有访客相同, 单实例部署下把 N 个访客的查询坍缩为每 2s 一次
const CACHE_TTL_MS = 2000;
const cache = new Map<"base", { data: AssetRow[]; ts: number }>();

// 行情列表对所有访客相同 → 允许 CDN(Cloudflare)吸收轮询流量, 减少打到源站的请求数
const PUBLIC_CACHE = { headers: { "Cache-Control": "public, max-age=1, s-maxage=2, stale-while-revalidate=4" } };

export async function GET() {
  try {
    const hit = cache.get("base");
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return ok(hit.data, PUBLIC_CACHE);

    // 只 select 白名单字段: 锚定价永不外露(2026-09-26 前整行外溢 anchorPrice, 计划 §3.4 修复)
    const assets = await prisma.asset.findMany({ orderBy: { symbol: "asc" }, select: INSTRUMENT_SELECT });

    // 计算每个标的最优买卖价 + 24h 统计(stats24h 一处计算)+ 火花线(索引定位抽样,不再把一天的成交读进内存)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result: AssetRow[] = await Promise.all(
      assets.map(async (a) => {
        const [bestBid, bestAsk, stats, supply, spark] = await Promise.all([
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
          // 24h 涨跌与成交量:与 /api/market/instruments 同一算处(百分数;首点 = 24h 窗口首笔成交,计划 §9.2 D12)
          stats24h(a.id, a.lastPrice),
          prisma.order.aggregate({
            where: { assetId: a.id, side: "SELL", type: "LIMIT", status: { in: ["OPEN", "PARTIAL"] } },
            _sum: { quantity: true, filledQuantity: true },
          }),
          sparkline(prisma, a.id, since),
        ]);
        return {
          ...toInstrument(a),
          bestBid: bestBid?.price ?? null,
          bestAsk: bestAsk?.price ?? null,
          volume24h: stats.volume24h,
          // Executable simulated asks; not project issuance or registry inventory.
          availableSupply: (supply._sum.quantity ?? 0) - (supply._sum.filledQuantity ?? 0),
          change24h: stats.change24hPct,
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
