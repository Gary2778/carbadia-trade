"use client";

import { useT } from "@/i18n/LangProvider";

/**
 * 「Demo / 模拟盘」徽标(计划 §3.1;launch-checklist:每一页的 Nav 与终端头部都要带,不得暗示真实市场)。
 * 文案 nav.demoBadge,悬停说明 nav.demoTooltip(都在核心包里:Nav 在每个页面都渲染它,终端文案只在 /trade 有);compact 变体给 Nav(品牌旁),常规变体给 TerminalHeader(与 ConnectionBadge 相邻)。
 * tokens-only:语义色 --warning(固定不随涨跌轴翻转),字号 --text-t-*,圆角 --radius-chip(P3-01:全站小圆角,徽标不再是胶囊形)。
 */
export function DemoBadge({ compact = false }: { compact?: boolean }) {
  const nav = useT("nav");
  return (
    <span
      data-demo-badge={compact ? "compact" : "regular"}
      title={nav.demoTooltip}
      className={`inline-flex shrink-0 select-none items-center whitespace-nowrap rounded-chip border border-warning/40 bg-warning-soft font-semibold uppercase tracking-wider text-warning ${
        compact ? "px-1.5 py-0 text-t-2xs leading-4" : "px-2 py-0.5 text-t-xs leading-4"
      }`}
    >
      {nav.demoBadge}
    </span>
  );
}
