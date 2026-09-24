"use client";

import { useTheme } from "@/providers/ThemeProvider";
import { useT } from "@/i18n/LangProvider";

// 儿童护眼模式的开关:第一版的手绘夜空(涂鸦星、笑脸弯月、深蓝卡片)。
// 图标是那张月亮上的小笑脸:关着是一圈描线,开着填月亮黄、带腮红。
// 名字要让人看得见:sm 到 xl 之间带文字;≥xl 导航最挤、<sm 是手机,只留图标,名字留在悬停提示与无障碍标签里。
export function KidsModeToggle() {
  const { kids, toggleKids } = useTheme();
  const tx = useT("themeToggle");
  const ink = kids ? "#4a3a12" : "currentColor";

  return (
    <button
      type="button"
      onClick={toggleKids}
      aria-label={kids ? tx.kidsOff : tx.kidsOn}
      aria-pressed={kids}
      title={tx.kidsName}
      className={`glass-control inline-flex h-10 min-w-10 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:h-9 md:min-w-9 ${
        kids ? "bg-[#ffe9a8]/15 text-[#ffe9a8]" : "bg-transparent text-muted hover:text-foreground"
      }`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
        <circle cx="12" cy="12" r="9" fill={kids ? "#ffe9a8" : "none"} stroke={kids ? "#e8c96a" : "currentColor"} strokeWidth="1.6" />
        <circle cx="9" cy="10.4" r="1.15" fill={ink} />
        <circle cx="15" cy="10.4" r="1.15" fill={ink} />
        <path d="M8.3 14c1 1.4 2.2 2.1 3.7 2.1s2.7-.7 3.7-2.1" stroke={ink} strokeWidth="1.6" strokeLinecap="round" />
        {kids && (
          <g fill="#ff9ec4" opacity="0.75">
            <circle cx="6.9" cy="13.3" r="1.25" />
            <circle cx="17.1" cy="13.3" r="1.25" />
          </g>
        )}
      </svg>
      <span className="hidden whitespace-nowrap sm:inline xl:hidden">{tx.kidsName}</span>
    </button>
  );
}
