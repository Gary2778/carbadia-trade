"use client";

import { usePathname } from "next/navigation";
import { useEffect, useId, useReducer, useRef, useState, type ComponentType } from "react";
import { ErrorState } from "@/components/ui/ErrorState";
import { useT } from "@/i18n/LangProvider";
import { useUnreadNotices } from "@/lib/market/account-store";
import { reducePanelLoad, startPanelLoad } from "./panel-load";

// Nav 里的铃铛(只在登录且账户状态已知后由 Nav 挂上)。铃铛本身随根布局进每个页面的 floor 包,所以只带角标与弹出层的外框;
// 面板(取数、列表、加载更多)在 NoticePanel.tsx,第一次打开时才 import():不用 next/dynamic —— 它的运行时(Loadable、BailoutToCSR)
// 要多带约 1 KB gzip 进每个页面的 floor 包,floor 预算放不下;也不用 React.lazy —— 它缓存失败,chunk 加载失败(断网、部署换代后的旧标签页)
// 之后重试无效,所以自己 import() 并带状态机(panel-load.ts):失败显示 core.notices.error 与重试,重试重新 import();
// 重试也失败(第二次失败)时按钮改成「刷新页面」—— 部署换代后的旧标签页再怎么重试也取不到旧 chunk,只有整页刷新能好。
// 面板只在点开之后才挂载(关闭即卸载,每次打开都重取第一页),服务端渲染与水合都碰不到它,所以不需要 ssr: false。
// 通知句子与面板文案在 notices 文案模块里(notice-copy.ts),随面板 chunk 走,铃铛不引;角标的数来自账户 store
// (me.unreadNotices、WS 的 notice 事件、重订阅 / 回到前台 / 轮询时的重读,见 lib/market/notice-refresh.ts),铃铛自己不发任何请求。
// 弹出层学语言菜单(LanguageToggle):点外面或按 Esc 关闭,Esc 之后焦点回到铃铛;glass-overlay 面,语义圆角。
// < sm 的视口窄,弹出层相对整条导航(固定在两侧各留一个边距),sm 起相对铃铛右对齐。
// 铃铛是右侧控件里的第一个(右对齐的一组向左长出来):登录后才出现的铃铛不会挤动已经在屏幕上的主题 / 语言 / 账户块 / 汉堡。

type PanelProps = { onClose: () => void };
let loadedPanel: ComponentType<PanelProps> | null = null;

/** 面板内容:第一次打开时 import() NoticePanel;失败显示错误与重试(重试重新 import) */
function PanelHost({ onClose }: PanelProps) {
  const t = useT("notices");
  const ui = useT("ui");
  const [load, dispatch] = useReducer(reducePanelLoad, loadedPanel !== null, startPanelLoad);
  // 初值与 setPanel 都要包成函数:组件本身是函数,直接传给 useState 会被当成惰性初始化函数调用
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(() => loadedPanel);

  useEffect(() => {
    if (load.phase !== "loading") return;
    const { attempt } = load;
    let live = true;
    import("./NoticePanel").then(
      (m) => {
        loadedPanel = m.NoticePanel;
        if (!live) return;
        setPanel(() => m.NoticePanel);
        dispatch({ kind: "loaded", attempt });
      },
      () => {
        if (live) dispatch({ kind: "failed", attempt });
      },
    );
    return () => {
      live = false;
    };
  }, [load]);

  if (load.phase === "failed") {
    const first = load.attempt === 0;
    return <ErrorState message={t.error} onRetry={() => (first ? dispatch({ kind: "retry" }) : location.reload())} retryLabel={first ? undefined : t.reload} />;
  }
  if (load.phase === "ready" && Panel) return <Panel onClose={onClose} />;
  return (
    <p role="status" className="px-3 py-2 text-sm text-muted">
      {ui.loading}
    </p>
  );
}

/** 角标上的数:个位数照写,超过 9 写 9+ */
export const badgeText = (unread: number): string => (unread > 9 ? "9+" : String(unread));

export function NoticeBell() {
  const t = useT("notices");
  const unread = useUnreadNotices();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [prevPath, setPrevPath] = useState(pathname);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();

  // 换路径(链接、前进 / 后退)收起 —— 渲染期状态调整,同 Nav 的汉堡菜单
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="sm:relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.bell(unread)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className="relative grid h-11 w-11 shrink-0 place-items-center rounded-full text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {unread > 0 ? (
          <span data-badge="" aria-hidden="true" className="absolute end-1 top-1 grid h-4 min-w-4 place-items-center rounded-chip bg-accent px-1 text-t-2xs font-semibold leading-none text-background">
            {badgeText(unread)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          className="glass-overlay absolute inset-x-4 top-full z-(--z-menu) mt-2 max-h-[min(24rem,calc(100dvh_-_4.5rem))] overflow-y-auto rounded-panel border border-border bg-surface p-1.5 shadow-card sm:inset-x-auto sm:end-0 sm:w-96"
        >
          <h2 id={headingId} className="px-3 pb-1 pt-1.5 text-sm font-semibold text-foreground">
            {t.title}
          </h2>
          <PanelHost onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
