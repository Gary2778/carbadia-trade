"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore, type Ref } from "react";
import type { Instrument, InstrumentListItem } from "@/shared";
import { useWatchlist } from "@/components/exchange/useExchange";
import { EmptyState } from "@/components/ui/EmptyState";
import { VirtualList } from "@/components/ui/VirtualList";
import { LANGS } from "@/i18n/config";
import { useLang, useT } from "@/i18n/LangProvider";
import { tName, tProjectType, tRegistry } from "@/i18n/data";
import { facets, filterByQuery, hasActiveFilters, setFilter } from "@/lib/market/instrument-filter";
import { filtersToSearch, readFiltersFromUrl, switchSymbol, writeFiltersToUrl } from "@/lib/market/navigation";
import { useInstrumentList, type InstrumentFilters as Filters, type InstrumentListRow } from "@/lib/market/selectors";
import { marketActions, useMarketStore } from "@/lib/market/store";
import { INSTRUMENT_SEARCH_ID, InstrumentFilters } from "./InstrumentFilters";
import { InstrumentRow } from "./InstrumentRow";

export type InstrumentPanelProps = {
  /** 当前标的(行高亮) */
  symbol: string;
  /** SSR 注入的全部标的 + ticker;store 尚未灌入(instrumentsVersion === 0)时列表从它派生 */
  initialItems: InstrumentListItem[];
  /** page.tsx 由 searchParams 经 readFiltersFromUrl 得到;服务端与客户端同一解析 */
  initialFilters: Filters;
  /** 面板对外的动作(TerminalShell 持有,经 useImperativeHandle 填入):搜索框 Enter 选第一条匹配。不叫 ref:终端组件的 prop 不得叫 ref */
  actionsRef?: Ref<InstrumentPanelHandle>;
};

export type InstrumentPanelHandle = {
  /**
   * 搜索框有字时选中当前筛选、排序后列表的第一条(switchSymbol),返回它的 symbol;搜索框为空或没有匹配返回 null(什么也不做)。
   * 基于面板的过滤数据,不看 DOM:列表滚动过、第一条不在可视区(没渲染)时选的仍是它。
   */
  selectFirstMatch: () => string | null;
};

/**
 * 聚焦标的搜索框并全选(给 / 与 Ctrl/Cmd+K,P1-22 的 hotkeys 调用);返回是否真的拿到了焦点。
 * < 80rem 左栏是抽屉:关着时输入框不可见、focus 会失败(返回 false),调用方先打开抽屉再调。服务端调用为空操作。
 */
export function focusInstrumentSearch(): boolean {
  if (typeof document === "undefined") return false;
  const input = document.getElementById(INSTRUMENT_SEARCH_ID);
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  input.select();
  return document.activeElement === input;
}

/**
 * 触屏行高:(pointer: coarse) 或 < 64rem 时行高换成 --spacing-row-touch(2.75rem)。CSS 那一半在面板根的两个变体类上
 * (把 --spacing-row 就地改指 --spacing-row-touch,行与 VirtualList 的定高包装层都用 h-row,跟着一起变);
 * JS 这一半只给 react-virtual 的 estimateSize 一个像素初值,挂载后 measureElement 按真实高度校正;
 * 非触屏不传,由 VirtualList 按行密度取 22 或 20(触屏的 44 不随密度:--spacing-row-touch 写在面板根上,压过终端根的 data-density)。
 */
const TOUCH_ROWS_QUERY = "(pointer: coarse), (width < 64rem)";
/** = --spacing-row-touch(2.75rem)在根字号 16 下的像素值,只作 estimateSize 的初值 */
export const TOUCH_ROW_HEIGHT = 44;

function subscribeTouchRows(onChange: () => void): () => void {
  const mql = window.matchMedia(TOUCH_ROWS_QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
const readTouchRows = (): boolean => window.matchMedia(TOUCH_ROWS_QUERY).matches;
/** 服务端快照与水合首帧恒为 false(估值 22 px),挂载后才切到真实值;只影响渲染哪几行,行的位置由 VirtualList 按 CSS 行高排 */
const readServerTouchRows = (): boolean => false;

const rowKey = (row: InstrumentListRow): string => row.instrument.symbol;

/**
 * 搜索要能命中的界面文字:行里显示的名称,以及下拉里显示的注册机构、项目类型 —— 两种界面语言(§4.8 只有 en 与 zh-CN)的
 * 译名都算,与当前语言无关。q 会镜像进可分享的 URL:同一条 ?q= 对任何读者给出同样的行,SSR(DEFAULT_LANG)与
 * zh-CN 偏好的读者水合后也不会从 3 行翻成 0 行。
 */
export const searchLabels = (instrument: Instrument): string[] =>
  LANGS.flatMap((lang) => [tName(instrument.symbol, instrument.name, lang), tRegistry(instrument.registry, lang), tProjectType(instrument.projectType, lang)]);

/**
 * 纯函数:面板显示的行 = useInstrumentList(除 q 以外的筛选)再过一道 filterByQuery(两种语言的显示标签,见 searchLabels)。
 * 渲染与「选第一条匹配」共用这一条管线,选中的一定是列表里排在最前的那一行。
 */
export const panelRows = (listed: InstrumentListRow[], q: string | undefined): InstrumentListRow[] => filterByQuery(listed, q, searchLabels);

/** 纯函数:搜索框 Enter 要选的标的 = rows(panelRows 的结果)的第一条;q 为空白或没有行时为 null */
export function firstInstrumentMatch(rows: readonly InstrumentListRow[], q: string | undefined): string | null {
  if (!q?.trim()) return null;
  return rows[0]?.instrument.symbol ?? null;
}

/**
 * 纯函数:挂载后以地址栏为准对一次筛选。浏览器前进 / 后退恢复缓存页时,Next 复用的是首次请求的页面 props
 * (initialFilters 例如 {}),地址栏却是之后 writeFiltersToUrl(replaceState)写进去的 ?q=forest;不对的话搜索框是空的、
 * 列表没过滤,分享出去的链接与自己看到的不是同一张表。两边按 URL 的规范写法(filtersToSearch)比较:
 * 相同返回 null(不多一次渲染),不同返回 URL 的筛选。
 */
export function filtersFromRestoredUrl(current: Filters, fromUrl: Filters): Filters | null {
  return filtersToSearch("", current) === filtersToSearch("", fromUrl) ? null : fromUrl;
}

/**
 * 左栏标的面板(计划 §3.1、§3.6):
 *   - 筛选主状态是本组件的 useState(initialFilters);改动经 InstrumentFilters 交上来,同一个事件处理器里
 *     writeFiltersToUrl(replaceState,只改 query、不走 RSC)镜像到 URL;挂载后以地址栏为准对一次(filtersFromRestoredUrl:
 *     前进 / 后退恢复的缓存页 props 是旧的),SSR 与水合首帧仍按 initialFilters,标记一致;
 *   - 列表 = useInstrumentList(除 q 以外的筛选, initialItems):store 空时从 SSR props 派生,灌入后从 store,两条路径同形 →
 *     首屏 14 行直接进 HTML,水合首帧标记相同;VirtualList 只渲染可视行 + overscan(SSR 无滚动容器时按 initialRect 出前 16 行);
 *   - 搜索 q 在这里另过一道 filterByQuery:除 symbol 与种子原值外,还比显示的名称 / 注册机构 / 项目类型的两种语言译名
 *     (种子原值是中文,英文界面搜 "forest" 要能找到行里写着 Forest 的标的);不看当前语言,同一个深链对谁都是同样的行;
 *     q 不进 useInstrumentList 的记忆键,打字时不重算底层列表;
 *   - 下拉的可选值(facets)只随标的元数据变:订阅 store 的 instruments 切片(ticker 刷新不换引用),store 空时用 props;
 *   - 自选沿用 useWatchlist(localStorage carbadia-credit-watchlist),星标在同一处理器里 marketActions.setWatchlist 同步进 store
 *     (MarketProvider 的镜像 effect 随后写同一内容,setWatchlist 同内容不 set);
 *   - 行的回调保持引用稳定(行是 React.memo):选中走 switchSymbol,星标经 ref 拿 useWatchlist 的最新值;
 *   - 对外动作 selectFirstMatch(经 actionsRef,TerminalShell 在搜索框 Enter 时调):选 panelRows 的第一条,与渲染同一份数据。
 */
export function InstrumentPanel({ symbol, initialItems, initialFilters, actionsRef }: InstrumentPanelProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const listFilters = useMemo(() => setFilter(filters, "q", undefined), [filters]);
  const listed = useInstrumentList(listFilters, initialItems);
  const q = filters.q;
  const rows = useMemo(() => panelRows(listed, q), [listed, q]);

  useImperativeHandle(
    actionsRef,
    () => ({
      selectFirstMatch: () => {
        const first = firstInstrumentMatch(rows, q);
        if (first !== null) switchSymbol(first);
        return first;
      },
    }),
    [rows, q],
  );

  const storedInstruments = useMarketStore((s) => (s.instrumentsVersion === 0 ? undefined : s.instruments));
  const facetValues = useMemo(
    () => facets(storedInstruments ? Object.values(storedInstruments).map((instrument) => ({ instrument })) : initialItems),
    [storedInstruments, initialItems],
  );

  const touchRows = useSyncExternalStore(subscribeTouchRows, readTouchRows, readServerTouchRows);

  // 挂载后以地址栏为准(见 filtersFromRestoredUrl):只跑一次,之后筛选的主状态仍是本组件,URL 只是它的镜像
  useEffect(() => {
    const restored = filtersFromRestoredUrl(filters, readFiltersFromUrl());
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合安全模式:SSR 与水合首帧按 initialFilters 渲染,挂载后才能读地址栏纠正
    if (restored) setFilters(restored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时对一次;之后的改动都经 handleFiltersChange 同步写 URL
  }, []);

  const handleFiltersChange = useCallback((next: Filters) => {
    setFilters(next);
    writeFiltersToUrl(next);
  }, []);
  const handleClearFilters = useCallback(() => handleFiltersChange({}), [handleFiltersChange]);

  // useWatchlist 每次渲染都返回新对象;经 ref 转一道,传给 memo 行的回调才能保持同一引用
  const watchlist = useWatchlist();
  const watchlistRef = useRef(watchlist);
  useEffect(() => {
    watchlistRef.current = watchlist;
  }, [watchlist]);
  const handleToggleStar = useCallback((s: string) => {
    const { symbols, toggle } = watchlistRef.current;
    if (!toggle(s)) return; // localStorage 写不进(隐私模式配额等):不动 store,星标保持原样
    marketActions.setWatchlist(symbols.includes(s) ? symbols.filter((x) => x !== s) : [...symbols, s]);
  }, []);

  const filtered = hasActiveFilters(filters);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-panel border border-(--terminal-border) bg-(--terminal-panel) pointer-coarse:[--spacing-row:var(--spacing-row-touch)] max-lg:[--spacing-row:var(--spacing-row-touch)]">
      <div className="flex items-center justify-between gap-gap px-panel pt-panel pb-gap">
        <h2 className="text-t-md font-semibold leading-t-tight">{t.instruments.title}</h2>
        <span className="tnum text-t-xs text-muted">{t.instruments.count(rows.length)}</span>
      </div>
      <InstrumentFilters filters={filters} facets={facetValues} onChange={handleFiltersChange} />
      <div aria-hidden="true" className="flex items-center gap-gap ps-7 pe-panel pb-gap text-t-2xs text-muted-2 pointer-coarse:ps-12 max-lg:ps-12">
        <span className="flex-1">{t.instruments.colSymbol}</span>
        <span>{t.instruments.colPrice}</span>
        <span className="w-14 text-end">{t.instruments.colChange}</span>
      </div>
      <VirtualList
        items={rows}
        rowHeight={touchRows ? TOUCH_ROW_HEIGHT : undefined}
        label={t.a11y.instrumentsRegion}
        getKey={rowKey}
        className="min-h-0 flex-1 pb-gap"
        empty={
          <EmptyState
            title={t.instruments.empty}
            action={
              filtered ? (
                <button type="button" onClick={handleClearFilters} className="rounded-chip text-t-xs text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus pointer-coarse:min-h-touch max-lg:min-h-touch">
                  {t.instruments.clear}
                </button>
              ) : undefined
            }
          />
        }
        renderRow={(row) => {
          const s = row.instrument.symbol;
          // 与 filterInstruments 同一口径:有 live ticker 就以它为准(哪怕是 null),没有才用 instrument.lastPrice
          const lastPrice = row.ticker ? row.ticker.lastPrice : row.instrument.lastPrice;
          return (
            <InstrumentRow
              symbol={s}
              name={tName(s, row.instrument.name, lang)}
              lastPrice={lastPrice}
              change24h={row.ticker?.change24h ?? null}
              pricePrecision={row.instrument.pricePrecision}
              starred={row.starred}
              active={s === symbol}
              onToggleStar={handleToggleStar}
              onSelect={switchSymbol}
            />
          );
        }}
      />
    </div>
  );
}
