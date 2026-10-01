"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { useT } from "@/i18n/LangProvider";

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** 打开后把焦点放到这个元素;缺省落在关闭按钮 */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 说明段落的 id → aria-describedby */
  describedBy?: string;
  /** 终端内默认不透明 --surface-overlay;终端外可加 glass-overlay(§4.5) */
  className?: string;
};

/**
 * 原生 <dialog> 包装:open 才挂载(关闭态不输出任何标记),挂载即 showModal;
 * Esc(cancel 事件)与点背景都走 onClose,open 是唯一真相——组件自己不 close;
 * 卸载时关掉 <dialog> 并把焦点还给打开前的元素。高度不另设:UA 样式表对 dialog:modal 的 max-height
 * 已把它限制在视口内,超出部分在 <dialog> 自身滚动。
 *
 * 原生 close 事件只在 <dialog> 真的处于关闭态时才转成 onClose:清理函数里的 dialog.close() 会排队一个
 * close 事件,StrictMode(dev)清理后立刻重跑 effect 又 showModal,事件到达时 open 已是 true——
 * 那是过期事件,不能把刚打开的对话框关掉;真正的原生关闭(Chrome close watcher 绕过 cancel 的 Esc)
 * 到达时 open 为 false,照常走 onClose。
 */
export function Dialog(props: DialogProps) {
  if (!props.open) return null;
  return <OpenDialog {...props} />;
}

function OpenDialog({ onClose, title, children, initialFocusRef, describedBy, className = "" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const ui = useT("ui");

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    (initialFocusRef?.current ?? dialog.querySelector<HTMLElement>("[data-dialog-close]"))?.focus();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, [initialFocusRef]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={(e) => {
        // open 仍为 true = 清理函数 close() 排队的过期事件(StrictMode 重挂载 / initialFocusRef 变化),忽略
        if (e.currentTarget.open) return;
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      // 窄视口两侧各留 --spacing-gutter,不贴边;背景遮罩走 --scrim token
      className={`fixed inset-0 z-(--z-dialog) m-auto w-[calc(100%_-_2*var(--spacing-gutter))] max-w-lg overflow-auto rounded-dialog border border-border bg-surface-overlay p-0 text-foreground shadow-overlay backdrop:bg-scrim ${className}`}
    >
      <div className="flex flex-col gap-panel p-panel">
        <header className="flex items-start justify-between gap-gap">
          <h2 id={titleId} className="text-t-lg font-semibold leading-t-tight">
            {title}
          </h2>
          <button
            type="button"
            data-dialog-close
            aria-label={ui.dialogClose}
            onClick={onClose}
            className="-m-1 shrink-0 rounded-control p-1 text-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus"
          >
            <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
