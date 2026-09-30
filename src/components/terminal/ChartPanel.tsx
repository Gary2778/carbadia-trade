"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import type { CandleBar, CandleInterval } from "@/shared";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
// chart-adapter 只取类型:它的运行时代码(指标、格式化、图表选项)只进懒加载的图表 chunk
import type { ChartHistory, ChartMode, ChartTab } from "@/lib/market/chart-adapter";
import { fetchCandles } from "@/lib/market/MarketProvider";
import { usePrefs, writePrefs, type IndicatorPrefs } from "@/lib/market/prefs";
import { IndicatorToggles } from "./IndicatorToggles";
import { IntervalTabs, chartTabOf, chartViewOf } from "./IntervalTabs";
import { useHydrated } from "./useTerminalLayout";

// 图表库只在浏览器里、图表容器挂载之后才下载(独立 chunk,首屏 HTML 的 script 列表里没有它);加载期间是面板骨架
const CandleChartLW = dynamic(() => import("./CandleChartLW"), { ssr: false, loading: () => <Skeleton height="panel" /> });

const LOADING: ChartHistory = { status: "loading" };

// ---- 分时开关:prefs 里没有图表模式的键(不新增存储键),所以它是模块级的会话状态 ----
// 放在组件外面,P1-22 的快捷键 1–7 调 selectChartTab 就能切到分时,不必进 ChartPanel;服务端快照恒为 false(K 线),
// 与 SSR 标记一致。
let lineMode = false;
const lineModeListeners = new Set<() => void>();
const subscribeLineMode = (listener: () => void): (() => void) => {
  lineModeListeners.add(listener);
  return () => {
    lineModeListeners.delete(listener);
  };
};
const readLineMode = (): boolean => lineMode;
const readServerLineMode = (): boolean => false;

/** 选中一个图表页签:分时 = interval 1m + line 模式;interval 经 writePrefs 持久化(MarketProvider 随之改订 candles 主题) */
export function selectChartTab(tab: ChartTab): void {
  const view = chartViewOf(tab);
  const nextLine = view.mode === "line";
  if (nextLine !== lineMode) {
    lineMode = nextLine;
    lineModeListeners.forEach((listener) => listener());
  }
  writePrefs({ interval: view.interval });
}

type HistoryState = { key: string; bars: CandleBar[] | null; failed: boolean };

/**
 * 当前 (symbol, interval) 的 REST 历史:分时 / 1m 取最近 24 h(1440 根),其它 interval 500 根(candlesUrl)。
 * 经 fetchCandles 取:换 symbol / interval 时 MarketProvider.calibrateCandles 的首轮同时请求同一 URL,两边共用一个在途请求。
 * 水合完成后才发请求:服务端快照与水合首帧的 interval 是默认 1m,等切到 localStorage 里的偏好再取,不白拉一次。
 * 换键时旧键的结果不外泄(key 不符即 loading),过期的响应丢弃;失败给 error + 重试(重试发新请求,不拿旧的失败)。
 */
function useChartHistory(symbol: string, interval: CandleInterval): ChartHistory {
  const hydrated = useHydrated();
  const key = `${symbol}:${interval}`;
  const [state, setState] = useState<HistoryState>({ key: "", bars: null, failed: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!hydrated) return;
    let current = true;
    const requested = `${symbol}:${interval}`;
    fetchCandles(symbol, interval).then(
      (r) => {
        if (current) setState({ key: requested, bars: r.candles, failed: false });
      },
      () => {
        if (current) setState({ key: requested, bars: null, failed: true });
      },
    );
    return () => {
      current = false;
    };
  }, [hydrated, symbol, interval, attempt]);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, failed: false })); // 重试期间回到 loading
    setAttempt((n) => n + 1);
  }, []);

  return useMemo<ChartHistory>(() => {
    if (state.key !== key) return LOADING;
    if (state.bars) return { status: "ready", bars: state.bars };
    return state.failed ? { status: "error", retry } : LOADING;
  }, [state, key, retry]);
}

export type ChartPanelProps = { symbol: string };

/**
 * 中栏 K 线面板(计划 §3.1、§3.6):周期页签 + 指标开关 + 懒加载的 CandleChartLW。放进 TerminalShell 的图表插槽
 * (PanelSlot area="chart" 已给面板壳与标题),自身只是一列撑满剩余高度的内容。
 *   - interval 来自 usePrefs()(服务端快照与默认值 1m),切换经 writePrefs 持久化,MarketProvider 随之改订 candles:S:<interval>;
 *   - 分时 = interval 1m 的 mode "line"(Area);prefs 里没有图表模式的键,分时选择是模块级会话状态(selectChartTab,
 *     快捷键也走它),刷新后回到 K 线;
 *   - 指标开关 MA(7 / 25 / 99)/ EMA(12 / 26)/ VOL 存在 prefs.indicators;
 *   - 本组件不订阅行情(useCandles 在 CandleChartLW 里),实时更新不会让工具条重渲染;
 *   - 4h / 1d 下注明模拟盘历史只保留 7 天(§9.1 第 21 条)。
 */
export function ChartPanel({ symbol }: ChartPanelProps) {
  const t = useT("terminal");
  const { interval, indicators } = usePrefs();
  const line = useSyncExternalStore(subscribeLineMode, readLineMode, readServerLineMode);
  const mode: ChartMode = line && interval === "1m" ? "line" : "candle";
  const tab = chartTabOf(interval, mode);
  const history = useChartHistory(symbol, interval);

  const handleIndicators = useCallback((next: IndicatorPrefs) => writePrefs({ indicators: next }), []);

  return (
    <div data-chart-panel="" className="flex min-h-0 min-w-0 flex-1 flex-col gap-gap">
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <IntervalTabs value={tab} onChange={selectChartTab} />
        <IndicatorToggles value={indicators} onChange={handleIndicators} />
      </div>
      {/* 图表区至少 12rem:手机上工具条换成两行触控高度的按钮后,图表不被挤扁 */}
      <div className="relative flex min-h-48 flex-1 flex-col">
        <CandleChartLW symbol={symbol} interval={interval} mode={mode} indicators={indicators} history={history} />
      </div>
      {interval === "4h" || interval === "1d" ? <p className="text-t-2xs text-muted-2">{t.chart.retention}</p> : null}
    </div>
  );
}
