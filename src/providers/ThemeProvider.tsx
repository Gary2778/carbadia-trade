"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { KIDS_KEY, THEME_KEY, effectiveTheme, pressKidsButton, pressThemeButton, readThemeState, type Theme, type ThemeState } from "./themeState";

export type { Theme };

// 默认浅色（首次访问）；dark（星空 + 液态玻璃）与儿童护眼模式（手绘夜空）都要手动切换
const DEFAULT_STATE: ThemeState = { base: "light", kids: false };

type ThemeCtx = {
  /** 实际色系:儿童护眼模式也是 "dark",现有的深色适配(Ransom 标题等)对它同样生效 */
  theme: Theme;
  /** 儿童护眼模式是否开着 */
  kids: boolean;
  /** 不开儿童护眼时用的那个;日 / 月按钮画的就是它 */
  baseTheme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  toggleKids: () => void;
};
const Ctx = createContext<ThemeCtx>({ theme: "light", kids: false, baseTheme: "light", setTheme: () => {}, toggle: () => {}, toggleKids: () => {} });

// <html data-theme> 只表示色系;儿童护眼再多挂一个 data-kids,样式里用它区分两种深色外观
function paint(state: ThemeState) {
  const root = document.documentElement;
  const theme = effectiveTheme(state);
  root.dataset.theme = theme;
  if (state.kids) root.dataset.kids = "true";
  else delete root.dataset.kids;
  root.style.colorScheme = theme;
}

function persist(state: ThemeState) {
  try {
    localStorage.setItem(THEME_KEY, state.base);
    if (state.kids) localStorage.setItem(KIDS_KEY, "1");
    else localStorage.removeItem(KIDS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 主题在 SSR/首帧始终按默认浅色渲染（与 layout 上 data-theme="light" 一致），
 * 避免水合不匹配；layout 里的内联脚本会在首帧绘制前按 localStorage 纠正 CSS 主题，
 * 挂载后这里再同步 React 状态。
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ThemeState>(DEFAULT_STATE);

  // 挂载后读取偏好（SSR/首帧按默认浅色，缺省时无需 setState，避免无谓重渲染）
  useEffect(() => {
    let saved = DEFAULT_STATE;
    try {
      saved = readThemeState(localStorage.getItem(THEME_KEY), localStorage.getItem(KIDS_KEY));
    } catch {
      /* ignore */
    }
    if (saved.base === DEFAULT_STATE.base && saved.kids === DEFAULT_STATE.kids) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合安全模式:SSR 按默认值渲染,挂载后才能读 localStorage 纠正
    setState(saved);
    paint(saved);
  }, []);

  const commit = (next: ThemeState) => {
    setState(next);
    paint(next);
    persist(next);
  };

  return (
    <Ctx.Provider
      value={{
        theme: effectiveTheme(state),
        kids: state.kids,
        baseTheme: state.base,
        setTheme: (t) => commit({ base: t, kids: false }),
        toggle: () => commit(pressThemeButton(state)),
        toggleKids: () => commit(pressKidsButton(state)),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useTheme = () => useContext(Ctx);
