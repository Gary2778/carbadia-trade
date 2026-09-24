"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { api } from "@/lib/http/client";
import { NumberTicker } from "@/components/anim/NumberTicker";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { KidsModeToggle } from "@/components/KidsModeToggle";
import { useT, useLang } from "@/i18n/LangProvider";
import { tUserName } from "@/i18n/data";

type Me = { id: string; name: string; email: string; cashBalance: number; lockedCash: number } | null;

type LinkKey = "markets" | "otc" | "portfolio";
const LINKS: { href: string; key: LinkKey }[] = [
  { href: "/", key: "markets" },
  { href: "/otc", key: "otc" },
  { href: "/portfolio", key: "portfolio" },
];
// 行情入口要求精确匹配,否则 / 会在所有子页常亮;
// 但标的页、项目、关注列表、市场数据、学习语义上仍属"行情",所以 / 额外接受这些前缀;
// 资产组合同理收下 dashboard/orders/retirement/transactions/account
const isActive = (href: string, pathname: string) =>
  href === "/"
    ? pathname === "/" || ["market", "projects", "watchlist", "research", "learn"].some((page) => pathname.startsWith(`/${page}`))
    : href === "/portfolio"
      ? ["portfolio", "dashboard", "orders", "retirement", "transactions", "account"].some((page) => pathname.startsWith(`/${page}`))
      : pathname.startsWith(href);

const CARBADIA_HOME = "https://carbadia.io";

export function Nav() {
  const t = useT("nav");
  const { lang } = useLang();
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me>(null);
  const [loaded, setLoaded] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false); // 移动端汉堡菜单
  const [prevPath, setPrevPath] = useState(pathname);

  // 路由变化(浏览器前进/后退等)自动收起菜单 —— 渲染期状态调整,不走 effect
  if (prevPath !== pathname) {
    setPrevPath(pathname);
    setOpen(false);
  }
  useEffect(() => {
    api<Me>("/api/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoaded(true));
  }, [pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    setMe(null);
    router.push("/login");
    router.refresh();
  }

  return (
    <header
      className={`glass-bar sticky top-0 z-20 border-b transition-all duration-300 md:backdrop-blur-xl ${
        scrolled
          ? "border-border bg-surface/95 md:bg-surface/80 shadow-soft"
          : "border-border/60 bg-surface/90 md:bg-surface/60"
      }`}
    >
      {/* dark 的滚动边缘:一层渐隐的模糊 + 暗色垫在导航条身后(见 LiquidGlassRefraction);其它外观下不显示 */}
      <div className="glass-scrim" aria-hidden="true" />
      <div className="max-w-7xl mx-auto px-4 sm:px-5 h-14 md:h-12 flex items-center gap-3 md:gap-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" onClick={() => setOpen(false)}>
          <span className="text-accent text-lg">🌿</span>
          <span>Carbadia Trade</span>
        </Link>

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

        <div className="ms-auto flex items-center gap-2 sm:gap-3 text-sm">
          <ThemeToggle />
          <KidsModeToggle />
          <LanguageToggle />
          {/* 桌面:账户/登录区 */}
          <div className="hidden xl:flex items-center gap-3">
            {!loaded ? null : me ? (
              <>
                <div className="text-end hidden lg:block">
                  <div className="text-xs text-muted">{t.cash}</div>
                  <div className="tnum text-accent">
                    $<NumberTicker value={me.cashBalance} />
                  </div>
                </div>
                <div className="h-8 w-px bg-border hidden lg:block" />
                <span className="text-muted">{tUserName(me.name, lang)}</span>
                <button onClick={logout} className="text-muted hover:text-down transition-colors">
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
                  $<NumberTicker value={me.cashBalance} />
                </span>
              </div>
              <button
                onClick={() => {
                  setOpen(false);
                  logout();
                }}
                className="flex items-center min-h-[44px] w-full px-3 text-start text-down"
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
