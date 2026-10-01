"use client";

import type { ReactNode } from "react";
import type { TerminalMessagesByLang } from "@/i18n";
import { TerminalMessagesContext } from "@/i18n/LangProvider";
import en from "@/i18n/messages/terminal/en";
import zhCN from "@/i18n/messages/terminal/zh-CN";

// 终端文案的登记处(计划 §6.2.2 C9)。只有 src/app/trade/layout.tsx 引入本文件,所以两种语言的 terminal 命名空间
// 只进 /trade 的 chunk,不进全站每页都带的公共包。两种语言一起同步加载(不按语言懒加载:切语言时不会闪一下)。
// 文案里有函数型条目,过不了 Server → Client 的序列化边界,所以由这个客户端模块自己引入,而不是从布局用 props 传下来。
const TERMINAL_MESSAGES: TerminalMessagesByLang = { en, "zh-CN": zhCN };

/** 把终端文案提供给子树里的 useT("terminal");服务端渲染与客户端水合走同一条路,首屏 HTML 里就是终端文案 */
export function TerminalMessagesProvider({ children }: { children: ReactNode }) {
  return <TerminalMessagesContext.Provider value={TERMINAL_MESSAGES}>{children}</TerminalMessagesContext.Provider>;
}
