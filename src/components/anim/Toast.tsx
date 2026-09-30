"use client";

import { createContext, useCallback, useContext, useEffect, useReducer } from "react";
import { AnimatePresence, motion } from "motion/react";
import { INITIAL_TOAST_QUEUE, nextExpiry, reduceToastQueue, splitToastRegions, type ToastItem, type ToastOptions, type ToastType } from "./toast-queue";

export type { ToastAction, ToastOptions, ToastType } from "./toast-queue";

/** 旧调用 toast("ok", text) 原样兼容;新类型与 opts 只在终端使用(§9.1 第 33 条) */
export type PushToast = (type: ToastType, text: string, opts?: ToastOptions) => void;

const ToastCtx = createContext<PushToast>(() => {});
export const useToast = () => useContext(ToastCtx);

// 语义色固定不随涨跌轴翻转(§4.1.2):ok/err 不再借用 --up/--down
const TONE: Record<ToastType, string> = {
  ok: "border-success/40 text-success",
  err: "border-danger/40 text-danger",
  info: "border-info/40 text-info",
  warning: "border-warning/40 text-warning",
};

/** 一个区域里的条目:条目本身不带 role / aria-live(播报由所在区域负责,见 ToastRegions) */
function ToastList({ items, onDismiss }: { items: readonly ToastItem[]; onDismiss: (id: number) => void }) {
  return (
    <AnimatePresence>
      {items.map((item) => (
        <motion.div
          key={item.id}
          initial={{ opacity: 0, x: 40, scale: 0.95 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ type: "spring", stiffness: 320, damping: 26 }}
          className={`glass-overlay pointer-events-auto flex items-center gap-3 px-4 py-2.5 rounded-dialog shadow-card border text-sm bg-surface ${TONE[item.type]}`}
        >
          <span>{item.text}</span>
          {item.action ? (
            <button
              type="button"
              onClick={() => {
                item.action?.onClick();
                onDismiss(item.id);
              }}
              className="shrink-0 rounded-control border border-current px-2 py-0.5 text-t-xs font-medium hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-focus"
            >
              {item.action.label}
            </button>
          ) : null}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/**
 * 两个常驻 live region(§4.5:ok / info role="status" 礼貌播报,err / warning role="alert" 打断播报),不嵌套:
 *   - 区域常驻在 DOM 里(空的时候也在),新插入的条目才会被可靠地播报 —— 动态插入一个自带 role="status" 的节点,
 *     多数读屏不当作 live 变更;
 *   - 角色只在区域上,条目不带角色:原来外层 polite 容器里再套 role="status" / "alert" 的条目,读屏可能读两遍;
 *   - aria-atomic="false":只读新增的那一条(role=status / alert 默认 atomic,会把整个区域重读一遍);
 *   - 视觉上同一列:打断类(错误、警告)在上,状态类在下,各自按队列顺序;dedupeKey 刷新改了类型的条目换到对应区域。
 */
export function ToastRegions({ items, onDismiss }: { items: readonly ToastItem[]; onDismiss: (id: number) => void }) {
  const regions = splitToastRegions(items);
  return (
    <div className="fixed top-16 end-4 z-(--z-toast) flex flex-col items-end pointer-events-none">
      <div role="alert" aria-live="assertive" aria-atomic="false" className="flex flex-col items-end gap-2 [&:not(:empty)]:mb-2">
        <ToastList items={regions.alert} onDismiss={onDismiss} />
      </div>
      <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-col items-end gap-2">
        <ToastList items={regions.status} onDismiss={onDismiss} />
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [queue, dispatch] = useReducer(reduceToastQueue, INITIAL_TOAST_QUEUE);

  const push = useCallback<PushToast>((type, text, opts) => {
    dispatch({ kind: "push", type, text, opts, now: Date.now() });
  }, []);
  const dismiss = useCallback((id: number) => dispatch({ kind: "dismiss", id }), []);

  // 单个计时器:队列每变一次,只对最近的到期时刻设一次 setTimeout;到点清扫,
  // 被 dedupeKey 刷新过的条目到期时刻已后移,自然留下,再由下一轮计时器处理。
  // 计时器就是为 at 这一刻布的,回调里把 now 钳到不小于 at:墙钟往回拨、或降精度的 Date.now()
  // 落在 at 之前时,reducer 才不会「无变化」返回同引用——那样 effect 不再执行,队列会一直挂着。
  useEffect(() => {
    const at = nextExpiry(queue);
    if (at === null) return;
    const timer = setTimeout(() => dispatch({ kind: "expire", now: Math.max(Date.now(), at) }), Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [queue]);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <ToastRegions items={queue.items} onDismiss={dismiss} />
    </ToastCtx.Provider>
  );
}
