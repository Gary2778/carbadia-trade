"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { persistTheme, persistUpDown, readAppearance } from "./appearance-storage";
import { pressThemeButton, pressUpDownButton, type Theme, type UpDown } from "./themeState";

export type { Theme, UpDown };

// 默认浅色(首次访问);dark(星空 + 液态玻璃)要手动切换。
// 唯一的例外是终端:没存过外观时 /trade 前缀按 dark 呈现,但不写入存储(见 defaultThemeFor)。
const DEFAULT_THEME: Theme = "light";
const DEFAULT_UPDOWN: UpDown = "green-up";

type ThemeCtx = {
  /** 当前外观:"light" | "dark";日 / 月按钮画的就是它 */
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  /** 涨跌轴:green-up(默认)| red-up;只翻方向色(--up / --down),语义色(--danger 等)不动 */
  upDown: UpDown;
  toggleUpDown: () => void;
};
const Ctx = createContext<ThemeCtx>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggle: () => {},
  upDown: DEFAULT_UPDOWN,
  toggleUpDown: () => {},
});

// <html data-theme>:globals.css 的 [data-theme="dark"] 规则按它换肤
function paint(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

// <html data-updown>:globals.css 末尾的 html[data-updown="red-up"] 只换 --up / --down 的指向
function paintUpDown(upDown: UpDown) {
  document.documentElement.dataset.updown = upDown;
}

/**
 * 主题在 SSR/首帧始终按默认浅色渲染(与 layout 上 data-theme="light" 一致),
 * 避免水合不匹配;layout 里的内联脚本会在首帧绘制前按 localStorage 与 pathname 纠正 CSS 主题,
 * 挂载后这里再同步 React 状态。换页(usePathname 变化)时按同一规则重算:
 * 没存过外观的用户进 /trade 变 dark、离开即回 light;点过日 / 月按钮的用户按存的走(存储不可用时按本次会话记下的,
 * 见 appearance-storage.ts)。本模块只导出组件与 hook(存储函数不放这里:非组件导出会让本文件成为整页刷新的 Fast Refresh 边界)。
 * 重算放在 layout effect 里:软导航进出 /trade 时,新页面与 html[data-theme] 在同一帧提交、浏览器绘制之前就改好 ——
 * 普通 effect 在绘制之后才跑,终端会先以浅色 token 闪一帧(离开时反过来闪一帧深色)。layout effect 不在服务端运行,
 * 水合那一次渲染仍是默认值、与服务端 HTML 一致;effect 里的 setState 在绘制前同步重渲染,不产生水合不一致。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [upDown, setUpDown] = useState<UpDown>(DEFAULT_UPDOWN);

  useLayoutEffect(() => {
    const stored = readAppearance(pathname);
    paint(stored.theme);
    paintUpDown(stored.upDown);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合安全模式:SSR 按默认值渲染,挂载后才能读 localStorage 纠正
    setThemeState(stored.theme);
    setUpDown(stored.upDown);
  }, [pathname]);

  // context value 只随 theme / upDown 变:换页(pathname 变化)时 ThemeProvider 会重渲染,
  // 每次新建对象会让所有 useTheme() 的消费者(终端头部的 UpDownToggle、Nav 的开关)跟着重渲染
  const value = useMemo<ThemeCtx>(() => {
    // 用户的显式选择:写 DOM + 持久化(终端派生的 dark 到日 / 月按钮这里才变成存储值)
    const commit = (next: Theme) => {
      setThemeState(next);
      paint(next);
      persistTheme(next);
    };
    const commitUpDown = (next: UpDown) => {
      setUpDown(next);
      paintUpDown(next);
      persistUpDown(next);
    };
    return {
      theme,
      setTheme: commit,
      toggle: () => commit(pressThemeButton(theme)),
      upDown,
      toggleUpDown: () => commitUpDown(pressUpDownButton(upDown)),
    };
  }, [theme, upDown]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
