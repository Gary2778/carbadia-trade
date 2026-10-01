"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DEFAULT_LANG, LANG_META, isActiveLang, isLang, type Lang } from "@/i18n/config";
import { MESSAGES, type AccountMessagesByLang, type CoreMessages, type Messages, type TerminalMessagesByLang } from "@/i18n";

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
 * 终端文案的上下文(计划 §6.2.2 C9)。terminal 命名空间不在核心包里:src/app/trade/layout.tsx 渲染的
 * TerminalMessagesProvider(src/i18n/TerminalMessages.tsx,只在 /trade 的 chunk 里)把两种语言的终端文案放进这里,
 * useT("terminal") 从这里读。默认值 null = 不在 /trade 的子树里。本文件从根布局可达,所以这里只放上下文对象本身,
 * 文案模块一律不在这里引入。
 */
export const TerminalMessagesContext = createContext<TerminalMessagesByLang | null>(null);

const TERMINAL_OUTSIDE_TRADE =
  'useT("terminal") was called outside <TerminalMessagesProvider>. Terminal copy is only loaded under /trade ' +
  "(src/app/trade/layout.tsx); a component rendered anywhere else must read a core namespace (nav, ui, …) instead. " +
  'In tests, render with renderToStaticMarkup from "@/i18n/test-support".';

/**
 * 资产页文案的上下文(P2-10,与终端文案同一套办法):account 命名空间既不在核心包里,也不在 terminal 里,
 * src/app/trade/account/layout.tsx 渲染的 AccountMessagesProvider(src/i18n/AccountMessages.tsx,只在资产页的 chunk 里)
 * 把两种语言放进这里,useT("account") 从这里读。默认值 null = 不在资产页的子树里。本文件只放上下文对象本身。
 */
export const AccountMessagesContext = createContext<AccountMessagesByLang | null>(null);

const ACCOUNT_OUTSIDE_PAGE =
  'useT("account") was called outside <AccountMessagesProvider>. Portfolio page copy is only loaded under /trade/account ' +
  "(src/app/trade/account/layout.tsx); a component rendered anywhere else must read another namespace instead. " +
  'In tests, render with renderAccountMarkup from "@/i18n/test-support".';

/**
 * 按命名空间取当前语言文案（中央目录见 src/i18n/messages/）：
 *   const t = useT("nav");
 *   t.portfolio
 * en.ts 是 source of truth，其余语言文件类型 = typeof en，缺 key 编译报错。
 *
 * useT("terminal") 只能在 /trade 的布局之下调用(终端文案只随 /trade 加载);在别处调用直接抛错,而不是静默拿到 undefined。
 * useT("account") 同理,只能在 /trade/account 的布局之下调用(资产页文案只随那一页加载)。
 * 终端之外也要用的文案放核心命名空间(nav / ui …)。
 */
export function useT<K extends keyof Messages>(ns: K): Messages[K] {
  const { lang } = useLang();
  const terminal = useContext(TerminalMessagesContext);
  const account = useContext(AccountMessagesContext);
  if (ns === "terminal") {
    if (terminal === null) throw new Error(TERMINAL_OUTSIDE_TRADE);
    return terminal[lang] as Messages[K];
  }
  if (ns === "account") {
    if (account === null) throw new Error(ACCOUNT_OUTSIDE_PAGE);
    return account[lang] as Messages[K];
  }
  return MESSAGES[lang][ns as keyof CoreMessages] as Messages[K];
}

/** 当前语言的 BCP-47 代码(给 toLocaleString 等 Intl API 用) */
export const htmlLang = (lang: Lang) => LANG_META[lang].htmlLang;
