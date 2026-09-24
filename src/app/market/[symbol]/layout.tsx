import type { Metadata } from "next";
import { prisma } from "@/lib/server/db";

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  const asset = await prisma.asset.findUnique({ where: { symbol }, select: { name: true } });
  return {
    title: asset ? `${symbol} · ${asset.name}` : symbol,
    description: `Simulated order book, candles and OTC data for ${symbol} on Carbadia Trade.`,
  };
}

export default function MarketLayout({ children }: { children: React.ReactNode }) {
  return children;
}
