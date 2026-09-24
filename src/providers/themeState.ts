// 三种外观的状态:浅色 / dark(星空 + 液态玻璃)/ 儿童护眼模式(第一版的手绘夜空)。
// base 记「不开儿童护眼时用哪个」,kids 是儿童护眼的开关;看到的外观 = kids ? 儿童护眼 : base。
// 这里只有纯函数;读写 localStorage 与 DOM 在 ThemeProvider.tsx。

export type Theme = "light" | "dark";
export type ThemeState = { base: Theme; kids: boolean };

export const THEME_KEY = "carbadia-theme"; // "light" | "dark",语义与只有两种外观时相同
export const KIDS_KEY = "carbadia-kids"; // "1" = 开;关掉时删除

export function readThemeState(theme: string | null, kids: string | null): ThemeState {
  return { base: theme === "dark" ? "dark" : "light", kids: kids === "1" };
}

/** 实际色系:儿童护眼模式是深色系,现有的深色适配对它同样生效 */
export function effectiveTheme({ base, kids }: ThemeState): Theme {
  return kids ? "dark" : base;
}

/** 日 / 月按钮:平时在浅色与 dark 之间切;儿童护眼开着时是「回去」,回到图标画的那个 */
export function pressThemeButton({ base, kids }: ThemeState): ThemeState {
  return kids ? { base, kids: false } : { base: base === "dark" ? "light" : "dark", kids: false };
}

/** 儿童护眼按钮:开 / 关,不动底下记着的那个 */
export function pressKidsButton({ base, kids }: ThemeState): ThemeState {
  return { base, kids: !kids };
}
