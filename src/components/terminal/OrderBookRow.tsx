"use client";

import { memo } from "react";
import type { Side } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { formatPrice, formatQty } from "@/shared/precision";

export type OrderBookRowProps = {
  /** 聚合后的档位价(分):买盘向下、卖盘向上取整 */
  price: number;
  /** 本档数量(吨) */
  quantity: number;
  /** 从最优价累计到本档的数量(吨) */
  cum: number;
  /** cum / 可见档总量,0..1,直接作深度条的 scaleX */
  pct: number;
  /** 本档挂单笔数 */
  orders: number;
  /** 本档含自己的挂单 */
  mine: boolean;
  /** 数量变化计数(buildBookView 维护):0 = 首次出现不闪;变了就换 key 重挂闪烁层 */
  flashKey: number;
  /** 价格小数位(Instrument.pricePrecision) */
  precision: number;
  /** 数量步长(Instrument.qtyStep,吨;决定数量与累计的小数位),默认 1 */
  qtyStep?: number;
  /** 本侧的 Tab 停靠行(roving tabindex,BookSide 决定):true → tabIndex 0,否则 -1 */
  tabbable: boolean;
  /** 本行所在的一侧:BUY = 买盘,SELL = 卖盘 */
  side: Side;
  /** 点价:由面板决定写哪一侧的草稿(对手方) */
  onPick: (price: number) => void;
};

/**
 * 盘口一行(计划 §3.1、§3.6):React.memo + 全原始类型 props,只有本档的数值变化才提交。
 *   - 深度条:绝对定位的 <span>,宽度靠行内 transform: scaleX(pct)(只动合成层,不触发布局),底色 --up-soft / --down-soft;
 *     它从行尾长出来,长的时候整行(含价格列)都压在上面。所以行里的字全用盘口专用 token(按外观取值,在深度条 + 悬停底上都 ≥ 4.5:1,
 *     门禁 contrast.test.ts):价格 --terminal-book-up / -down(浅色比 --up / --down 深一级,随涨跌轴翻转),
 *     累计与笔数 --terminal-book-muted(笔数靠更小的字号退后一级);不用 --up / --down、--muted / --muted-2(浅色外观
 *     在深度条上不到 AA,P1-25e);
 *   - 闪烁:<span key={flashKey}> 在数量变化时重挂载,.flash-up / .flash-down 的 CSS 动画(--motion-flash)自己跑完自己停,
 *     不用计时器;flashKey 0(档位首次出现、快照首帧)不闪。买盘闪涨色、卖盘闪跌色,随涨跌轴翻转;
 *   - 自家档:<li data-mine>,terminal.css 画 --terminal-mine 竖条,读屏在 aria-label 里念出 book.mine;
 *   - 整行是 <button>:点击与 Enter / 空格都走 onPick(price)(面板写 marketActions.setDraft,不在渲染期);
 *     一侧只有一行在 Tab 序列里(tabbable,roving tabindex 由 BookSide 管),↑ ↓ Home End 在行间移动焦点。
 * 数量与累计按 qtyStep 的小数位显示(§4.4:精度来自 Instrument;Phase 1 种子恒 1,即整数吨)。
 */
export const OrderBookRow = memo(function OrderBookRow({ price, quantity, cum, pct, orders, mine, flashKey, precision, qtyStep = 1, tabbable, side, onPick }: OrderBookRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const bid = side === "BUY";
  const priceText = formatPrice(price, precision, locale);
  const qtyText = formatQty(quantity, qtyStep, locale);
  const cumText = formatQty(cum, qtyStep, locale);
  const label = [
    `${t.book.price} ${priceText}`,
    `${t.book.qty} ${qtyText}`,
    `${t.book.cum} ${cumText}`,
    `${t.book.orders} ${orders}`,
    ...(mine ? [t.book.mine] : []),
  ].join(" · ");

  return (
    <li data-book-row="" data-price={price} data-mine={mine ? "" : undefined}>
      <button
        type="button"
        tabIndex={tabbable ? 0 : -1}
        aria-label={label}
        title={mine ? t.book.mine : undefined}
        onClick={() => onPick(price)}
        className="t-book-row t-book-grid h-row w-full px-gap text-t-sm leading-t-tight hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus"
      >
        <span aria-hidden="true" className={`t-depth-bar ${bid ? "bg-up-soft" : "bg-down-soft"}`} style={{ transform: `scaleX(${pct})` }} />
        {flashKey > 0 ? <span key={flashKey} aria-hidden="true" className={`t-row-flash ${bid ? "flash-up" : "flash-down"}`} /> : null}
        <span className={`tnum truncate text-start ${bid ? "text-(--terminal-book-up)" : "text-(--terminal-book-down)"} ${mine ? "font-semibold" : ""}`}>{priceText}</span>
        <span className="tnum truncate text-end text-foreground">{qtyText}</span>
        <span className="tnum truncate text-end text-(--terminal-book-muted)">{cumText}</span>
        <span className="tnum text-end text-t-2xs text-(--terminal-book-muted)">{orders}</span>
      </button>
    </li>
  );
});
