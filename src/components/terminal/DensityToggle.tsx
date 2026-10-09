"use client";

import { useT } from "@/i18n/LangProvider";
import { useDensity, writePrefs } from "@/lib/market/prefs";

/**
 * 紧凑行高开关(计划 §6.3.2 C8):盘口、成交、各页签与标的列表的行从 22 px 收到 20 px。
 * 偏好 density 存在 carbadia-terminal-prefs(writePrefs),TerminalShell 的 data-density 把行高 token 换成 --spacing-row-dense;
 * 触屏的 44 px 行不受影响。aria-pressed 表示「开着紧凑」;服务端与水合首帧是 comfortable(未按下),挂载后读存储。
 * 只有图标:头部右侧的位置很紧(英文 1440 宽时时区选择 + 涨跌颜色之后只剩约 70 px,加文字会把整组挤到第二行),
 * 名称在 aria-label 与 title 里;图标画的就是当前密度(三道宽松的线 / 五道紧的线)。
 * 触控目标:< 64rem(手机、平板)min-h-touch 与 min-w-touch(只有图标,宽度也要 44 px),≥ 64rem 收回紧凑尺寸(计划 §4.7);
 * py-1 让图标按钮与旁边带文字的开关一样高(22 px)。
 */
export function DensityToggle() {
  const t = useT("terminal");
  const compact = useDensity() === "compact";
  return (
    <button
      type="button"
      aria-pressed={compact}
      aria-label={t.header.density}
      title={t.header.density}
      data-density-toggle={compact ? "compact" : "comfortable"}
      onClick={() => writePrefs({ density: compact ? "comfortable" : "compact" })}
      className={`inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center rounded-control border border-(--terminal-border) px-2 py-1 lg:min-h-0 lg:min-w-0 transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
        compact ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
      }`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d={compact ? "M2.5 2.5h11M2.5 5.25h11M2.5 8h11M2.5 10.75h11M2.5 13.5h11" : "M2.5 3.5h11M2.5 8h11M2.5 12.5h11"} />
      </svg>
    </button>
  );
}
