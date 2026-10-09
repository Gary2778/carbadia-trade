"use client";

import { useT } from "@/i18n/LangProvider";

/**
 * 错误态:role="alert" 即时播报;语义色 --danger 不随涨跌轴翻转;有 onRetry 才出按钮(文案缺省 ui.retry,retryLabel 可换,如「刷新页面」)。
 * 触屏上按钮至少 44 px 高(pointer-coarse:min-h-touch)
 */
export function ErrorState({ message, onRetry, retryLabel }: { message: string; onRetry?: () => void; retryLabel?: string }) {
  const ui = useT("ui");
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-gap rounded-panel bg-danger-soft p-panel text-center text-t-sm text-danger">
      <p>{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-control border border-danger/40 px-3 py-1.5 text-t-xs font-medium hover:bg-danger/10 focus-visible:outline-none focus-visible:shadow-focus pointer-coarse:min-h-touch"
        >
          {retryLabel ?? ui.retry}
        </button>
      ) : null}
    </div>
  );
}
