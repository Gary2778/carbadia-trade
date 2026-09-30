import { prisma } from "@/lib/server/db";
import { getOrderBook } from "@/lib/exchange/matching";
import { stats24h } from "@/lib/exchange/stats24h";
import { ok, fail, handle } from "@/lib/server/api";
import { getCurrentUser } from "@/lib/server/auth";
import { INSTRUMENT_SELECT, toInstrument } from "@/lib/server/instrument-select";
import type { Instrument } from "@/shared/types";

// symbol 路由是轮询最热的未缓存路径: 每访客每 2s 直查 5 个表。公共部分(asset/stats/book/trades)
// 对所有访客相同, 按 symbol 进程内缓存 2s; 用户部分(holding/myOrders)含私有数据, 每请求现查。
const PUB_TTL_MS = 2000;
const pubCache = new Map<string, { data: { asset: Instrument; stats: unknown; book: unknown; trades: unknown }; ts: number; assetId: string }>();

export async function GET(_req: Request, ctx: { params: Promise<{ symbol: string }> }) {
  try {
    const { symbol } = await ctx.params;
    const userPromise = getCurrentUser().catch(() => null);

    let pub = pubCache.get(symbol);
    if (!pub || Date.now() - pub.ts >= PUB_TTL_MS) {
      // 只 select 白名单字段: 锚定价 / description / createdAt 不进响应(计划 §3.4)
      const row = await prisma.asset.findUnique({ where: { symbol }, select: INSTRUMENT_SELECT });
      if (!row) return fail("Instrument not found", 404);
      const asset = toInstrument(row);

      const [book, trades] = await Promise.all([
        getOrderBook(asset.id),
        prisma.trade.findMany({
          where: { assetId: asset.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { id: true, price: true, quantity: true, createdAt: true },
        }),
      ]);

      // 24h 统计与 /api/assets、/api/market/instruments 同一算处(计划 §3.4):change24h 仍是百分数,
      // 末值由「窗口末笔成交价」改为 Asset.lastPrice、首点为窗口首笔成交(§9.2 D12);键名 vol24h 给旧页面保留
      const s = await stats24h(asset.id, asset.lastPrice);
      const stats = { high24h: s.high24h, low24h: s.low24h, vol24h: s.volume24h, change24h: s.change24hPct };

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
