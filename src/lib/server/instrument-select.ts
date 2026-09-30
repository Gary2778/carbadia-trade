// 标的的公开字段白名单与边界映射(计划 §3.4)。
// 诚实规则: /api/assets*、/api/market/* 只能 select 这里的字段——anchorPrice(bot 锚定价)、description、createdAt 永不外露;
// 核证状态列是自由 TEXT, 读取时经 narrowVerification 收窄为字面量联合, 不用 as 断言(§9.1 第 15 条)。
import type { Prisma } from "../../generated/prisma";
import type { Instrument, VerificationStatus } from "../../shared/types";

export const INSTRUMENT_SELECT = {
  id: true,
  symbol: true,
  name: true,
  standard: true,
  projectType: true,
  vintage: true,
  country: true,
  registry: true,
  isScenario: true,
  projectId: true,
  methodology: true,
  verificationStatus: true,
  tickSize: true,
  pricePrecision: true,
  qtyStep: true,
  minQty: true,
  currency: true,
  lastPrice: true,
} satisfies Prisma.AssetSelect;

/** prisma.asset.find*({ select: INSTRUMENT_SELECT }) 的行类型 */
export type InstrumentRow = Prisma.AssetGetPayload<{ select: typeof INSTRUMENT_SELECT }>;

/** 同一非法值只告警一次: 轮询路由每 2 s 读一遍, 不能每次都刷日志 */
const warnedValues = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedValues.has(key)) return;
  warnedValues.add(key);
  console.warn(message);
}

/**
 * 只有 "SIMULATED_UNVERIFIED" 原样通过; 其它任何字符串(包括真实核证状态)一律收窄为 null 并告警一次。
 * 模拟盘不得出现真实核证状态, 未知即 null(UI 显示「未提供」)。
 */
export function narrowVerification(s: string | null): VerificationStatus | null {
  if (s === null) return null;
  if (s === "SIMULATED_UNVERIFIED") return s;
  warnOnce(`verification:${s}`, `[instruments] verificationStatus 非法值 ${JSON.stringify(s)} 已收窄为 null`);
  return null;
}

/** Phase 1 全站 USD(§9.1 第 14 条); 列值不是 USD 只可能来自手工改库, 告警并按 USD 输出 */
function narrowCurrency(s: string): Instrument["currency"] {
  if (s !== "USD") warnOnce(`currency:${s}`, `[instruments] currency 非法值 ${JSON.stringify(s)}, Phase 1 只支持 USD`);
  return "USD";
}

/** 显式逐字段映射, 不 spread: 即使误传整行, anchorPrice / description / createdAt 也不会进响应 */
export function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    standard: row.standard,
    projectType: row.projectType,
    vintage: row.vintage,
    country: row.country,
    registry: row.registry,
    isScenario: row.isScenario,
    projectId: row.projectId,
    methodology: row.methodology,
    verificationStatus: narrowVerification(row.verificationStatus),
    tickSize: row.tickSize,
    pricePrecision: row.pricePrecision,
    qtyStep: row.qtyStep,
    minQty: row.minQty,
    currency: narrowCurrency(row.currency),
    lastPrice: row.lastPrice,
  };
}
