import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/messages/en";
import { createInitialAccountState, useAccountStore } from "@/lib/market/account-store";
import { isActive, Nav } from "./Nav";
import { DemoBadge } from "./terminal/DemoBadge";

// §9.1 第 7 条:不引 jsdom,只做 renderToStaticMarkup 的服务端标记测试;没有 LangProvider 时 useT 落到默认英文。
// Nav 的 usePathname / useRouter 在 App Router 之外没有上下文,按 next/navigation 的模块边界打桩。
vi.mock("next/navigation", () => ({
  usePathname: () => "/otc",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const count = (html: string, needle: string) => html.split(needle).length - 1;
const source = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// §4.6 tokens-only 正则(与 P1-16 的 tokens-only.test.ts 同一规则;它落地前本文件先对 DemoBadge 把关)
const TOKENS_ONLY_VIOLATION =
  /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\(|\b\d+(\.\d+)?px\b|(text|bg|border|ring|fill|stroke|from|to)-(amber|red|green|blue|slate|gray|zinc|neutral|stone|emerald|rose|sky|indigo|orange|yellow|lime|teal|cyan|violet|purple|fuchsia|pink)-\d|text-\[|min-h-\[|w-\[\d|h-\[\d|z-\[/;

beforeEach(() => {
  useAccountStore.setState(createInitialAccountState(), true);
});

describe("DemoBadge", () => {
  it("renders nav.demoBadge with the nav.demoTooltip tooltip, in compact and regular variants", () => {
    const compact = renderToStaticMarkup(createElement(DemoBadge, { compact: true }));
    const regular = renderToStaticMarkup(createElement(DemoBadge));
    for (const html of [compact, regular]) {
      expect(html).toContain(`>${en.nav.demoBadge}<`);
      expect(html).toContain(`title="${en.nav.demoTooltip}"`);
      expect(html).toContain("text-warning");
      expect(html).toContain("rounded-pill");
    }
    expect(compact).toContain('data-demo-badge="compact"');
    expect(compact).toContain("text-t-2xs");
    expect(regular).toContain('data-demo-badge="regular"');
    expect(regular).toContain("text-t-xs");
  });

  it("uses tokens only (no hex, rgb, px literals, palette classes or arbitrary values)", () => {
    const lines = source("./terminal/DemoBadge.tsx").split("\n");
    const offenders = lines.map((line, i) => (TOKENS_ONLY_VIOLATION.test(line) ? `${i + 1}: ${line.trim()}` : null)).filter(Boolean);
    expect(offenders).toEqual([]);
  });
});

describe("Nav", () => {
  it("shows the Demo badge and the Terminal link on every page, and sits on the --z-nav layer", () => {
    const html = renderToStaticMarkup(createElement(Nav));
    expect(html).toContain('data-demo-badge="compact"');
    expect(count(html, `>${en.nav.demoBadge}<`)).toBe(1);
    // 桌面导航里有 /trade(手机菜单只在展开后渲染)
    expect(html).toContain('href="/trade"');
    expect(html).toContain(`>${en.nav.terminal}<`);
    expect(html).toContain("z-(--z-nav)");
    expect(html).not.toContain("z-20");
    // 当前路径 /otc:OTC 高亮,/trade 不高亮
    expect(html).toMatch(/aria-current="page"[^>]*href="\/otc"/);
    expect(html).not.toMatch(/aria-current="page"[^>]*href="\/trade"/);
    // 「持仓」指向资产页 /trade/account(P2-10),旧 /portfolio 不再出现
    expect(html).toContain(`href="/trade/account"`);
    expect(html).not.toContain('href="/portfolio"');
  });

  // P2-10(计划 §6.2.2 C8):/trade/account 亮「持仓」,其余 /trade* 亮「Terminal」;/orders、/retirement、/transactions、/account 仍亮「持仓」
  it("highlights Portfolio on /trade/account and the old account pages, and Terminal on every other /trade path", () => {
    const active = (pathname: string) => ["/", "/trade", "/otc", "/trade/account"].filter((href) => isActive(href, pathname));
    expect(active("/trade/account")).toEqual(["/trade/account"]);
    expect(active("/trade/account/")).toEqual(["/trade/account"]);
    for (const pathname of ["/trade", "/trade/VCS-FOR-2021", "/trade/CEA-SCEN-2026"]) expect(active(pathname), pathname).toEqual(["/trade"]);
    // 形如 /trade/accountX 的不是资产页
    expect(active("/trade/accounts")).toEqual(["/trade"]);
    for (const pathname of ["/orders", "/retirement", "/transactions", "/account"]) expect(active(pathname), pathname).toEqual(["/trade/account"]);
    for (const pathname of ["/", "/market/VCS-FOR-2021", "/projects", "/watchlist"]) expect(active(pathname), pathname).toEqual(["/"]);
    expect(active("/otc")).toEqual(["/otc"]);
  });

  it("keeps the brand on one line at phone width: leaf alone below 23rem, short wordmark up to sm, full name from sm; badge never hidden or shrunk, token gaps", () => {
    const html = renderToStaticMarkup(createElement(Nav));
    // 品牌链接:可访问名恒为全称(字标隐藏时也是);可收缩(min-w-0)而不是把徽标挤到右侧控件上
    expect(html).toMatch(/<a[^>]*aria-label="Carbadia Trade"[^>]*class="[^"]*\bmin-w-0\b[^"]*"[^>]*href="\/"|<a[^>]*href="\/"[^>]*aria-label="Carbadia Trade"[^>]*class="[^"]*\bmin-w-0\b/);
    // 三段只靠 CSS 显隐(SSR 与首帧一致):< 23rem 只有叶子;23rem–sm 只有 Carbadia(单行,truncate 兜底);sm 起叶子 + Carbadia Trade
    expect(html).toContain('<span class="hidden text-accent text-lg max-[23rem]:inline sm:inline">🌿</span>');
    expect(html).toContain('<span class="truncate max-[23rem]:hidden">Carbadia<span class="hidden sm:inline"> Trade</span></span>');
    // 断点用 rem,不写 px(§4.6)
    expect(source("./Nav.tsx")).not.toMatch(/(max|min)-\[\d+px\]/);
    // 徽标任何宽度都在(§4.3):自身与所在的品牌行都没有任何 hidden 变体;shrink-0 由 DemoBadge 自带
    const badge = html.match(/<span[^>]*data-demo-badge="compact"[^>]*>/)?.[0] ?? "";
    expect(badge).toContain("shrink-0");
    expect(badge).not.toMatch(/hidden/);
    expect(html).toMatch(/<div class="flex items-center gap-2 min-w-0"><a[^>]*aria-label="Carbadia Trade"[\s\S]*?<\/a><span[^>]*data-demo-badge="compact"/);
    // 与右侧控件之间是行容器的 gap-3;右侧控件手机上 gap-1
    expect(html).toMatch(/class="[^"]*\bms-auto flex items-center gap-1 sm:gap-3\b/);
    expect(html).toMatch(/class="max-w-7xl[^"]*\bgap-3\b/);
  });

  it("paints no account area during SSR, whatever the store holds (markup never depends on store state)", () => {
    const empty = renderToStaticMarkup(createElement(Nav));
    expect(empty).not.toContain(en.nav.login);
    expect(empty).not.toContain(en.nav.logout);
    useAccountStore.setState({
      me: { id: "u-1", email: "a@example.com", name: "Alice", cashBalance: 12_345, lockedCash: 0 },
      balance: { cashBalance: 12_345, lockedCash: 0 },
      status: "ready",
    });
    const hydrated = renderToStaticMarkup(createElement(Nav));
    expect(hydrated).toBe(empty);
  });

  it("no longer borrows the direction colour for the destructive logout action", () => {
    const nav = source("./Nav.tsx");
    expect(nav).not.toMatch(/text-down/);
    expect(nav).toContain("hover:text-danger");
    expect(nav).not.toMatch(/api\("\/api\/auth\/me"/);
  });

  // effect 在 renderToStaticMarkup 里不跑(无 jsdom),这里按源码把关账户生命周期的接线;行为本身在 account-store.test.ts 里测
  // (refreshOnNavigation:终端之外对已确认的状态节流刷新、/trade 下不刷、未确认的 anon 走自愈重试)
  it("hydrates identity and balance only (mode \"me\") once on mount; every path change goes through refreshOnNavigation (no more guessing a login from leaving /login or /register)", () => {
    const nav = source("./Nav.tsx");
    const code = nav.replace(/\/\/.*$/gm, ""); // 只数代码里的调用,不数注释
    expect(code.match(/accountActions\.hydrate\(/g)).toHaveLength(1);
    expect(nav).toMatch(/useEffect\(\(\) => \{\s*if \(useAccountStore\.getState\(\)\.status === "idle"\) void accountActions\.hydrate\(api, "me"\);\s*return watchHydrateRetry\(\);\s*\}, \[\]\);/);
    expect(nav).toMatch(/useEffect\(\(\) => \{\s*void accountActions\.refreshOnNavigation\(pathname\);\s*\}, \[pathname\]\);/);
    // 列表(持仓、挂单翻页)不在根布局首屏里拉
    expect(code).not.toMatch(/loadAccountLists|hydrate\(\)/);
    expect(nav).not.toMatch(/isAuthPage|AUTH_PAGES|lastPathRef/);
  });

  // 等多久、挂住时怎么办由 hydrateForNavigation 负责(行为在 account-store.test.ts 里测):这里只把关三处都走它,不再裸等 hydrate()
  it("login, demo and register refresh the shared account store before navigating to returnTo, without waiting on a hung request", () => {
    const pages: [string, string][] = [
      ["../app/login/page.tsx", "login"],
      ["../app/login/page.tsx", "demo"],
      ["../app/register/page.tsx", "register"],
    ];
    for (const [file, endpoint] of pages) {
      const afterSuccess = new RegExp(
        `await api\\("/api/auth/${endpoint}"[^\\n]*\\n(?:\\s*//[^\\n]*\\n)*\\s*await accountActions\\.hydrateForNavigation\\(\\);\\s*router\\.push\\(returnTo\\);`,
      );
      expect(source(file), `${file} → /api/auth/${endpoint}`).toMatch(afterSuccess);
      expect(source(file).replace(/\/\/.*$/gm, ""), file).not.toMatch(/accountActions\.hydrate\(/);
    }
  });

  // 登录态只有一个来源:旧页面不再各拉一份 /api/auth/me,改读共享的账户 store(useMe / useAccountStatus;SSR 与水合首帧是 idle,
  // 与这些页面原来「未知 → 加载中」的首帧一致);改了余额的写操作成功后调 accountActions.refresh(),Nav 不等下一次导航就更新
  it("otc, account and market pages read login state from the shared account store instead of fetching /api/auth/me themselves", () => {
    for (const file of ["../app/otc/page.tsx", "../app/account/page.tsx", "../app/market/[symbol]/MarketContent.tsx"]) {
      const code = source(file).replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\/api\/auth\/me/);
      expect(code, file).toMatch(/from "@\/lib\/market\/account-store"/);
      expect(code, file).toMatch(/\buseAccountStatus\(\)/);
    }
    // 账户页的退出登录也走 store(POST + 清空 + 重连),Nav 与页面同一拍变成未登录
    expect(source("../app/account/page.tsx")).toMatch(/await accountActions\.logout\(\);/);
  });

  it("legacy mutations that move cash refresh the shared store right away (OTC buy, simple trade); a 401 on the portfolio page re-checks the login", () => {
    const code = (file: string) => source(file).replace(/\/\/.*$/gm, "");
    expect(code("../app/otc/page.tsx")).toMatch(/api\(`\/api\/otc\/\$\{listing\.id\}\/buy`[\s\S]*?accountActions\.refresh\(\)/);
    expect(code("./exchange/SimpleTrade.tsx")).toMatch(/setReceipt\([\s\S]*?accountActions\.refresh\(\)/);
    // 资产页 /trade/account(P2-10)取代了旧 /portfolio:它挂着 AccountFeed,余额由账户推送 / 轮询维护,撤牌后不必手动刷新余额;
    // 会话在它上面失效(总览或撤牌回 401)时同样让共享 store 重新确认身份,Nav 同一拍变成未登录
    expect(code("./account/useAccountOverview.ts")).toMatch(/status === 401\)[\s\S]*?accountActions\.refresh\(\)/);
    expect(code("./account/OtcListings.tsx")).toMatch(/method: "DELETE"[\s\S]*?status === 401\)[\s\S]*?accountActions\.refresh\(\)/);
  });
});
