"use client";
// 终端的布局档位(计划 §3.1、§4.7):"desktop"(≥ 64rem;64–80rem 左栏为抽屉,由 CSS 决定)/ "tablet"(48–64rem)/ "mobile"(< 48rem)。
// 桌面 / 平板的差异全部在 terminal.css 的断点里,这个 hook 只决定手机变体挂哪些子树:面板挂进 MobileTabs 的页签面板、加底部买卖条;
// 页签条本身不看它,总在 HTML 里、由 CSS 断点显示(< 48rem),手机的 SSR 首帧就占好位置(P1-25f)。
// useSyncExternalStore(matchMedia):服务端快照与水合首帧恒为 "desktop",与 SSR HTML 一致;挂载后才切到真实档位。
// 断点用 rem 写,与 terminal.css 的 @media (width >= 48rem | 64rem) 同一基准(媒体查询里的 rem 取初始字号)。
import { useSyncExternalStore } from "react";

export type TerminalLayout = "desktop" | "tablet" | "mobile";

const DESKTOP_QUERY = "(min-width: 64rem)";
const TABLET_QUERY = "(min-width: 48rem)";
/** ≥ 80rem 左栏回到网格(terminal.css 同一断点);窄于它才是模态抽屉。TerminalShell 只在事件处理器与 effect 里读 */
export const DRAWER_DOCKED_QUERY = "(min-width: 80rem)";

let queries: { desktop: MediaQueryList; tablet: MediaQueryList } | null = null;
function mediaQueries() {
  if (!queries) queries = { desktop: window.matchMedia(DESKTOP_QUERY), tablet: window.matchMedia(TABLET_QUERY) };
  return queries;
}

/** 纯函数:两条媒体查询的结果 → 档位 */
export function layoutFor(desktop: boolean, tablet: boolean): TerminalLayout {
  if (desktop) return "desktop";
  return tablet ? "tablet" : "mobile";
}

function subscribe(onChange: () => void): () => void {
  const { desktop, tablet } = mediaQueries();
  desktop.addEventListener("change", onChange);
  tablet.addEventListener("change", onChange);
  return () => {
    desktop.removeEventListener("change", onChange);
    tablet.removeEventListener("change", onChange);
  };
}

function getSnapshot(): TerminalLayout {
  const { desktop, tablet } = mediaQueries();
  return layoutFor(desktop.matches, tablet.matches);
}

const getServerSnapshot = (): TerminalLayout => "desktop";

export function useTerminalLayout(): TerminalLayout {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const noopSubscribe = () => () => {};

/**
 * 水合完成之后才为 true(服务端与水合首帧为 false):TerminalShell 用它推迟 MarketProvider 的挂载,
 * 让 MarketProvider 第一次渲染就读到 localStorage 里的偏好(interval 等),不会先按默认 1m 订阅 / 拉一次 K 线再改订。
 * 站内软导航进入终端时没有水合,第一次渲染即为 true。
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}
