"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import type { Side } from "@/shared";
import { useT } from "@/i18n/LangProvider";
import { marketActions } from "@/lib/market/store";
import type { TerminalLayout } from "./useTerminalLayout";

export type MobileTab = "chart" | "book" | "order";
export const MOBILE_TABS: readonly MobileTab[] = ["chart", "book", "order"];

/**
 * 纯函数:盘口点价之后要切到哪个页签(null = 不切)。手机布局里盘口与下单框分在两个页签,点价只写草稿的话
 * 用户在盘口页签上看不到任何变化;切到「下单」页签,价格已经带入表单,页签切换本身就是可见反馈。
 * 平板 / 桌面的下单框就在盘口旁边,不切。
 */
export const tabAfterBookPick = (layout: TerminalLayout): MobileTab | null => (layout === "mobile" ? "order" : null);

/** 点价那一刻焦点在哪:将被卸载的页签面板里(键盘 / 读屏激活了盘口那一行)、<body>(iOS 触屏点按不聚焦按钮)、别处 */
export type BookPickFocus = "inPanel" | "body" | "elsewhere";

/**
 * 纯函数:点价切页签之后焦点交给谁(null = 不动)。只挂载激活页签,切过去时刚激活的盘口行随面板卸载,焦点掉到 <body>:
 * 读屏用户(VoiceOver / TalkBack,手机布局的主要读屏人群)与放大到 400% 落进手机布局的桌面键盘用户都会丢了位置,也听不到页签已换。
 * 所以交给刚选中的页签按钮:读屏念「下单,页签,已选中」,Tab 的下一步就进表单;不选价格框 —— 它是 input,聚焦会弹软键盘。
 * 程序聚焦不会给触屏用户画焦点环(:focus-visible 沿用上一个焦点的状态)。焦点原本在面板外就不抢;没切页签(平板 / 桌面)不动。
 */
export const focusAfterBookPick = (tab: MobileTab | null, focus: BookPickFocus): "selectedTab" | null =>
  tab !== null && focus !== "elsewhere" ? "selectedTab" : null;

/** 初始页签:?side= 带来的方向直接落在下单页签,否则图表 */
export const initialMobileTab = (initialSide?: Side): MobileTab => (initialSide ? "order" : "chart");

/** 方向键在页签之间移动(WAI-ARIA APG 的自动激活 tabs):← → 循环,Home / End 到两端;其它键 null */
export function nextMobileTab(current: MobileTab, key: string): MobileTab | null {
  const i = MOBILE_TABS.indexOf(current);
  const n = MOBILE_TABS.length;
  if (key === "ArrowRight") return MOBILE_TABS[(i + 1) % n];
  if (key === "ArrowLeft") return MOBILE_TABS[(i - 1 + n) % n];
  if (key === "Home") return MOBILE_TABS[0];
  if (key === "End") return MOBILE_TABS[n - 1];
  return null;
}

export type MobileTabsProps = {
  symbol: string;
  /**
   * 三个页签的内容;只挂载激活的那个(ReactNode 在渲染之前只是描述,不会提前挂载)。
   * 不传 = 只出页签条(服务端快照与桌面 / 平板布局):页签条总在 HTML 里、只由 terminal.css 的断点决定显示(< 48rem),
   * 手机的 SSR 首帧就为它占好位置,水合后换成手机子树时图表与页脚不被推下去(P1-25f);
   * 传了(layout === "mobile")才挂面板与底部买卖条。页签条始终是本组件的第一个节点,换布局时不重挂载(id 不变)。
   */
  panels?: Record<MobileTab, ReactNode>;
  /** 激活页签由 TerminalShell 持有:快捷键(b / s / l / m 切到下单,1–7 切到图表)也要能切 */
  tab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
};

/**
 * 手机版(< 48rem)的页签容器(计划 §4.7):
 * 「图表 / 盘口·成交 / 下单」三页签(tape 并入盘口页签、碳元数据折叠在下单页签里,由 TerminalShell 组装 panels),
 * 只挂载激活页签;页签条按 WAI-ARIA tabs 模式:roving tabIndex(只有激活页签在 Tab 序列里),← → / Home / End 移动焦点并切换。
 * 页签条不看 useTerminalLayout():总是输出(≥ 48rem 由 terminal.css 隐藏);面板与买卖条只在 panels 传入时挂载,
 * 没有面板时页签不写 aria-controls(不指向不存在的节点)。
 * 底部固定买入 / 卖出双按钮 —— 切到下单页签并经 marketActions.setDraft 预设方向(事件处理器里写 store,不在渲染期;
 * 显式带 price: undefined,不沿用上一次盘口点价的价格)。
 * 触控目标 min-h-touch;底部条的位置与留白在 terminal.css / globals.css。
 */
export function MobileTabs({ symbol, panels, tab, onTabChange }: MobileTabsProps) {
  const t = useT("terminal");
  const id = useId();
  const tabId = (key: MobileTab) => `${id}-${key}-tab`;
  const label: Record<MobileTab, string> = { chart: t.mobile.chart, book: t.mobile.book, order: t.mobile.order };

  const handleOrderSide = (side: Side) => {
    marketActions.setDraft({ symbol, side, price: undefined });
    onTabChange("order");
  };
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextMobileTab(tab, e.key);
    if (!next) return;
    e.preventDefault();
    onTabChange(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <>
      <div data-area="mobile-tabs" role="tablist" aria-label={t.mobile.tabsLabel} aria-orientation="horizontal" className="grid grid-cols-3 gap-gap rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-gap">
        {MOBILE_TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={tabId(key)}
            aria-selected={tab === key}
            aria-controls={panels ? `${id}-panel` : undefined}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => onTabChange(key)}
            onKeyDown={handleKeyDown}
            className={`min-h-touch rounded-control text-t-sm font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
              tab === key ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {label[key]}
          </button>
        ))}
      </div>
      {panels ? (
        <div data-area="mobile-panel" data-tab={tab} role="tabpanel" id={`${id}-panel`} aria-labelledby={tabId(tab)} className="flex min-w-0 flex-col gap-gap">
          {panels[tab]}
        </div>
      ) : null}
      {panels ? (
        <div data-mobile-actions="">
          <button
            type="button"
            onClick={() => handleOrderSide("BUY")}
            className="min-h-touch rounded-control bg-(--terminal-up) text-t-md font-semibold text-background focus-visible:outline-none focus-visible:shadow-focus"
          >
            {t.mobile.buy}
          </button>
          <button
            type="button"
            onClick={() => handleOrderSide("SELL")}
            className="min-h-touch rounded-control bg-(--terminal-down) text-t-md font-semibold text-background focus-visible:outline-none focus-visible:shadow-focus"
          >
            {t.mobile.sell}
          </button>
        </div>
      ) : null}
    </>
  );
}
