"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import type { InstrumentListItem } from "@/shared";
import { NoticeToaster } from "@/components/notices/NoticeToaster";
import { DemoBadge } from "@/components/terminal/DemoBadge";
import { TimeZoneSelect } from "@/components/terminal/TimeZoneSelect";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
import { AccountFeed } from "@/lib/market/AccountFeed";
import { accountActions, useAccountStatus, useAccountStore, useMe } from "@/lib/market/account-store";
import { accountPhase, type AccountPhase } from "@/lib/market/account-view";
import type { TransportMode } from "@/lib/market/transport";
import { AccountContent } from "./AccountContent";
import { AccountGate } from "./AccountGate";
import { PANEL } from "./styles";
import { useAccountOverview } from "./useAccountOverview";

// 资产页 /trade/account(计划 §6.2.3 P2-10):终端的设计语言(token、等宽数字、统一反馈件),文档式单列布局 —— 不是终端的固定网格。
//   - 根 <div data-terminal data-glass="off" data-account>:data-terminal 让 --terminal-* token 在子树里有值、旧页面 .exchange-content 的
//     聚焦 / 禁用默认样式不串进来(exchange.css 对 [data-terminal] 子树整棵排除);data-glass="off" 让 dark 下的面板不透明;
//     data-account 把终端的网格与全宽规则换成文档式单列(terminal.css 的「资产页」一节:display 回到 block,内容列最大宽度由这里的 max-w-7xl 给)。
//   - 服务端渲染:页头(标题、Demo 徽标、说明、演示资金说明、入口)+ 骨架。会话判断与账户数据都在客户端,不进可缓存的 HTML;
//     页头是首屏最大的文字块(LCP),之后换上来的登录入口 / 数据都比它小,也不在它上面插东西(无布局偏移)。
//   - 数据:AccountFeed(ticker:* + account,连不上则轮询)水合后才挂;总览接口首屏落 store,之后持仓与余额跟账户 store、价格跟行情 store,
//     合计按最新价重算(AccountContent);24 小时变化与 OTC 挂牌由 useAccountOverview 定时 / 事件后重取。

const noopSubscribe = () => () => {};
/**
 * 水合完成之后才为 true(服务端与水合首帧为 false;站内软导航进来时第一次渲染即为 true)。与终端 useTerminalLayout 的 useHydrated
 * 同一写法,这里不引那个模块:资产页一引,它就成了两页共享的模块,终端首屏的包跟着变大。
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export type AccountPageProps = {
  /** 服务端的标的清单(listInstruments()):挂载后灌入行情 store,名称、分组元数据与最新价不等 WS */
  initialInstruments: InstrumentListItem[];
  /** 服务端的传输提示(transportModeForServer):"poll" = 服务端没有 /ws,首帧就轮询 */
  transportMode?: TransportMode;
};

/** 资产页的外框与页头(纯展示;SSR 测试直接渲染) */
export function AccountFrame({ children }: { children: ReactNode }) {
  return (
    <div data-terminal="" data-glass="off" data-account="">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-panel">
        <AccountHeader />
        {children}
      </div>
    </div>
  );
}

/** 到其它账户页的入口:委托与历史、流水、注销记录与证书、个人资料、回终端(旧页面保留,新页只给入口) */
const LINKS = [
  { href: "/orders", key: "orders" },
  { href: "/transactions", key: "ledger" },
  { href: "/retirement", key: "retirements" },
  { href: "/account", key: "profile" },
  { href: "/trade", key: "terminal" },
] as const;

/** 页头:标题 + Demo 徽标、一句说明、演示资金说明(固定,不做任何充提入口)、账户页面入口 */
export function AccountHeader() {
  const a = useT("account");
  return (
    <header className={`flex flex-col gap-gap p-panel ${PANEL}`}>
      <div className="flex flex-wrap items-center gap-x-panel gap-y-gap">
        <h1 className="text-t-2xl font-semibold text-foreground">{a.title}</h1>
        <DemoBadge />
        <span className="ms-auto">
          <TimeZoneSelect />
        </span>
      </div>
      <p className="max-w-3xl text-t-md text-muted">{a.intro}</p>
      <p data-demo-note="" className="text-t-sm font-medium text-warning">
        {a.demoNote}
      </p>
      <nav aria-label={a.links.label} className="flex flex-wrap gap-gap pt-gap">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            prefetch={false}
            className="inline-flex min-h-touch items-center rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-3 text-t-sm text-foreground transition-colors duration-(--motion-fast) hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1"
          >
            {a.links[link.key]}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** 加载骨架:与就绪后的版面同一骨架(四个数一行、一块持仓面板),替换时不跳 */
export function AccountSkeleton() {
  return (
    <div data-account-skeleton="" className="flex flex-col gap-panel">
      <div className="grid grid-cols-2 gap-gap lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`p-panel ${PANEL}`}>
            <Skeleton rows={2} />
          </div>
        ))}
      </div>
      <div className={`p-panel ${PANEL}`}>
        <Skeleton rows={6} />
      </div>
    </div>
  );
}

/**
 * 页面主体按状态切换(纯展示):加载中 → 骨架;未登录 → 登录入口;身份未确认(/api/auth/me 瞬时失败)与第一次取总览失败 → 出错可重试;
 * 就绪 → ready 插槽(AccountContent,读 store)。
 */
export function AccountBody({ phase, ready, onRetry }: { phase: AccountPhase; ready?: ReactNode; onRetry: () => void }) {
  const a = useT("account");
  switch (phase) {
    case "anon":
      return <AccountGate />;
    case "unverified":
    case "error":
      return (
        <div className={`p-panel ${PANEL}`}>
          <ErrorState message={phase === "error" ? a.errors.load : a.errors.session} onRetry={onRetry} />
        </div>
      );
    case "ready":
      return <>{ready}</>;
    default:
      return <AccountSkeleton />;
  }
}

/**
 * 资产页(容器)。渲染期不读写行情 store;账户 store 只读 status / 身份(SSR 与水合首帧是初始状态 idle → 骨架,与 HTML 一致)。
 * 星空:与终端一样挂载时写 html[data-starfield="static"](dark 下页面整块不透明,背后的 30 fps 星空白跑),卸载删掉。
 */
export function AccountPage({ initialInstruments, transportMode }: AccountPageProps) {
  const hydrated = useHydrated();
  const status = useAccountStatus();
  const unverified = useAccountStore((s) => s.unverified !== null);
  const meId = useMe()?.id ?? null;
  const overview = useAccountOverview(status === "ready" ? meId : null);
  const phase = accountPhase(status, unverified, { loaded: overview.data !== null, failed: overview.failed });

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.starfield = "static";
    return () => {
      delete root.dataset.starfield;
    };
  }, []);

  const retry = () => {
    if (phase === "unverified") void accountActions.refresh();
    else void overview.reload().catch(() => {});
  };

  return (
    <AccountFrame>
      {hydrated ? <AccountFeed initialInstruments={initialInstruments} transportMode={transportMode} /> : null}
      <NoticeToaster />
      <AccountBody
        phase={phase}
        onRetry={retry}
        ready={overview.data ? <AccountContent extras={overview.data} stale={overview.failed} onListingCancelled={overview.dropListing} onRefresh={overview.reload} /> : null}
      />
    </AccountFrame>
  );
}
