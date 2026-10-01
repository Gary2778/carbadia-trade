// 测试专用(运行时代码不得引入)。
// 终端文案不在根 LangProvider 里(计划 §6.2.2 C9):直接渲染终端组件的 SSR 测试要先包上 /trade 布局登记文案的那一层 Provider,
// 否则 useT("terminal") 抛错。终端的测试文件把
//   import { renderToStaticMarkup } from "react-dom/server";
// 换成
//   import { renderToStaticMarkup } from "@/i18n/test-support";
// 即可,其余不用改;输出的标记与不包 Provider 时逐字节相同(Provider 自己不产生任何标记)。
// 注意:mock 了 @/i18n/LangProvider 的测试不要在 vi.mock 的工厂函数里引入本文件——会互相等待,vitest 挂起而不是失败;
// 那类测试照 meta.ssr.test.ts 的写法,直接读 @/i18n/messages/en 与 zh-CN。
// 资产页 /trade/account 的组件另读 account 命名空间(P2-10):用 renderAccountMarkup,它在终端文案之下再包一层 AccountMessagesProvider
//(与资产页在 /trade 布局 + /trade/account 布局之下的处境相同)。
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { AccountMessagesProvider } from "@/i18n/AccountMessages";
import { TerminalMessagesProvider } from "@/i18n/TerminalMessages";

/** 同 react-dom/server 的 renderToStaticMarkup,但渲染在 TerminalMessagesProvider 之下(与 /trade 布局里的页面同样的处境) */
export function renderToStaticMarkup(node: ReactNode): string {
  return render(createElement(TerminalMessagesProvider, null, node));
}

/** 资产页的组件:终端文案 + 资产页文案两层 Provider 之下渲染(两层都不产生标记) */
export function renderAccountMarkup(node: ReactNode): string {
  return render(createElement(TerminalMessagesProvider, null, createElement(AccountMessagesProvider, null, node)));
}
