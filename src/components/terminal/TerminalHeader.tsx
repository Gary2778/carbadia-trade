"use client";

import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
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
import { DensityToggle } from "./DensityToggle";
import { changeTone, formatChangePct } from "./InstrumentRow";
import { TimeZoneSelect } from "./TimeZoneSelect";
import { UpDownToggle } from "./UpDownToggle";

// 价格提醒对话框只在点开时下载与挂载(next/dynamic;模态,加载那一瞬不占位);指针移到 / 焦点落到按钮上时预取
const PriceAlertDialog = dynamic(() => import("./PriceAlertDialog").then((m) => m.PriceAlertDialog), { ssr: false });
const preloadAlertDialog = () => void import("./PriceAlertDialog");

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
 * 终端头部(计划 §3.1):代码、名称、最新价(FlashCell,LCP 元素)、24h 涨跌 / 高 / 低 / 量、买一 / 卖一(≥ 100rem 才显示),
 * DemoBadge 与 ConnectionBadge 和最新价同组、紧随其后(截图必须带 Demo 徽标),涨跌颜色开关在行尾。
 * 「提醒」按钮(P3-07)也在价格组里,排在 Demo 徽标之后(徽标仍贴着价格):打开价格提醒对话框(懒加载);未登录时对话框里只给登录入口。
 * 100rem 以下它只有图标、买一 / 卖一两格不显示:英文头部在 1280 / 1366 宽要放进一行(P3 终审实测)。
 * PerfHud 不挂在这里:头部是 sticky + z-sticky 的层叠上下文,fixed 的 HUD 在里面会被手机底部买卖条与抽屉遮住,
 * 所以由 TerminalShell 挂在终端根下(PerfHudGate,仅 ?perf=1)。
 * 行尾三个显示开关:时区(P3-09)、紧凑行高(P3-10)、涨跌颜色。
 * 触控目标:抽屉开关在 < 64rem(手机、平板)保持 min-h-touch,64–80rem 才收紧(计划 §4.7)。
 * SSR 规则:store 值 ?? props 值 —— 服务端与水合首帧 store 为空,标记只来自 initial;渲染期不写 store。
 */
export function TerminalHeader({ symbol, initial, vintageSlot, instrumentsOpen = false, instrumentsId, onToggleInstruments, transportMode }: TerminalHeaderProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const instrument = useInstrument(symbol) ?? initial?.instrument;
  const ticker = useTicker(symbol) ?? initial?.ticker;

  const [alertOpen, setAlertOpen] = useState(false);
  const lastPrice = ticker ? ticker.lastPrice : (instrument?.lastPrice ?? null);
  const change = ticker?.change24h ?? null;
  const precision = { pricePrecision: instrument?.pricePrecision ?? 2 };
  const price = (cents: number | null | undefined) => fmtPrice(cents, precision, lang);
  // hide:窄于多少就不显示。买一 / 卖一在 100rem 以下隐藏 —— 盘口与价差条里就有;本期加了「提醒」、时区与紧凑开关之后,
  // 英文头部在 1280 / 1366 宽要靠少这两格才放得进一行。其余 24h 数据 < 48rem 隐藏,涨跌一直在
  const stats: { key: string; label: string; value: string; tone?: string; hide: string }[] = [
    { key: "change", label: t.header.change24h, value: formatChangePct(change), tone: changeTone(change), hide: "" },
    { key: "high", label: t.header.high24h, value: price(ticker?.high24h), hide: "max-md:hidden" },
    { key: "low", label: t.header.low24h, value: price(ticker?.low24h), hide: "max-md:hidden" },
    { key: "volume", label: t.header.volume24h, value: ticker ? formatQty(ticker.volume24h, instrument?.qtyStep ?? 1, locale) : "—", hide: "max-md:hidden" },
    { key: "bid", label: t.header.bestBid, value: price(ticker?.bestBid), tone: "text-(--terminal-up)", hide: "max-[100rem]:hidden" },
    { key: "ask", label: t.header.bestAsk, value: price(ticker?.bestAsk), tone: "text-(--terminal-down)", hide: "max-[100rem]:hidden" },
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
        {/* 100rem 以下只留图标(名字在 aria-label 与 title 里):买一 / 卖一收起之后,英文头部在 1280 宽、带年份 chip 的标的上仍差一点放不进一行;
            只有图标时触屏宽度也要 44 px(min-w-touch,≥ 64rem 收回) */}
        <button
          type="button"
          data-price-alert=""
          aria-haspopup="dialog"
          aria-label={`${t.triggers.types.alert} ${symbol}`}
          title={`${t.triggers.types.alert} ${symbol}`}
          onClick={() => setAlertOpen(true)}
          onPointerEnter={preloadAlertDialog}
          onFocus={preloadAlertDialog}
          className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center whitespace-nowrap rounded-control border border-(--terminal-border) px-2 py-0.5 text-t-xs leading-4 text-muted lg:min-h-0 lg:min-w-0 transition-colors duration-(--motion-fast) hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5 shrink-0 min-[100rem]:hidden" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7a4 4 0 1 1 8 0c0 3.2 1.3 4.3 1.3 4.3H2.7S4 10.2 4 7Z" />
            <path d="M6.7 13.5a1.3 1.3 0 0 0 2.6 0" />
          </svg>
          <span className="max-[100rem]:hidden">{t.triggers.alert}</span>
        </button>
        <ConnectionBadge mode={transportMode} />
      </div>

      <dl className="flex min-w-0 flex-wrap items-center gap-x-panel gap-y-0 text-t-xs">
        {stats.map((s) => (
          <div key={s.key} data-stat={s.key} className={s.hide ? `flex flex-col ${s.hide}` : "flex flex-col"}>
            <dt className="text-t-2xs text-muted-2">{s.label}</dt>
            <dd className={`tnum ${s.tone ?? "text-foreground"}`}>{s.value}</dd>
          </div>
        ))}
      </dl>

      <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-gap">
        <TimeZoneSelect />
        <DensityToggle />
        <UpDownToggle />
      </div>
      {alertOpen ? <PriceAlertDialog symbol={symbol} onClose={() => setAlertOpen(false)} /> : null}
    </header>
  );
}
