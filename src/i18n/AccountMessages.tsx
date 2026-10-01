"use client";

import type { ReactNode } from "react";
import type { AccountMessagesByLang } from "@/i18n";
import { AccountMessagesContext } from "@/i18n/LangProvider";
import en from "@/i18n/messages/account/en";
import zhCN from "@/i18n/messages/account/zh-CN";

// 资产页文案的登记处(P2-10,照 ./TerminalMessages.tsx 的办法再来一份)。只有 src/app/trade/account/layout.tsx 引入本文件,
// 所以两种语言的 account 命名空间只进资产页的 chunk,不进全站公共包,也不进终端页 /trade/[symbol] 的首屏。
// 两种语言一起同步加载(切语言不闪);文案里有函数型条目,过不了 Server → Client 的序列化边界,所以由这个客户端模块自己引入。
const ACCOUNT_MESSAGES: AccountMessagesByLang = { en, "zh-CN": zhCN };

/** 把资产页文案提供给子树里的 useT("account");服务端渲染与客户端水合走同一条路,首屏 HTML 里就是资产页英文文案 */
export function AccountMessagesProvider({ children }: { children: ReactNode }) {
  return <AccountMessagesContext.Provider value={ACCOUNT_MESSAGES}>{children}</AccountMessagesContext.Provider>;
}
