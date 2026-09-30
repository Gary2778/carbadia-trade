"use client";

import { useT } from "@/i18n/LangProvider";

/**
 * 加载骨架:所有 next/dynamic 的 loading 与 Suspense fallback 统一用它(§4.5)。
 * height="row":rows 条固定 h-row 的横条;height="panel":一块撑满父容器的面板占位(图表懒加载)。
 * 底色 --surface-2 上扫过一道 shimmer(globals.css 的 .t-shimmer:只动 transform,时长 --motion-shimmer),减弱动效下静态。
 */
export function Skeleton({ rows = 3, height = "row", className = "" }: { rows?: number; height?: "row" | "panel"; className?: string }) {
  const ui = useT("ui");
  const bar = "t-shimmer rounded-chip";
  return (
    <div role="status" aria-busy="true" className={`flex flex-col gap-gap ${height === "panel" ? "h-full min-h-touch" : ""} ${className}`}>
      <span className="sr-only">{ui.loading}</span>
      {height === "panel" ? (
        <div className={`${bar} h-full flex-1`} />
      ) : (
        Array.from({ length: rows }, (_, i) => <div key={i} className={`${bar} h-row`} />)
      )}
    </div>
  );
}
