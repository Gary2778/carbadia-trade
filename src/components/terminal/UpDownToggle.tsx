"use client";

import { useT } from "@/i18n/LangProvider";
import { useTheme } from "@/providers/ThemeProvider";

/**
 * 涨跌颜色切换(计划 §4.1.1):绿涨红跌 ⇄ 红涨绿跌,调 ThemeProvider.toggleUpDown(写 <html data-updown> 与 carbadia-updown)。
 * 只翻方向色 --up / --down,错误等语义色不动。服务端与水合首帧 upDown 是默认 green-up(内联脚本已按存储值纠正了 CSS),
 * 挂载后 ThemeProvider 读存储再同步文案。两个小三角用 bg-up / bg-down 画,翻转后自己跟着变色。
 * 触控目标:< 64rem(手机、平板)min-h-touch,≥ 64rem 收回紧凑高度(计划 §4.7)。
 */
export function UpDownToggle() {
  const t = useT("terminal");
  const { upDown, toggleUpDown } = useTheme();
  const current = upDown === "red-up" ? t.header.redUp : t.header.greenUp;
  return (
    <button
      type="button"
      onClick={toggleUpDown}
      data-updown-toggle={upDown}
      title={t.header.upDownLabel}
      className="inline-flex min-h-touch shrink-0 items-center gap-1 whitespace-nowrap rounded-control border border-(--terminal-border) px-2 py-0.5 text-t-xs leading-4 text-muted lg:min-h-0 transition-colors duration-(--motion-fast) hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus"
    >
      <span aria-hidden="true" className="flex flex-col gap-px">
        <svg viewBox="0 0 8 5" className="h-1.5 w-2 fill-up">
          <path d="M4 0l4 5H0z" />
        </svg>
        <svg viewBox="0 0 8 5" className="h-1.5 w-2 fill-down">
          <path d="M4 5L0 0h8z" />
        </svg>
      </span>
      <span className="sr-only">
        {t.header.upDownLabel}
        {" "}
      </span>
      <span>{current}</span>
    </button>
  );
}
