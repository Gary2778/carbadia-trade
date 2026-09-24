// 审计流水写入器。只 create、永不 update/delete —— append-only 是审计的全部意义。
import type { Prisma } from "@/generated/prisma";

export type LedgerAccount = "CASH" | "CASH_LOCKED" | "HOLDING" | "HOLDING_LOCKED";

export interface LedgerLine {
  userId: string;
  account: LedgerAccount;
  delta: number; // 分(CASH*)或 吨(HOLDING*)
  reason: string;
  assetId?: string;
  refType?: "ORDER" | "TRADE" | "LISTING" | "DEAL";
  refId?: string;
}

export async function writeLedger(tx: Prisma.TransactionClient, lines: LedgerLine[]) {
  const rows = lines.filter((l) => l.delta !== 0);
  if (rows.length === 0) return;
  await tx.ledgerEntry.createMany({
    data: rows.map((l) => ({
      userId: l.userId,
      account: l.account,
      delta: BigInt(l.delta),
      reason: l.reason,
      assetId: l.assetId ?? null,
      refType: l.refType ?? null,
      refId: l.refId ?? null,
    })),
  });
}
