"use client";

import { memo, useId } from "react";
import { DEPTH_OPTIONS } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { formatPrice } from "@/shared/precision";

export type DepthSelectorProps = {
  /** 可选的合并档(分)= AGG_STEPS × tickSize */
  steps: readonly number[];
  /** 当前合并档(分),必在 steps 里 */
  value: number;
  /** 当前每侧档数,∈ DEPTH_OPTIONS */
  depth: number;
  /** 两个下拉任一变化都回调完整的一对值(另一项原样带回) */
  onChange: (agg: number, depth: number) => void;
};

const SELECT =
  "tnum min-h-touch rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-1 text-t-xs text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-0.5";

/**
 * 合并档与深度选择(计划 §3.1):两个原生 <select>(键盘、读屏、触屏都现成)。
 * 合并档按价格显示(分 → 元,两位小数:1 分档显示 0.01、5 分档 0.05);深度 15 / 25 / 50。
 * 切换即时生效:面板把合并档与深度写进 prefs(carbadia-terminal-prefs 的 agg / depth),刷新与换标的后沿用。
 * 触控目标:< 64rem 保持 min-h-touch(与头部抽屉开关同一口径),≥ 64rem 收紧。
 */
export const DepthSelector = memo(function DepthSelector({ steps, value, depth, onChange }: DepthSelectorProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const aggId = useId();
  const depthId = useId();
  return (
    <div className="flex shrink-0 items-center gap-gap text-t-2xs text-muted-2">
      <label htmlFor={aggId}>{t.book.agg}</label>
      <select id={aggId} value={value} onChange={(e) => onChange(Number(e.target.value), depth)} className={SELECT}>
        {steps.map((step) => (
          <option key={step} value={step}>
            {formatPrice(step, 2, locale)}
          </option>
        ))}
      </select>
      <label htmlFor={depthId}>{t.book.depth}</label>
      <select id={depthId} value={depth} onChange={(e) => onChange(value, Number(e.target.value))} className={SELECT}>
        {DEPTH_OPTIONS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
    </div>
  );
});
