"use client";

import { memo } from "react";
import { useT } from "@/i18n/LangProvider";
import type { IndicatorPrefs } from "@/lib/market/prefs";

export type IndicatorTogglesProps = {
  value: IndicatorPrefs;
  onChange: (next: IndicatorPrefs) => void;
};

const KEYS: readonly (keyof IndicatorPrefs)[] = ["ma", "ema", "vol"];

/**
 * 指标开关:MA(7 / 25 / 99)、EMA(12 / 26)、VOL 三个独立的 aria-pressed 按钮;
 * 值就是 prefs 的 indicators(carbadia-terminal-prefs),ChartPanel 经 writePrefs 持久化。
 */
export const IndicatorToggles = memo(function IndicatorToggles({ value, onChange }: IndicatorTogglesProps) {
  const t = useT("terminal");
  const label: Record<keyof IndicatorPrefs, string> = { ma: t.chart.ma, ema: t.chart.ema, vol: t.chart.vol };
  return (
    <div role="group" aria-label={t.chart.indicatorsLabel} className="flex shrink-0 items-center gap-px">
      {KEYS.map((key) => {
        const on = value[key];
        return (
          <button
            key={key}
            type="button"
            data-indicator={key}
            aria-pressed={on}
            onClick={() => onChange({ ...value, [key]: !on })}
            className={`inline-flex min-h-touch items-center rounded-control px-2 text-t-xs font-medium lg:min-h-0 lg:py-0.5 transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
              on ? "bg-(--terminal-selected) text-foreground" : "text-muted-2 hover:text-muted"
            }`}
          >
            {label[key]}
          </button>
        );
      })}
    </div>
  );
});
