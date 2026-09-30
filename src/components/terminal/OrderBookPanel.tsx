"use client";

import { useCallback, useMemo } from "react";
import { AGG_STEPS, type Side } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
import { requestTransportReconnect } from "@/lib/market/account-bridge";
import { usePrefs, writePrefs, type TerminalPrefs } from "@/lib/market/prefs";
import { selectFeedOffline, useBookTop, useBookView, useInstrument } from "@/lib/market/selectors";
import { marketActions, useMarketStore } from "@/lib/market/store";
import { BookSide } from "./BookSide";
import { DepthSelector } from "./DepthSelector";
import { SpreadBar } from "./SpreadBar";

/** 纯函数:本标的可选的合并档(分)= AGG_STEPS × tickSize;tickSize 非正整数按 1 */
export function aggStepsFor(tickSize: number): number[] {
  const tick = Number.isSafeInteger(tickSize) && tickSize > 0 ? tickSize : 1;
  return AGG_STEPS.map((step) => step * tick);
}

/**
 * 纯函数:prefs 里存的合并档(分,全局一个值)→ 本标的实际用的档。
 * 没存过(null)或存的值不在本标的的档位里(换到 tickSize 不同的标的)→ 回到 tickSize(steps[0],即不合并)。
 */
export function resolveAgg(stored: number | null, steps: readonly number[]): number {
  return stored !== null && steps.includes(stored) ? stored : steps[0];
}

/**
 * 点价(事件处理器,不在渲染期调用):点卖盘的价 = 以该价买入,点买盘的价 = 以该价卖出 —— 写对手方向的下单草稿
 * (带 symbol,DraftSeed 不会沿用上一个标的),再通知调用方。onPicked 由 TerminalShell 在手机布局下传入,
 * 用来切到「下单」页签(盘口与下单框不在同一页签,否则点了没有任何可见变化)。
 */
export function handleBookPick(symbol: string, bookSide: Side, price: number, onPicked?: () => void): void {
  marketActions.setDraft({ symbol, side: bookSide === "SELL" ? "BUY" : "SELL", price });
  onPicked?.();
}

export type OrderBookPanelProps = {
  symbol: string;
  /** 点价之后调用(草稿已写入);手机布局由 TerminalShell 传入以切到下单页签,桌面 / 平板不传 */
  onPicked?: () => void;
};

/**
 * 盘口面板(计划 §3.1、§3.6):合并档(默认 tickSize)× 深度(15 / 25 / 50)→ useBookView,两者都存 prefs
 * (carbadia-terminal-prefs 的 agg 与 depth,全局一个值;服务端快照与水合首帧是默认值);
 * 卖盘在上、SpreadBar 居中、买盘在下,两侧各自滚动(卖盘容器 column-reverse:内容贴底、滚动起点在底,卖一永远可见)。
 * 面板级订阅:books[symbol](经 useBookView 的显式缓存)、自家挂单价、书顶、最新价(只取 lastPrice 这个原始值,
 * 24h 量 / 高低变化不让面板重渲染)、instrument 的 tickSize / 精度 / qtyStep;
 * BookSide / OrderBookRow / SpreadBar / DepthSelector 都是 memo,盘口一跳只提交变化行。
 * 点价 → handleBookPick:marketActions.setDraft({ symbol, side: 对手方, price })(点卖盘 = 买入、点买盘 = 卖出),在 useCallback 里写,
 * 不在渲染期;带 symbol,DraftSeed 不会沿用上一个标的;之后调 onPicked(手机布局切到下单页签)。
 * 三态(§4.5):store 还没有这本簿 → Skeleton;这时行情源已断(selectFeedOffline)→ ErrorState(ui.error),重试 = 让传输层重连;
 * 两侧都空 → EmptyState(book.empty)。
 */
export function OrderBookPanel({ symbol, onPicked }: OrderBookPanelProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const instrument = useInstrument(symbol);
  const tickSize = instrument?.tickSize ?? 1;
  const precision = instrument?.pricePrecision ?? 2;
  const qtyStep = instrument?.qtyStep ?? 1;
  const prefs = usePrefs();
  const steps = useMemo(() => aggStepsFor(tickSize), [tickSize]);
  const agg = resolveAgg(prefs.agg, steps);
  const depth = prefs.depth;

  const view = useBookView(symbol, agg, depth);
  const top = useBookTop(symbol);
  const lastPrice = useMarketStore((s) => s.tickers[symbol]?.lastPrice ?? null);
  const offline = useMarketStore(selectFeedOffline);

  // 只写真的变了的那一项:只改深度时不把「按 tickSize」(agg null)固化成本标的的具体档,换到 tickSize 不同的标的仍回默认
  const handleDepthChange = useCallback(
    (nextAgg: number, nextDepth: number) => {
      const patch: Partial<TerminalPrefs> = {};
      if (nextAgg !== agg) patch.agg = nextAgg;
      if (nextDepth !== depth) patch.depth = nextDepth;
      if (patch.agg !== undefined || patch.depth !== undefined) writePrefs(patch);
    },
    [agg, depth],
  );
  // 点卖盘的价 = 以该价买入;点买盘的价 = 以该价卖出(见 handleBookPick)
  const handlePickAsk = useCallback((price: number) => handleBookPick(symbol, "SELL", price, onPicked), [symbol, onPicked]);
  const handlePickBid = useCallback((price: number) => handleBookPick(symbol, "BUY", price, onPicked), [symbol, onPicked]);

  const empty = view !== undefined && view.bids.length === 0 && view.asks.length === 0;

  return (
    <section
      data-area="book"
      aria-label={t.book.title}
      className="flex min-h-0 min-w-0 flex-col gap-gap overflow-hidden rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <h2 className="text-t-md font-semibold leading-t-tight">{t.book.title}</h2>
        <DepthSelector steps={steps} value={agg} depth={depth} onChange={handleDepthChange} />
      </div>

      {view === undefined ? (
        offline ? (
          <ErrorState message={ui.error} onRetry={requestTransportReconnect} />
        ) : (
          <Skeleton rows={10} className="min-h-0 flex-1 overflow-hidden" />
        )
      ) : empty ? (
        <EmptyState title={t.book.empty} />
      ) : (
        <>
          <div aria-hidden="true" className="t-book-grid px-gap text-t-2xs text-muted-2">
            <span>{t.book.price}</span>
            <span className="text-end">{t.book.qty}</span>
            <span className="text-end">{t.book.cum}</span>
            <span className="text-end">{t.book.orders}</span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain">
            <BookSide side="SELL" rows={view.asks} precision={precision} qtyStep={qtyStep} onPick={handlePickAsk} />
          </div>
          {/* key = symbol:换标的时 FlashCell 重挂载,不拿上一个标的的价跟新标的比着闪 */}
          <SpreadBar key={symbol} bestBid={top?.bestBid ?? null} bestAsk={top?.bestAsk ?? null} lastPrice={lastPrice} precision={precision} />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <BookSide side="BUY" rows={view.bids} precision={precision} qtyStep={qtyStep} onPick={handlePickBid} />
          </div>
        </>
      )}
    </section>
  );
}
