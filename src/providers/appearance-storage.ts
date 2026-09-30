// 外观的存储读写与按 pathname 的派生(纯模块,不带 "use client"):ThemeProvider.tsx 只导出组件与 hook,
// 这里的函数单独成模块 —— 组件模块混着非组件导出时,dev 下改它的每一次都是整页刷新的 Fast Refresh 边界(P1-25c 复审)。
// 规则本体(键名、defaultThemeFor、readUpDown)仍在 themeState.ts;本模块只管「存储读不到 / 写不进时怎么办」。
import { THEME_KEY, UPDOWN_KEY, defaultThemeFor, readUpDown, type Theme, type UpDown } from "./themeState";

/**
 * 外观两个键(carbadia-theme / carbadia-updown)写不进存储时的内存值:键 → 该写入的值(null = 删除)。
 * 禁用站点数据(getItem / setItem 都抛 SecurityError)或配额满时,用户点日 / 月、涨跌轴按钮的选择留在这里;
 * 读的时候优先 —— 否则下一次软导航按 pathname 重新派生时读到的是空值(或旧值),选择被撤回(main 只在挂载时读一次存储,
 * 所以内存里的选择能活过软导航)。某个键写成功即清掉它的内存值,以存储为准。模块级:只在浏览器里、用户点按钮时写。
 */
const unsaved = new Map<string, string | null>();

/** 读一个外观键:这次会话写失败过的键取内存值,否则读存储(读抛错 → null) */
export function readAppearanceKey(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 写一个外观键(null = 删除):成功则清掉内存值,抛错(禁用站点数据、配额、没有 localStorage)则记进内存 */
export function writeAppearanceKey(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
}

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
