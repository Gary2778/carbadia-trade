/** Ledger amounts are integer cents; quantities are whole nominal tonnes CO₂e. */
export type CostBasisLedgerLine = {
  id: string;
  account: string;
  assetId: string | null;
  delta: number | bigint;
  reason: string;
  refType: string | null;
  refId: string | null;
  createdAt: Date | string;
};

export type PositionBasis = {
  /** Remaining weighted-average acquisition cost, rounded to integer cents. */
  costBasis: number | null;
  averagePurchasePrice: number | null;
  unrealisedPnl: number | null;
  costBasisComplete: boolean;
  costBasisStatus: "complete" | "unknown_acquisition_cost" | "incomplete_ledger";
};

function reference(line: CostBasisLedgerLine) {
  return line.refType && line.refId ? `${line.refType}:${line.refId}` : null;
}

function safeNumber(value: number | bigint): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Reconstruct remaining cost from the user's append-only ledger, not the last
 * page of trades. A limit fill's CASH_LOCKED debit includes the limit price;
 * its PRICE_IMPROVE_REFUND restores the difference, so both cash accounts must
 * be netted by trade reference. OTC uses the same approach by deal reference.
 *
 * Seed/granted/migration holdings have no recorded acquisition cost. Mixing
 * them with purchased credits keeps the pool unknown until it is fully sold
 * or retired. A missing ledger baseline/payment never becomes a zero cost.
 * This is a demo portfolio estimate, not tax-lot or realised-P&L accounting.
 */
export function reconstructPositionBasis(
  assetId: string,
  currentQuantity: number,
  lastPrice: number | null,
  entries: readonly CostBasisLedgerLine[],
): PositionBasis {
  const cashByRef = new Map<string, { net: number; valid: boolean }>();
  const acquisitionsByRef = new Map<string, number>();
  for (const entry of entries) {
    const key = reference(entry);
    if (!key) continue;
    if (entry.account === "HOLDING" && Number(entry.delta) > 0) {
      acquisitionsByRef.set(key, (acquisitionsByRef.get(key) ?? 0) + 1);
    }
    const isTradePayment = entry.refType === "TRADE" && ["TRADE_SETTLE", "PRICE_IMPROVE_REFUND"].includes(entry.reason);
    const isOtcPayment = entry.refType === "DEAL" && entry.reason === "OTC_SETTLE";
    if (!["CASH", "CASH_LOCKED"].includes(entry.account) || (!isTradePayment && !isOtcPayment)) continue;
    const existing = cashByRef.get(key) ?? { net: 0, valid: true };
    const delta = safeNumber(entry.delta);
    const net = existing.net + (delta ?? 0);
    cashByRef.set(key, { net, valid: existing.valid && delta != null && Number.isSafeInteger(net) });
  }

  const movements = entries
    .filter((entry) => entry.account === "HOLDING" && entry.assetId === assetId)
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
  let quantity = 0;
  let cost = 0;
  let known = true;
  let incomplete = !Number.isSafeInteger(currentQuantity) || currentQuantity < 0;

  for (const entry of movements) {
    const delta = safeNumber(entry.delta);
    if (delta == null || !Number.isFinite(new Date(entry.createdAt).getTime())) {
      incomplete = true;
      continue;
    }
    if (delta > 0) {
      const key = reference(entry);
      const payment = key ? cashByRef.get(key) : null;
      const purchased = (entry.reason === "TRADE_SETTLE" && entry.refType === "TRADE") ||
        (entry.reason === "OTC_SETTLE" && entry.refType === "DEAL");
      if (purchased && key && payment?.valid && payment.net < 0 && acquisitionsByRef.get(key) === 1) {
        cost -= payment.net;
        if (!Number.isFinite(cost) || cost > Number.MAX_SAFE_INTEGER) incomplete = true;
      } else {
        known = false;
      }
      quantity += delta;
    } else if (delta < 0) {
      if (-delta > quantity || quantity <= 0) {
        incomplete = true;
      } else {
        cost *= (quantity + delta) / quantity;
      }
      quantity += delta;
    }
    if (!Number.isSafeInteger(quantity)) incomplete = true;
    if (quantity === 0) {
      cost = 0;
      known = true;
    }
  }

  if (quantity !== currentQuantity) incomplete = true;
  const status = incomplete ? "incomplete_ledger" : known ? "complete" : "unknown_acquisition_cost";
  if (status !== "complete") {
    return { costBasis: null, averagePurchasePrice: null, unrealisedPnl: null, costBasisComplete: false, costBasisStatus: status };
  }
  const markValue = lastPrice == null ? null : lastPrice * currentQuantity;
  return {
    costBasis: Math.round(cost),
    averagePurchasePrice: currentQuantity > 0 ? Math.round(cost / currentQuantity) : null,
    unrealisedPnl: markValue != null && Number.isSafeInteger(markValue) ? Math.round(markValue - cost) : null,
    costBasisComplete: true,
    costBasisStatus: "complete",
  };
}
