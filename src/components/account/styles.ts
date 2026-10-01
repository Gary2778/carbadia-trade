// 资产页共用的样式片段(只引 token;tokens-only.test.ts 扫描本目录)。

/**
 * 面板:终端的不透明面板色(dark 下经 data-glass="off" 不透明)。资产页的文字一律落在面板上 —— 页面底色 --terminal-bg 只做间隙:
 * 浅色下 --muted(4.49:1)、--warning(4.45:1)在它上面不到 4.5:1,面板上才是对比度门禁量过的底(terminal/contrast.test.ts)。
 */
export const PANEL = "rounded-panel border border-(--terminal-border) bg-(--terminal-panel)";

/** 面板标题行(h2) */
export const PANEL_TITLE = "text-t-md font-semibold text-foreground";

/** 次要按钮 / 链接按钮:手机触控高度,≥ 64rem 收紧 */
export const SECONDARY_BUTTON =
  "inline-flex min-h-touch items-center justify-center rounded-control border border-(--terminal-border) px-3 text-t-sm font-medium text-foreground transition-colors duration-(--motion-fast) hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 lg:min-h-0 lg:py-1.5";
