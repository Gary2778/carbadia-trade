"use client";

import { useId, type ReactNode } from "react";
import { useExchangeText } from "./useExchange";

export function TableViewport({
  label,
  children,
  className = "ex-table-wrap",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const descriptionId = useId();
  const c = useExchangeText();
  return (
    <div
      role="region"
      aria-label={label}
      aria-describedby={descriptionId}
      tabIndex={0}
      className={`${className} focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`}
    >
      <span className="sr-only" id={descriptionId}>
        {c(
          "If columns extend beyond the screen, use the left and right arrow keys to scroll this table.",
          "若字段超出屏幕，可使用左右方向键滚动此表格。",
        )}
      </span>
      {children}
    </div>
  );
}
