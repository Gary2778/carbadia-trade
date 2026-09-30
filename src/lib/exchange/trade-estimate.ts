export type TradeLevel = { price: number; quantity: number };
export type MarketEstimate = { quantity: number; totalCents: number; unfilledQuantity: number };

/** A snapshot estimate of visible book liquidity, not an execution guarantee.
 * Prices and totals stay in integer cents. Pass available cash for buy orders.
 */
export function estimateMarketOrder(
  levels: TradeLevel[],
  quantity: number,
  availableCash?: number | null,
): MarketEstimate | null {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
  let remaining = quantity;
  let totalCents = 0;
  let cash = availableCash ?? Infinity;
  for (const level of levels) {
    if (!Number.isSafeInteger(level.price) || level.price <= 0 || !Number.isSafeInteger(level.quantity) || level.quantity < 0) return null;
    const take = Math.min(remaining, level.quantity, Math.max(0, Math.floor(cash / level.price)));
    totalCents += take * level.price;
    if (!Number.isSafeInteger(totalCents)) return null;
    cash -= take * level.price;
    remaining -= take;
    if (remaining === 0 || cash < level.price) break;
  }
  return { quantity: quantity - remaining, totalCents, unfilledQuantity: remaining };
}

/** 按金额吃单的估算:quantity = 买到的吨数,totalCents = 实际花费,unspentCents = 剩余金额(不足下一吨或盘口耗尽) */
export type AmountEstimate = { quantity: number; totalCents: number; unspentCents: number };

/** A snapshot estimate of how many whole credits an amount buys across visible levels, not an execution guarantee.
 * Levels must be best-price first (asks ascending for a buy). Amount and totals stay in integer cents.
 */
export function estimateMarketByAmount(levels: TradeLevel[], amountCents: number): AmountEstimate | null {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  let cash = amountCents;
  let quantity = 0;
  for (const level of levels) {
    if (!Number.isSafeInteger(level.price) || level.price <= 0 || !Number.isSafeInteger(level.quantity) || level.quantity < 0) return null;
    const take = Math.min(level.quantity, Math.floor(cash / level.price));
    quantity += take;
    cash -= take * level.price;
    if (cash < level.price) break;
  }
  return { quantity, totalCents: amountCents - cash, unspentCents: cash };
}
