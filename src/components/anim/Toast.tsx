"use client";

import { createContext, useCallback, useContext, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

type ToastItem = { id: number; type: "ok" | "err"; text: string };
type PushToast = (type: "ok" | "err", text: string) => void;

const ToastCtx = createContext<PushToast>(() => {});
export const useToast = () => useContext(ToastCtx);

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const push = useCallback<PushToast>((type, text) => {
    const id = nextId++;
    setToasts((ts) => [...ts, { id, type, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 3200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div role="status" aria-live="polite" className="fixed top-16 end-4 z-50 flex flex-col gap-2 items-end pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, x: 40, scale: 0.95 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 24 }}
              transition={{ type: "spring", stiffness: 320, damping: 26 }}
              className={`glass-overlay px-4 py-2.5 rounded-xl shadow-card border text-sm bg-surface ${
                t.type === "ok" ? "border-up/40 text-up" : "border-down/40 text-down"
              }`}
            >
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}
