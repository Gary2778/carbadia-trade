import { AccountMessagesProvider } from "@/i18n/AccountMessages";

// 资产页 /trade/account 的布局(P2-10):只登记资产页的文案(account 命名空间)。它在 /trade 的共用布局之下 ——
// terminal.css 与终端文案由上一级 src/app/trade/layout.tsx 给,资产页里复用的终端组件(注销对话框、Demo 徽标、ui/*)照常读 terminal.* / ui.*。
// account 命名空间只随这一页的 chunk 加载:不进全站公共包,也不进终端页 /trade/[symbol] 的首屏(bundle-boundary.test.ts、chunk-report.mjs 守着)。
// 不加任何可见结构;标题与描述在 page.tsx。
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return <AccountMessagesProvider>{children}</AccountMessagesProvider>;
}
