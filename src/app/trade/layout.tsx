import "@/app/terminal.css";
import { TerminalMessagesProvider } from "@/i18n/TerminalMessages";

// /trade 下所有页面的共用布局(计划 §6.2.2 C9):只做两件事 ——
//   1. 引入 terminal.css(规则都收在 [data-terminal] 等作用域之下,别的页面不受影响;data-terminal 由页面自己挂);
//   2. 登记终端文案:terminal 命名空间不在全站公共包里,TerminalMessagesProvider 把两种语言带进 /trade 的 chunk,
//      子树里的 useT("terminal") 才取得到(服务端渲染与水合都在这棵子树里,首屏 HTML 照常是终端英文文案)。
// 不加任何可见结构;标题与描述由各页面自己的布局 / 页面给(/trade/[symbol]/layout.tsx 的 generateMetadata)。
export default function TradeLayout({ children }: { children: React.ReactNode }) {
  return <TerminalMessagesProvider>{children}</TerminalMessagesProvider>;
}
