"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { InstrumentListItem, OrderType, Side } from "@/shared";
import { NoticeToaster } from "@/components/notices/NoticeToaster";
import { useT } from "@/i18n/LangProvider";
import { MarketProvider } from "@/lib/market/MarketProvider";
import { intervalSlot, matchHotkey, nudgePrice, type HotkeyAction } from "@/lib/market/hotkeys";
import { symbolFromPath } from "@/lib/market/navigation";
import { useDensity, usePrefs } from "@/lib/market/prefs";
import type { InstrumentFilters } from "@/lib/market/selectors";
import { marketActions, useMarketStore } from "@/lib/market/store";
import type { TransportMode } from "@/lib/market/transport";
import { BottomTabs } from "./BottomTabs";
import { CarbonMetaPanel } from "./CarbonMetaPanel";
import { ChartPanel, selectChartTab } from "./ChartPanel";
import { INSTRUMENT_SEARCH_ID } from "./InstrumentFilters";
import { InstrumentPanel, focusInstrumentSearch, type InstrumentPanelHandle } from "./InstrumentPanel";
import { CHART_TABS } from "./IntervalTabs";
import { MobileTabs, focusAfterBookPick, initialMobileTab, tabAfterBookPick, type BookPickFocus, type MobileTab } from "./MobileTabs";
import { OrderBookPanel } from "./OrderBookPanel";
import { OrderPanel } from "./OrderPanel";
import { PerfHudGate } from "./PerfHud";
import { TerminalHeader } from "./TerminalHeader";
import { TradesTape } from "./TradesTape";
import { VintageSelector } from "./VintageSelector";
import { DRAWER_DOCKED_QUERY, useHydrated, useTerminalLayout } from "./useTerminalLayout";

// 快捷键帮助只在按 ? 之后才下载与挂载(计划 §3.6「渲染纪律」:四个 next/dynamic({ ssr: false }) 之一);
// 它是模态对话框,加载那一瞬不占位(不往网格里塞 Skeleton)
const KeyboardShortcutsHelp = dynamic(() => import("./KeyboardShortcutsHelp").then((m) => m.KeyboardShortcutsHelp), { ssr: false });

export type TerminalShellProps = {
  /** 服务端 params 的 symbol;客户端以 symbolFromPath(usePathname()) 为准(switchSymbol 的 replaceState 之后 params 就过期了) */
  symbol: string;
  /** listInstruments() 的全部标的 + ticker:头部与左栏的首屏由它渲染,挂载后由 MarketProvider 灌入 store */
  initialInstruments: InstrumentListItem[];
  /** ?side=BUY|SELL:下单面板的初始方向 */
  initialSide?: Side;
  /** ?q / registry / … 经 readFiltersFromUrl 解析的初始筛选 */
  initialFilters?: InstrumentFilters;
  /**
   * 服务端的运行期传输提示:"poll" = 这台服务端接不了 /ws(START_MODE=next 回滚、本进程没有 hub 或 hub 关着;
   * page.tsx 经 transportModeForServer 读出)——
   * MarketProvider 首帧就轮询、不试 /ws,连接徽标的占位也显示「轮询」。缺省 = 按构建期模式(行为不变)。
   */
  transportMode?: TransportMode;
};

const NO_FILTERS: InstrumentFilters = {};

/** ?perf=1 的 HUD 入口没有 props:模块级元素,壳重渲染时 React 直接跳过它 */
const PERF_HUD = <PerfHudGate />;

/** 模态抽屉里参与 Tab 循环的元素(再加上遮罩按钮) */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 快捷键只在键鼠设备上启用(计划 §4.7);触屏上既不分发快捷键,也打不开帮助 */
const HOTKEY_POINTER_QUERY = "(pointer: fine)";

/** ≥ 80rem 左栏在网格里(不是抽屉):头部开关与快捷键都走这一个判断,所以 drawerOpen 为真 ⇔ 模态抽屉 */
const drawerDocked = (): boolean => window.matchMedia(DRAWER_DOCKED_QUERY).matches;

/**
 * 纯函数:焦点困在 items(按 Tab 顺序)里时,这一次 Tab / Shift+Tab 要把焦点送到哪里;null = 交给浏览器默认。
 * 从最后一个 Tab 回到第一个,从第一个 Shift+Tab 到最后一个;焦点不在 items 里(例如刚打开时在抽屉容器本身)
 * 时 Tab 进第一个、Shift+Tab 进最后一个。
 */
export function trapFocusTarget<T>(items: readonly T[], active: T | null, shift: boolean): T | null {
  if (items.length === 0) return null;
  const i = active === null ? -1 : items.indexOf(active);
  if (i === -1) return shift ? items[items.length - 1] : items[0];
  if (shift && i === 0) return items[items.length - 1];
  if (!shift && i === items.length - 1) return items[0];
  return null;
}

/**
 * 纯函数:抽屉(模态)开着时哪些快捷键照常分发 —— 只有找标的(/、Ctrl/Cmd+K)、帮助与 Esc;
 * 买卖、类型、周期作用在抽屉背后被 inert 的面板上,不分发。
 */
export function hotkeyAllowedWithDrawer(action: HotkeyAction): boolean {
  return action === "focusSearch" || action === "help" || action === "cancelDialog";
}

/** 纯函数:这个动作要求手机布局切到哪个页签(null = 不用切)—— 下单相关到「下单」,周期到「图表」 */
export function mobileTabFor(action: HotkeyAction): MobileTab | null {
  if (action === "sideBuy" || action === "sideSell" || action === "typeLimit" || action === "typeMarket") return "order";
  if (intervalSlot(action) !== null) return "chart";
  return null;
}

/** 受控 <input> 的程序化改值:走原型上的 value setter 再派发 input 事件,React 的 onChange 照常收到 */
function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** 面板外壳:标题 + 内容。其它面板都自带 <section data-area>,只有 ChartPanel 不带,由这里包一层 */
function PanelFrame({ area, title, children }: { area: string; title: string; children: ReactNode }) {
  return (
    <section
      data-area={area}
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-col gap-gap overflow-hidden rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel"
    >
      <h2 className="text-t-md font-semibold leading-t-tight">{title}</h2>
      {children}
    </section>
  );
}

/**
 * 这个包装只为把 interval 显式传给 MarketProvider(P1-14 的备注:订阅的 K 线周期在调用处看得见),不是为了隔离重渲染 ——
 * MarketProvider 自己也调 usePrefs()(不传 interval 时用它),任何偏好变化本来就会重渲染 MarketProvider;
 * 这里只是多一个同源的偏好订阅。壳本身只订阅行密度(useDensity,一个枚举值),不订阅其它偏好。
 */
function MarketFeed({ symbol, initialInstruments, transportMode }: { symbol: string; initialInstruments: InstrumentListItem[]; transportMode?: TransportMode }) {
  const { interval } = usePrefs();
  return <MarketProvider symbol={symbol} interval={interval} initialInstruments={initialInstruments} transportMode={transportMode} />;
}

/**
 * 终端根容器、布局网格与键盘分发(计划 §3.1、§3.6、§4.1.5、§4.7、§6.1 SSR 首屏规则):
 *   - 根 <div data-terminal data-glass="off">:terminal.css 的网格 / 断点只匹配它;data-glass="off" 让 dark 下的面板不透明、
 *     液态玻璃折射跳过整棵子树;挂载时写 html[data-starfield="static"](星空画一帧就停 rAF),卸载删掉;
 *     data-density(偏好 comfortable | compact,useDensity 只订阅这一项:服务端与水合首帧 comfortable)让 terminal.css 把行高 token 换成 20 px;
 *   - symbol = symbolFromPath(usePathname()) ?? props.symbol:换标的走 switchSymbol 的 replaceState,不走 RSC,本组件不重挂载;
 *   - 渲染期零 store 访问:头部、左栏、碳元数据的首屏由 initialInstruments 画(组件内部 store 值 ?? props 值),本组件不订阅任何行情,
 *     偏好也只订阅 density(周期 / 页签 / 盘口档数变化不重渲染壳,见 MarketFeed 上方的说明);
 *   - 面板(§3.1 组件树):ChartPanel(图表库在它内部 next/dynamic 懒加载)、OrderBookPanel、TradesTape、OrderPanel、
 *     CarbonMetaPanel、BottomTabs、头部的 VintageSelector;除图表外都自带 <section data-area>;
 *   - MarketProvider(唯一挂 transport 与 usePolling 的地方)等水合完成才挂(经 MarketFeed 显式传 interval):
 *     它第一次渲染就读到 localStorage 里的偏好,不会先按服务端快照的默认 1m 订阅、拉一次 K 线再改订;
 *   - useTerminalLayout():服务端快照恒 desktop;桌面 / 平板差异全在 CSS,只有 mobile 把面板换进 MobileTabs 的页签面板(页签由本组件持有,
 *     快捷键也能切);MobileTabs 的页签条不看 layout、总在 HTML 里(≥ 48rem 由 terminal.css 隐藏),根上的 data-mobile-tab
 *     让手机的 SSR 首帧只露当前页签的那几块面板 —— 首帧与水合后的手机子树同高同位,无布局偏移(P1-25f);
 *   - 左栏在 < 80rem 是模态抽屉:头部开关、抽屉内关闭按钮、遮罩、Esc 关闭,其余面板 inert、Tab 困在抽屉里,换标的后自动收起;
 *   - 快捷键(hotkeys.ts 的 HOTKEYS / matchHotkey):window 上一个 keydown 监听,只在 pointer: fine 时分发;见下方 effect 的说明;
 *   - ?perf=1 的 PerfHud 由 PerfHudGate 挂在根下(不在头部里,见 PerfHud.tsx);
 *   - 重渲染边界:本组件的状态(帮助框 helpOpen、手机页签 mobileTab、抽屉 drawerOpen)变化会重渲染本组件,但各面板元素
 *     (头部、左栏、图表、盘口、成交、下单、碳元数据、底部 Tab、vintage chip)都经 useMemo 按各自用到的值记忆 ——
 *     元素引用不变,React 跳过整棵子树;所以按 ? 或切手机页签只提交帮助框 / 页签本身,面板不重渲染(计划 §3.1
 *     「只在 pathname / layout 变化时重渲染」的面板那一半)。
 */
export function TerminalShell({ symbol: propSymbol, initialInstruments, initialSide, initialFilters = NO_FILTERS, transportMode }: TerminalShellProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const pathname = usePathname();
  const symbol = symbolFromPath(pathname) ?? propSymbol;
  const layout = useTerminalLayout();
  const density = useDensity();
  const hydrated = useHydrated();
  const drawerId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const instrumentsRef = useRef<InstrumentPanelHandle>(null);

  const initial = useMemo(() => initialInstruments.find((item) => item.instrument.symbol === symbol), [initialInstruments, symbol]);

  const [mobileTab, setMobileTab] = useState<MobileTab>(() => initialMobileTab(initialSide));
  const [helpOpen, setHelpOpen] = useState(false);
  const handleCloseHelp = useCallback(() => setHelpOpen(false), []);

  // 抽屉:换标的后收起(渲染期按上一次的 symbol 调整状态,不走 effect)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSymbol, setDrawerSymbol] = useState(symbol);
  if (drawerSymbol !== symbol) {
    setDrawerSymbol(symbol);
    setDrawerOpen(false);
  }
  const handleToggleDrawer = useCallback(() => {
    const docked = drawerDocked();
    setDrawerOpen((open) => !open && !docked);
  }, []);
  const handleCloseDrawer = useCallback(() => setDrawerOpen(false), []);

  // 星空静态:终端内不跑 30 fps 的星空 rAF,离开终端恢复
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.starfield = "static";
    return () => {
      delete root.dataset.starfield;
    };
  }, []);

  // 抽屉(< 80rem)是模态的,视觉(全屏遮罩)与语义(role="dialog" aria-modal)一致:
  //   - 打开:终端根下除抽屉与遮罩之外的子节点设 inert(Tab、读屏、指针都进不去),焦点移进抽屉,
  //     Tab / Shift+Tab 在「抽屉里的可聚焦元素 + 遮罩按钮」之间循环,不漏到根外的页脚;
  //   - Esc、抽屉里的关闭按钮或点遮罩关闭;关闭后焦点还给头部的开关;
  //   - 打开期间视口变到 ≥ 80rem(左栏回到网格)就直接收起,不留一层 inert;
  //   - layout 变化(跨 48rem 换子树)时重跑一遍,新挂上的面板也被 inert。
  // Esc 关抽屉留在这里(不走快捷键分发):它是模态层的基本可达性,触屏 + 外接键盘也要能用。
  const wasOpen = useRef(false);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!drawerOpen) {
      if (wasOpen.current) root.querySelector<HTMLElement>("[data-drawer-toggle]")?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    const drawer = root.querySelector<HTMLElement>('[data-area="instruments"]');
    const scrim = root.querySelector<HTMLElement>("[data-drawer-scrim]");
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(root.children)) {
      if (!(child instanceof HTMLElement) || child === drawer || child === scrim || child.inert) continue;
      child.inert = true;
      inerted.push(child);
    }
    if (drawer && !drawer.contains(document.activeElement)) drawer.focus();

    const focusables = (): HTMLElement[] => {
      const inside = drawer ? Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      return [...inside, ...(scrim ? [scrim] : [])].filter((el) => el.getClientRects().length > 0);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // 抽屉上面又开了对话框(按 ? 打开的快捷键帮助):Esc 与 Tab 归对话框,不关抽屉、不把焦点拽回抽屉
      if (e.target instanceof Element && e.target.closest("dialog")) return;
      if (e.key === "Escape") {
        setDrawerOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const target = trapFocusTarget(focusables(), active, e.shiftKey);
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    const docked = window.matchMedia(DRAWER_DOCKED_QUERY);
    const onDockedChange = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    docked.addEventListener("change", onDockedChange);
    return () => {
      for (const el of inerted) el.inert = false;
      window.removeEventListener("keydown", onKeyDown);
      docked.removeEventListener("change", onDockedChange);
    };
  }, [drawerOpen, layout]);

  // 键盘快捷键(计划 §3.6):window 冒泡阶段一个 keydown 监听,matchHotkey 判定、这里分发。
  //   - 已被别人处理的(defaultPrevented:撤单武装的 Esc 在捕获阶段、搜索框清字的 Esc 已停止冒泡)、焦点在对话框里的
  //     (确认框 / 成交详情 / 帮助:Enter 与 Esc 归对话框自己)不分发;
  //   - 搜索框里按 Enter:InstrumentPanel.selectFirstMatch() 选中当前筛选结果的第一条(按面板的过滤数据,不看 DOM;
  //     键盘流程「/ 搜索 → Enter 选标的」);不算快捷键,触屏的软键盘回车也生效;搜索框为空或没有匹配时不处理;
  //   - 其余只在 pointer: fine 时分发;自动重复的按键只给价格步进;抽屉开着时只放行找标的、帮助与 Esc;
  //   - / 与 Ctrl/Cmd+K:与头部开关同一个判断(≥ 80rem 不开抽屉,直接聚焦搜索框;否则先开抽屉,下一帧再聚焦 ——
  //     抽屉关着时搜索框不可见,focusInstrumentSearch 会失败);
  //   - b / s:marketActions.setDraft({ symbol, side, price: undefined })(下单面板按种子切方向;显式清掉 price,
  //     不沿用上一次盘口点价的价格);
  //   - l / m:点下单面板里 data-order-type="LIMIT" / "MARKET" 的按钮,l 之后焦点进价格框;
  //   - ↑ ↓(Shift ×10):只在价格框里,nudgePrice 按 tickSize 步进,经受控 input 的 setter + input 事件交给面板的 onChange;
  //   - Enter(价格框):交给表单原生的隐式提交(= 点「核对订单」),不 preventDefault;再按一次 Enter 由确认框的初始焦点接住;
  //   - 1–7:selectChartTab(CHART_TABS[n-1])(分时 / 1m / 5m / 15m / 1h / 4h / 1d);
  //   - ?:打开 KeyboardShortcutsHelp;Esc:关帮助(对话框自己也会关;抽屉的 Esc 在上面的 effect 里);
  //   - 手机布局下,下单相关的键切到「下单」页签、周期键切到「图表」页签;面板刚挂上时 DOM 操作推到下一帧。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const pointer = window.matchMedia(HOTKEY_POINTER_QUERY);
    const isMobile = layout === "mobile";

    const orderArea = (): HTMLElement | null => root.querySelector<HTMLElement>('[data-area="order"]');
    const priceField = (): HTMLInputElement | null => orderArea()?.querySelector<HTMLInputElement>("input[data-price-field]") ?? null;
    /** 手机布局下切到这个动作要的页签(mobileTabFor);返回 true = 刚切过去,那个页签的面板要等 React 提交后才在 DOM 里 */
    const showTabFor = (action: HotkeyAction): boolean => {
      const tab = isMobile ? mobileTabFor(action) : null;
      if (!tab || tab === mobileTab) return false;
      setMobileTab(tab);
      return true;
    };
    const clickOrderType = (type: OrderType) => {
      orderArea()?.querySelector<HTMLButtonElement>(`button[data-order-type="${type}"]`)?.click();
      // 点击触发的是面板本地 reducer 的更新,限价时价格框要等提交后才解除 disabled:下一帧再聚焦
      if (type === "LIMIT") {
        requestAnimationFrame(() => {
          const input = priceField();
          if (!input || input.disabled) return;
          input.focus();
          input.select();
        });
      }
    };
    const nudge = (input: HTMLInputElement, ticks: number) => {
      const state = useMarketStore.getState();
      const instrument = state.instruments[symbol] ?? initial?.instrument;
      const fallback = state.tickers[symbol]?.lastPrice ?? instrument?.lastPrice ?? null;
      const next = nudgePrice(input.value, ticks, { tickSize: instrument?.tickSize ?? 1, pricePrecision: instrument?.pricePrecision ?? 2 }, fallback);
      if (next !== null && next !== input.value) setInputValue(input, next);
    };
    /** 返回 true = 选中了一个标的(调用方 preventDefault) */
    const pickFirstInstrument = (): boolean => {
      const picked = instrumentsRef.current?.selectFirstMatch() ?? null; // switchSymbol(replaceState,不走 RSC)
      if (picked === null) return false;
      // 抽屉:关上,焦点回到头部开关(选中的就是当前标的时 symbol 不变,抽屉不会自己收起,所以这里显式关);
      // 网格左栏:焦点落到选中的那一行;那一行不在可视区(虚拟列表没渲染它)时只让出搜索框 —— 两种情况单键快捷键都接着能用
      if (drawerOpen) setDrawerOpen(false);
      else {
        const row = root.querySelector<HTMLElement>(`[data-area="instruments"] [data-symbol="${CSS.escape(picked)}"] a[href]`);
        if (row) row.focus();
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
      return true;
    };

    /** 分发一个动作;返回 true = 已处理(调用方 preventDefault) */
    const handleHotkey = (action: HotkeyAction, target: EventTarget | null): boolean => {
      switch (action) {
        case "focusSearch":
          if (drawerOpen || drawerDocked()) focusInstrumentSearch();
          else {
            setDrawerOpen(true);
            requestAnimationFrame(() => focusInstrumentSearch());
          }
          return true;
        case "sideBuy":
        case "sideSell":
          marketActions.setDraft({ symbol, side: action === "sideBuy" ? "BUY" : "SELL", price: undefined });
          showTabFor(action); // 种子按 nonce 消费,下单面板晚一步挂载也照样收到
          return true;
        case "typeLimit":
        case "typeMarket": {
          const run = () => clickOrderType(action === "typeLimit" ? "LIMIT" : "MARKET");
          if (showTabFor(action)) requestAnimationFrame(run);
          else run();
          return true;
        }
        case "priceUp":
        case "priceDown":
        case "priceUp10":
        case "priceDown10":
          if (target instanceof HTMLInputElement) nudge(target, action === "priceUp" ? 1 : action === "priceDown" ? -1 : action === "priceUp10" ? 10 : -10);
          return true;
        case "review":
          return false;
        case "cancelDialog":
          setHelpOpen(false);
          return false;
        case "help":
          setHelpOpen(true);
          return true;
        default: {
          const slot = intervalSlot(action);
          if (slot === null) return false;
          selectChartTab(CHART_TABS[slot]); // 只写偏好与模块级的分时开关,不碰 DOM:图表页签没挂载也照样生效
          showTabFor(action);
          return true;
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest("dialog")) return;
      const plainKey = !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === "Enter" && plainKey && target instanceof HTMLInputElement && target.id === INSTRUMENT_SEARCH_ID) {
        if (pickFirstInstrument()) e.preventDefault();
        return;
      }
      if (!pointer.matches) return;
      const action = matchHotkey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, isComposing: e.isComposing, target });
      if (!action) return;
      const stepping = action === "priceUp" || action === "priceDown" || action === "priceUp10" || action === "priceDown10";
      if (e.repeat && !stepping) return;
      if (drawerOpen && !hotkeyAllowedWithDrawer(action)) return;
      if (handleHotkey(action, e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [symbol, initial, layout, mobileTab, drawerOpen]);

  // 面板元素按各自用到的值记忆(见组件注释「重渲染边界」):helpOpen / mobileTab / drawerOpen 变化时引用不变,子树整棵跳过
  const chart = useMemo(
    () => (
      <PanelFrame area="chart" title={t.chart.title}>
        <ChartPanel symbol={symbol} />
      </PanelFrame>
    ),
    [t.chart.title, symbol],
  );
  // 手机布局:点价之后切到「下单」页签(草稿已写入,下单面板挂载时按 nonce 消费);桌面 / 平板下单框就在旁边,不传。
  // 切页签会卸载盘口面板:先记下焦点在不在面板里,focusAfterBookPick 决定下一帧(新页签已提交)把焦点交给选中的页签按钮。
  // 再把价格框滚到视口中间:用户在盘口页签往下滚过,切过去时表单可能停在视口之上,带入的价格就看不见 ——
  // 所以有价格框时交焦点不滚动(页签条在顶上),没有价格框(未登录的 LoginGate)时让焦点自己把页签滚进视口。
  const bookPickTab = tabAfterBookPick(layout);
  const handleBookPicked = useCallback(() => {
    if (!bookPickTab) return;
    const active = document.activeElement;
    const panel = rootRef.current?.querySelector('[data-area="mobile-panel"]');
    const focus: BookPickFocus = !active || active === document.body ? "body" : panel?.contains(active) ? "inPanel" : "elsewhere";
    const focusTarget = focusAfterBookPick(bookPickTab, focus);
    setMobileTab(bookPickTab);
    requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const priceField = root.querySelector<HTMLElement>('[data-area="order"] [data-price-field]');
      if (focusTarget === "selectedTab") {
        root.querySelector<HTMLElement>('[data-area="mobile-tabs"] [role="tab"][aria-selected="true"]')?.focus({ preventScroll: priceField !== null });
      }
      priceField?.scrollIntoView({ block: "center" });
    });
  }, [bookPickTab]);
  const book = useMemo(
    () => <OrderBookPanel symbol={symbol} onPicked={bookPickTab ? handleBookPicked : undefined} />,
    [symbol, bookPickTab, handleBookPicked],
  );
  const tape = useMemo(() => <TradesTape symbol={symbol} />, [symbol]);
  const order = useMemo(() => <OrderPanel symbol={symbol} initialSide={initialSide} />, [symbol, initialSide]);
  const meta = useMemo(() => <CarbonMetaPanel symbol={symbol} initial={initial?.instrument} />, [symbol, initial]);
  const tabs = useMemo(() => <BottomTabs symbol={symbol} />, [symbol]);
  const projectId = initial?.instrument.projectId ?? null;
  const vintages = useMemo(
    () => <VintageSelector projectId={projectId} current={symbol} initialItems={initialInstruments} />,
    [projectId, symbol, initialInstruments],
  );
  const feed = useMemo(
    () => (hydrated ? <MarketFeed symbol={symbol} initialInstruments={initialInstruments} transportMode={transportMode} /> : null),
    [hydrated, symbol, initialInstruments, transportMode],
  );
  const header = useMemo(
    () => (
      <TerminalHeader
        symbol={symbol}
        initial={initial}
        vintageSlot={vintages}
        instrumentsOpen={drawerOpen}
        instrumentsId={drawerId}
        onToggleInstruments={handleToggleDrawer}
        transportMode={transportMode}
      />
    ),
    [symbol, initial, vintages, drawerOpen, drawerId, handleToggleDrawer, transportMode],
  );
  const instruments = useMemo(
    () => <InstrumentPanel actionsRef={instrumentsRef} symbol={symbol} initialItems={initialInstruments} initialFilters={initialFilters} />,
    [symbol, initialInstruments, initialFilters],
  );
  const mobilePanels = useMemo(
    () => ({
      chart,
      book: (
        <>
          {book}
          {tape}
        </>
      ),
      order: (
        <>
          {order}
          {meta}
          {tabs}
        </>
      ),
    }),
    [chart, book, tape, order, meta, tabs],
  );

  return (
    <div ref={rootRef} data-terminal="" data-glass="off" data-density={density} data-layout={layout} data-mobile-tab={mobileTab} data-drawer={drawerOpen ? "open" : "closed"}>
      {feed}
      {/* 实时通知的 Toast(无渲染输出;列表在 Nav 的铃铛里) */}
      <NoticeToaster />

      {header}

      <aside
        id={drawerId}
        data-area="instruments"
        tabIndex={-1}
        aria-label={t.instruments.title}
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        className="flex flex-col gap-gap focus-visible:outline-none"
      >
        {/* 触屏上遮罩之外唯一可见的关闭方式;≥ 80rem 左栏回到网格时由 terminal.css 隐藏 */}
        <button
          type="button"
          data-drawer-close=""
          aria-label={t.a11y.drawerClose}
          onClick={handleCloseDrawer}
          className="inline-flex min-h-touch shrink-0 items-center gap-1 self-end rounded-control border border-(--terminal-border) bg-(--terminal-panel) px-2 text-t-xs text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1"
        >
          <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
          <span>{ui.close}</span>
        </button>
        <div className="min-h-0 flex-1">{instruments}</div>
      </aside>
      {drawerOpen ? <button type="button" data-drawer-scrim="" aria-label={t.a11y.drawerClose} onClick={handleCloseDrawer} /> : null}

      {/* 页签条总在这里(SSR 首帧就占位,≥ 48rem 由 terminal.css 隐藏);只有手机布局把面板交给它的页签面板 */}
      <MobileTabs symbol={symbol} tab={mobileTab} onTabChange={setMobileTab} panels={layout === "mobile" ? mobilePanels : undefined} />
      {layout === "mobile" ? null : (
        <>
          {chart}
          {book}
          {tape}
          {order}
          {meta}
          {tabs}
        </>
      )}

      {helpOpen ? <KeyboardShortcutsHelp open onClose={handleCloseHelp} /> : null}

      {/* ?perf=1:fixed 的 HUD 挂在根下(不进头部的 sticky 层叠上下文),z-popover 才压得住抽屉与手机底部条 */}
      {PERF_HUD}
    </div>
  );
}
