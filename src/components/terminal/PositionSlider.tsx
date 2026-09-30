"use client";

import { memo, useId } from "react";
import type { Side } from "@/shared";
import { useT } from "@/i18n/LangProvider";

export type PositionSliderProps = {
  /** 0..100 的整数百分比 */
  value: number;
  onChange: (pct: number) => void;
  /** 刻度(计划 §3.1:0/25/50/75/100),同时渲染成可点的快捷按钮 */
  marks: readonly number[];
  /** 方向色:买 --up、卖 --down(随涨跌轴翻转) */
  side?: Side;
  disabled?: boolean;
};

/**
 * 仓位滑杆(计划 §3.1):原生 input type=range(键盘 ←→ / Home / End 自带),高度 --spacing-touch(触控目标);
 * datalist 给浏览器画刻度,下面一排刻度按钮一点即到。买按可用现金、卖按可用持仓的换算在 order-draft 的 reducer 里。
 */
export const PositionSlider = memo(function PositionSlider({ value, onChange, marks, side = "BUY", disabled = false }: PositionSliderProps) {
  const t = useT("terminal");
  const id = useId();
  const listId = `${id}-marks`;
  return (
    <div data-position-slider="" className="flex flex-col">
      <div className="flex items-baseline justify-between gap-gap text-t-xs">
        <label htmlFor={id} className="text-muted">
          {t.order.positionPct}
        </label>
        <span className="tnum text-foreground">{value}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        list={listId}
        disabled={disabled}
        aria-valuetext={`${value}%`}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        // exchange.css 给终端的 accent-color 默认值在 @layer base 里,普通工具类就能压过(不再需要 !)
        className={`h-touch w-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${side === "BUY" ? "accent-up" : "accent-down"}`}
      />
      <datalist id={listId}>
        {marks.map((mark) => (
          <option key={mark} value={mark} />
        ))}
      </datalist>
      <div className="flex justify-between gap-1">
        {marks.map((mark) => (
          <button
            key={mark}
            type="button"
            disabled={disabled}
            aria-pressed={value === mark}
            onClick={() => onChange(mark)}
            className={`tnum min-h-touch rounded-chip px-1 text-t-2xs transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 lg:min-h-0 ${
              value === mark ? "text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {mark}%
          </button>
        ))}
      </div>
    </div>
  );
});
