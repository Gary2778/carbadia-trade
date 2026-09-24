import type { MetadataRoute } from "next";
import { prisma } from "@/lib/server/db";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = "https://cbda.trade";
  const statics = ["", "/otc", "/terms", "/privacy"].map((p) => ({
    url: `${base}${p}`,
    changeFrequency: "daily" as const,
    priority: p === "" ? 1 : 0.6,
  }));
  const assets = await prisma.asset.findMany({ select: { symbol: true } });
  return [
    ...statics,
    ...assets.map((a) => ({ url: `${base}/market/${a.symbol}`, changeFrequency: "hourly" as const, priority: 0.8 })),
  ];
}
