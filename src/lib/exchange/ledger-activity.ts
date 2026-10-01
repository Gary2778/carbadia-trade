// 流水分类(计划 §6.2.2 C4):一行账本(account / reason / delta)→ 给人看的类别与英文标签,以及反方向的「按类别筛选」条件。
// 纯函数、零依赖(只引 src/shared 的类型),服务端路由与客户端都能用;分类与筛选必须一致,由 ledger-activity.test.ts 的性质测试守住。
import type { ActivityType, LedgerAccount } from "@/shared/api-shapes";

export type { ActivityType, LedgerAccount };

/** 账本的四个账户(schema.prisma LedgerEntry.account) */
export const LEDGER_ACCOUNTS = ["CASH", "CASH_LOCKED", "HOLDING", "HOLDING_LOCKED"] as const satisfies readonly LedgerAccount[];

/** 全部流水类别;顺序即筛选下拉的顺序 */
export const ACTIVITY_TYPES = [
  "BUY", "SELL", "SETTLEMENT",
  "OTC_BUY", "OTC_SELL", "OTC_SETTLEMENT",
  "RETIREMENT", "RESERVE", "RELEASE", "REFUND",
  "GRANT", "OPENING_BALANCE", "ADJUSTMENT",
] as const satisfies readonly ActivityType[];

export type LedgerEntryLike = { account: string; reason: string; delta: bigint | number };

/**
 * 一行账本 → 类别与英文标签。原 /api/transactions 路由里的 activity(),逻辑与标签文字原样搬来:
 * 成交(撮合 / OTC)在 HOLDING 账户上按正负分买入、卖出,其余账户是同一笔成交的结算腿;没登记的 reason 一律 ADJUSTMENT。
 */
export function activityOf(entry: LedgerEntryLike): { type: ActivityType; label: string } {
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

/**
 * type → 它对应的账本 reason 集合。ADJUSTMENT 是空集:它的含义是「不在任何一组里的 reason」(见 activityFilter)。
 * BUY / SELL / SETTLEMENT 共用 TRADE_SETTLE(OTC 三项同理),只靠 reason 分不开,还要看账户与正负——筛选一律走 activityFilter。
 */
export const REASONS_BY_TYPE: Record<ActivityType, readonly string[]> = {
  BUY: ["TRADE_SETTLE"],
  SELL: ["TRADE_SETTLE"],
  SETTLEMENT: ["TRADE_SETTLE"],
  OTC_BUY: ["OTC_SETTLE"],
  OTC_SELL: ["OTC_SETTLE"],
  OTC_SETTLEMENT: ["OTC_SETTLE"],
  RETIREMENT: ["SIMULATED_RETIREMENT"],
  RESERVE: ["ORDER_LOCK", "OTC_LOCK"],
  RELEASE: ["ORDER_UNLOCK", "OTC_UNLOCK", "SELF_TRADE_UNLOCK"],
  REFUND: ["PRICE_IMPROVE_REFUND"],
  GRANT: ["GRANT"],
  OPENING_BALANCE: ["SEED", "MIGRATION_BASELINE"],
  ADJUSTMENT: [],
};

/** 有专门分类的全部 reason(去重);不在这里的 reason 都归 ADJUSTMENT */
export const KNOWN_REASONS: readonly string[] = [...new Set(Object.values(REASONS_BY_TYPE).flat())];

/**
 * 按 type 筛选时加在账本行上的条件,与 activityOf 的分支一一对应:
 * - reasons + exclude:exclude 为 false → reason 在 reasons 里;为 true → reason 不在 reasons 里(ADJUSTMENT)
 * - holding:true → account 必须是 HOLDING;false → account 不是 HOLDING;null → 不限
 * - positive:true → delta > 0;false → delta ≤ 0;null → 不限
 */
export type ActivityFilter = { reasons: readonly string[]; exclude: boolean; holding: boolean | null; positive: boolean | null };

/** 买入、卖出、结算腿在 HOLDING 账户与正负上的划分(撮合与 OTC 同一套) */
const SETTLE_SPLIT: Partial<Record<ActivityType, Pick<ActivityFilter, "holding" | "positive">>> = {
  BUY: { holding: true, positive: true },
  SELL: { holding: true, positive: false },
  SETTLEMENT: { holding: false, positive: null },
  OTC_BUY: { holding: true, positive: true },
  OTC_SELL: { holding: true, positive: false },
  OTC_SETTLEMENT: { holding: false, positive: null },
};

export function activityFilter(type: ActivityType): ActivityFilter {
  if (type === "ADJUSTMENT") return { reasons: KNOWN_REASONS, exclude: true, holding: null, positive: null };
  return { reasons: REASONS_BY_TYPE[type], exclude: false, ...(SETTLE_SPLIT[type] ?? { holding: null, positive: null }) };
}

/** activityFilter 的条件在内存里的判定(路由把同一组条件写进 SQL);entry 满足 filter ⇔ activityOf(entry).type 就是那个 type */
export function matchesActivityFilter(entry: LedgerEntryLike, filter: ActivityFilter): boolean {
  if (filter.reasons.includes(entry.reason) === filter.exclude) return false;
  if (filter.holding !== null && (entry.account === "HOLDING") !== filter.holding) return false;
  if (filter.positive !== null && (entry.delta > 0) !== filter.positive) return false;
  return true;
}
