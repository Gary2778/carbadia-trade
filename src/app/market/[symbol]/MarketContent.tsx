"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/http/client";
import { fmtMoney, fmtQty } from "@/lib/format";
import { NumberTicker } from "@/components/anim/NumberTicker";
import { FlashCell } from "@/components/anim/FlashCell";
import { CreditOverview } from "@/components/exchange/CreditOverview";
import { SimpleTrade } from "@/components/exchange/SimpleTrade";
import { useT, useLang } from "@/i18n/LangProvider";
import { isChinese } from "@/i18n/config";
import { tName, tProjectType, tCountry, tRegistry } from "@/i18n/data";
import { usePolling } from "@/hooks/usePolling";
import { terminalHref } from "@/lib/market/navigation";
import { useAccountStatus, useMe } from "@/lib/market/account-store";

/** 盘口一档;orders = 该档挂单数(getOrderBook 已带,本页不显示) */
type Level = { price: number; quantity: number; orders?: number };
type MarketData = {
  asset: {
    id: string;
    symbol: string;
    name: string;
    standard: string;
    projectType: string;
    vintage: number;
    country: string;
    registry: string;
    lastPrice: number | null;
    isScenario: boolean;
    methodology: string | null;
    verificationStatus: string | null;
  };
  stats: {
    high24h: number | null;
    low24h: number | null;
    vol24h: number;
    change24h: number | null;
  };
  book: { bids: Level[]; asks: Level[] };
  holding: { quantity: number; locked: number } | null;
  /** 可用现金(整数分), 仅登录态响应携带 */
  cashBalance?: number;
};

/**
 * 旧标的页的内容(计划 §3.1 末段、§9.1 第 23 条):总览 + 简易交易原样保留,继续承接 ?tab=trade&side=BUY|SELL;数据在客户端轮询。
 * 原来的高级交易分支已收口到终端:tab=trade 且(mode=advanced 或情景标的)的请求由 page.tsx 在服务端跳到 /trade/<symbol>?side=<side>
 * (站内点「交易」页签也是一次 RSC 请求,同样在服务端跳),到不了这里;「高级」按钮直接链到终端。
 */
export function MarketContent({ symbol }: { symbol: string }) {
  const t = useT("market");
  const { lang } = useLang();
  const zh = isChinese(lang);
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams();
  const view = search.get("tab") === "trade" ? "trade" : "overview";
  const initialSide = search.get("side") === "SELL" ? "SELL" : "BUY";
  const viewHref = (nextView: "overview" | "trade") => {
    const query = new URLSearchParams(search.toString());
    if (nextView === "trade") query.set("tab", "trade");
    else query.delete("tab");
    return `${pathname}${query.size ? `?${query.toString()}` : ""}`;
  };
  const changeSide = (side: "BUY" | "SELL") => {
    const query = new URLSearchParams(search.toString());
    query.set("tab", "trade");
    query.set("side", side);
    router.replace(`${pathname}?${query.toString()}`, { scroll: false });
  };
  const [data, setData] = useState<MarketData | null>(null);
  const [err, setErr] = useState("");
  // 登录态读共享的账户 store(不再自己拉 /api/auth/me):null = 还不知道(SSR 与水合首帧 store 是 idle,与原来的初值一致)
  const me = useMe();
  const accountStatus = useAccountStatus();
  const loggedIn: boolean | null = accountStatus === "ready" ? !!me : accountStatus === "anon" ? false : null;

  const load = useCallback(async () => {
    try {
      const d = await api<MarketData>(`/api/assets/${symbol}`);
      setData(d);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
      throw e;
    }
  }, [symbol]);

  // 可见性感知轮询(后台自动暂停);切换标的时立即重启刷新
  usePolling(load, 2000, symbol);

  // 只有还没拿到过数据时才整页报错;已有数据时轮询失败不能卸载页面(否则下单表单会被打断)
  if (!data) {
    if (err) return <div className="text-danger p-8 text-center">{err}</div>;
    return <div className="text-muted p-8 text-center">{t.loading}</div>;
  }

  const { asset, stats, book, holding } = data;

  return (
    <div className="space-y-4">
      <nav
        aria-label={zh ? "面包屑导览" : "Breadcrumb"}
        className="flex items-center gap-2 text-xs text-muted"
      >
        <Link href="/" className="hover:text-accent">
          {zh ? "市场" : "Marketplace"}
        </Link>
        <span aria-hidden="true">/</span>
        <span>{asset.symbol}</span>
      </nav>
      {err && <div className="text-danger text-sm">{t.refreshFailed}</div>}

      <header className="rounded-panel border border-border bg-surface shadow-card p-5 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold">{asset.symbol}</h1>
            <span className="rounded bg-surface-2 border border-border px-2 py-0.5 text-xs">
              {asset.standard}
            </span>
            <span className="rounded-chip bg-accent/10 border border-accent/20 px-2 py-0.5 text-xs text-accent">
              {asset.isScenario
                ? zh
                  ? "配额／指数情景"
                  : "Allowance / index scenario"
                : zh
                  ? "示范碳信用"
                  : "Demo carbon credit"}
            </span>
          </div>
          <div className="text-muted text-sm">
            {tName(asset.symbol, asset.name, lang)}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted">{t.lastPrice}</div>
          <div className="flex items-baseline gap-2">
            <FlashCell
              value={asset.lastPrice}
              className="inline-block px-1 -mx-1"
            >
              <span className="tnum text-2xl font-semibold text-accent">
                {asset.lastPrice == null ? (
                  "—"
                ) : (
                  <>
                    $<NumberTicker value={asset.lastPrice} />
                  </>
                )}
              </span>
            </FlashCell>
            {stats.change24h != null && (
              <span
                className={`tnum text-xs px-1.5 py-0.5 rounded font-medium ${stats.change24h >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}
              >
                {stats.change24h >= 0 ? "+" : ""}
                {stats.change24h.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
        <div className="text-sm space-y-0.5">
          <div className="text-xs text-muted">{t.high24h}</div>
          <div className="tnum">
            <span className="text-up">
              {stats.high24h == null ? "—" : fmtMoney(stats.high24h)}
            </span>
            <span className="mx-1 text-muted">/</span>
            <span className="text-down">
              {stats.low24h == null ? "—" : fmtMoney(stats.low24h)}
            </span>
            <span className="mx-1 text-muted">/</span>
            <span>
              {fmtQty(stats.vol24h)} {t.tonnes}
            </span>
          </div>
        </div>
        <div className="text-sm text-muted space-y-0.5">
          <div>
            {t.projectType}:{" "}
            <span className="text-foreground">
              {tProjectType(asset.projectType, lang)}
            </span>
          </div>
          <div>
            {asset.isScenario
              ? zh
                ? "情景参考年份"
                : "Scenario reference year"
              : t.vintage}
            : <span className="text-foreground">{asset.vintage}</span> ·{" "}
            {t.region}:{" "}
            <span className="text-foreground">
              {tCountry(asset.country, lang)}
            </span>
          </div>
          <div>
            {t.registry}:{" "}
            <span className="text-foreground">
              {tRegistry(asset.registry, lang)}
            </span>
          </div>
        </div>
        {asset.isScenario && (
          <p className="w-full text-[11px] leading-relaxed text-muted">
            {t.scenarioNote}
          </p>
        )}
      </header>

      <nav
        aria-label={zh ? "标的查看" : "Instrument view"}
        className="flex w-fit gap-1 rounded-control border border-border bg-surface p-1 text-sm font-medium"
      >
        <Link
          href={viewHref("overview")}
          scroll={false}
          aria-current={view === "overview" ? "page" : undefined}
          className={`rounded-chip px-5 py-2 transition-colors ${view === "overview" ? "bg-accent text-background" : "text-muted hover:text-foreground hover:bg-surface-2"}`}
        >
          {zh ? "总览" : "Overview"}
        </Link>
        <Link
          href={viewHref("trade")}
          scroll={false}
          aria-current={view === "trade" ? "page" : undefined}
          className={`rounded-chip px-5 py-2 transition-colors ${view === "trade" ? "bg-accent text-background" : "text-muted hover:text-foreground hover:bg-surface-2"}`}
        >
          {zh ? "交易" : "Trade"}
        </Link>
      </nav>

      {view === "overview" ? (
        <CreditOverview
          asset={asset}
          availableSupply={book.asks.reduce(
            (sum, level) => sum + level.quantity,
            0,
          )}
          holding={holding}
        />
      ) : (
        <>
          {/* 简易交易在本页;高级交易(限价 / 市价、盘口、K 线)是终端 /trade/<symbol>,方向随 ?side= 带过去 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1 rounded-control border border-border bg-surface p-1 text-sm">
              <Link
                href={`${pathname}?tab=trade&side=${initialSide}`}
                scroll={false}
                aria-current="page"
                className="rounded-chip px-4 py-1.5 transition-colors bg-accent/10 font-medium text-accent"
              >
                {zh ? "简易" : "Simple"}
              </Link>
              <Link
                href={terminalHref(asset.symbol, `side=${initialSide}`)}
                className="rounded-chip px-4 py-1.5 transition-colors text-muted hover:bg-surface-2"
              >
                {zh ? "高级" : "Advanced"}
              </Link>
            </div>
          </div>
          <SimpleTrade
            key={asset.id}
            asset={asset}
            asks={book.asks}
            bids={book.bids}
            holding={holding}
            cashBalance={data.cashBalance ?? null}
            loggedIn={loggedIn}
            initialSide={initialSide}
            onSideChange={changeSide}
            onDone={load}
          />
        </>
      )}
    </div>
  );
}
