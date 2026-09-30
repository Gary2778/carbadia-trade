"use client";

import { memo, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactElement } from "react";
import type { Side } from "@/shared";
import { useT } from "@/i18n/LangProvider";
import type { BookViewRow } from "@/lib/market/selectors";
import { OrderBookRow } from "./OrderBookRow";

export type BookSideProps = {
  /** BUY = 买盘,SELL = 卖盘(与 buildBookView 的取整方向同一枚举) */
  side: Side;
  /** buildBookView 的一侧:最优价在前,已截到 depth 档 */
  rows: BookViewRow[];
  precision: number;
  /** Instrument.qtyStep(吨),原样传给行;默认 1 */
  qtyStep?: number;
  onPick: (price: number) => void;
};

/**
 * 纯函数:本侧的 Tab 停靠行(roving tabindex)。最近获得焦点的那一档还在盘口里就停在它上面(Tab 出去再回来回到原处);
 * 否则(从没聚焦过、那一档已成交 / 撤掉 / 换了合并档)停在最优价 —— rows 最优价在前,即贴着中缝的买一 / 卖一。空侧 null。
 */
export function rovingPrice(rows: readonly BookViewRow[], focused: number | null): number | null {
  if (rows.length === 0) return null;
  if (focused !== null && rows.some((row) => row.price === focused)) return focused;
  return rows[0].price;
}

/** 纯函数:按键 → 焦点要去的行(DOM 顺序的下标)。↑ ↓ 一行、Home / End 到两端,越界钳住;其余键(含 Enter / 空格)不管,null */
export function nextRovingIndex(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowUp":
      return Math.max(0, index - 1);
    case "ArrowDown":
      return Math.min(count - 1, index + 1);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** 事件目标所在行的价格(行的 <li data-price>);不在行里 null */
function rowPriceOf(target: EventTarget): number | null {
  if (!(target instanceof Element)) return null;
  const raw = target.closest("[data-price]")?.getAttribute("data-price");
  const price = raw == null ? Number.NaN : Number(raw);
  return Number.isFinite(price) ? price : null;
}

/**
 * 盘口一侧(计划 §3.1):固定行高的 <ol>,每侧 ≤ 50 档,不虚拟化。React.memo:getBookView 在
 * [book.version, stepCents, depth, mineVersion] 不变时返回同一 rows 引用,本组件整侧跳过;
 * rows 变了也只有数值真正变化的行提交(行以价格为 key,OrderBookRow 是 memo + 原始 props)。
 * 卖盘倒着画(最差价在上、卖一贴着中缝的 SpreadBar),买盘顺着画(买一在上);倒序只是按下标反向取,
 * 不复制数组,且只在 rows 变化时发生。
 * 键盘(计划 §4.8):每侧只有一个 Tab 停靠点(roving tabindex,rovingPrice),深度 50 时整本盘口也只占两个 Tab 位;
 * ↑ ↓ 在本侧行间移动焦点(按屏幕上的上下,卖盘同样是往上 = 更高价),Home / End 到两端;Enter / 空格照旧点价。
 * 焦点与按键都在 <ol> 上委托处理,行组件只多一个布尔 prop,停靠点换行时只有新旧两行重渲染。
 * 焦点所在的那一档消失(成交、撤单、换合并档,行被卸载)时,把焦点交给本侧新的停靠行,键盘用户不被甩出盘口。
 */
export const BookSide = memo(function BookSide({ side, rows, precision, qtyStep = 1, onPick }: BookSideProps) {
  const t = useT("terminal");
  const asks = side === "SELL";
  const [focused, setFocused] = useState<number | null>(null);
  const tabPrice = rovingPrice(rows, focused);
  const listRef = useRef<HTMLOListElement>(null);
  /** 焦点是否在本侧某一行上(focus / blur 维护;聚焦的行被卸载时保持 true,见 handleBlur) */
  const focusWithin = useRef(false);

  // 点击、Tab 进来、方向键移过来都会让某行获得焦点:记下它,Tab 出去再回来停在原处
  const handleFocus = (e: FocusEvent<HTMLOListElement>) => {
    focusWithin.current = true;
    const price = rowPriceOf(e.target);
    if (price !== null && price !== focused) setFocused(price);
  };
  const handleBlur = (e: FocusEvent<HTMLOListElement>) => {
    const next = e.relatedTarget;
    if (next instanceof Node && e.currentTarget.contains(next)) return; // 本侧行间移动
    if (next !== null) {
      focusWithin.current = false; // 焦点去了页面别处
      return;
    }
    // relatedTarget 为空:点了页面空白处 / 切走窗口(行还在),或者行随档位消失被卸载(Chrome 卸载聚焦元素时也发 focusout)。
    // 等这次卸载落定再看:行还连在文档上才算真的离开
    const left = e.target;
    queueMicrotask(() => {
      if (left.isConnected) focusWithin.current = false;
    });
  };
  // 盘口一跳之后:焦点原本在本侧、现在却不在了 → 那一行随档位消失被卸载了,焦点落到新的停靠行
  useEffect(() => {
    const list = listRef.current;
    if (!list || !focusWithin.current || list.contains(document.activeElement)) return;
    const stop = list.querySelector<HTMLButtonElement>('li[data-price] > button[tabindex="0"]');
    if (stop) stop.focus();
    else focusWithin.current = false;
  }, [rows]);
  const handleKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("li[data-price] > button"));
    const index = buttons.findIndex((button) => button === e.target);
    if (index < 0) return;
    const next = nextRovingIndex(e.key, index, buttons.length);
    if (next === null) return;
    e.preventDefault(); // 方向键 / Home / End 不再滚动盘口容器,焦点移动自己会把行滚进视野
    if (next !== index) buttons[next].focus();
  };

  const items: ReactElement[] = [];
  for (let k = 0; k < rows.length; k++) {
    const row = rows[asks ? rows.length - 1 - k : k];
    items.push(
      <OrderBookRow
        key={row.price}
        price={row.price}
        quantity={row.quantity}
        cum={row.cum}
        pct={row.pct}
        orders={row.orders}
        mine={row.mine}
        flashKey={row.flashKey}
        precision={precision}
        qtyStep={qtyStep}
        tabbable={row.price === tabPrice}
        side={side}
        onPick={onPick}
      />,
    );
  }
  return (
    <ol
      ref={listRef}
      data-side={side}
      aria-label={asks ? t.book.asks : t.book.bids}
      title={t.book.clickToFill}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className="flex flex-col"
    >
      {items}
    </ol>
  );
});
