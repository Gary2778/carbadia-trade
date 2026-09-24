import { prisma } from "../server/db";
import type { Prisma } from "@/generated/prisma";
import { MAX_NOTIONAL_CENTS, MAX_PRICE_CENTS } from "./limits";
import { writeLedger, type LedgerLine } from "./ledger";

export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

export class TradingError extends Error {}

interface PlaceOrderInput {
  userId: string;
  assetId: string;
  side: Side;
  type: OrderType;
  price?: number | null; // LIMIT 必填, 整数分
  quantity: number; // 整数(吨)
}

/**
 * 下单 + 撮合。整个过程在一个事务中完成，保证资金/持仓与订单状态一致。
 * 撮合规则: 价格优先、时间优先。成交价取被动方(挂单方)价格。
 * 金额语义: 一切价格/金额均为整数分; JS number 运算, 仅 User.cashBalance/lockedCash 在 Prisma 边界转 BigInt。
 */
export async function placeOrder(input: PlaceOrderInput) {
  const { userId, assetId, side, type } = input;
  const quantity = Math.trunc(input.quantity);
  const price = input.price ?? null;

  if (quantity <= 0) throw new TradingError("Quantity must be a positive integer");
  if (type === "LIMIT") {
    if (price == null || price <= 0) throw new TradingError("Limit orders require a price greater than 0");
    if (!Number.isInteger(price)) throw new TradingError("Price must be an integer amount in cents");
    if (price > MAX_PRICE_CENTS) throw new TradingError("Price exceeds maximum");
    if (price * quantity > MAX_NOTIONAL_CENTS) throw new TradingError("Order notional exceeds maximum");
  }

  return prisma.$transaction(async (tx) => {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset) throw new TradingError("Instrument not found");

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new TradingError("User not found");

    // 审计流水: 事务内累积, 末尾一次 createMany(ref 需订单/成交创建后才可得)
    const ledger: LedgerLine[] = [];

    // ---- 下单前冻结资源 ----
    if (side === "BUY" && type === "LIMIT") {
      const lock = price! * quantity;
      if (Number(user.cashBalance) < lock) throw new TradingError("Insufficient available cash");
      await tx.user.update({
        where: { id: userId },
        data: { cashBalance: { decrement: BigInt(lock) }, lockedCash: { increment: BigInt(lock) } },
      });
    }
    if (side === "SELL") {
      const holding = await tx.holding.findUnique({
        where: { userId_assetId: { userId, assetId } },
      });
      const available = (holding?.quantity ?? 0) - (holding?.locked ?? 0);
      if (available < quantity) throw new TradingError("Insufficient available holdings");
      await tx.holding.update({
        where: { userId_assetId: { userId, assetId } },
        data: { locked: { increment: quantity } },
      });
    }

    // ---- 创建 taker 订单 ----
    const takerOrder = await tx.order.create({
      data: { userId, assetId, side, type, price, quantity, status: "OPEN" },
    });

    // 冻结流水(冻结发生在订单创建前, ref 统一挂 taker 订单)
    if (side === "BUY" && type === "LIMIT") {
      const lock = price! * quantity;
      ledger.push(
        { userId, account: "CASH", delta: -lock, reason: "ORDER_LOCK", refType: "ORDER", refId: takerOrder.id },
        { userId, account: "CASH_LOCKED", delta: lock, reason: "ORDER_LOCK", refType: "ORDER", refId: takerOrder.id },
      );
    }
    if (side === "SELL") {
      ledger.push({ userId, account: "HOLDING_LOCKED", assetId, delta: quantity, reason: "ORDER_LOCK", refType: "ORDER", refId: takerOrder.id });
    }

    // ---- 拉取对手方挂单 (排除自成交) ----
    const candidates = await tx.order.findMany({
      where: {
        assetId,
        status: { in: ["OPEN", "PARTIAL"] },
        side: side === "BUY" ? "SELL" : "BUY",
        userId: { not: userId },
        ...(type === "LIMIT"
          ? side === "BUY"
            ? { price: { lte: price! } }
            : { price: { gte: price! } }
          : {}),
      },
      orderBy: side === "BUY" ? [{ price: "asc" }, { createdAt: "asc" }] : [{ price: "desc" }, { createdAt: "asc" }],
    });

    let remaining = quantity;
    let filledCost = 0; // 已成交金额
    let filledQty = 0;
    let takerCash = Number(user.cashBalance); // 市价买单实时余额(限价买已冻结)

    for (const maker of candidates) {
      if (remaining <= 0) break;
      const makerRemaining = maker.quantity - maker.filledQuantity;
      if (makerRemaining <= 0) continue;
      const fp = maker.price!; // 挂单一定是限价单, price 非空

      let q = Math.min(remaining, makerRemaining);

      // 市价买单受可用现金约束
      if (side === "BUY" && type === "MARKET") {
        const affordable = Math.floor(takerCash / fp);
        q = Math.min(q, affordable);
        if (q <= 0) break;
      }

      const buyerId = side === "BUY" ? userId : maker.userId;
      const sellerId = side === "BUY" ? maker.userId : userId;
      const buyerIsTaker = side === "BUY";
      const amount = fp * q;

      // --- 资金结算 ---
      // 卖方收款(进可用余额)
      await tx.user.update({ where: { id: sellerId }, data: { cashBalance: { increment: BigInt(amount) } } });
      // 买方付款
      if (buyerIsTaker) {
        if (type === "MARKET") {
          await tx.user.update({ where: { id: buyerId }, data: { cashBalance: { decrement: BigInt(amount) } } });
          takerCash -= amount;
        } else {
          // 限价买 taker: 按下单价冻结, 成交价更优时退还差额
          // 冻结解除必须按下单价(price×q)而非成交价(amount), 否则差额会同时留在冻结里又退进余额
          const refund = (price! - fp) * q;
          await tx.user.update({
            where: { id: buyerId },
            data: { lockedCash: { decrement: BigInt(price! * q) }, cashBalance: { increment: BigInt(refund) } },
          });
        }
      } else {
        // 买方是挂单方: 按其挂单价(=fp)冻结, 直接从冻结扣除
        await tx.user.update({ where: { id: buyerId }, data: { lockedCash: { decrement: BigInt(amount) } } });
      }

      // --- 持仓结算 ---
      // 卖方交付(卖方下单时已冻结)
      await tx.holding.update({
        where: { userId_assetId: { userId: sellerId, assetId } },
        data: { quantity: { decrement: q }, locked: { decrement: q } },
      });
      // 买方收货
      await tx.holding.upsert({
        where: { userId_assetId: { userId: buyerId, assetId } },
        create: { userId: buyerId, assetId, quantity: q, locked: 0 },
        update: { quantity: { increment: q } },
      });

      // --- 更新挂单 ---
      const makerNewFilled = maker.filledQuantity + q;
      await tx.order.update({
        where: { id: maker.id },
        data: {
          filledQuantity: makerNewFilled,
          status: makerNewFilled >= maker.quantity ? "FILLED" : "PARTIAL",
        },
      });

      // --- 成交记录 ---
      const trade = await tx.trade.create({
        data: {
          assetId,
          buyOrderId: buyerIsTaker ? takerOrder.id : maker.id,
          sellOrderId: buyerIsTaker ? maker.id : takerOrder.id,
          buyerId,
          sellerId,
          price: fp,
          quantity: q,
        },
      });

      // 结算流水(与上方资金/持仓结算逐一对应)
      ledger.push({ userId: sellerId, account: "CASH", delta: amount, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
      if (buyerIsTaker) {
        if (type === "MARKET") {
          ledger.push({ userId: buyerId, account: "CASH", delta: -amount, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
        } else {
          ledger.push({ userId: buyerId, account: "CASH_LOCKED", delta: -(price! * q), reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
          const refund = (price! - fp) * q;
          if (refund > 0) {
            ledger.push({ userId: buyerId, account: "CASH", delta: refund, reason: "PRICE_IMPROVE_REFUND", refType: "TRADE", refId: trade.id });
          }
        }
      } else {
        ledger.push({ userId: buyerId, account: "CASH_LOCKED", delta: -amount, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
      }
      ledger.push(
        { userId: sellerId, account: "HOLDING", assetId, delta: -q, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id },
        { userId: sellerId, account: "HOLDING_LOCKED", assetId, delta: -q, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id },
        { userId: buyerId, account: "HOLDING", assetId, delta: q, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id },
      );

      remaining -= q;
      filledQty += q;
      filledCost += amount;
    }

    // ---- 处理 taker 剩余 ----
    let finalStatus: string;
    if (remaining === 0) {
      finalStatus = "FILLED";
    } else if (type === "LIMIT") {
      finalStatus = filledQty > 0 ? "PARTIAL" : "OPEN"; // 挂在订单簿上
    } else {
      finalStatus = "CANCELLED"; // 市价单剩余撤销
      if (side === "SELL") {
        await tx.holding.update({
          where: { userId_assetId: { userId, assetId } },
          data: { locked: { decrement: remaining } },
        });
        ledger.push({ userId, account: "HOLDING_LOCKED", assetId, delta: -remaining, reason: "ORDER_UNLOCK", refType: "ORDER", refId: takerOrder.id });
      }
    }

    const updatedTaker = await tx.order.update({
      where: { id: takerOrder.id },
      data: {
        filledQuantity: filledQty,
        status: finalStatus,
        avgFillPrice: filledQty > 0 ? Math.round(filledCost / filledQty) : null, // 展示用参考价, 允许 ±1 分舍入
      },
    });

    if (filledQty > 0) {
      const lastPrice = Math.round(filledCost / filledQty);
      await tx.asset.update({ where: { id: assetId }, data: { lastPrice } });
    }

    await writeLedger(tx, ledger);

    return { order: updatedTaker, filledQty, filledCost };
  });
}

export async function cancelOrder(userId: string, orderId: string) {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) throw new TradingError("Order not found");
    if (order.userId !== userId) throw new TradingError("Not your order");
    if (!["OPEN", "PARTIAL"].includes(order.status)) throw new TradingError("Order can no longer be cancelled");

    const remaining = order.quantity - order.filledQuantity;
    const ledger: LedgerLine[] = [];
    if (order.side === "BUY" && order.price != null) {
      const unlock = order.price * remaining;
      await tx.user.update({
        where: { id: userId },
        data: { lockedCash: { decrement: BigInt(unlock) }, cashBalance: { increment: BigInt(unlock) } },
      });
      ledger.push(
        { userId, account: "CASH_LOCKED", delta: -unlock, reason: "ORDER_UNLOCK", refType: "ORDER", refId: order.id },
        { userId, account: "CASH", delta: unlock, reason: "ORDER_UNLOCK", refType: "ORDER", refId: order.id },
      );
    } else if (order.side === "SELL") {
      await tx.holding.update({
        where: { userId_assetId: { userId, assetId: order.assetId } },
        data: { locked: { decrement: remaining } },
      });
      ledger.push({ userId, account: "HOLDING_LOCKED", assetId: order.assetId, delta: -remaining, reason: "ORDER_UNLOCK", refType: "ORDER", refId: order.id });
    }
    await writeLedger(tx, ledger);

    return tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
  });
}

/** 聚合订单簿(买卖各价位档位) */
export async function getOrderBook(assetId: string, depth = 12) {
  const open = await prisma.order.findMany({
    where: { assetId, status: { in: ["OPEN", "PARTIAL"] }, type: "LIMIT" },
    select: { side: true, price: true, quantity: true, filledQuantity: true },
  });

  const agg = (s: Side) => {
    const map = new Map<number, number>();
    for (const o of open) {
      if (o.side !== s || o.price == null) continue;
      const rem = o.quantity - o.filledQuantity;
      if (rem <= 0) continue;
      map.set(o.price, (map.get(o.price) ?? 0) + rem);
    }
    return [...map.entries()]
      .map(([price, quantity]) => ({ price, quantity }))
      .sort((a, b) => (s === "BUY" ? b.price - a.price : a.price - b.price))
      .slice(0, depth);
  };

  return { bids: agg("BUY"), asks: agg("SELL") };
}

export type OrderBook = Awaited<ReturnType<typeof getOrderBook>>;
export type TxClient = Prisma.TransactionClient;
