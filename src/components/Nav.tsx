"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { NumberTicker } from "@/components/anim/NumberTicker";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { DemoBadge } from "@/components/terminal/DemoBadge";
import { useT, useLang } from "@/i18n/LangProvider";
import { tUserName } from "@/i18n/data";
import { api } from "@/lib/http/client";
import { accountActions, useAccountStatus, useAccountStore, useBalance, useMe, watchHydrateRetry } from "@/lib/market/account-store";

type LinkKey = "markets" | "terminal" | "otc" | "portfolio";
const LINKS: { href: string; key: LinkKey }[] = [
  { href: "/", key: "markets" },
  { href: "/trade", key: "terminal" },
  { href: "/otc", key: "otc" },
  { href: "/trade/account", key: "portfolio" },
];
/** 资产页(计划 §6.2.2 C8,P2-10):在 /trade 之下,但属于「持仓」而不是「终端」 */
const ACCOUNT_PAGE = "/trade/account";
const isAccountPage = (pathname: string) => pathname === ACCOUNT_PAGE || pathname.startsWith(`${ACCOUNT_PAGE}/`);
// 行情入口要求精确匹配,否则 / 会在所有子页常亮;
// 但标的页、项目、关注列表、市场数据、学习语义上仍属"行情",所以 / 额外接受这些前缀;
// 「持仓」指向资产页 /trade/account,并收下 orders / retirement / transactions / account(旧页面保留、从资产页进入);
// 其余 /trade 前缀是终端 —— 资产页虽在 /trade 下,亮的是「持仓」不是「Terminal」
export const isActive = (href: string, pathname: string) =>
  href === "/"
    ? pathname === "/" || ["market", "projects", "watchlist", "research", "learn"].some((page) => pathname.startsWith(`/${page}`))
    : href === ACCOUNT_PAGE
      ? isAccountPage(pathname) || ["orders", "retirement", "transactions", "account"].some((page) => pathname.startsWith(`/${page}`))
      : href === "/trade"
        ? pathname.startsWith("/trade") && !isAccountPage(pathname)
        : pathname.startsWith(href);

const CARBADIA_HOME = "https://carbadia.io";

export function Nav() {
  const t = useT("nav");
  const { lang } = useLang();
  const pathname = usePathname();
  const router = useRouter();
  // 登录态来自共享的账户 store(SSR / 水合期 status 为 idle → 账户区不画,与旧版 !loaded 一致)
  const me = useMe();
  const balance = useBalance();
  const status = useAccountStatus();
  const loaded = status === "ready" || status === "anon";
  const cash = balance?.cashBalance ?? me?.cashBalance ?? 0;
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false); // 移动端汉堡菜单
  const [prevPath, setPrevPath] = useState(pathname);

  // 路由变化(浏览器前进/后退等)自动收起菜单 —— 渲染期状态调整,不走 effect
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }

  // 挂载时拉一次身份与余额(store 已有登录态时跳过,例如 StrictMode 的二次挂载)。只拉 /api/auth/me(mode "me"):Nav 只画名字与现金,
  // 持仓与挂单翻页只有终端要,由 MarketProvider 自己拉 —— 根布局的首屏只多这一个请求,与 main 的 Nav 同价。
  // 登录 / 注册 / demo 成功后由那几个页面自己 await accountActions.hydrateForNavigation() 再跳转(最多等几秒,挂住的请求不卡跳转;
  // DemoButton 走整页跳转,挂载时自然 hydrate),Nav 不再靠「离开认证页」去猜。
  // 自愈:/api/auth/me 瞬时失败或超时落下的「未确认 anon」由 watchHydrateRetry 的定时器到点重试(第一次失败后立即,之后只沿重试链退避),
  // online、页面重新可见与路径变化时也重试(登录页 hydrate 抖了一下,紧接着的 router.push 就能重拉)。
  useEffect(() => {
    if (useAccountStore.getState().status === "idle") void accountActions.hydrate(api, "me");
    return watchHydrateRetry();
  }, []);

  // 换路径:终端之外对已确认的状态节流(10 s)重拉 /api/auth/me —— 旧页面(OTC、简易交易、资产页撤单)与机器人成交改了余额、
  // 会话过期、别的标签页登录 / 登出,下一次导航就反映出来(main 的 Nav 每次换路径都拉);/trade 下由 MarketProvider 的推送 / 轮询维护,
  // 不拉。未确认的 anon 照旧走自愈重试。规则都在 refreshOnNavigation 里(account-store.test.ts 测)。
  useEffect(() => {
    void accountActions.refreshOnNavigation(pathname);
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function logout() {
    await accountActions.logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <header
      className={`glass-bar sticky top-0 z-(--z-nav) border-b transition-all duration-300 md:backdrop-blur-xl ${
        scrolled
          ? "border-border bg-surface/95 md:bg-surface/80 shadow-soft"
          : "border-border/60 bg-surface/90 md:bg-surface/60"
      }`}
    >
      {/* dark 的滚动边缘:一层渐隐的模糊 + 暗色垫在导航条身后(见 LiquidGlassRefraction);其它外观下不显示 */}
      <div className="glass-scrim" aria-hidden="true" />
      <div className="max-w-7xl mx-auto px-4 sm:px-5 h-14 md:h-12 flex items-center gap-3 md:gap-6">
        {/* 品牌 + 徽标:单行。右侧四个控件共 192 px,全称加叶子放不下 —— sm 以下只写 Carbadia(「 Trade」sm 起才显示)。
            Carbadia 完整放下要 356 px 视口(en / zh-CN 实测:侧边距 2×16 + 字标 65 + gap 8 + 徽标 47 + gap 12 + 控件 192);
            窄于 23rem(368 px,给别的平台字体留 12 px 余量)时改由叶子单独代表品牌、字标隐藏,不再截成「C…」。三段只靠 CSS 显隐切换,
            SSR 与首帧一致;可访问名恒为链接的 aria-label;truncate 留作兜底。徽标 shrink-0、任何宽度都在(§4.3:每页可见 Demo 标识),
            与右侧控件之间是行容器的 gap-3 */}
        <div className="flex items-center gap-2 min-w-0">
          <Link href="/" aria-label="Carbadia Trade" className="flex min-w-0 items-center gap-2 font-semibold tracking-tight" onClick={() => setOpen(false)}>
            <span className="hidden text-accent text-lg max-[23rem]:inline sm:inline">🌿</span>
            <span className="truncate max-[23rem]:hidden">
              Carbadia<span className="hidden sm:inline"> Trade</span>
            </span>
          </Link>
          {/* 模拟盘徽标:每一页都带(launch-checklist) */}
          <DemoBadge compact />
        </div>

        {/* 桌面:分区导航 + 回主站;手机隐藏,收进汉堡菜单 */}
        <div className="hidden lg:flex items-center gap-3 text-sm min-w-0">
          <nav className="flex items-center gap-1">
            {LINKS.map((l) => {
              const active = isActive(l.href, pathname);
              return (
                <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className="relative px-3 py-1.5 rounded-full">
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 bg-surface-2 rounded-full"
                      transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    />
                  )}
                  <span className={`relative transition-colors ${active ? "text-foreground" : "text-muted hover:text-foreground"}`}>{t[l.key]}</span>
                </Link>
              );
            })}
          </nav>
          <a href={CARBADIA_HOME} rel="noopener" className="glass-control rounded-full border border-border px-3 py-1 text-xs text-muted hover:text-foreground whitespace-nowrap">
            Carbadia<span aria-hidden> ↗</span>
          </a>
        </div>

        <div className="ms-auto flex items-center gap-1 sm:gap-3 text-sm">
          <ThemeToggle />
          <LanguageToggle />
          {/* 桌面:账户/登录区 */}
          <div className="hidden xl:flex items-center gap-3">
            {!loaded ? null : me ? (
              <>
                <div className="text-end hidden lg:block">
                  <div className="text-xs text-muted">{t.cash}</div>
                  <div className="tnum text-accent">
                    $<NumberTicker value={cash} />
                  </div>
                </div>
                <div className="h-8 w-px bg-border hidden lg:block" />
                <span className="text-muted">{tUserName(me.name, lang)}</span>
                {/* 登出是破坏性动作:语义色 --danger,不随涨跌轴翻转 */}
                <button onClick={logout} className="text-muted hover:text-danger transition-colors">
                  {t.logout}
                </button>
              </>
            ) : (
              <>
                <Link href={`/login?returnTo=${encodeURIComponent(pathname)}`} className="text-muted hover:text-foreground">
                  {t.login}
                </Link>
                <Link
                  href={`/register?returnTo=${encodeURIComponent(pathname)}`}
                  className="px-4 py-1.5 rounded-full bg-accent text-background font-medium hover:bg-accent-strong transition-colors"
                >
                  {t.register}
                </Link>
              </>
            )}
          </div>
          {/* 手机:汉堡按钮(≥44px 触控目标) */}
          <button
            type="button"
            className="xl:hidden grid h-11 w-11 place-items-center rounded-full text-foreground hover:bg-surface-2 transition-colors"
            aria-label={t.menu}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </div>

      {/* 手机:展开式菜单 */}
      {open && (
        <nav className="glass-menu xl:hidden border-t border-border bg-surface px-4 py-2">
          {LINKS.map((l) => {
            const active = isActive(l.href, pathname);
            return (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center min-h-[44px] px-3 rounded-xl text-base transition-colors ${
                  active ? "bg-surface-2 text-foreground font-medium" : "text-muted hover:text-foreground"
                }`}
              >
                {t[l.key]}
              </Link>
            );
          })}
          <a href={CARBADIA_HOME} rel="noopener" onClick={() => setOpen(false)} className="flex min-h-[44px] items-center px-3 rounded-xl text-base text-muted hover:text-foreground">
            Carbadia<span aria-hidden> ↗</span>
          </a>
          <div className="h-px bg-border my-2" />
          {!loaded ? null : me ? (
            <>
              <div className="flex items-center justify-between min-h-[44px] px-3">
                <span className="text-muted">{tUserName(me.name, lang)}</span>
                <span className="tnum text-accent">
                  $<NumberTicker value={cash} />
                </span>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  logout();
                }}
                className="flex items-center min-h-[44px] w-full px-3 text-start text-danger"
              >
                {t.logout}
              </button>
            </>
          ) : (
            <div className="flex gap-2 py-1">
              <Link
                href={`/login?returnTo=${encodeURIComponent(pathname)}`}
                onClick={() => setOpen(false)}
                className="flex-1 min-h-[44px] flex items-center justify-center rounded-full border border-border text-foreground"
              >
                {t.login}
              </Link>
              <Link
                href={`/register?returnTo=${encodeURIComponent(pathname)}`}
                onClick={() => setOpen(false)}
                className="flex-1 min-h-[44px] flex items-center justify-center rounded-full bg-accent text-background font-medium"
              >
                {t.register}
              </Link>
            </div>
          )}
        </nav>
      )}
    </header>
  );
}
