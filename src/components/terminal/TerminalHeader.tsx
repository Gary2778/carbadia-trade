"use client";

import type { ReactNode } from "react";
import type { InstrumentListItem } from "@/shared";
import { FlashCell } from "@/components/anim/FlashCell";
import { useLang, useT } from "@/i18n/LangProvider";
import { tName } from "@/i18n/data";
import { fmtPrice } from "@/lib/format";
import { useInstrument, useTicker } from "@/lib/market/selectors";
import type { TransportMode } from "@/lib/market/transport";
import { formatQty } from "@/shared/precision";
import { ConnectionBadge } from "./ConnectionBadge";
import { DemoBadge } from "./DemoBadge";
import { changeTone, formatChangePct } from "./InstrumentRow";
import { UpDownToggle } from "./UpDownToggle";

export type TerminalHeaderProps = {
  symbol: string;
  /** initialInstruments 里当前 symbol 的那一项(SSR 首屏);找不到时头部只显示代码与「—」 */
  initial?: InstrumentListItem;
  /** 同项目其它 vintage 的年份 chip(VintageSelector,P1-17 起接入) */
  vintageSlot?: ReactNode;
  /** 标的抽屉(< 80rem)是否打开;开关只在窄于 80rem 时显示 */
  instrumentsOpen?: boolean;
  instrumentsId?: string;
  onToggleInstruments?: () => void;
  /** 运行期传输提示(服务端没有 /ws(transportModeForServer:START_MODE=next、本进程没有 hub、或 WS_DISABLED=1) → "poll"),转给 ConnectionBadge 的占位 */
  transportMode?: TransportMode;
};

/**
 * 终端头部(计划 §3.1):代码、名称、最新价(FlashCell,LCP 元素)、24h 涨跌 / 高 / 低 / 量、买一 / 卖一,
 * DemoBadge 与 ConnectionBadge 和最新价同组、紧随其后(截图必须带 Demo 徽标),涨跌颜色开关在行尾。
 * PerfHud 不挂在这里:头部是 sticky + z-sticky 的层叠上下文,fixed 的 HUD 在里面会被手机底部买卖条与抽屉遮住,
 * 所以由 TerminalShell 挂在终端根下(PerfHudGate,仅 ?perf=1)。
 * 触控目标:抽屉开关在 < 64rem(手机、平板)保持 min-h-touch,64–80rem 才收紧(计划 §4.7)。
 * SSR 规则:store 值 ?? props 值 —— 服务端与水合首帧 store 为空,标记只来自 initial;渲染期不写 store。
 */
export function TerminalHeader({ symbol, initial, vintageSlot, instrumentsOpen = false, instrumentsId, onToggleInstruments, transportMode }: TerminalHeaderProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const instrument = useInstrument(symbol) ?? initial?.instrument;
  const ticker = useTicker(symbol) ?? initial?.ticker;

  const lastPrice = ticker ? ticker.lastPrice : (instrument?.lastPrice ?? null);
  const change = ticker?.change24h ?? null;
  const precision = { pricePrecision: instrument?.pricePrecision ?? 2 };
  const price = (cents: number | null | undefined) => fmtPrice(cents, precision, lang);
  const stats: { key: string; label: string; value: string; tone?: string }[] = [
    { key: "change", label: t.header.change24h, value: formatChangePct(change), tone: changeTone(change) },
    { key: "high", label: t.header.high24h, value: price(ticker?.high24h) },
    { key: "low", label: t.header.low24h, value: price(ticker?.low24h) },
    { key: "volume", label: t.header.volume24h, value: ticker ? formatQty(ticker.volume24h, instrument?.qtyStep ?? 1, locale) : "—" },
    { key: "bid", label: t.header.bestBid, value: price(ticker?.bestBid), tone: "text-(--terminal-up)" },
    { key: "ask", label: t.header.bestAsk, value: price(ticker?.bestAsk), tone: "text-(--terminal-down)" },
  ];

  return (
    <header
      data-area="header"
      className="flex min-h-header flex-wrap items-center gap-x-panel gap-y-gap rounded-panel border border-(--terminal-border) bg-(--terminal-panel) px-panel py-gap"
    >
      {onToggleInstruments ? (
        <button
          type="button"
          data-drawer-toggle=""
          aria-expanded={instrumentsOpen}
          aria-controls={instrumentsId}
          onClick={onToggleInstruments}
          className="inline-flex min-h-touch shrink-0 items-center gap-1 rounded-control border border-(--terminal-border) px-2 text-t-xs text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
          </svg>
          <span>{t.header.openInstruments}</span>
        </button>
      ) : null}

      <div className="flex min-w-0 flex-col">
        <h1 className="text-t-lg font-semibold leading-t-tight">{symbol}</h1>
        {instrument ? <p className="truncate text-t-xs text-muted">{tName(symbol, instrument.name, lang)}</p> : null}
      </div>

      {vintageSlot}

      {/* 最新价与两个徽标同组(计划 §3.1「紧邻最新价」):截图裁到价格附近也一定带着 Demo 徽标;
          窄屏放不下时连接徽标在组内换行,Demo 徽标仍贴着价格,不会被 24h 数据挤到头部另一端。
          手机(< 48rem):价格组占满一行、连接徽标在组内独占一行(ConnectionBadge 的 max-md:basis-full)——
          徽标换字(占位 →「重连中…」→「已连接」)与 RTT 出现只改它自己的宽度,24h 统计不在两行之间跳(P1-25f) */}
      <div data-price-group="" className="flex min-w-0 flex-wrap items-center gap-x-gap gap-y-1 max-md:w-full">
        <div className="flex min-w-0 items-baseline gap-1">
          <span className="sr-only">{t.header.lastPrice}</span>
          {/* key = symbol:换标的时重挂载,不拿上一个标的的价跟新标的比着闪 */}
          <FlashCell key={symbol} value={lastPrice} className="px-1">
            <span data-last-price="" className={`tnum text-t-2xl font-semibold leading-t-tight md:text-t-xl ${changeTone(change)}`}>
              {price(lastPrice)}
            </span>
          </FlashCell>
          <span className="text-t-2xs text-muted-2">{t.header.unit}</span>
        </div>
        <DemoBadge />
        <ConnectionBadge mode={transportMode} />
      </div>

      <dl className="flex min-w-0 flex-wrap items-center gap-x-panel gap-y-0 text-t-xs">
        {stats.map((s) => (
          <div key={s.key} className={`flex flex-col ${s.key === "change" ? "" : "max-md:hidden"}`}>
            <dt className="text-t-2xs text-muted-2">{s.label}</dt>
            <dd className={`tnum ${s.tone ?? "text-foreground"}`}>{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-gap">
        <UpDownToggle />
      </div>
    </header>
  );
}
