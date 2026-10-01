"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useExchangeText } from "./useExchange";

// 「持仓」是资产页 /trade/account(P2-10 取代了旧 /portfolio 与 /dashboard);其余四页保留,从资产页也有入口
const PORTFOLIO_HREF = "/trade/account";
const accountLinks = [
  [PORTFOLIO_HREF, "Holdings", "持仓"],
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

/**
 * Secondary pages stay within the original Markets / OTC / Portfolio structure.
 * /trade 下的页面(终端与资产页)有自己的页头与入口,这里不画(资产页 /trade/account 虽在「持仓」清单里,也不在它上面叠一条)。
 */
export function ExchangeSectionNav() {
  const path = usePathname();
  const c = useExchangeText();
  if (path.startsWith("/trade")) return null;
  const account = accountLinks.some(([href]) => href === path);
  const discovery = discoveryLinks.some(([href]) => href === path);
  if (!account && !discovery) return null;
  return (
    <nav className="ex-section-nav" aria-label={c("Related pages", "相关页面")}>
      <Link
        className="ex-section-back"
        href={account ? PORTFOLIO_HREF : "/"}
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
