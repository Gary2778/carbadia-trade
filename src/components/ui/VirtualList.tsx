"use client";

import { useId, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useT } from "@/i18n/LangProvider";
import { EmptyState } from "./EmptyState";

/**
 * 默认行高估值(像素)= --spacing-row(1.375rem,根字号 16 时为 22)。react-virtual 只认像素,这个值只用来算
 * 渲染哪几行;行由 h-row 定高、位置与总高都按 --spacing-row 写成 CSS(见下),估值与真实行高不一致时也不会错位,
 * 挂载后 measureElement 按真实高度校正可视范围。
 */
export const DEFAULT_ROW_HEIGHT = 22;
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
  rowHeight = DEFAULT_ROW_HEIGHT,
  overscan = DEFAULT_OVERSCAN,
  label,
  renderRow,
  getKey,
  empty,
  className = "",
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const t = useT("terminal");
  // eslint-disable-next-line react-hooks/incompatible-library -- React Compiler 对 useVirtualizer 的返回值跳过自动记忆化(TanStack 官方说明),本组件不把它传给任何记忆化的子组件
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
    getItemKey: (index) => getKey(items[index]),
    // 至少一行高:overscan 0 是合法值,但 virtual-core 在 outerSize 0 时 range 为 null,SSR 会一行都不出
    initialRect: { width: 0, height: rowHeight * Math.max(1, overscan) },
  });
  const rows = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={label}
      aria-describedby={hintId}
      tabIndex={0}
      className={`relative overflow-auto tabular-nums focus-visible:outline-none focus-visible:shadow-focus ${className}`}
    >
      <span className="sr-only" id={hintId}>
        {t.a11y.listHint}
      </span>
      {items.length === 0 ? (
        (empty ?? <EmptyState />)
      ) : (
        <div className="relative w-full" style={{ height: `calc(var(--spacing-row) * ${items.length})` }}>
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
