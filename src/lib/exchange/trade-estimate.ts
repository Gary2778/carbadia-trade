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
