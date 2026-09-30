"use client";

import { useT } from "@/i18n/LangProvider";

/**
 * 「Demo / 模拟盘」徽标(计划 §3.1;launch-checklist:每一页的 Nav 与终端头部都要带,不得暗示真实市场)。
 * 文案 nav.demoBadge,悬停说明 terminal.demo.tooltip;compact 变体给 Nav(品牌旁),常规变体给 TerminalHeader(与 ConnectionBadge 相邻)。
 * tokens-only:语义色 --warning(固定不随涨跌轴翻转),字号 --text-t-*,圆角 --radius-pill。
 */
export function DemoBadge({ compact = false }: { compact?: boolean }) {
  const nav = useT("nav");
  const terminal = useT("terminal");
  return (
    <span
      data-demo-badge={compact ? "compact" : "regular"}
      title={terminal.demo.tooltip}
      className={`inline-flex shrink-0 select-none items-center whitespace-nowrap rounded-pill border border-warning/40 bg-warning-soft font-semibold uppercase tracking-wider text-warning ${
        compact ? "px-1.5 py-0 text-t-2xs leading-4" : "px-2 py-0.5 text-t-xs leading-4"
      }`}
    >
      {nav.demoBadge}
    </span>
  );
}
