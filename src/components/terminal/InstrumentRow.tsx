"use client";

import { memo, type MouseEvent } from "react";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import { terminalHref } from "@/lib/market/navigation";
import { useTicker } from "@/lib/market/selectors";

/** 24 h 涨跌(百分数,1.23 = +1.23%)→ 显示串;null → 「—」 */
export function formatChangePct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** 涨跌着色:终端的方向文字 token(随涨跌轴翻转;浅色是比站点 --up / --down 深一级的同色相,§4.1.3);0 与空值用 muted */
export function changeTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "text-muted";
  return value > 0 ? "text-(--terminal-up)" : "text-(--terminal-down)";
}

export type InstrumentRowProps = {
  symbol: string;
  name: string;
  /** 分;SSR 首屏值,store 有 live ticker 后以 live 为准 */
  lastPrice: number | null;
  /** 百分数 */
  change24h: number | null;
  pricePrecision: number;
  starred: boolean;
  active: boolean;
  onToggleStar: (symbol: string) => void;
  onSelect: (symbol: string) => void;
};

/** 新标签页 / 新窗口打开(Cmd / Ctrl / Shift / 中键)交给浏览器,普通点击才走 replaceState 换标的(VintageSelector 同一口径) */
export const opensElsewhere = (e: MouseEvent) => e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

/**
 * 标的列表的一行(计划 §3.1):React.memo + 原始类型 props,只有本行的 ticker 或 props 变化才提交。
 * 价与涨跌自己订阅 useTicker(symbol),store 还没有该键时(SSR 与水合首帧)用 props —— 首屏标记只来自 props。
 * 主体是指向 /trade/<symbol> 的普通 <a>(不是 next/link:不预取、不走 RSC),普通点击 preventDefault 后交给 onSelect
 * (InstrumentPanel 传的是 switchSymbol 的 replaceState),新标签页打开仍是完整的深链。
 * 行在 VirtualList 的定高包装层里,根节点是 <div>(不是 <li>);行高 h-row 读 --spacing-row,触屏布局下
 * InstrumentPanel 把它换成 --spacing-row-touch,星标按钮同时给 min-h-touch / min-w-touch(计划 §4.7)。
 */
export const InstrumentRow = memo(function InstrumentRow({
  symbol,
  name,
  lastPrice,
  change24h,
  pricePrecision,
  starred,
  active,
  onToggleStar,
  onSelect,
}: InstrumentRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const live = useTicker(symbol);
  const price = live ? live.lastPrice : lastPrice;
  const change = live ? live.change24h : change24h;
  return (
    <div
      data-symbol={symbol}
      data-active={active ? "" : undefined}
      className={`flex h-row items-center gap-gap pe-panel transition-colors duration-(--motion-fast) ${
        active ? "bg-(--terminal-selected)" : "hover:bg-(--terminal-row-hover)"
      }`}
    >
      <button
        type="button"
        aria-pressed={starred}
        aria-label={starred ? t.instruments.unstar : t.instruments.star}
        title={starred ? t.instruments.unstar : t.instruments.star}
        onClick={() => onToggleStar(symbol)}
        className={`grid h-row w-6 shrink-0 place-items-center rounded-chip focus-visible:outline-none focus-visible:shadow-focus pointer-coarse:min-h-touch pointer-coarse:min-w-touch max-lg:min-h-touch max-lg:min-w-touch ${
          starred ? "text-warning" : "text-muted-2 hover:text-muted"
        }`}
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3" fill={starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
          <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
        </svg>
      </button>
      <a
        href={terminalHref(symbol)}
        aria-current={active ? "page" : undefined}
        onClick={(e) => {
          if (opensElsewhere(e)) return;
          e.preventDefault();
          onSelect(symbol);
        }}
        className="flex min-w-0 flex-1 items-center gap-gap self-stretch rounded-chip text-t-sm leading-t-tight focus-visible:outline-none focus-visible:shadow-focus"
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="shrink-0 font-medium text-foreground">{symbol}</span>
          {/* 当前行铺 --terminal-selected 染色,灰字压在上面不到 4.5:1(浅色 --muted-2 4.26、--muted 4.46),当前行的名称用 --foreground */}
          <span className={`truncate text-t-2xs ${active ? "text-foreground" : "text-muted-2"}`}>{name}</span>
        </span>
        <span className="tnum shrink-0 text-foreground">{fmtPrice(price, { pricePrecision }, lang)}</span>
        <span className={`tnum w-14 shrink-0 text-end ${changeTone(change)}`}>{formatChangePct(change)}</span>
      </a>
    </div>
  );
});
