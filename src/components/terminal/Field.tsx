"use client";

import type { ReactNode } from "react";

/** 一个带可见标签的输入格:标签(text-t-xs,muted)在上、控件在下。下单面板、条件单票据与两个条件单对话框共用 */
export function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-t-xs text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}
