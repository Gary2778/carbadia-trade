"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useLang, useT } from "@/i18n/LangProvider";
import { LANGS, LANG_META } from "@/i18n/config";

// 语言下拉切换器:英文、简体中文两项,当前项打勾。菜单项用本语言原名(endonym)。
// 桌面/移动共用,点击外部或 Esc 关闭。
export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const t = useT("nav");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.language}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="glass-control flex items-center gap-1.5 rounded-control bg-surface-2 border border-border px-3 py-2 md:px-2.5 md:py-1 text-xs font-medium text-muted hover:text-foreground hover:border-accent/60 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.7 2.6 4 5.8 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.8-4-9s1.3-6.4 4-9Z" />
        </svg>
        {/* 手机上只留地球图标,省出导航空间 */}
        <span className="hidden sm:inline whitespace-nowrap">{LANG_META[lang].label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            aria-label={t.language}
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.16, ease: [0.21, 0.7, 0.3, 1] }}
            className="glass-overlay absolute end-0 top-full mt-2 z-(--z-menu) w-44 rounded-panel border border-border bg-surface shadow-card p-1.5"
          >
            {LANGS.map((code) => {
              const active = code === lang;
              return (
                <li key={code} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => {
                      setLang(code);
                      setOpen(false);
                    }}
                    lang={LANG_META[code].htmlLang}
                    className={`flex w-full items-center justify-between gap-3 rounded-control px-3 py-2 text-sm text-start transition-colors min-h-[38px] ${
                      active ? "bg-surface-2 text-foreground font-medium" : "text-muted hover:text-foreground hover:bg-surface-2/60"
                    }`}
                  >
                    <span className="whitespace-nowrap">{LANG_META[code].label}</span>
                    {active && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-accent shrink-0">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
