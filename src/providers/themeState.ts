// 两种外观的状态:浅色 / dark(星空 + 液态玻璃)。
// 这里只有纯函数;读写 localStorage 与 DOM 在 ThemeProvider.tsx / appearance-storage.ts。

export type Theme = "light" | "dark";

export const THEME_KEY = "carbadia-theme"; // "light" | "dark"

/** 读存储值:只认 "dark",其余(含未存、非法值)一律浅色 */
export function readTheme(raw: string | null): Theme {
  return raw === "dark" ? "dark" : "light";
}

/** 日 / 月按钮:在浅色与 dark 之间切 */
export function pressThemeButton(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

// ── 涨跌轴:绿涨红跌 / 红涨绿跌 ──────────────────────────────────
// 只翻方向色(--up / --down 是 --palette-green / --palette-red 的别名),错误、警告等语义色固定不翻。
// 属性挂在 <html data-updown>,由 layout.tsx 的内联脚本在首帧前写、ThemeProvider 挂载后接管。

export type UpDown = "green-up" | "red-up";

export const UPDOWN_KEY = "carbadia-updown"; // "green-up" | "red-up";默认 green-up

/** 读存储值:只认两个合法值,其余(含未存)一律 green-up */
export function readUpDown(raw: string | null): UpDown {
  return raw === "red-up" ? "red-up" : "green-up";
}

/** 涨跌轴按钮:两个值之间翻转 */
export function pressUpDownButton(current: UpDown): UpDown {
  return current === "red-up" ? "green-up" : "red-up";
}

// ── 终端首访默认 dark(不持久化)──────────────────────────────────

/**
 * 没存过外观(storedTheme === null)时,/trade 前缀的页面按 dark 呈现;其余情况与 readTheme 同一规则。
 * 这是派生值,不写 localStorage:无存储值时离开 /trade 即回 light;用户点一次日 / 月按钮才按现状持久化。
 * 三处镜像同一规则:layout.tsx 的 THEME_INIT 内联脚本、ThemeProvider 挂载时、ThemeProvider 监听 pathname 变化时。
 */
export function defaultThemeFor(pathname: string, storedTheme: string | null): Theme {
  if (storedTheme === null && pathname.startsWith("/trade")) return "dark";
  return readTheme(storedTheme);
}
