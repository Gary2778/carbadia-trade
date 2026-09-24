import { prisma } from "@/lib/server/db";
import { getOrderBook } from "@/lib/exchange/matching";
import { ok, fail, handle } from "@/lib/server/api";
import { getCurrentUser } from "@/lib/server/auth";

// symbol 路由是轮询最热的未缓存路径: 每访客每 2s 直查 5 个表。公共部分(asset/stats/book/trades)
// 对所有访客相同, 按 symbol 进程内缓存 2s; 用户部分(holding/myOrders)含私有数据, 每请求现查。
const PUB_TTL_MS = 2000;
const pubCache = new Map<string, { data: { asset: unknown; stats: unknown; book: unknown; trades: unknown }; ts: number; assetId: string }>();

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = await ctx.params;
    const userPromise = getCurrentUser().catch(() => null);

    let pub = pubCache.get(symbol);
    if (!pub || Date.now() - pub.ts >= PUB_TTL_MS) {
      const asset = await prisma.asset.findUnique({ where: { symbol } });
      if (!asset) return fail("Instrument not found", 404);

      const [book, trades] = await Promise.all([
        getOrderBook(asset.id),
        prisma.trade.findMany({
          where: { assetId: asset.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, price: true, quantity: true, createdAt: true },
        }),
      ]);

      const since = new Date(Date.now() - 24 * 3_600_000);
      const t24 = await prisma.trade.findMany({
        where: { assetId: asset.id, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { price: true, quantity: true },
      });
      let high24h: number | null = null;
      let low24h: number | null = null;
      let vol24h = 0;
      for (const t of t24) {
        high24h = high24h == null ? t.price : Math.max(high24h, t.price);
        low24h = low24h == null ? t.price : Math.min(low24h, t.price);
        vol24h += t.quantity;
      }
      const change24h = t24.length >= 2 ? ((t24[t24.length - 1].price - t24[0].price) / t24[0].price) * 100 : null;
      const stats = { high24h, low24h, vol24h, change24h };

      pub = { data: { asset, stats, book, trades }, ts: Date.now(), assetId: asset.id };
      pubCache.set(symbol, pub);
    }

    const user = await userPromise;
    let holding = null;
    let myOrders: unknown[] = [];
    let cashBalance: number | null = null;
    if (user) {
      holding = await prisma.holding.findUnique({
        where: { userId_assetId: { userId: user.id, assetId: pub.assetId } },
      });
      myOrders = await prisma.order.findMany({
        where: { userId: user.id, assetId: pub.assetId, status: { in: ["OPEN", "PARTIAL"] } },
        orderBy: { createdAt: "desc" },
      });
      // 买入侧可用现金提示用(整数分), 只读附加字段; 未登录响应不含该字段(向后兼容)
      cashBalance = Number(user.cashBalance); // BigInt → number, 否则 JSON 序列化 throw
    }

    // 响应含用户持仓/挂单等私有数据, 禁止任何共享缓存(CDN/浏览器)存储
    return ok(
      { ...pub.data, holding, myOrders, ...(cashBalance != null ? { cashBalance } : {}) },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (err) {
    return handle(err);
  }
}
