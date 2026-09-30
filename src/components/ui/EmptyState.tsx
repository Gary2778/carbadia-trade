"use client";

import type { ReactNode } from "react";
import { useT } from "@/i18n/LangProvider";

/** 空态:title 缺省为 ui.empty;hint 是一行灰字说明;action 是可选的入口(Link / 按钮)插槽 */
export function EmptyState({ title, hint, action }: { title?: string; hint?: string; action?: ReactNode }) {
  const ui = useT("ui");
  return (
    <div className="flex flex-col items-center justify-center gap-gap p-panel text-center text-t-sm text-muted">
      <p className="font-medium">{title ?? ui.empty}</p>
      {hint ? <p className="text-t-xs text-muted-2">{hint}</p> : null}
      {action ? <div className="mt-gap">{action}</div> : null}
    </div>
  );
}
