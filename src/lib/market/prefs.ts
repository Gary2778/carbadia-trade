"use client";
// 终端偏好(计划 §3.6、§4.9):localStorage 键 carbadia-terminal-prefs(/privacy §4 列出)。
// readPrefs 对非法 JSON / 缺键 / 非法值逐键回默认,writePrefs 合并写入并 try/catch(隐私模式、配额、禁用存储都不抛);
// 写不进存储时偏好留在内存里(memoryPrefs),本次会话照样生效 —— 图表周期、指标、盘口分组 / 档数不会点了没反应。
// usePrefs = useSyncExternalStore(subscribe, 读 localStorage, () => DEFAULT_PREFS):服务端快照与水合首帧恒为默认值,
// 挂载后才切到存储值 —— 与 useWatchlist 同一模式,不会 SSR 与客户端首帧不一致,也不需要 effect 里 setState。
import { useSyncExternalStore } from "react";
import type { CandleInterval } from "@/shared";
import { CANDLE_INTERVALS, DEPTH_OPTIONS } from "@/shared";

export const PREFS_KEY = "carbadia-terminal-prefs";

/** 底部页签;"ledger"(流水)是 P2-07 加的第五个,"triggers"(条件单)是 P3-07 加的第六个。旧存储里的值照旧有效,认不得的值(含以后才有的页签)回默认 */
export type BottomTab = "open" | "triggers" | "history" | "fills" | "positions" | "ledger";
export type IndicatorPrefs = { ma: boolean; ema: boolean; vol: boolean };
/** 表格行密度(P3-10):comfortable = --spacing-row(22 px),compact = --spacing-row-dense(20 px);终端根的 data-density 把前者换成后者 */
export type Density = "comfortable" | "compact";
export type TerminalPrefs = {
  interval: CandleInterval;
  /** 盘口聚合档(分);null = 用标的 tickSize */
  agg: number | null;
  /** 盘口每侧档数,∈ DEPTH_OPTIONS(15 / 25 / 50);与 agg 一样全局一个值 */
  depth: number;
  bottomTab: BottomTab;
  indicators: IndicatorPrefs;
  lastSymbol: string | null;
  /** 旧存储里没有这个键:读出来是默认值 comfortable */
  density: Density;
};

const BOTTOM_TABS: readonly BottomTab[] = ["open", "triggers", "history", "fills", "positions", "ledger"];

export const DEFAULT_PREFS: TerminalPrefs = Object.freeze({
  interval: "1m",
  agg: null,
  depth: DEPTH_OPTIONS[0],
  bottomTab: "open",
  indicators: Object.freeze({ ma: true, ema: false, vol: true }),
  lastSymbol: null,
  density: "comfortable",
}) as TerminalPrefs;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInterval = (v: unknown): v is CandleInterval => typeof v === "string" && (CANDLE_INTERVALS as readonly string[]).includes(v);
const isDepth = (v: unknown): v is number => typeof v === "number" && (DEPTH_OPTIONS as readonly number[]).includes(v);
const isBottomTab = (v: unknown): v is BottomTab => typeof v === "string" && BOTTOM_TABS.includes(v as BottomTab);
const isDensity = (v: unknown): v is Density => v === "comfortable" || v === "compact";
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** 非法 JSON、非对象、缺键或非法值一律逐键回默认;永不抛错 */
export function readPrefs(raw: string | null): TerminalPrefs {
  if (raw === null || raw === "") return DEFAULT_PREFS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFS;
  }
  if (!isRecord(parsed)) return DEFAULT_PREFS;
  const ind = isRecord(parsed.indicators) ? parsed.indicators : {};
  return {
    interval: isInterval(parsed.interval) ? parsed.interval : DEFAULT_PREFS.interval,
    agg: typeof parsed.agg === "number" && Number.isSafeInteger(parsed.agg) && parsed.agg > 0 ? parsed.agg : DEFAULT_PREFS.agg,
    depth: isDepth(parsed.depth) ? parsed.depth : DEFAULT_PREFS.depth,
    bottomTab: isBottomTab(parsed.bottomTab) ? parsed.bottomTab : DEFAULT_PREFS.bottomTab,
    indicators: {
      ma: bool(ind.ma, DEFAULT_PREFS.indicators.ma),
      ema: bool(ind.ema, DEFAULT_PREFS.indicators.ema),
      vol: bool(ind.vol, DEFAULT_PREFS.indicators.vol),
    },
    lastSymbol: typeof parsed.lastSymbol === "string" && parsed.lastSymbol.length > 0 ? parsed.lastSymbol : DEFAULT_PREFS.lastSymbol,
    density: isDensity(parsed.density) ? parsed.density : DEFAULT_PREFS.density,
  };
}

const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((fn) => fn());

const readRaw = (): string | null => {
  try {
    return localStorage.getItem(PREFS_KEY);
  } catch {
    return null;
  }
};

/**
 * 会话内的偏好:存储写不进去(禁用站点数据时 setItem / getItem 抛 SecurityError、配额满抛 QuotaExceededError、没有 localStorage)
 * 时留着最近一次写入的完整偏好,getSnapshot 优先返回它;写入成功即清掉(以存储为准)。每次写入是一个新对象、读取不另建,
 * useSyncExternalStore 的「同一内容同一引用」照旧成立。另一个标签页写了同一个键(storage 事件)说明存储又能用了,也清掉。
 */
let memoryPrefs: TerminalPrefs | null = null;

/** 合并写入(可以只传要改的键,如 switchSymbol 的 { lastSymbol });存储不可用时留在内存里(本次会话有效),都会通知订阅者 */
export function writePrefs(partial: Partial<TerminalPrefs>): void {
  const current = memoryPrefs ?? readPrefs(readRaw());
  const next: TerminalPrefs = {
    ...current,
    ...partial,
    indicators: { ...current.indicators, ...(partial.indicators ?? {}) },
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    memoryPrefs = null;
  } catch {
    // 隐私模式 / 配额 / 禁用存储:偏好只在本次会话内生效
    memoryPrefs = next;
  }
  emit();
}

/** usePrefs 的 subscribe(导出供测试):同标签页的 writePrefs 与其它标签页的 storage 事件都通知 */
export const subscribePrefs = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== PREFS_KEY) return;
    memoryPrefs = null; // 别的标签页写进去了:存储可用,以它为准
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

// useSyncExternalStore 要求同一份存储内容返回同一引用,否则会无限重渲染:按 raw 字符串缓存
let cachedRaw: string | null | undefined;
let cachedPrefs: TerminalPrefs = DEFAULT_PREFS;
/** usePrefs 的客户端快照(导出供测试):会话内偏好优先,否则按 raw 字符串缓存的存储值 */
export const readPrefsSnapshot = (): TerminalPrefs => {
  if (memoryPrefs) return memoryPrefs;
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefs = readPrefs(raw);
  }
  return cachedPrefs;
};
const getServerSnapshot = (): TerminalPrefs => DEFAULT_PREFS;

/**
 * 行密度单独订阅(TerminalShell 的 data-density、行高估值、头部开关):只在密度变时重渲染,
 * 周期 / 页签 / 盘口档数的偏好变化不牵动壳。服务端与水合首帧恒为 comfortable,挂载后切到存储值(根上只多一个属性,没有布局位移:行高只在定高面板里变)。
 */
export function useDensity(): Density {
  return useSyncExternalStore(subscribePrefs, () => readPrefsSnapshot().density, () => DEFAULT_PREFS.density);
}

/** 服务端与水合首帧恒为 DEFAULT_PREFS(ChartPanel 的 1m、盘口的 15 档、BottomTabs 的 open),挂载后切到 localStorage 值 */
export function usePrefs(): TerminalPrefs {
  return useSyncExternalStore(subscribePrefs, readPrefsSnapshot, getServerSnapshot);
}
