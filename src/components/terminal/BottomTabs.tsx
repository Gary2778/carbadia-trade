"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
import { useAccountStatus } from "@/lib/market/account-store";
import { terminalHref } from "@/lib/market/navigation";
import { usePrefs, writePrefs, type BottomTab } from "@/lib/market/prefs";
import { FillsTab } from "./FillsTab";
import { OpenOrdersTab } from "./OpenOrdersTab";
import { OrderHistoryTab } from "./OrderHistoryTab";
import { PositionsTab } from "./PositionsTab";

export const BOTTOM_TABS: readonly BottomTab[] = ["open", "history", "fills", "positions"];

/** 非激活面板的样式(计划 §3.1、§3.6):content-visibility:auto;它们本来就不挂载内容,这一条保证即使日后改成保活也不付布局 / 绘制 */
export const INACTIVE_PANEL_STYLE = { contentVisibility: "auto" } as const;

/** 方向键在 tab 之间移动(APG 的自动激活 tabs):← → 循环,Home / End 到两端;其它键 null */
export function nextTab(current: BottomTab, key: string): BottomTab | null {
  const i = BOTTOM_TABS.indexOf(current);
  const n = BOTTOM_TABS.length;
  if (key === "ArrowRight") return BOTTOM_TABS[(i + 1) % n];
  if (key === "ArrowLeft") return BOTTOM_TABS[(i - 1 + n) % n];
  if (key === "Home") return BOTTOM_TABS[0];
  if (key === "End") return BOTTOM_TABS[n - 1];
  return null;
}

/**
 * 底部四个 Tab(计划 §3.1):当前委托 / 历史委托 / 成交记录 / 持仓。
 *   - 激活的 Tab 存 prefs.bottomTab(usePrefs:服务端快照与水合首帧恒为默认 open,挂载后切到 localStorage 值;切换经 writePrefs;
 *     存储不可用时 prefs 自己留在内存里,本次会话照样能切);
 *   - 只有激活面板挂载内容 —— 非激活面板是空的 hidden tabpanel(style content-visibility:auto),Profiler 里零渲染;
 *     分页数据缓存在各 Tab 的模块级查询里,切回来不重拉、不丢已翻的页;
 *   - 登录态在这里统一判定:未知(idle / loading)→ Skeleton,未登录 → 登录入口(EmptyState),就绪才挂 Tab;
 *   - 自带面板外壳 <section data-area="tabs">(aria-labelledby 指向 tablist,区域名 = 四个 Tab 名):P1-22 在 TerminalShell 里用它
 *     替换 tabs 的 PanelSlot(网格按 data-area 摆放);
 *     手机布局里它在下单页签内,没有网格行高,所以自带 h-65(= 16.25rem,与桌面网格行同高),≥ 48rem 交回网格。
 */
export function BottomTabs({ symbol }: { symbol: string }) {
  const t = useT("terminal");
  const { bottomTab } = usePrefs();
  const status = useAccountStatus();
  const id = useId();
  const tablistId = `${id}-tablist`;
  const tabId = (tab: BottomTab) => `${id}-tab-${tab}`;
  const panelId = (tab: BottomTab) => `${id}-panel-${tab}`;
  const labels: Record<BottomTab, string> = { open: t.tabs.open, history: t.tabs.history, fills: t.tabs.fills, positions: t.tabs.positions };

  const handleSelect = (tab: BottomTab) => writePrefs({ bottomTab: tab });
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextTab(bottomTab, e.key);
    if (!next) return;
    e.preventDefault();
    handleSelect(next);
    document.getElementById(tabId(next))?.focus();
  };

  const content = (tab: BottomTab): ReactNode => {
    if (status === "idle" || status === "loading") return <Skeleton rows={5} />;
    if (status === "anon") {
      return (
        <EmptyState
          title={t.toast.loginRequired}
          action={
            <Link
              href={`/login?returnTo=${encodeURIComponent(terminalHref(symbol))}`}
              prefetch={false}
              className="rounded-control border border-(--terminal-border) px-3 py-1 text-t-sm font-medium text-foreground hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus"
            >
              {t.order.login}
            </Link>
          }
        />
      );
    }
    switch (tab) {
      case "open":
        return <OpenOrdersTab symbol={symbol} />;
      case "history":
        return <OrderHistoryTab />;
      case "fills":
        return <FillsTab />;
      case "positions":
        return <PositionsTab />;
    }
  };

  return (
    <section
      data-area="tabs"
      aria-labelledby={tablistId}
      className="flex h-65 min-h-0 min-w-0 flex-col gap-gap overflow-hidden rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel md:h-auto"
    >
      <div id={tablistId} role="tablist" aria-label={t.tabs.tablistLabel} aria-orientation="horizontal" className="flex shrink-0 items-center gap-gap overflow-x-auto border-b border-(--terminal-border)">
        {BOTTOM_TABS.map((tab) => {
          const selected = tab === bottomTab;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              id={tabId(tab)}
              aria-selected={selected}
              aria-controls={panelId(tab)}
              tabIndex={selected ? 0 : -1}
              onClick={() => handleSelect(tab)}
              onKeyDown={handleKeyDown}
              className={`-mb-px shrink-0 border-b-2 px-1.5 pb-gap text-t-sm font-semibold md:px-2 md:text-t-md leading-t-tight transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
                selected ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {labels[tab]}
            </button>
          );
        })}
      </div>
      {BOTTOM_TABS.map((tab) => {
        const active = tab === bottomTab;
        return (
          <div
            key={tab}
            role="tabpanel"
            id={panelId(tab)}
            aria-labelledby={tabId(tab)}
            data-tab={tab}
            hidden={!active}
            style={active ? undefined : INACTIVE_PANEL_STYLE}
            className={active ? "flex min-h-0 flex-1 flex-col" : undefined}
          >
            {active ? content(tab) : null}
          </div>
        );
      })}
    </section>
  );
}
