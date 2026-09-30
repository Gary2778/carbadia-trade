// 24 h 统计的唯一算处(计划 §3.4「撮合与 OTC」、§9.1 第 38 条、§9.2 D12):
// /api/assets、/api/assets/[symbol]、/api/market/instruments 与发布器(P1-10)都从这里取,不再各算各的。
// change24hPct = (Asset.lastPrice − 24 h 窗口首笔成交价) / 首笔 × 100,单位是百分数(1.23 = +1.23%),
// 与 SpotTable.tsx、market page 现有的 toFixed(2) + "%" 渲染兼容;窗口内无成交或 lastPrice 为 null → null。
import { prisma } from "../server/db";

export const WINDOW_24H_MS = 24 * 3_600_000;

export type Stats24h = {
  /** 百分数:1.23 = +1.23%;不是小数比例 */
  change24hPct: number | null;
  /** 窗口内最高 / 最低成交价,分;无成交 → null */
  high24h: number | null;
  low24h: number | null;
  /** 窗口内成交量,吨;无成交 → 0 */
  volume24h: number;
  /** 窗口内首笔成交价,分;无成交 → null */
  firstPrice: number | null;
};

/** (last − first) × 100 / first:先乘后除,10123 vs 10000 恰得 1.23 而不是 1.2300000000000002 */
function changePct(firstPrice: number | null, lastPrice: number | null): number | null {
  if (firstPrice == null || lastPrice == null || firstPrice <= 0) return null;
  return ((lastPrice - firstPrice) * 100) / firstPrice;
}

/**
 * 一个标的最近 24 h(createdAt ≥ now − 24 h)的统计。
 * @param lastPrice 调用方已持有的 Asset.lastPrice(列表路由逐行传入,省一次查询);不传则查 Asset 表。
 * 首笔按 createdAt asc, id asc 取(同一毫秒多笔时确定);高低量交给数据库聚合,走 (assetId, createdAt) 索引。
 */
export async function stats24h(assetId: string, lastPrice?: number | null): Promise<Stats24h> {
  const since = new Date(Date.now() - WINDOW_24H_MS);
  const within = { assetId, createdAt: { gte: since } };
  const [first, agg, asset] = await Promise.all([
    prisma.trade.findFirst({ where: within, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { price: true } }),
    prisma.trade.aggregate({ where: within, _max: { price: true }, _min: { price: true }, _sum: { quantity: true } }),
    lastPrice === undefined ? prisma.asset.findUnique({ where: { id: assetId }, select: { lastPrice: true } }) : null,
  ]);
  const last = lastPrice === undefined ? (asset?.lastPrice ?? null) : lastPrice;
  const firstPrice = first?.price ?? null;
  return {
    change24hPct: changePct(firstPrice, last),
    high24h: agg._max.price ?? null,
    low24h: agg._min.price ?? null,
    volume24h: agg._sum.quantity ?? 0,
    firstPrice,
  };
}
