"use client";

import { memo } from "react";
import { FlashCell } from "@/components/anim/FlashCell";
import { useLang, useT } from "@/i18n/LangProvider";
import { spread } from "@/shared/orderbook";
import { formatPrice } from "@/shared/precision";

export type SpreadBarProps = {
  /** 原始最优买价(聚合前,分);spread 反映真实市场,不随合并档变化 */
  bestBid: number | null;
  bestAsk: number | null;
  /** 最新成交价(分) */
  lastPrice: number | null;
  precision: number;
};

const bpsFormatters = new Map<string, Intl.NumberFormat>();
/** bps 固定一位小数,分隔符按界面语言;Intl 实例按 locale 缓存 */
function formatBps(bps: number, locale: string): string {
  let fmt = bpsFormatters.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    bpsFormatters.set(locale, fmt);
  }
  return fmt.format(bps);
}

/**
 * 盘口中缝(计划 §3.1):左边最新价(FlashCell 涨跌闪烁),右边价差的绝对值与基点。
 * 基点的单位写 terminal.book.bps(en「bps」/ zh「基点」,§9.2 D20)。
 * 任一侧缺失时价差显示「—」,不出基点;最新价为空也显示「—」。
 */
export const SpreadBar = memo(function SpreadBar({ bestBid, bestAsk, lastPrice, precision }: SpreadBarProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const gap = spread(bestBid, bestAsk);
  return (
    <div data-spread-bar="" className="flex min-h-row items-center justify-between gap-gap border-y border-(--terminal-border) px-gap">
      <span className="flex min-w-0 items-baseline">
        <span className="sr-only">{t.header.lastPrice}</span>
        <FlashCell value={lastPrice} className="px-1">
          <span className="tnum text-t-md font-semibold leading-t-tight text-foreground">{lastPrice == null ? "—" : formatPrice(lastPrice, precision, locale)}</span>
        </FlashCell>
      </span>
      <span className="flex min-w-0 items-baseline gap-1 text-t-xs text-muted">
        <span>{t.book.spread}</span>
        <span className="tnum text-foreground">{gap ? formatPrice(gap.abs, precision, locale) : "—"}</span>
        {gap ? <span className="tnum">{`${formatBps(gap.bps, locale)} ${t.book.bps}`}</span> : null}
      </span>
    </div>
  );
});
