"use client";

import { useTheme } from "@/providers/ThemeProvider";
import { useT } from "@/i18n/LangProvider";

// 日 / 月按钮:在浅色与 dark 之间切;图标画的是当前外观(太阳 = 浅色,月亮 = dark)。
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  const tx = useT("themeToggle");
  const label = dark ? tx.toLight : tx.toDark;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={dark}
      className="glass-control grid h-10 w-10 shrink-0 cursor-pointer place-items-center rounded-full bg-transparent text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:h-9 md:w-9"
    >
      <span aria-hidden>
        {dark ? (
          // 弯月
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
              fill="#ffe9a8"
              stroke="#e8c96a"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          // 太阳
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="4.4" fill="#f5a623" />
            <g stroke="#f5a623" strokeWidth="1.8" strokeLinecap="round">
              <path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4M5 5l1.7 1.7M17.3 17.3 19 19M19 5l-1.7 1.7M6.7 17.3 5 19" />
            </g>
          </svg>
        )}
      </span>
    </button>
  );
}
