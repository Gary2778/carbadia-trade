"use client";
// selectors(计划 §3.6):全部配 useShallow;store 无该键时返回 undefined,由组件用 props 兜底(SSR 首屏规则,§6.1)。
// 渲染期只读 store、从不写;视图计算在 book-view.ts 的纯函数 + 显式缓存里,不在 hook 里 useMemo。
import { useMemo, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import type { CandleBar, CandleInterval, ConnectionState, Instrument, InstrumentListItem, TapeEntry, Ticker } from "@/shared";
import { getBookView, minePricesOf, type BookView } from "./book-view";
import { filterInstruments, type InstrumentFilters, type InstrumentListRow } from "./instrument-filter";
import { readOpenOrders, readServerOpenOrders, subscribeOpenOrders } from "./open-orders-source";
import { bookTopOf, type DraftBookTop } from "./order-draft";
import { candleKey, useMarketStore, type BookState, type DraftSeed, type MarketState } from "./store";
import type { TransportMode } from "./transport";

export type { InstrumentFilters, InstrumentListRow, InstrumentSort } from "./instrument-filter";
export type { BookView, BookViewRow } from "./book-view";

export function useTicker(symbol: string): Ticker | undefined {
  return useMarketStore(useShallow((s) => s.tickers[symbol]));
}

export function useInstrument(symbol: string): Instrument | undefined {
  return useMarketStore(useShallow((s) => s.instruments[symbol]));
}

export function useTape(symbol: string): TapeEntry[] | undefined {
  return useMarketStore(useShallow((s) => s.tapes[symbol]));
}

/** 成交快照是否已到(store.tapeReady,空快照也算):没有 tape 时区分「还没加载」与「确实没有成交」;原始布尔,只在翻转时重渲染 */
export function useTapeReady(symbol: string): boolean {
  return useMarketStore((s) => s.tapeReady[symbol] === true);
}

export function useCandles(symbol: string, interval: CandleInterval): CandleBar[] | undefined {
  return useMarketStore(useShallow((s) => s.candles[candleKey(symbol, interval)]));
}

export function useConnection(): ConnectionState {
  return useMarketStore(useShallow((s) => s.connection));
}

export type ConnectionBadgeKind = "live" | "polling" | "offline" | "reconnecting";

/**
 * 纯函数:connection 切片 → 连接状态的种类(连接徽标的显示与面板的「行情源已断」同一条规则,都从这里来)。
 * pending = 传输层还没启动(SSR、水合首帧、MarketProvider 的 effect 之前:store 仍是创建时的 { transport: "none",
 * state: "offline" },且从未收过消息):这时按构建期模式 mode 给预期的种类(ws → live,poll → polling)作占位,
 * 不在首屏喊「离线」;一旦传输层报了状态就照实给。ConnectionBadge 以构建期内联的模式调用它。
 */
export function connectionKind(conn: ConnectionState, mode: TransportMode): { kind: ConnectionBadgeKind; pending: boolean } {
  if (conn.transport === "poll") return { kind: "polling", pending: false };
  if (conn.state === "open") return { kind: "live", pending: false };
  if (conn.state === "connecting" || conn.state === "degraded") return { kind: "reconnecting", pending: false };
  if (conn.transport === "none" && conn.lastMessageAt === null && conn.rttMs === null) {
    return { kind: mode === "poll" ? "polling" : "live", pending: true };
  }
  return { kind: "offline", pending: false };
}

/**
 * store selector(返回布尔原始值,只在它翻转时重渲染):行情源真的断了 —— 与 ConnectionBadge 显示「离线」同一口径。
 * 传输层还没启动的初始 store(SSR、水合首帧,徽标显示弱化的占位)不算:那时面板照常是骨架,不在首屏报错。
 * 盘口与成交面板在「还没有任何数据」时据此把骨架换成 ErrorState(§4.5 三态);已有数据时照常显示最后的数据。
 * 构建期模式只影响占位(pending)时的标签,不影响「离线」这个判断,所以这里传哪个模式都一样。
 */
export const selectFeedOffline = (s: MarketState): boolean => {
  const { kind, pending } = connectionKind(s.connection, "ws");
  return kind === "offline" && !pending;
};

export function useDraft(): DraftSeed {
  return useMarketStore(useShallow((s) => s.draft));
}

export type BookTop = DraftBookTop;

/**
 * 「顶档」只有一个定义:order-draft.ts 的 bookTopOf(纯函数,下单面板在事件与 store.subscribe 回调里用的也是它)。
 * 这里只多一层「store 里还没有这个标的的盘口 → undefined」(组件据此用 props 兜底)。
 * 引入方向是 selectors → order-draft:order-draft 对 store 只有类型引用,不会反过来把 store 带进它的调用方。
 */
function topOf(book: BookState | undefined): BookTop | undefined {
  return book ? bookTopOf(book) : undefined;
}

/** 原始最优买卖价(聚合前);值不变时引用不变(useShallow) */
export function useBookTop(symbol: string): BookTop | undefined {
  return useMarketStore(useShallow((s) => topOf(s.books[symbol])));
}

// ---- 自家挂单价的来源:账户 store(account-store.ts,P1-15)在模块初始化时 registerOpenOrdersSource(useAccountStore) 接上 ----
// 接缝本体在零依赖叶子 open-orders-source.ts(account-store 只引那个叶子,不经本文件把市场 store 拖进根布局 bundle);
// 这里原样再导出,既有调用方不用改。未注册时 openOrders 恒为空 Map(没有自家档)。
export { readOpenOrders, registerOpenOrdersSource, subscribeOpenOrders, type OpenOrdersSource } from "./open-orders-source";

/**
 * 盘口视图:订阅 books[symbol] 与账户 store 的 openOrders,调 getBookView(每 symbol 一个缓存槽,
 * 键 [book.version, stepCents, depth, mineVersion] 不变时返回同一引用)。store 无该 symbol 的簿时返回 undefined。
 */
export function useBookView(symbol: string, stepCents: number, depth: number): BookView | undefined {
  const book = useMarketStore(useShallow((s) => s.books[symbol]));
  const openOrders = useSyncExternalStore(subscribeOpenOrders, readOpenOrders, readServerOpenOrders);
  if (!book) return undefined;
  const { mine, version } = minePricesOf(symbol, openOrders);
  return getBookView(symbol, book, stepCents, depth, mine, version);
}

/** 把筛选对象规范成稳定的字符串键(键序固定、undefined 丢弃),调用方每次渲染新建 {} 也不会打穿缓存 */
function filtersKey(f: InstrumentFilters): string {
  return JSON.stringify({
    q: f.q,
    registry: f.registry,
    projectType: f.projectType,
    vintage: f.vintage,
    minPrice: f.minPrice,
    maxPrice: f.maxPrice,
    watchlistOnly: f.watchlistOnly,
    sort: f.sort,
  });
}

/**
 * 标的列表:instrumentsVersion === 0(store 尚未灌入)时从 fallback(SSR props)派生,否则从 store;
 * 两条路径输出同一形状,SSR 与水合首帧一致。记忆键 [instruments, tickers, watchlist, instrumentsVersion, filters 内容, fallback 引用]。
 * 永远返回数组(store 空且无 fallback → []),不返回 undefined。
 */
export function useInstrumentList(filters: InstrumentFilters, fallback?: InstrumentListItem[]): InstrumentListRow[] {
  // tickers 的引用与 tickersVersion 同步变化(store 里二者总是一起 set),所以记忆键用 tickers 引用即可覆盖 tickersVersion
  const { instruments, tickers, watchlist, instrumentsVersion } = useMarketStore(
    useShallow((s) => ({
      instruments: s.instruments,
      tickers: s.tickers,
      watchlist: s.watchlist,
      instrumentsVersion: s.instrumentsVersion,
    })),
  );
  const key = filtersKey(filters);
  return useMemo(() => {
    const parsed = JSON.parse(key) as InstrumentFilters;
    const starred = new Set(watchlist);
    const rows: InstrumentListRow[] =
      instrumentsVersion === 0
        ? (fallback ?? []).map((item) => ({
            instrument: item.instrument,
            ticker: tickers[item.instrument.symbol] ?? item.ticker,
            starred: starred.has(item.instrument.symbol),
          }))
        : Object.values(instruments).map((instrument) => ({
            instrument,
            ticker: tickers[instrument.symbol],
            starred: starred.has(instrument.symbol),
          }));
    return filterInstruments(rows, parsed);
  }, [instruments, tickers, watchlist, instrumentsVersion, key, fallback]);
}
