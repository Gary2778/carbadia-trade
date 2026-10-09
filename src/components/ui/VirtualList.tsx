"use client";

import { useId, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useT } from "@/i18n/LangProvider";
import { useDensity } from "@/lib/market/prefs";
import { EmptyState } from "./EmptyState";

/**
 * 默认行高估值(像素)= --spacing-row(1.375rem,根字号 16 时为 22);偏好 density = compact(P3-10)时用 DENSE_ROW_HEIGHT = --spacing-row-dense(1.25rem)的 20。
 * react-virtual 只认像素,这个值只用来算渲染哪几行;行由 h-row 定高、位置与总高都按 --spacing-row 写成 CSS(见下),
 * 估值与真实行高不一致时也不会错位,挂载后 measureElement 按真实高度校正可视范围。
 * 不传 rowHeight 的列表(盘口 tape、各页签)按密度取估值;传了就用传入的(触屏与条件单历史的 44)。
 */
export const DEFAULT_ROW_HEIGHT = 22;
export const DENSE_ROW_HEIGHT = 20;
export const DEFAULT_OVERSCAN = 8;

export type VirtualListProps<T> = {
  items: T[];
  rowHeight?: number;
  overscan?: number;
  /** role="region" 的 aria-label(terminal.a11y.*Region) */
  label: string;
  renderRow: (item: T, index: number) => ReactNode;
  getKey: (item: T) => string;
  /** 空列表时渲染的插槽,缺省 <EmptyState /> */
  empty?: ReactNode;
  className?: string;
  /**
   * 滚动容器里、各行上方的一行(贴顶,--z-sticky;有它时空列表也照样显示)。给「横向滚动时首列 / 操作列贴边」的表用
   *(TabTable 的 pinEdges,P2-12):position: sticky 只认最近的滚动容器,所以表头与各行要在同一个滚动容器(就是这里)里一起横向滚,
   * 格子上的 sticky 才有参照。表头按一行(--spacing-row)高计,虚拟器的可视范围随之下移一行。
   * 有表头时滚动容器自成层叠上下文(isolate),表头的 z-index 只在容器里面起作用,见组件体里的注释。
   */
  header?: ReactNode;
  /** 表头与行轨道的最小宽度(如 "45.5rem"):容器更窄时由本组件的滚动容器横向滚动 */
  minWidth?: string;
};

/**
 * @tanstack/react-virtual 包装:固定行高、overscan 8;保留 TableViewport 的 role=region + aria-label +
 * sr-only 提示。服务端与水合首帧没有滚动容器,用 overscan 行高的 initialRect 让 SSR HTML 含前 2×overscan 行。
 *
 * 位置与总高用 CSS 表达(translateY(calc(var(--spacing-row) * i))、height: calc(var(--spacing-row) * n)),不用虚拟器的
 * 像素 start:所有行都是 h-row 定高,第 i 行就在 i 个 --spacing-row 处,SSR 与水合首帧也跟着 CSS 走。否则像标的面板
 * 在粗指针设备上那样(CSS 首帧就把行高换成 2.75rem,服务端快照的估值仍是 22 px),首帧每行都压住下一行的一半。
 */
export function VirtualList<T>({
  items,
  rowHeight: rowHeightProp,
  overscan = DEFAULT_OVERSCAN,
  label,
  renderRow,
  getKey,
  empty,
  className = "",
  header,
  minWidth,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const ui = useT("ui");
  const density = useDensity();
  const rowHeight = rowHeightProp ?? (density === "compact" ? DENSE_ROW_HEIGHT : DEFAULT_ROW_HEIGHT);
  // eslint-disable-next-line react-hooks/incompatible-library -- React Compiler 对 useVirtualizer 的返回值跳过自动记忆化(TanStack 官方说明),本组件不把它传给任何记忆化的子组件
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index) => getKey(items[index]),
    // 贴顶的表头占去第一行的位置:各行实际从第二行起(位置由 CSS 给,这里只让可视范围算得一致)
    paddingStart: header === undefined ? 0 : rowHeight,
    // 至少一行高:overscan 0 是合法值,但 virtual-core 在 outerSize 0 时 range 为 null,SSR 会一行都不出
    initialRect: { width: 0, height: rowHeight * Math.max(1, overscan) },
  });
  const rows = virtualizer.getVirtualItems();
  // 有表头时滚动容器自成层叠上下文(isolate,P2-12):贴顶表头的 z-index(--z-sticky)只在容器里和各行比高低。
  // 不隔离的话,它和页面上别的贴顶层在同一个层叠上下文里比:终端头部(terminal.css 的 [data-area="header"])也是 sticky + --z-sticky、
  // DOM 在前,页面滚动、列表从头部底下经过时,表头就画在头部上面,还截走头部的点击(最新价、标的 / 年份切换、抽屉开关)。
  // 不传 header 时不加,标记与原来逐字节一致。
  const isolate = header === undefined ? "" : " isolate";

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={label}
      aria-describedby={hintId}
      tabIndex={0}
      className={`relative overflow-auto tabular-nums focus-visible:outline-none focus-visible:shadow-focus${isolate} ${className}`}
    >
      <span className="sr-only" id={hintId}>
        {ui.listHint}
      </span>
      {header !== undefined ? (
        <div className="sticky top-0 z-(--z-sticky)" style={{ minWidth }}>
          {header}
        </div>
      ) : null}
      {items.length === 0 ? (
        (empty ?? <EmptyState />)
      ) : (
        <div className="relative w-full" style={{ height: `calc(var(--spacing-row) * ${items.length})`, minWidth }}>
          {rows.map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full h-row"
              style={{ transform: `translateY(calc(var(--spacing-row) * ${row.index}))` }}
            >
              {renderRow(items[row.index], row.index)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
