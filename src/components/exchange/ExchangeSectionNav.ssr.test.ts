import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ExchangeSectionNav } from "./ExchangeSectionNav";

// 旧页面的二级导航(根布局里挂着):P2-10 起「持仓」是资产页 /trade/account(计划 §6.2.2 C8),
// 账户组的返回链接也指向它;/trade 下的页面(终端、资产页)不画这一条。
const nav = vi.hoisted(() => ({ pathname: "/orders" }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const render = (pathname: string) => {
  nav.pathname = pathname;
  return renderToStaticMarkup(createElement(ExchangeSectionNav));
};

describe("ExchangeSectionNav", () => {
  it("on the account pages, goes back to /trade/account and lists it as Holdings; /portfolio and /dashboard are gone", () => {
    for (const pathname of ["/orders", "/retirement", "/transactions", "/account"]) {
      const html = render(pathname);
      expect(html, pathname).toMatch(/class="ex-section-back" href="\/trade\/account">← Portfolio</);
      expect(html, pathname).toContain('href="/trade/account">Holdings<');
      expect(html, pathname).not.toMatch(/href="\/(portfolio|dashboard)"/);
    }
  });

  it("renders nothing under /trade (terminal and portfolio page have their own header) nor on unrelated paths", () => {
    for (const pathname of ["/trade/account", "/trade", "/trade/VCS-FOR-2021", "/otc", "/portfolio", "/dashboard"]) expect(render(pathname), pathname).toBe("");
  });

  it("keeps the discovery group unchanged", () => {
    expect(render("/projects")).toMatch(/class="ex-section-back" href="\/">← Markets</);
  });
});
