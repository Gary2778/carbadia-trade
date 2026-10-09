// 外观的存储读写与按 pathname 的派生(纯模块,不带 "use client"):ThemeProvider.tsx 只导出组件与 hook,
// 这里的函数单独成模块 —— 组件模块混着非组件导出时,dev 下改它的每一次都是整页刷新的 Fast Refresh 边界(P1-25c 复审)。
// 规则本体(键名、defaultThemeFor、readUpDown)仍在 themeState.ts;「存储读不到 / 写不进时怎么办」(两个存取函数与内存兜底)在 appearance-key-storage.ts,
// 本模块照旧导出它们,再加上按 pathname 的派生与显式选择的持久化。
import { readAppearanceKey, writeAppearanceKey } from "./appearance-key-storage";
import { THEME_KEY, UPDOWN_KEY, defaultThemeFor, readUpDown, type Theme, type UpDown } from "./themeState";

export { readAppearanceKey, writeAppearanceKey };

/** 读存储并按 pathname 派生:无存储值时 /trade 前缀 → dark,派生值不写回存储 */
export function readAppearance(pathname: string): { theme: Theme; upDown: UpDown } {
  const theme = readAppearanceKey(THEME_KEY);
  const upDown = readAppearanceKey(UPDOWN_KEY);
  return { theme: defaultThemeFor(pathname, theme), upDown: readUpDown(upDown) };
}

/** 用户显式选择的外观写进存储(点日 / 月按钮;终端派生的 dark 到这里才变成存储值) */
export function persistTheme(theme: Theme): void {
  writeAppearanceKey(THEME_KEY, theme);
}

export function persistUpDown(upDown: UpDown): void {
  writeAppearanceKey(UPDOWN_KEY, upDown);
}
