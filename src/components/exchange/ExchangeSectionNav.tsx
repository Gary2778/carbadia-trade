"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useExchangeText } from "./useExchange";

const accountLinks = [
  ["/portfolio", "Holdings", "持仓"],
  ["/orders", "Orders", "订单"],
  ["/retirement", "Retirement", "注销"],
  ["/transactions", "Transactions", "资产流水"],
  ["/account", "Account", "账户"],
] as const;
const discoveryLinks = [
  ["/projects", "Projects", "项目"],
  ["/watchlist", "Watchlist", "关注列表"],
  ["/research", "Market data", "市场数据"],
  ["/learn", "Learn", "学习"],
] as const;

/** Secondary pages stay within the original Markets / OTC / Portfolio structure. */
export function ExchangeSectionNav() {
  const path = usePathname();
  const c = useExchangeText();
  const account =
    accountLinks.some(([href]) => href === path) ||
    path === "/dashboard";
  const discovery = discoveryLinks.some(([href]) => href === path);
  if (path === "/portfolio" || (!account && !discovery)) return null;
  return (
    <nav className="ex-section-nav" aria-label={c("Related pages", "相关页面")}>
      <Link
        className="ex-section-back"
        href={account ? "/portfolio" : "/"}
      >
        ← {account ? c("Portfolio", "资产组合") : c("Markets", "市场")}
      </Link>
      {(account ? accountLinks : discoveryLinks).map(([href, en, zh]) => (
        <Link
          key={href}
          href={href}
          aria-current={href === path ? "page" : undefined}
        >
          {c(en, zh)}
        </Link>
      ))}
    </nav>
  );
}
