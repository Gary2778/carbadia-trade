import { prisma } from "../server/db";
import { publishLastPrice } from "../server/market-publisher";
import { MAX_NOTIONAL_CENTS, MAX_PRICE_CENTS } from "./limits";
import { writeLedger } from "./ledger";

export class OtcError extends Error {}

interface CreateListingInput {
  sellerId: string;
  assetId: string;
  quantity: number;
  pricePerUnit: number; // 整数分/吨
  minQuantity?: number;
}

/** 创建 OTC 挂牌: 冻结卖方对应持仓。金额语义: 整数分。 */
export async function createListing(input: CreateListingInput) {
  const quantity = Math.trunc(input.quantity);
  const pricePerUnit = input.pricePerUnit;
  const minQuantity = Math.max(1, Math.trunc(input.minQuantity ?? 1));

  if (quantity <= 0) throw new OtcError("Quantity must be a positive integer");
  if (!Number.isInteger(pricePerUnit)) throw new OtcError("Unit price must be an integer amount in cents");
  if (pricePerUnit <= 0) throw new OtcError("Unit price must be greater than 0");
  if (pricePerUnit > MAX_PRICE_CENTS) throw new OtcError("Unit price exceeds maximum");
  if (pricePerUnit * quantity > MAX_NOTIONAL_CENTS) throw new OtcError("Listing notional exceeds maximum");
  if (minQuantity > quantity) throw new OtcError("Min buy cannot exceed listing quantity");

  return prisma.$transaction(async (tx) => {
    const holding = await tx.holding.findUnique({
      where: { userId_assetId: { userId: input.sellerId, assetId: input.assetId } },
    });
    const available = (holding?.quantity ?? 0) - (holding?.locked ?? 0);
    if (available < quantity) throw new OtcError("Insufficient available holdings");

    await tx.holding.update({
      where: { userId_assetId: { userId: input.sellerId, assetId: input.assetId } },
      data: { locked: { increment: quantity } },
    });

    const listing = await tx.otcListing.create({
      data: {
        sellerId: input.sellerId,
        assetId: input.assetId,
        quantity,
        pricePerUnit,
        minQuantity,
      },
    });

    await writeLedger(tx, [
      { userId: input.sellerId, account: "HOLDING_LOCKED", assetId: input.assetId, delta: quantity, reason: "OTC_LOCK", refType: "LISTING", refId: listing.id },
    ]);

    return listing;
  });
}

/** 撤销 OTC 挂牌: 解冻剩余持仓 */
export async function cancelListing(sellerId: string, listingId: string) {
  return prisma.$transaction(async (tx) => {
    const listing = await tx.otcListing.findUnique({ where: { id: listingId } });
    if (!listing) throw new OtcError("Listing not found");
    if (listing.sellerId !== sellerId) throw new OtcError("Not your listing");
    if (listing.status !== "ACTIVE") throw new OtcError("Listing can no longer be cancelled");

    await tx.holding.update({
      where: { userId_assetId: { userId: sellerId, assetId: listing.assetId } },
      data: { locked: { decrement: listing.quantity } },
    });

    await writeLedger(tx, [
      { userId: sellerId, account: "HOLDING_LOCKED", assetId: listing.assetId, delta: -listing.quantity, reason: "OTC_UNLOCK", refType: "LISTING", refId: listing.id },
    ]);

    return tx.otcListing.update({ where: { id: listingId }, data: { status: "CANCELLED" } });
  });
}

/** 购买 OTC 挂牌(可部分成交)。事务提交后把成交价交给发布器(ticker 最后价 + 双方账户事件),发布不 await、失败的事务永不进总线 */
export async function buyListing(buyerId: string, listingId: string, qty: number) {
  const quantity = Math.trunc(qty);
  if (quantity <= 0) throw new OtcError("Purchase quantity must be a positive integer");

  const { deal, published } = await prisma.$transaction(async (tx) => {
    const listing = await tx.otcListing.findUnique({ where: { id: listingId }, include: { asset: { select: { symbol: true } } } });
    if (!listing) throw new OtcError("Listing not found");
    if (listing.status !== "ACTIVE") throw new OtcError("Listing is not available");
    if (listing.sellerId === buyerId) throw new OtcError("You cannot buy your own listing");
    if (quantity > listing.quantity) throw new OtcError("Exceeds available listing quantity");
    if (quantity < listing.minQuantity && quantity < listing.quantity) {
      throw new OtcError(`Below the minimum purchase (${listing.minQuantity} t)`);
    }

    const total = listing.pricePerUnit * quantity;
    const buyer = await tx.user.findUnique({ where: { id: buyerId } });
    if (!buyer) throw new OtcError("Buyer not found");
    if (Number(buyer.cashBalance) < total) throw new OtcError("Insufficient available cash");

    // 资金: 买方 -> 卖方
    await tx.user.update({ where: { id: buyerId }, data: { cashBalance: { decrement: BigInt(total) } } });
    await tx.user.update({ where: { id: listing.sellerId }, data: { cashBalance: { increment: BigInt(total) } } });

    // 持仓: 卖方交付(已冻结) -> 买方
    await tx.holding.update({
      where: { userId_assetId: { userId: listing.sellerId, assetId: listing.assetId } },
      data: { quantity: { decrement: quantity }, locked: { decrement: quantity } },
    });
    await tx.holding.upsert({
      where: { userId_assetId: { userId: buyerId, assetId: listing.assetId } },
      create: { userId: buyerId, assetId: listing.assetId, quantity, locked: 0 },
      update: { quantity: { increment: quantity } },
    });

    // 更新挂牌
    const remaining = listing.quantity - quantity;
    await tx.otcListing.update({
      where: { id: listingId },
      data: { quantity: remaining, status: remaining === 0 ? "SOLD" : "ACTIVE" },
    });

    // 参考价
    await tx.asset.update({ where: { id: listing.assetId }, data: { lastPrice: listing.pricePerUnit } });

    const deal = await tx.otcDeal.create({
      data: { listingId, buyerId, quantity, price: listing.pricePerUnit, total },
    });

    await writeLedger(tx, [
      { userId: buyerId, account: "CASH", delta: -total, reason: "OTC_SETTLE", refType: "DEAL", refId: deal.id },
      { userId: listing.sellerId, account: "CASH", delta: total, reason: "OTC_SETTLE", refType: "DEAL", refId: deal.id },
      { userId: listing.sellerId, account: "HOLDING", assetId: listing.assetId, delta: -quantity, reason: "OTC_SETTLE", refType: "DEAL", refId: deal.id },
      { userId: listing.sellerId, account: "HOLDING_LOCKED", assetId: listing.assetId, delta: -quantity, reason: "OTC_SETTLE", refType: "DEAL", refId: deal.id },
      { userId: buyerId, account: "HOLDING", assetId: listing.assetId, delta: quantity, reason: "OTC_SETTLE", refType: "DEAL", refId: deal.id },
    ]);

    return {
      deal,
      published: { assetId: listing.assetId, symbol: listing.asset.symbol, lastPrice: listing.pricePerUnit, buyerId, sellerId: listing.sellerId },
    };
  });
  publishLastPrice(published);
  return deal;
}
