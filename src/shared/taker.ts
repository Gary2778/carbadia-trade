// 成交主动方判定(计划 §9.1 第 25 条):Trade 表不存 takerSide,由成交价与两张订单确定性派生。
// 规则按序:MARKET 单是 taker → 挂单价 ≠ 成交价的一方是 taker(成交按被动方价)→ 较晚创建的是 taker → id 大的是 taker。
import type { OrderType, Side } from "./types";

export type OrderStub = { type: OrderType; price: number | null; createdAt: number; id: string };

export function takerSideOf(t: { price: number; buyOrder: OrderStub; sellOrder: OrderStub }): Side {
  const { price, buyOrder, sellOrder } = t;
  const buyMarket = buyOrder.type === "MARKET";
  const sellMarket = sellOrder.type === "MARKET";
  if (buyMarket !== sellMarket) return buyMarket ? "BUY" : "SELL";

  const buyOff = buyOrder.price !== price;
  const sellOff = sellOrder.price !== price;
  if (buyOff !== sellOff) return buyOff ? "BUY" : "SELL";

  if (buyOrder.createdAt !== sellOrder.createdAt) return buyOrder.createdAt > sellOrder.createdAt ? "BUY" : "SELL";

  return buyOrder.id > sellOrder.id ? "BUY" : "SELL";
}
