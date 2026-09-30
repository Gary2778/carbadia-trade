import type { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { fail, handle, ok } from "@/lib/server/api";

const ACCOUNT_LABELS: Record<string, string> = {
  CASH: "Available demo cash",
  CASH_LOCKED: "Reserved demo cash",
  HOLDING: "Credit balance",
  HOLDING_LOCKED: "Reserved credits",
};

function privateResponse<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

function activity(entry: { account: string; reason: string; delta: bigint }) {
  const credits = entry.account.startsWith("HOLDING");
  switch (entry.reason) {
    case "TRADE_SETTLE":
      if (entry.account === "HOLDING") return entry.delta > 0 ? { type: "BUY", label: "Credits purchased" } : { type: "SELL", label: "Credits sold" };
      return { type: "SETTLEMENT", label: credits ? "Reserved credits delivered" : entry.delta > 0 ? "Trade proceeds" : "Trade payment" };
    case "OTC_SETTLE":
      if (entry.account === "HOLDING") return entry.delta > 0 ? { type: "OTC_BUY", label: "OTC credits purchased" } : { type: "OTC_SELL", label: "OTC credits sold" };
      return { type: "OTC_SETTLEMENT", label: credits ? "Reserved OTC credits delivered" : entry.delta > 0 ? "OTC proceeds" : "OTC payment" };
    case "SIMULATED_RETIREMENT":
      return { type: "RETIREMENT", label: "Simulated credit retirement" };
    case "ORDER_LOCK":
    case "OTC_LOCK":
      return { type: "RESERVE", label: credits ? "Credits reserved" : "Demo funds reserved" };
    case "ORDER_UNLOCK":
    case "OTC_UNLOCK":
      return { type: "RELEASE", label: credits ? "Credits released" : "Demo funds released" };
    // 自成交防护撤掉本人挂单时的解冻(计划 §9.1 第 41 条):同属 RELEASE,标签点明原因
    case "SELF_TRADE_UNLOCK":
      return { type: "RELEASE", label: credits ? "Credits released (self-trade prevention)" : "Demo funds released (self-trade prevention)" };
    case "PRICE_IMPROVE_REFUND":
      return { type: "REFUND", label: "Price improvement refund" };
    case "GRANT":
      return { type: "GRANT", label: credits ? "Demo credits granted" : "Demo funds granted" };
    case "SEED":
      return { type: "OPENING_BALANCE", label: credits ? "Opening demo credits" : "Opening demo cash" };
    case "MIGRATION_BASELINE":
      return { type: "OPENING_BALANCE", label: "Opening ledger balance" };
    default:
      return { type: "ADJUSTMENT", label: entry.reason.toLowerCase().replaceAll("_", " ") };
  }
}

/** Account movements, not a second trade ledger: related rows share refType/refId. */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    const rawLimit = params.get("limit");
    const limit = rawLimit == null ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return privateResponse(fail("Limit must be an integer between 1 and 100", 400));
    }
    const cursor = params.get("cursor");
    if (cursor && cursor.length > 200) return privateResponse(fail("Invalid activity cursor", 400));
    const after = cursor ? await prisma.ledgerEntry.findFirst({
      where: { id: cursor, userId: user.id },
      select: { id: true, createdAt: true },
    }) : null;
    if (cursor && !after) return privateResponse(fail("Activity cursor was not found", 400));

    const where: Prisma.LedgerEntryWhereInput = {
      userId: user.id,
      ...(after ? { OR: [
        { createdAt: { lt: after.createdAt } },
        { createdAt: after.createdAt, id: { lt: after.id } },
      ] } : {}),
    };
    const [total, fetched] = await prisma.$transaction([
      prisma.ledgerEntry.count({ where: { userId: user.id } }),
      prisma.ledgerEntry.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: { id: true, account: true, delta: true, reason: true, refType: true, refId: true, assetId: true, createdAt: true },
      }),
    ]);
    const rows = fetched.slice(0, limit);
    const refs = new Map<string, { refType: string; refId: string }>();
    for (const row of rows) {
      if (row.refType && row.refId) refs.set(`${row.refType}:${row.refId}`, { refType: row.refType, refId: row.refId });
    }
    const orderIds = [...refs.values()].filter((ref) => ref.refType === "ORDER").map((ref) => ref.refId);
    // Cash ledger rows do not carry assetId. Recover it from the user's
    // companion credit movement, or from the user's order for cash locks.
    const [companions, orders] = await Promise.all([
      refs.size ? prisma.ledgerEntry.findMany({
        where: { userId: user.id, assetId: { not: null }, OR: [...refs.values()] },
        select: { refType: true, refId: true, assetId: true },
      }) : Promise.resolve([]),
      orderIds.length ? prisma.order.findMany({
        where: { userId: user.id, id: { in: orderIds } },
        select: { id: true, assetId: true },
      }) : Promise.resolve([]),
    ]);
    const assetByRef = new Map<string, string>();
    for (const row of companions) if (row.refType && row.refId && row.assetId) assetByRef.set(`${row.refType}:${row.refId}`, row.assetId);
    for (const order of orders) assetByRef.set(`ORDER:${order.id}`, order.assetId);
    const assetIds = [...new Set(rows.map((row) => row.assetId ?? assetByRef.get(`${row.refType}:${row.refId}`)).filter((id): id is string => !!id))];
    const assets = assetIds.length ? await prisma.asset.findMany({
      where: { id: { in: assetIds } },
      select: { id: true, symbol: true, name: true, standard: true, registry: true, vintage: true, country: true, projectType: true, isScenario: true },
    }) : [];
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const entries = rows.map((row) => {
      const assetId = row.assetId ?? assetByRef.get(`${row.refType}:${row.refId}`) ?? null;
      const delta = Number(row.delta);
      return {
        ...row,
        // Ordinary amounts are JSON numbers. Preserve any unusually large
        // append-only amount as an exact decimal string instead of rounding it.
        delta: Number.isSafeInteger(delta) ? delta : row.delta.toString(),
        deltaIsExactNumber: Number.isSafeInteger(delta),
        ...activity(row),
        accountLabel: ACCOUNT_LABELS[row.account] ?? row.account,
        unit: row.account.startsWith("HOLDING") ? "tCO2e" : "USD_CENTS",
        assetId,
        asset: assetId ? assetById.get(assetId) ?? null : null,
      };
    });
    const hasMore = fetched.length > limit;
    return privateResponse(ok({
      entries,
      pagination: { limit, total, hasMore, nextCursor: hasMore ? rows.at(-1)!.id : null },
    }));
  } catch (err) {
    return privateResponse(handle(err));
  }
}
