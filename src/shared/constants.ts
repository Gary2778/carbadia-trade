// 前后端共用常量(计划 §3.5)。纯数据,零依赖。
import type { AuditRef, CandleInterval, FeeSchedule } from "./types";

export const DEFAULT_TERMINAL_SYMBOL = "VCS-FOR-2021";
export const BASE_UNIT = "tCO2e";
/** 成交详情的披露常量:模拟成交,不是登记机构记录(GET /api/account/fills/[id] 的 disclosure 字段) */
export const FILL_DISCLOSURE = "SIMULATED_TRADE_NOT_REGISTRY_RECORD" as const;
export const auditRefOf = (tradeId: string): AuditRef => `SIM-TRD-${tradeId}`;
/** 运行时的 interval 列表,与 CandleInterval 联合一一对应(ws-protocol.test.ts 断言与 server/ws-schema.mjs 相等) */
export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const satisfies readonly CandleInterval[];
/** 盘口聚合档位,× tickSize,单位分 */
export const AGG_STEPS = [1, 5, 10, 50, 100] as const;
export const DEPTH_OPTIONS = [15, 25, 50] as const;
/** 客户端 tape 保留条数 */
export const MAX_TAPE = 200;
/** 也是 /api/market/[symbol]/candles 的 limit 上限;分时(1m × 24 h)= 1440 */
export const MAX_BARS = 1500;
export const DEFAULT_FEE_SCHEDULE: FeeSchedule = { makerBps: 0, takerBps: 0, minFeeCents: 0, demo: true };
/**
 * 条件单接口失败信封里的 error 码:服务端(src/lib/server/triggers.ts、trigger-routes.ts)抛,客户端(src/lib/market/trigger-submit.ts)按它选文案;
 * 两边共用这一份,改了措辞也不会悄悄变成通用错误。400:wouldTriggerNow = 方向与最新价不一致(一创建就会触发),tooManyTriggers = 未完结的已有 50 条,
 * overPosition = 止盈止损的数量超过持仓;503:triggersDisabled = TRIGGERS_DISABLED=1,不收新的条件单与提醒
 */
export const TRIGGER_ERROR = { wouldTriggerNow: "wouldTriggerNow", tooManyTriggers: "tooManyTriggers", overPosition: "overPosition", triggersDisabled: "triggersDisabled" } as const;
