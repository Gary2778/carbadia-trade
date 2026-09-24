"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_LANG, LANG_META, isActiveLang, isLang, type Lang } from "@/i18n/config";
import { MESSAGES, type Messages } from "@/i18n";

export type { Lang };

const STORAGE_KEY = "carbadia-lang";

// 语言落到文档:lang 供排版/日期语义,dir 支持阿拉伯语 RTL
function applyToDocument(l: Lang) {
  document.documentElement.lang = LANG_META[l].htmlLang;
  document.documentElement.dir = LANG_META[l].dir;
}

type LangCtx = { lang: Lang; setLang: (l: Lang) => void };
const Ctx = createContext<LangCtx>({ lang: DEFAULT_LANG, setLang: () => {} });

export function LangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(DEFAULT_LANG);

  // 挂载后读取已保存的偏好（SSR 始终按默认英文渲染，避免水合不一致）
  useEffect(() => {
    let saved = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    // 历史偏好 zh(2026-07 前的简中代码)直接对应回今天的简中并改写存储
    if (saved === "zh") {
      saved = "zh-CN";
      try {
        localStorage.setItem(STORAGE_KEY, saved);
      } catch {
        /* ignore */
      }
    }
    // 冻结语言的历史偏好不再生效:存储值留着不动,页面按英文渲染;语言重新激活后偏好自动回来
    if (isLang(saved) && isActiveLang(saved) && saved !== DEFAULT_LANG) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 水合安全模式:SSR 按默认英文渲染,挂载后才能读 localStorage 纠正
      setLangState(saved);
      applyToDocument(saved);
    }
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    if (typeof document !== "undefined") applyToDocument(l);
  };

  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>;
}

export const useLang = () => useContext(Ctx);

/**
 * 按命名空间取当前语言文案（中央目录见 src/i18n/messages/）：
 *   const t = useT("portfolio");
 *   t.holdings
 * en.ts 是 source of truth，其余语言文件类型 = typeof en，缺 key 编译报错。
 */
export function useT<K extends keyof Messages>(ns: K): Messages[K] {
  const { lang } = useLang();
  return MESSAGES[lang][ns];
}

/** 当前语言的 BCP-47 代码(给 toLocaleString 等 Intl API 用) */
export const htmlLang = (lang: Lang) => LANG_META[lang].htmlLang;
