"use client";

import { memo } from "react";
import type { CandleInterval } from "@/shared";
import { useT } from "@/i18n/LangProvider";
import type { ChartMode, ChartTab } from "@/lib/market/chart-adapter";

/** 七个页签,顺序即快捷键 1–7(§3.6 键盘表):分时 / 1m / 5m / 15m / 1h / 4h / 1d */
export const CHART_TABS: readonly ChartTab[] = ["time", "1m", "5m", "15m", "1h", "4h", "1d"];

/** 分时 = interval 1m 的 line 模式;其它 interval 一律 K 线 */
export function chartTabOf(interval: CandleInterval, mode: ChartMode): ChartTab {
  return mode === "line" && interval === "1m" ? "time" : interval;
}

export function chartViewOf(tab: ChartTab): { interval: CandleInterval; mode: ChartMode } {
  return tab === "time" ? { interval: "1m", mode: "line" } : { interval: tab, mode: "candle" };
}

export type IntervalTabsProps = {
  value: ChartTab;
  onChange: (tab: ChartTab) => void;
};

/**
 * 图表周期:分时 / 1m / 5m / 15m / 1h / 4h / 1d(terminal.chart.intervals.*,顺序即快捷键 1–7)。
 * 互斥的一组按钮,选中项 aria-pressed;分时 = interval 1m 的 line 模式,由 ChartPanel 换算(chartViewOf)。
 * 触控目标:< 64rem min-h-touch,≥ 64rem 收回紧凑高度(计划 §4.7)。
 */
export const IntervalTabs = memo(function IntervalTabs({ value, onChange }: IntervalTabsProps) {
  const t = useT("terminal");
  return (
    <div role="group" aria-label={t.chart.intervalLabel} className="flex min-w-0 flex-wrap items-center gap-px">
      {CHART_TABS.map((tab) => {
        const selected = tab === value;
        return (
          <button
            key={tab}
            type="button"
            data-interval={tab}
            aria-pressed={selected}
            onClick={() => onChange(tab)}
            className={`inline-flex min-h-touch items-center rounded-control px-2 text-t-xs font-medium tnum lg:min-h-0 lg:py-0.5 transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
              selected ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {t.chart.intervals[tab]}
          </button>
        );
      })}
    </div>
  );
});
