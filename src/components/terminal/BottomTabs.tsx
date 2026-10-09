"use client";

import { useId, type KeyboardEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
import { useAccountStatus, type AccountStatus } from "@/lib/market/account-store";
import { terminalHref } from "@/lib/market/navigation";
import { usePrefs, writePrefs, type BottomTab } from "@/lib/market/prefs";
import { ExportCsvLink, FILLS_CSV_HREF, HISTORY_CSV_HREF, STRIP_ITEM_BOX } from "./ExportCsvLink";
import { OpenOrdersTab } from "./OpenOrdersTab";

// 只有默认页签「当前委托」静态引入;其余五个选中时才取代码(next/dynamic,加载中统一 Skeleton):
// /trade/[symbol] 首屏的自有 JS 预算所剩不多(计划 §7.1),它们连同各自的分页查询、筛选条、导出入口(P2-06)都不进首屏。
// 页签只在登录态就绪后挂载,服务端从不渲染它们(ssr: false)。面板区高度固定(h-65 / 网格行),
// 存了非默认页签的用户水合后切过去时 Skeleton 与表格在同一个框里替换,不推动页面其它部分。
const tabLoading = () => <Skeleton rows={5} />;
const TriggersTab = dynamic(() => import("./TriggersTab").then((m) => m.TriggersTab), { ssr: false, loading: tabLoading });
const OrderHistoryTab = dynamic(() => import("./OrderHistoryTab").then((m) => m.OrderHistoryTab), { ssr: false, loading: tabLoading });
const FillsTab = dynamic(() => import("./FillsTab").then((m) => m.FillsTab), { ssr: false, loading: tabLoading });
const PositionsTab = dynamic(() => import("./PositionsTab").then((m) => m.PositionsTab), { ssr: false, loading: tabLoading });
const LedgerTab = dynamic(() => import("./LedgerTab").then((m) => m.LedgerTab), { ssr: false, loading: tabLoading });

export const BOTTOM_TABS: readonly BottomTab[] = ["open", "triggers", "history", "fills", "positions", "ledger"];

/** 非激活面板的样式(计划 §3.1、§3.6):content-visibility:auto;它们本来就不挂载内容,这一条保证即使日后改成保活也不付布局 / 绘制 */
export const INACTIVE_PANEL_STYLE = { contentVisibility: "auto" } as const;

/**
 * 手机(< 48rem)上并进页签条右端的 CSV 导出入口(P2-12):历史委托与成交记录没有筛选条,入口原来在表格上方单独占一行,
 * 手机上 16.25rem 高的面板因此少两行数据;≥ 48rem 仍是页签里的那一行(ExportCsvBar)。流水页签的入口在它自己的筛选行里,
 * 当前委托与持仓没有导出。账户就绪之前没有(页签内容还没挂载,也不该看到导出)。
 */
export function stripExportHref(tab: BottomTab, status: AccountStatus): string | null {
  if (status !== "ready") return null;
  if (tab === "history") return HISTORY_CSV_HREF;
  if (tab === "fills") return FILLS_CSV_HREF;
  return null;
}

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
 * 底部六个 Tab(计划 §3.1、§6.2.3 P2-07、§6.3.3 P3-07):当前委托 / 条件单 / 历史委托 / 成交记录 / 持仓 / 流水。
 *   - 激活的 Tab 存 prefs.bottomTab(usePrefs:服务端快照与水合首帧恒为默认 open,挂载后切到 localStorage 值;切换经 writePrefs;
 *     存储不可用时 prefs 自己留在内存里,本次会话照样能切);
 *   - 只有激活面板挂载内容 —— 非激活面板是空的 hidden tabpanel(style content-visibility:auto),Profiler 里零渲染;
 *     分页数据缓存在各 Tab 的模块级查询里,切回来不重拉、不丢已翻的页;
 *   - 登录态在这里统一判定:未知(idle / loading)→ Skeleton,未登录 → 登录入口(EmptyState),就绪才挂 Tab;
 *   - 自带面板外壳 <section data-area="tabs">(aria-labelledby 指向 tablist):P1-22 在 TerminalShell 里用它
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
  const labels: Record<BottomTab, string> = { open: t.tabs.open, triggers: t.tabs.triggers, history: t.tabs.history, fills: t.tabs.fills, positions: t.tabs.positions, ledger: t.ledger.tab };
  const stripExport = stripExportHref(bottomTab, status);

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
      case "triggers":
        return <TriggersTab />;
      case "history":
        return <OrderHistoryTab />;
      case "fills":
        return <FillsTab />;
      case "positions":
        return <PositionsTab />;
      case "ledger":
        return <LedgerTab symbol={symbol} />;
    }
  };

  return (
    <section
      data-area="tabs"
      aria-labelledby={tablistId}
      className="flex h-65 min-h-0 min-w-0 flex-col gap-gap overflow-hidden rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel md:h-auto"
    >
      {/* 页签条:tablist 本身只放 tab(ARIA);手机上导出入口是它右边的兄弟节点,不随 tab 横向滚走。
          入口与 tab 同一个纵向盒子(STRIP_ITEM_BOX)、贴底对齐,外层不加上下内边距:在各个 tab 之间切换时页签条一样高 */}
      <div className="flex shrink-0 items-stretch">
        <div id={tablistId} role="tablist" aria-label={t.tabs.tablistLabel} aria-orientation="horizontal" className="flex min-w-0 flex-1 items-end gap-gap overflow-x-auto border-b border-(--terminal-border)">
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
                className={`${STRIP_ITEM_BOX} shrink-0 px-1.5 text-t-sm font-semibold md:px-2 md:text-t-md transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
                  selected ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
                }`}
              >
                {labels[tab]}
              </button>
            );
          })}
        </div>
        {stripExport ? (
          <div className="flex shrink-0 items-end border-b border-(--terminal-border) ps-gap md:hidden">
            <ExportCsvLink href={stripExport} compact />
          </div>
        ) : null}
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
