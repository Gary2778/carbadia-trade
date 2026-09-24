import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { ok, handle } from "@/lib/server/api";
import { reconstructPositionBasis } from "@/lib/exchange/portfolio-analysis";

const PRIVATE = { headers: { "Cache-Control": "private, no-store" } };

export async function GET() {
  try {
    const user = await requireUser();

    // One read snapshot prevents a trade/retirement between the holdings and
    // ledger reads from masquerading as missing acquisition evidence.
    const [balances, holdings, openOrders, trades, otcListings, ledger, retirementTotals] = await prisma.$transaction([
      prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { cashBalance: true, lockedCash: true } }),
      prisma.holding.findMany({
        where: { userId: user.id, quantity: { gt: 0 } },
        include: { asset: true },
      }),
      prisma.order.findMany({
        where: { userId: user.id, status: { in: ["OPEN", "PARTIAL"] } },
        orderBy: { createdAt: "desc" },
        include: { asset: { select: { symbol: true, name: true } } },
      }),
      prisma.trade.findMany({
        where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { asset: { select: { symbol: true, name: true } } },
      }),
      prisma.otcListing.findMany({
        where: { sellerId: user.id, status: "ACTIVE" },
        include: { asset: { select: { symbol: true, name: true } } },
      }),
      prisma.ledgerEntry.findMany({
        where: {
          userId: user.id,
          OR: [
            { account: "HOLDING" },
            { account: { in: ["CASH", "CASH_LOCKED"] }, reason: { in: ["TRADE_SETTLE", "OTC_SETTLE", "PRICE_IMPROVE_REFUND"] } },
          ],
        },
        select: { id: true, account: true, assetId: true, delta: true, reason: true, refType: true, refId: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      prisma.retirement.aggregate({ where: { userId: user.id }, _sum: { quantity: true } }),
    ]);

    // 持仓市值(按最新价)
    const positions = holdings.map((h) => {
      const mark = h.asset.lastPrice ?? 0;
      return {
        assetId: h.assetId,
        symbol: h.asset.symbol,
        name: h.asset.name,
        registry: h.asset.registry,
        standard: h.asset.standard,
        vintage: h.asset.vintage,
        country: h.asset.country,
        projectType: h.asset.projectType,
        isScenario: h.asset.isScenario,
        quantity: h.quantity,
        locked: h.locked,
        available: h.quantity - h.locked,
        lastPrice: h.asset.lastPrice,
        marketValue: mark * h.quantity, // 分 × 吨 → 分
        valuationComplete: h.asset.lastPrice != null,
        ...reconstructPositionBasis(h.assetId, h.quantity, h.asset.lastPrice, ledger),
      };
    });
    const holdingsValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const basisComplete = positions.every((p) => p.costBasisComplete);
    const valuationComplete = positions.every((p) => p.valuationComplete);

    return ok({
      cashBalance: Number(balances.cashBalance), // BigInt → number, 否则 JSON 序列化 throw
      lockedCash: Number(balances.lockedCash),
      holdingsValue,
      totalAssets: Number(balances.cashBalance) + Number(balances.lockedCash) + holdingsValue,
      heldCredits: positions.filter((p) => !p.isScenario).reduce((sum, p) => sum + p.quantity, 0),
      retiredCredits: retirementTotals._sum.quantity ?? 0,
      costBasisComplete: basisComplete,
      valuationComplete,
      unrealisedPnl: basisComplete && valuationComplete ? positions.reduce((sum, p) => sum + (p.unrealisedPnl ?? 0), 0) : null,
      // There is no account valuation time series. Current market movements
      // cannot be substituted for the user's actual 24-hour performance.
      change24h: null,
      impactBasis: "nominal_demo_tonnes",
      positions,
      openOrders,
      trades: trades.map((t) => ({
        ...t,
        direction: t.buyerId === user.id ? "BUY" : "SELL",
      })),
      otcListings,
    }, PRIVATE);
  } catch (err) {
    const response = handle(err);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
