// 核心文案注册表:英文(source of truth)与简体中文,静态导入,编译期保证 key 齐全。
// 这里只有核心命名空间(除 terminal 之外的全部),由根 LangProvider 带进每个页面的公共包;
// 终端文案不在这里(计划 §6.2.2 C9):它在 ./messages/terminal/*,经 ./TerminalMessages.tsx 只随 /trade 的 chunk 加载;
// 资产页文案同样不在这里(P2-10):./messages/account/*,经 ./AccountMessages.tsx 只随 /trade/account 的 chunk 加载。
// 本文件从根布局可达,所以只许 `import type` 合并对象(./messages/en),不得把它或终端文案作为值引入
// (src/i18n/bundle-boundary.test.ts 守着)。
import type { Lang } from "./config";
import en, { type CoreMessages } from "./messages/core/en";
import zhCN from "./messages/core/zh-CN";
import type { Messages } from "./messages/en";

export const MESSAGES: Record<Lang, CoreMessages> = {
  en,
  "zh-CN": zhCN,
};

/** 终端命名空间的两种语言(TerminalMessagesProvider 提供、useT("terminal") 读取的值的形状) */
export type TerminalMessagesByLang = Record<Lang, Messages["terminal"]>;

/** 资产页命名空间的两种语言(AccountMessagesProvider 提供、useT("account") 读取的值的形状;P2-10) */
export type AccountMessagesByLang = Record<Lang, Messages["account"]>;

export type { CoreMessages, Messages };
