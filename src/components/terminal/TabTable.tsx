"use client";

import { useCallback, useEffect, useId, useMemo, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Instrument, OrderStatus, Side } from "@/shared";
import { formatPrice, formatQty } from "@/shared/precision";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { VirtualList } from "@/components/ui/VirtualList";
import { useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import type { PagedSnapshot } from "@/lib/market/paged-query";
import { useMarketStore } from "@/lib/market/store";

// 底部四个 Tab(P1-21)共用的表格骨架与格式化:
//   - 表头与行共用同一个 grid-template-columns(行在 VirtualList 里绝对定位,不能用 <table>);
//   - 窄视口整张表横向滚动(外层 overflow-x-auto + 内层 minWidth),表头与行一起滚,VirtualList 只管纵向;
//   - 分页表在末尾挂一个哨兵行:虚拟列表只挂载视口 + overscan 附近的行,哨兵一挂上就说明滚到了底,自动拉下一页。
// 「账户变了 → 重读第一页」的信号不在这里,在 src/lib/market/account-refresh.ts。
// 只用 token(tokens-only.test.ts),数字列 tabular-nums + .tnum。

export type Columns = {
  /** grid-template-columns,只用 rem / fr / minmax */
  template: string;
  /** 整张表的最小宽度(rem):视口更窄时横向滚动 */
  minWidth: string;
};

export type HeaderCell = { label: string; align?: "start" | "end"; title?: string };

/** 标的代码 → 价格精度(纯函数;tabs.ssr.test.ts 用它从测试标的造 props) */
export function pricePrecisionsOf(instruments: Readonly<Record<string, Instrument>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const symbol in instruments) out[symbol] = instruments[symbol].pricePrecision;
  return out;
}

/**
 * 各标的价格精度,浅比较订阅(计划 §3.1:面板只订阅自己的选择器)。轮询模式下 MarketProvider 每 2 s 整体替换 instruments,
 * 直接订阅 s.instruments 会让挂着的 Tab 与它的 VirtualList 每 2 s 重渲染一次;这里只有精度真的变了才换引用。
 */
export function usePricePrecisions(): Readonly<Record<string, number>> {
  return useMarketStore(useShallow((s) => pricePrecisionsOf(s.instruments)));
}

/**
 * 把 id 追加进元素已有的 aria-describedby(已在其中则不动)。TabTable 用它把横向滚动提示挂到 VirtualList 的 role=region 上:
 * 能拿到焦点的是那个 region,挂在不可聚焦、没有 role 的外层 div 上读屏不会念。VirtualList(P1-12 的基础件)没有 describedBy 入参,
 * 它自己的 aria-describedby(listHint)值不变,React 之后也不会再写这个属性,追加的这一项不会被覆盖。
 */
export function appendDescribedBy(el: Pick<Element, "getAttribute" | "setAttribute"> | null | undefined, id: string): void {
  if (!el) return;
  const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  if (ids.includes(id)) return;
  el.setAttribute("aria-describedby", [...ids, id].join(" "));
}

/** 界面语言 → 数字 / 日期的 Intl locale(与 fmtPrice 同一规则) */
export const numberLocale = (lang: string): string => (lang === "zh-CN" ? "zh-CN" : "en-US");

/** 价格列(计划 §4.4:终端价格列一律走 lib/format 的 fmtPrice):按标的精度、按界面语言的分隔符;null → 「—」 */
export const fmtRowPrice = (cents: number | null | undefined, precision: number, lang: string): string => fmtPrice(cents, { pricePrecision: precision }, lang);

/** 金额(整数分)→ 两位小数的元,带千分位;null → 「—」 */
export const fmtCents = (cents: number | null | undefined, locale: string): string => (cents == null ? "—" : formatPrice(cents, 2, locale));

/** 带正负号的金额(盈亏、账本变动);0 不带号 */
export const fmtSignedCents = (cents: number, locale: string): string => `${cents > 0 ? "+" : ""}${formatPrice(cents, 2, locale)}`;

/** 数量(整数吨,Phase 1 qtyStep = 1) */
export const fmtQuantity = (qty: number | null | undefined, locale: string): string => (qty == null ? "—" : formatQty(qty, 1, locale));

const timeFormats = new Map<string, Intl.DateTimeFormat>();
/** unix ms → 「MM/DD HH:mm:ss」(按 locale 与浏览器时区,§9.1 第 32 条);按 locale 缓存 */
export function fmtTs(ms: number, locale: string): string {
  let fmt = timeFormats.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    timeFormats.set(locale, fmt);
  }
  return Number.isFinite(ms) ? fmt.format(ms) : "—";
}

/** 方向色:终端的方向文字 token(买涨色、卖跌色,随涨跌轴翻转;§4.1.3) */
export const sideTone = (side: Side): string => (side === "BUY" ? "text-(--terminal-up)" : "text-(--terminal-down)");

/** 委托状态着色:语义色(成交 success、部分成交 warning),不随涨跌轴翻转 */
export const statusTone = (status: OrderStatus): string =>
  status === "FILLED" ? "text-success" : status === "PARTIAL" ? "text-warning" : status === "CANCELLED" ? "text-muted" : "text-foreground";

/** 盈亏着色;0 与空值 muted */
export const pnlTone = (value: number | null | undefined): string => (value == null || value === 0 ? "text-muted" : value > 0 ? "text-(--terminal-up)" : "text-(--terminal-down)");

/** 行的公共样式(固定 h-row,与 VirtualList 行高一致) */
export const ROW_CLASS = "grid h-row items-center gap-gap px-gap text-t-sm whitespace-nowrap";
export const CELL_END = "tnum truncate text-end";
export const CELL_START = "truncate";

/** 列表末尾的哨兵:不是数据行,只用来触发「滚到底加载下一页」 */
const MORE = Symbol("more");
type ListItem<T> = T | typeof MORE;

export type TabTableProps<T> = {
  columns: Columns;
  headers: HeaderCell[];
  items: readonly T[];
  getKey: (item: T) => string;
  renderRow: (item: T, index: number) => ReactNode;
  /** VirtualList 的 role=region 名称(terminal.a11y.ordersRegion) */
  label: string;
  /** 数据为空时的插槽(EmptyState) */
  empty: ReactNode;
  /** 分页表:当前快照与翻页动作;不传 = 一次性全量列表(当前委托、持仓) */
  pager?: { status: PagedSnapshot<T>["status"]; onLoadMore: () => void };
  /** 表下一行可见的说明(有数据时才显示),例如成交表的 terminal.tape.auditNote —— 触屏 / 不悬停的用户看不到 title */
  footnote?: ReactNode;
};

/**
 * 横向可滚的表格外壳:表头 + VirtualList(DOM 行数 = 视口 + overscan)。
 * 分页状态:第一页未到 → Skeleton;第一页失败 → ErrorState(重试);翻页中 → 末行 Skeleton;翻页失败 → 表下 ErrorState(重试),
 * 失败后不自动重试(哨兵只在 idle 时触发),避免对着一个坏端点连发。
 */
export function TabTable<T>({ columns, headers, items, getKey, renderRow, label, empty, pager, footnote }: TabTableProps<T>) {
  const t = useT("terminal");
  const ui = useT("ui");
  const hintId = useId();
  const status = pager?.status;
  const withSentinel = status === "idle" || status === "loading";
  const rows = useMemo<ListItem<T>[]>(() => (withSentinel ? [...items, MORE] : [...items]), [items, withSentinel]);
  // 外层横向滚动容器挂上时 VirtualList 的 region 已在它里面:把横向滚动提示追加到那个可聚焦的 region 上(见 appendDescribedBy)
  const describeRegion = useCallback((node: HTMLDivElement | null) => appendDescribedBy(node?.querySelector('[role="region"]'), hintId), [hintId]);

  if (items.length === 0 && (status === "idle" || status === "loading")) return <Skeleton rows={5} />;
  if (items.length === 0 && status === "error") return <ErrorState message={ui.error} onRetry={pager?.onLoadMore} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <span id={hintId} className="sr-only">
        {t.a11y.scrollHint}
      </span>
      <div ref={describeRegion} className="flex min-h-0 flex-1 flex-col overflow-x-auto overflow-y-hidden">
        <div className="flex min-h-0 flex-1 flex-col" style={{ minWidth: columns.minWidth }}>
          <div className={`${ROW_CLASS} shrink-0 border-b border-(--terminal-border) text-t-xs text-muted`} style={{ gridTemplateColumns: columns.template }}>
            {headers.map((h, i) => (
              <span key={i} title={h.title} className={h.align === "end" ? "truncate text-end" : "truncate"}>
                {h.label}
              </span>
            ))}
          </div>
          <VirtualList<ListItem<T>>
            items={rows}
            label={label}
            className="min-h-0 flex-1"
            empty={empty}
            getKey={(item) => (item === MORE ? "__more__" : getKey(item))}
            renderRow={(item, index) =>
              item === MORE ? <PagerRow status={status ?? "idle"} onLoadMore={pager?.onLoadMore} /> : renderRow(item, index)
            }
          />
        </div>
      </div>
      {footnote && items.length > 0 ? <p className="shrink-0 px-gap text-t-2xs text-muted">{footnote}</p> : null}
      {status === "error" ? <ErrorState message={ui.error} onRetry={pager?.onLoadMore} /> : null}
    </div>
  );
}

/**
 * 哨兵行:挂载即说明它进了视口 + overscan,idle 时自动加载下一页;一页回来后若它仍在范围内(列表还没填满视口)会接着拉,
 * 直到填满或到最后一页。加载中显示一行 Skeleton;按钮(ui.loadMore)给键盘与读屏用户手动翻页。
 */
function PagerRow({ status, onLoadMore }: { status: PagedSnapshot<unknown>["status"]; onLoadMore?: () => void }) {
  const ui = useT("ui");
  useEffect(() => {
    if (status === "idle") onLoadMore?.();
  }, [status, onLoadMore]);
  if (status === "loading") return <Skeleton rows={1} />;
  return (
    <button
      type="button"
      onClick={onLoadMore}
      className="flex h-row w-full items-center justify-center text-t-xs text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus"
    >
      {ui.loadMore}
    </button>
  );
}
