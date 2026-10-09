import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Retirement } from "../../generated/prisma";
import { prisma } from "../server/db";
import { publishPositionChange } from "../server/market-publisher";
import { writeLedger } from "./ledger";
import { prismaErrorCode } from "../server/prisma-errors";
import { isContentionError } from "./matching";

export const retirementInputSchema = z.object({
  assetId: z.string().trim().min(1).max(100),
  quantity: z.number().int("Quantity must be a whole number").positive("Quantity must be greater than zero").max(2_147_483_647),
  reason: z.string().trim().min(1, "Enter a retirement reason").max(200),
  beneficiary: z.string().trim().min(1, "Enter a beneficiary").max(200),
  purpose: z.string().trim().min(1, "Enter the retirement purpose").max(500),
  publicMessage: z.string().trim().max(500).optional().default(""),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/, "Invalid request identifier"),
  acknowledged: z.literal(true, { error: "Acknowledge the irreversible simulation before confirming" }),
});

export type RetirementInput = z.infer<typeof retirementInputSchema>;
export type RetirementRecord = {
  id: string;
  reference: string;
  status: "SIMULATED";
  assetId: string;
  symbol: string;
  projectName: string;
  registry: string;
  standard: string;
  vintage: number;
  quantity: number;
  tonnesCO2e: number;
  reason: string;
  beneficiary: string;
  purpose: string;
  publicMessage: string | null;
  createdAt: string;
  certificateUrl: string;
};
export type RetirementPosition = {
  assetId: string;
  symbol: string;
  name: string;
  registry: string;
  standard: string;
  vintage: number;
  quantity: number;
  locked: number;
  available: number;
};
export type RetirementOverview = {
  positions: RetirementPosition[];
  retirements: RetirementRecord[];
  totalRetired: number;
};

export class RetirementError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "RetirementError";
  }
}

export function retirementRecord(record: Retirement): RetirementRecord {
  return {
    id: record.id,
    reference: record.reference,
    status: "SIMULATED",
    assetId: record.assetId,
    symbol: record.symbol,
    projectName: record.projectName,
    registry: record.registry,
    standard: record.standard,
    vintage: record.vintage,
    quantity: record.quantity,
    tonnesCO2e: record.quantity,
    reason: record.reason,
    beneficiary: record.beneficiary,
    purpose: record.purpose,
    publicMessage: record.publicMessage,
    createdAt: record.createdAt.toISOString(),
    certificateUrl: `/api/retirements/${encodeURIComponent(record.id)}/certificate`,
  };
}

/**
 * User identity comes from the authenticated session, never the submitted body.
 * 事务提交后把该标的交给发布器(计划 §6.2.2 C2:持仓数量减少、retired 增加,现金不变,只发 position 事件);发布不 await。
 * 重放的请求(replayed: true,库没变)不发。
 */
export async function retireCredits(userId: string, rawInput: unknown) {
  const result = await retireCreditsTx(userId, rawInput);
  if (!result.replayed) publishPositionChange(userId, result.retirement.assetId);
  return result;
}

/** 注销事务本体(不发布);导出的 retireCredits 包一层,同 matching.ts 的 placeOrderTx / placeOrder */
async function retireCreditsTx(userId: string, rawInput: unknown) {
  const input = retirementInputSchema.parse(rawInput);
  const { idempotencyKey } = input;
  const details = { assetId: input.assetId, quantity: input.quantity, reason: input.reason, beneficiary: input.beneficiary, purpose: input.purpose, publicMessage: input.publicMessage };
  const requestFingerprint = createHash("sha256").update(JSON.stringify(details)).digest("hex");
  const key = { userId, idempotencyKey };
  const replay = (existing: Retirement) => {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new RetirementError("This request identifier was already used with different retirement details", 409);
    }
    return { retirement: existing, replayed: true };
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.retirement.findUnique({ where: { userId_idempotencyKey: key } });
      if (existing) return replay(existing);

      const holding = await tx.holding.findUnique({
        where: { userId_assetId: { userId, assetId: input.assetId } },
        include: { asset: true },
      });
      if (holding?.asset.isScenario) {
        throw new RetirementError("Scenario index instruments cannot be retired. Choose an eligible project credit.", 400);
      }
      if (!holding || holding.quantity - holding.locked < input.quantity) {
        throw new RetirementError("Insufficient available holdings. Credits locked in sell orders or OTC listings cannot be retired.", 409);
      }

      // Guard both the balance and observed lock amount; never consume a concurrent sell reservation.
      const debit = await tx.holding.updateMany({
        where: { id: holding.id, userId, locked: holding.locked, quantity: { gte: holding.locked + input.quantity } },
        data: { quantity: { decrement: input.quantity } },
      });
      if (debit.count !== 1) throw new RetirementError("Available holdings changed. Refresh and review the amount again.", 409);

      const record = await tx.retirement.create({
        data: {
          userId,
          assetId: input.assetId,
          quantity: input.quantity,
          reference: `SIM-RET-${randomUUID().toUpperCase()}`,
          status: "SIMULATED",
          symbol: holding.asset.symbol,
          projectName: holding.asset.name,
          registry: holding.asset.registry,
          standard: holding.asset.standard,
          vintage: holding.asset.vintage,
          reason: input.reason,
          beneficiary: input.beneficiary,
          purpose: input.purpose,
          publicMessage: input.publicMessage || null,
          idempotencyKey,
          requestFingerprint,
        },
      });
      // 账本行与其它写入走同一个入口(计划 §6.2.2 C3):同一事务、同样的一行
      await writeLedger(tx, [
        { userId, account: "HOLDING", assetId: input.assetId, delta: -input.quantity, reason: "SIMULATED_RETIREMENT", refType: "RETIREMENT", refId: record.id },
      ]);
      return { retirement: record, replayed: false };
    });
  } catch (error) {
    // 只认 code 字段不认类:生产下 globalThis.prisma 来自 instrumentation 那份运行时,这里 instanceof 本 bundle 的
    // Prisma.PrismaClientKnownRequestError 恒为 false,P2002 重放与 P1008/P2028/P2034 → 503 都会漏成 500(见 src/lib/server/prisma-errors.ts)。
    // Concurrent duplicate submissions are resolved by the database unique key.
    if (prismaErrorCode(error) === "P2002") {
      const existing = await prisma.retirement.findUnique({ where: { userId_idempotencyKey: key } });
      if (existing) return replay(existing);
    }
    // P2002 但重读不到(另一次提交已回滚 / reference 撞了 uuid)同样让客户端原样重发,而不是 500
    if (isContentionError(error)) {
      throw new RetirementError("The account is busy. Retry this same request to check whether it completed.", 503);
    }
    throw error;
  }
}

export async function listRetirements(userId: string): Promise<RetirementOverview> {
  const [holdings, retirements, total] = await Promise.all([
    prisma.holding.findMany({ where: { userId, quantity: { gt: 0 }, asset: { isScenario: false } }, include: { asset: true }, orderBy: { assetId: "asc" } }),
    prisma.retirement.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 }),
    prisma.retirement.aggregate({ where: { userId }, _sum: { quantity: true } }),
  ]);
  return {
    positions: holdings.map((holding) => ({
      assetId: holding.assetId,
      symbol: holding.asset.symbol,
      name: holding.asset.name,
      registry: holding.asset.registry,
      standard: holding.asset.standard,
      vintage: holding.asset.vintage,
      quantity: holding.quantity,
      locked: holding.locked,
      available: Math.max(0, holding.quantity - holding.locked),
    })),
    retirements: retirements.map(retirementRecord),
    totalRetired: total._sum.quantity ?? 0,
  };
}

export async function getRetirement(userId: string, id: string) {
  return prisma.retirement.findFirst({ where: { id, userId } });
}

/** Authenticated, printable HTML only; the simulation never issues a registry certificate. */
export function renderRetirementCertificate(record: Retirement): string {
  const escape = (value: string | number) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  const rows: [string, string | number][] = [
    ["Simulation reference", record.reference],
    ["Simulation date (UTC)", record.createdAt.toISOString()],
    ["Simulated credits removed", record.quantity],
    ["Modelled quantity (tCO2e)", record.quantity],
    ["Project label in demo", record.projectName],
    ["Instrument", record.symbol],
    ["Registry label in demo", record.registry || "Not provided"],
    ["Standard label in demo", record.standard || "Not provided"],
    ["Vintage", record.vintage],
    ["Beneficiary (user supplied)", record.beneficiary],
    ["Reason", record.reason],
    ["Purpose", record.purpose],
    ...(record.publicMessage ? [["Optional message (kept private)", record.publicMessage] as [string, string]] : []),
  ];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Simulation certificate · ${escape(record.reference)}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#f5f7f6;color:#172a22;font:15px/1.6 system-ui,sans-serif}main{max-width:850px;margin:36px auto;padding:44px;background:white;border:1px solid #d8e2dc;border-radius:16px}.brand{font-weight:700;letter-spacing:.08em}.notice{padding:18px;border:2px solid #97631a;background:#fff8e9;border-radius:8px;margin:24px 0}.notice strong{display:block;font-size:19px}h1{font-size:32px;line-height:1.2;margin:18px 0 10px}p{margin:8px 0}dl{margin:28px 0}dl>div{display:grid;grid-template-columns:220px 1fr;gap:24px;padding:12px 0;border-bottom:1px solid #e3e9e5;break-inside:avoid}dt{color:#52655a}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}.foot{font-size:12px;color:#52655a}@media(max-width:600px){main{margin:0;padding:24px}dl>div{grid-template-columns:1fr;gap:4px}}@media print{body{background:white}main{margin:0;border:0;padding:12mm;max-width:none}.print-help{display:none}h1{font-size:26px}.notice{background:white}dl>div{padding:7px 0}}
  </style></head><body><main><div class="brand">CARBADIA / DEMO</div><h1>Simulated retirement certificate</h1><p>A receipt for an irreversible change to your demonstration holdings.</p><div class="notice"><strong>SIMULATION ONLY</strong><p>No registry retirement has occurred. No real emissions claim, offset, credit ownership, or environmental benefit is certified by this receipt.</p></div><dl>${rows.map(([label, value]) => `<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl><p>Each simulated credit represents one modelled tCO2e in this application. Project and registry labels describe the demo instrument; they do not verify a real project, serial number, registry connection, or carbon-credit custody.</p><p class="foot">Status: SIMULATED · Private account receipt · This reference is an internal simulation identifier, not a registry retirement ID.</p><p class="foot print-help">Use your browser’s Print command to print or save this simulation receipt as a PDF. This file contains the beneficiary and message you entered; share it deliberately.</p></main></body></html>`;
}
