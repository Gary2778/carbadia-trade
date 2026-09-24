"use client";

import { Suspense, use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { motion } from "motion/react";
import { api } from "@/lib/http/client";
import { fmtMoney, fmtQty } from "@/lib/format";
import { CandleChart } from "@/components/charts/CandleChart";
import { DepthChart } from "@/components/charts/DepthChart";
import { NumberTicker } from "@/components/anim/NumberTicker";
import { FlashCell } from "@/components/anim/FlashCell";
import { useToast } from "@/components/anim/Toast";
import { ComplianceNote } from "@/components/ComplianceNote";
import { CreditOverview } from "@/components/exchange/CreditOverview";
import { SimpleTrade } from "@/components/exchange/SimpleTrade";
import { useT, useLang, htmlLang } from "@/i18n/LangProvider";
import { isChinese } from "@/i18n/config";
import { tName, tProjectType, tCountry, tRegistry } from "@/i18n/data";
import { usePolling } from "@/hooks/usePolling";
import type { Candle, IntervalKey } from "@/lib/exchange/candles";

type Level = { price: number; quantity: number };
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
    description: string;
    lastPrice: number | null;
    isScenario: boolean;
  };
  stats: {
    high24h: number | null;
    low24h: number | null;
    vol24h: number;
    change24h: number | null;
  };
  book: { bids: Level[]; asks: Level[] };
  trades: { id: string; price: number; quantity: number; createdAt: string }[];
  holding: { quantity: number; locked: number } | null;
  myOrders: {
    id: string;
    side: string;
    type: string;
    price: number | null;
    quantity: number;
    filledQuantity: number;
    status: string;
  }[];
  /** 可用现金(整数分), 仅登录态响应携带 */
  cashBalance?: number;
};

const INTERVAL_TABS: { key: IntervalKey }[] = [
  { key: "1m" },
  { key: "5m" },
  { key: "1h" },
  { key: "1d" },
];

export default function MarketPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = use(params);
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-muted">Loading market…</div>
      }
    >
      <MarketContent key={symbol} symbol={symbol} />
    </Suspense>
  );
}

function MarketContent({ symbol }: { symbol: string }) {
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
  const advanced =
    data?.asset.isScenario === true || search.get("mode") === "advanced";
  const [candles, setCandles] = useState<Candle[]>([]);
  const [period, setPeriod] = useState<IntervalKey>("1m");
  const [tab, setTab] = useState<"candles" | "depth">("candles");
  const [err, setErr] = useState("");
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  // K 线加载/失败小指示: candlesReady 在切周期时归位 false, 成功拉到当前周期数据后为 true
  const [candlesReady, setCandlesReady] = useState(false);
  const [candleErr, setCandleErr] = useState(false);
  // 下单类型提升到页面级: 订单簿点价回填(2.7)需要知道当前是否限价模式
  const [orderType, setOrderType] = useState<"LIMIT" | "MARKET">("LIMIT");
  // 订单簿点价回填载荷: 每次点击都是新对象, 同价重复点也能触发回填
  const [prefill, setPrefill] = useState<{ price: number } | null>(null);

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

  const loadCandles = useCallback(async () => {
    if (view !== "trade" || !advanced) return;
    try {
      const d = await api<{ candles: Candle[] }>(
        `/api/assets/${symbol}/candles?interval=${period}`,
      );
      setCandles(d.candles);
      setCandlesReady(true);
      setCandleErr(false);
    } catch (e) {
      /* 图表数据失败不打断页面(容器角落小字提示),但仍需上抛让轮询退避感知失败 */
      setCandleErr(true);
      throw e;
    }
  }, [symbol, period, view, advanced]);

  useEffect(() => {
    api("/api/auth/me")
      .then((u) => setLoggedIn(!!u))
      .catch(() => setLoggedIn(false));
  }, []);

  // 可见性感知轮询(后台自动暂停);切换标的/周期时立即重启刷新
  usePolling(load, 2000, symbol);
  usePolling(loadCandles, 5000, `${symbol}:${period}:${view}:${advanced}`);

  // 只有还没拿到过数据时才整页报错;已有数据时轮询失败不能卸载页面(否则下单表单会被打断)
  if (!data) {
    if (err) return <div className="text-down p-8 text-center">{err}</div>;
    return <div className="text-muted p-8 text-center">{t.loading}</div>;
  }

  const { asset, stats, book, trades, holding, myOrders } = data;
  const maxDepth = Math.max(
    1,
    ...book.bids.map((b) => b.quantity),
    ...book.asks.map((a) => a.quantity),
  );
  // 订单簿点价回填: 仅登录且限价模式下可点(市价单没有价格输入框, 点击不动作)
  const bookPriceClick =
    loggedIn && orderType === "LIMIT"
      ? (price: number) => setPrefill({ price })
      : undefined;

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
      {err && <div className="text-down text-sm">{t.refreshFailed}</div>}

      <header className="rounded-2xl border border-border bg-surface shadow-card p-5 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold">{asset.symbol}</h1>
            <span className="rounded bg-surface-2 border border-border px-2 py-0.5 text-xs">
              {asset.standard}
            </span>
            <span className="rounded-full bg-accent/10 border border-accent/20 px-2 py-0.5 text-xs text-accent">
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
        className="flex w-fit gap-1 rounded-full border border-border bg-surface p-1 text-sm font-medium"
      >
        <Link
          href={viewHref("overview")}
          scroll={false}
          aria-current={view === "overview" ? "page" : undefined}
          className={`rounded-full px-5 py-2 transition-colors ${view === "overview" ? "bg-accent text-background" : "text-muted hover:text-foreground hover:bg-surface-2"}`}
        >
          {zh ? "总览" : "Overview"}
        </Link>
        <Link
          href={viewHref("trade")}
          scroll={false}
          aria-current={view === "trade" ? "page" : undefined}
          className={`rounded-full px-5 py-2 transition-colors ${view === "trade" ? "bg-accent text-background" : "text-muted hover:text-foreground hover:bg-surface-2"}`}
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            {asset.isScenario ? (
              <p className="max-w-3xl text-sm leading-6 text-muted">
                {zh
                  ? "配额与指数情景仅提供高级模拟交易，并非可供注销的自愿性碳信用。"
                  : "Allowance and index scenarios use the advanced demo terminal. They are not voluntary credits available for retirement."}
              </p>
            ) : (
              <div className="flex gap-1 rounded-full border border-border bg-surface p-1 text-sm">
                <Link
                  href={`${pathname}?tab=trade&side=${initialSide}`}
                  scroll={false}
                  aria-current={!advanced ? "page" : undefined}
                  className={`rounded-full px-4 py-1.5 transition-colors ${!advanced ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-surface-2"}`}
                >
                  {zh ? "简易" : "Simple"}
                </Link>
                <Link
                  href={`${pathname}?tab=trade&side=${initialSide}&mode=advanced`}
                  scroll={false}
                  aria-current={advanced ? "page" : undefined}
                  className={`rounded-full px-4 py-1.5 transition-colors ${advanced ? "bg-accent/10 font-medium text-accent" : "text-muted hover:bg-surface-2"}`}
                >
                  {zh ? "高级" : "Advanced"}
                </Link>
              </div>
            )}
            {advanced && (
              <p className="text-xs text-muted">
                {zh
                  ? "限价单、市价单及市场深度"
                  : "Limit orders, market orders and market depth"}
              </p>
            )}
          </div>
          {!advanced ? (
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
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
                {/* 左侧: 图表 + 最近成交(<lg 时排到右栏之后, 让下单动线优先; 桌面顺序不变) */}
                <div className="lg:col-span-2 space-y-4 order-2 lg:order-1">
                  <div className="rounded-2xl border border-border bg-surface shadow-card">
                    <div className="px-4 py-2 border-b border-border flex items-center gap-1">
                      <div
                        role="group"
                        aria-label={`${t.candles} / ${t.depth}`}
                        className="flex items-center gap-1"
                      >
                        {(["candles", "depth"] as const).map((tabKey) => (
                          <button
                            key={tabKey}
                            onClick={() => setTab(tabKey)}
                            aria-pressed={tab === tabKey}
                            className="relative px-3 py-1.5 text-sm rounded-full"
                          >
                            {tab === tabKey && (
                              <motion.span
                                layoutId="chart-tab"
                                className="absolute inset-0 bg-surface-2 rounded-full"
                                transition={{
                                  type: "spring",
                                  stiffness: 380,
                                  damping: 32,
                                }}
                              />
                            )}
                            <span
                              className={`relative ${tab === tabKey ? "text-foreground font-medium" : "text-muted"}`}
                            >
                              {tabKey === "candles" ? t.candles : t.depth}
                            </span>
                          </button>
                        ))}
                      </div>
                      {tab === "candles" && (
                        <div
                          role="group"
                          aria-label={t.candles}
                          className="ms-auto flex gap-1"
                        >
                          {INTERVAL_TABS.map((it) => (
                            <button
                              key={it.key}
                              onClick={() => {
                                if (period === it.key) return;
                                setPeriod(it.key);
                                // 切周期先清旧图: 避免新周期标签下挂着旧周期数据(STATES-10)
                                setCandles([]);
                                setCandlesReady(false);
                                setCandleErr(false);
                              }}
                              aria-pressed={period === it.key}
                              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                                period === it.key
                                  ? "bg-surface-2 text-foreground border border-border"
                                  : "text-muted hover:text-foreground"
                              }`}
                            >
                              {t.intervals[it.key]}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="p-3 relative">
                      {/* K 线拉取中/失败的角落小指示: 不打断页面, 只在图表容器右上角提示 */}
                      {tab === "candles" && candleErr && (
                        <span className="absolute top-2 end-3 text-xs text-down">
                          {t.refreshFailed}
                        </span>
                      )}
                      {tab === "candles" && !candleErr && !candlesReady && (
                        <span className="absolute top-2 end-3 text-xs text-muted">
                          {t.loading}
                        </span>
                      )}
                      {tab === "candles" ? (
                        <CandleChart
                          candles={candles}
                          lastPrice={asset.lastPrice}
                          ariaLabel={`${t.candles} · ${t.intervals[period]}`}
                        />
                      ) : (
                        <DepthChart
                          bids={book.bids}
                          asks={book.asks}
                          ariaLabel={t.depth}
                        />
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border bg-surface shadow-card">
                    <div className="px-4 py-2.5 border-b border-border font-semibold text-sm">
                      {t.recentTrades}
                    </div>
                    <div className="p-2">
                      <div className="grid grid-cols-3 text-xs text-muted px-2 pb-1">
                        <span>{t.price}</span>
                        <span className="text-end">{t.quantity}</span>
                        <span className="text-end">{t.time}</span>
                      </div>
                      <div className="max-h-[280px] overflow-y-auto">
                        {trades.length === 0 ? (
                          <div className="text-center text-muted text-sm py-8">
                            {t.noTrades}
                          </div>
                        ) : (
                          trades.map((tr) => (
                            <motion.div
                              key={tr.id}
                              className="grid grid-cols-3 text-xs tnum px-2 py-1 hover:bg-surface-2 rounded"
                              initial={{ opacity: 0, x: -8 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ duration: 0.3 }}
                            >
                              <span className="text-accent">
                                {fmtMoney(tr.price)}
                              </span>
                              <span className="text-end">
                                {fmtQty(tr.quantity)}
                              </span>
                              <span className="text-end text-muted">
                                {new Date(tr.createdAt).toLocaleTimeString(
                                  htmlLang(lang),
                                  { hour12: false },
                                )}
                              </span>
                            </motion.div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* 右侧: 订单簿 + 下单(<lg 时整体排到 K 线图之前) */}
                <div className="space-y-4 order-1 lg:order-2">
                  <div className="rounded-2xl border border-border bg-surface shadow-card">
                    <div className="px-4 py-2.5 border-b border-border font-semibold text-sm">
                      {t.orderBook}
                    </div>
                    <div className="p-2">
                      <DepthSide
                        levels={book.asks}
                        side="ask"
                        max={maxDepth}
                        reverse
                        onPriceClick={bookPriceClick}
                      />
                      <div className="py-2 px-2 my-1 border-y border-border tnum text-center text-lg font-semibold">
                        <FlashCell
                          value={asset.lastPrice}
                          className="inline-block px-2 -mx-2"
                        >
                          {asset.lastPrice == null ? (
                            <span className="text-muted text-sm">
                              {t.noTradesYet}
                            </span>
                          ) : (
                            `$${fmtMoney(asset.lastPrice)}`
                          )}
                        </FlashCell>
                      </div>
                      <DepthSide
                        levels={book.bids}
                        side="bid"
                        max={maxDepth}
                        onPriceClick={bookPriceClick}
                      />
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border bg-surface shadow-card">
                    <div className="px-4 py-2.5 border-b border-border font-semibold text-sm">
                      {t.placeOrder}
                    </div>
                    <div className="p-4">
                      {loggedIn === false ? (
                        <div className="text-center text-muted text-sm py-8">
                          {t.loginPrefix}
                          <Link
                            href={`/login?returnTo=${encodeURIComponent(viewHref("trade"))}`}
                            className="text-accent mx-1"
                          >
                            {t.login}
                          </Link>
                          {t.loginSuffix}
                        </div>
                      ) : (
                        <OrderForm
                          key={asset.id}
                          assetId={asset.id}
                          initialSide={initialSide}
                          onSideChange={changeSide}
                          asks={book.asks}
                          bids={book.bids}
                          holding={holding}
                          cashBalance={data.cashBalance ?? null}
                          type={orderType}
                          onTypeChange={setOrderType}
                          prefillPrice={prefill}
                          onDone={load}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {/* 我的挂单 */}
              {loggedIn && (
                <div className="rounded-2xl border border-border bg-surface shadow-card">
                  <div className="px-4 py-2.5 border-b border-border font-semibold text-sm flex items-center justify-between">
                    <span>{t.myOpenOrders}</span>
                    {holding && (
                      <span className="text-xs text-muted">
                        {t.position} {fmtQty(holding.quantity)} {t.tonnes}(
                        {t.locked} {fmtQty(holding.locked)})
                      </span>
                    )}
                  </div>
                  {myOrders.length === 0 ? (
                    <div className="text-center text-muted text-sm py-6">
                      {t.noOpenOrders}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="text-muted text-xs">
                        <tr className="border-b border-border">
                          <th className="text-start px-4 py-2 font-medium">
                            {t.side}
                          </th>
                          <th className="text-start px-3 py-2 font-medium">
                            {t.type}
                          </th>
                          <th className="text-end px-3 py-2 font-medium">
                            {t.price}
                          </th>
                          <th className="text-end px-3 py-2 font-medium">
                            {t.filledTotal}
                          </th>
                          <th className="text-end px-4 py-2 font-medium">
                            {t.action}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {myOrders.map((o) => (
                          <tr key={o.id} className="border-b border-border/40">
                            <td
                              className={`px-4 py-2 font-medium ${o.side === "BUY" ? "text-up" : "text-down"}`}
                            >
                              {o.side === "BUY" ? t.buy : t.sell}
                            </td>
                            <td className="px-3 py-2 text-muted">
                              {o.type === "LIMIT" ? t.limit : t.market}
                            </td>
                            <td className="px-3 py-2 text-end tnum">
                              {o.price == null ? t.market : fmtMoney(o.price)}
                            </td>
                            <td className="px-3 py-2 text-end tnum">
                              {fmtQty(o.filledQuantity)} / {fmtQty(o.quantity)}
                            </td>
                            <td className="px-4 py-2 text-end">
                              <CancelOrderBtn id={o.id} onDone={load} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function DepthSide({
  levels,
  side,
  max,
  reverse,
  onPriceClick,
}: {
  levels: Level[];
  side: "bid" | "ask";
  max: number;
  reverse?: boolean;
  /** 限价模式下点价回填下单表单; 未传时(市价/未登录)行不可交互 */
  onPriceClick?: (price: number) => void;
}) {
  const t = useT("market");
  const rows = reverse ? [...levels].reverse() : levels;
  const color = side === "bid" ? "text-up" : "text-down";
  const bar = side === "bid" ? "bg-up/10" : "bg-down/10";
  return (
    <div>
      {rows.length === 0 && (
        <div className="text-center text-muted text-xs py-3">{t.noOrders}</div>
      )}
      {rows.map((l) => (
        <motion.div
          key={l.price}
          className={`relative grid grid-cols-2 text-xs tnum px-2 py-1 ${
            onPriceClick ? "cursor-pointer hover:bg-surface-2 rounded" : ""
          }`}
          role={onPriceClick ? "button" : undefined}
          tabIndex={onPriceClick ? 0 : undefined}
          onClick={onPriceClick ? () => onPriceClick(l.price) : undefined}
          onKeyDown={
            onPriceClick
              ? (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onPriceClick(l.price);
                  }
                }
              : undefined
          }
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
        >
          <motion.div
            className={`absolute inset-y-0 end-0 ${bar}`}
            animate={{ width: `${(l.quantity / max) * 100}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 22 }}
          />
          <span className={`relative ${color}`}>{fmtMoney(l.price)}</span>
          <span className="relative text-end">{fmtQty(l.quantity)}</span>
        </motion.div>
      ))}
    </div>
  );
}

// 市价单参考总额: 按订单簿逐档吃单估算(分); 深度不足以覆盖数量时返回 null
function estimateMarketTotal(levels: Level[], qty: number): number | null {
  let remaining = qty;
  let total = 0;
  for (const l of levels) {
    const take = Math.min(remaining, l.quantity);
    total += take * l.price;
    remaining -= take;
    if (remaining <= 0) return total;
  }
  return null;
}

function OrderForm({
  assetId,
  initialSide,
  onSideChange,
  asks,
  bids,
  holding,
  cashBalance,
  type,
  onTypeChange,
  prefillPrice,
  onDone,
}: {
  assetId: string;
  initialSide: "BUY" | "SELL";
  onSideChange: (side: "BUY" | "SELL") => void;
  asks: Level[];
  bids: Level[];
  holding: { quantity: number; locked: number } | null;
  /** 可用现金(整数分); 未登录/旧响应缺省为 null */
  cashBalance: number | null;
  type: "LIMIT" | "MARKET";
  onTypeChange: (type: "LIMIT" | "MARKET") => void;
  /** 订单簿点价回填载荷(每次点击都是新对象) */
  prefillPrice: { price: number } | null;
  onDone: () => void;
}) {
  const t = useT("market");
  const tp = useT("portfolio");
  const toast = useToast();
  const side = initialSide;
  const [price, setPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // 内联错误: 拒单原因固定展示在提交按钮上方, toast 只作余光提醒(STATES-2)
  const [err, setErr] = useState("");

  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const available = holding ? holding.quantity - holding.locked : 0;

  // 订单簿点价回填(2.7): 渲染期比对 props 派生状态(React 官方模式, 不进 effect);
  // 对象引用每次点击都变, 同价重复点也生效; type 切回限价时不重放旧点击
  const [seenPrefill, setSeenPrefill] = useState<typeof prefillPrice>(null);
  if (prefillPrice !== seenPrefill) {
    setSeenPrefill(prefillPrice);
    if (prefillPrice && type === "LIMIT") {
      setPrice(String(prefillPrice.price / 100)); // API 返回分, 输入框是元
      setErr("");
    }
  }

  // 客户端校验(STATES-4): 整数且 ≥1, 卖出侧再限持仓可用量
  const qty = Number(quantity);
  const qtyValid = quantity !== "" && Number.isInteger(qty) && qty >= 1;
  const overAvailable = side === "SELL" && qtyValid && qty > available;
  const qtyReason =
    quantity !== "" && !qtyValid
      ? t.qtyInvalid
      : overAvailable
        ? t.qtyOverAvailable
        : "";

  // 元输入先换算成整数分再乘数量, 与后端结算完全一致(避免 Float 元乘法误差)
  const estTotal =
    type === "LIMIT" && price && quantity
      ? Math.round(Number(price) * 100) * Number(quantity)
      : null;
  // 市价单参考总额(STATES-6): BUY 吃卖盘, SELL 吃买盘; null = 订单簿深度不足
  const marketEst =
    type === "MARKET" && qtyValid
      ? estimateMarketTotal(side === "BUY" ? asks : bids, qty)
      : null;

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const res = await api<{ filledQty: number; order: { status: string } }>(
        "/api/orders",
        {
          method: "POST",
          body: JSON.stringify({
            assetId,
            side,
            type,
            price: type === "LIMIT" ? Math.round(Number(price) * 100) : null,
            quantity: Number(quantity),
          }),
        },
      );
      const statusLabel = t.status[res.order.status] ?? res.order.status;
      toast(
        "ok",
        res.filledQty > 0
          ? t.fillToast(res.filledQty, statusLabel)
          : t.openToast(statusLabel),
      );
      setQuantity("");
      setDone(true);
      setTimeout(() => setDone(false), 1200);
      onDone();
    } catch (e) {
      // 拒单原因是需要据此修改表单的关键信息: 内联常驻 + toast 余光提醒
      setErr((e as Error).message);
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div role="group" aria-label={t.side} className="grid grid-cols-2 gap-2">
        <button
          onClick={() => {
            onSideChange("BUY");
            setErr("");
          }}
          aria-pressed={side === "BUY"}
          className={`py-2.5 rounded-xl text-sm font-medium transition-colors ${side === "BUY" ? "bg-up text-background" : "bg-surface-2 text-muted hover:text-foreground"}`}
        >
          {t.buy}
        </button>
        <button
          onClick={() => {
            onSideChange("SELL");
            setErr("");
          }}
          aria-pressed={side === "SELL"}
          className={`py-2.5 rounded-xl text-sm font-medium transition-colors ${side === "SELL" ? "bg-down text-background" : "bg-surface-2 text-muted hover:text-foreground"}`}
        >
          {t.sell}
        </button>
      </div>

      <div role="group" aria-label={t.type} className="flex gap-2 text-xs">
        {(["LIMIT", "MARKET"] as const).map((typeKey) => (
          <button
            key={typeKey}
            onClick={() => {
              onTypeChange(typeKey);
              setErr("");
            }}
            aria-pressed={type === typeKey}
            className={`px-3 py-1 rounded ${type === typeKey ? "bg-surface-2 text-foreground border border-border" : "text-muted"}`}
          >
            {typeKey === "LIMIT" ? t.limit : t.market}
          </button>
        ))}
      </div>

      {type === "LIMIT" && (
        <label className="block">
          <span className="text-xs text-muted">{t.priceUnit}</span>
          <div className="flex gap-2 mt-1">
            <input
              type="number"
              value={price}
              onChange={(e) => {
                setPrice(e.target.value);
                setErr("");
              }}
              placeholder="0.00"
              min="0"
              step="0.01"
              className="flex-1 bg-surface-2 border border-border rounded-xl px-3.5 py-2.5 text-sm tnum outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => {
                const cp = side === "BUY" ? bestAsk : bestBid; // API 返回分, 输入框是元
                setPrice(cp != null ? String(cp / 100) : "");
              }}
              className="text-xs text-muted hover:text-foreground px-2 whitespace-nowrap"
            >
              {t.counterPrice}
            </button>
          </div>
        </label>
      )}

      <label className="block">
        <span className="text-xs text-muted">{t.quantityUnit}</span>
        <input
          type="number"
          value={quantity}
          onChange={(e) => {
            setQuantity(e.target.value);
            setErr("");
          }}
          placeholder="0"
          min="1"
          step="1"
          className="w-full mt-1 bg-surface-2 border border-border rounded-xl px-3.5 py-2.5 text-sm tnum outline-none focus:border-accent"
        />
        {/* 校验不通过时解释按钮为何禁用(STATES-4) */}
        {qtyReason && (
          <div className="text-xs text-muted mt-1">{qtyReason}</div>
        )}
        {side === "SELL" && (
          <button
            type="button"
            onClick={() => {
              setQuantity(String(available));
              setErr("");
            }}
            className="text-xs text-muted hover:text-foreground mt-1"
          >
            {t.available} {fmtQty(available)} {t.tonnes} · {t.max}
          </button>
        )}
        {/* 买入侧可用现金(STATES-12): 复用卖侧同款小字排; 点 Max 按参考价反推最大整数吨 */}
        {side === "BUY" && cashBalance != null && (
          <button
            type="button"
            onClick={() => {
              // 限价用限价、市价用最优卖价作参考价(均为整数分)
              const ref =
                type === "LIMIT" ? Math.round(Number(price) * 100) : bestAsk;
              if (!ref || ref <= 0) return;
              setQuantity(String(Math.floor(cashBalance / ref)));
              setErr("");
            }}
            className="text-xs text-muted hover:text-foreground mt-1"
          >
            {tp.availableCash} ${fmtMoney(cashBalance)} · {t.max}
          </button>
        )}
      </label>

      {estTotal != null && (
        <div className="text-xs text-muted flex justify-between">
          <span>{t.estTotal}</span>
          <span className="tnum text-foreground">${fmtMoney(estTotal)}</span>
        </div>
      )}

      {/* 市价单参考总额(STATES-6): 逐档吃单估算, 标 ≈; 深度不足时提示 */}
      {type === "MARKET" && qtyValid && (
        <div className="text-xs text-muted flex justify-between">
          <span>{t.estTotal}</span>
          {marketEst != null ? (
            <span className="tnum text-foreground">
              ≈ ${fmtMoney(marketEst)}
            </span>
          ) : (
            <span>{t.depthShort}</span>
          )}
        </div>
      )}

      {err && (
        <div aria-live="polite" className="text-down text-xs">
          {err}
        </div>
      )}

      <motion.button
        onClick={submit}
        disabled={
          busy || !qtyValid || overAvailable || (type === "LIMIT" && !price)
        }
        whileTap={{ scale: 0.97 }}
        animate={done ? { scale: [1, 1.04, 1] } : undefined}
        className={`w-full min-h-11 sm:min-h-0 py-3 rounded-full font-medium text-background disabled:opacity-40 transition-colors ${
          done ? "bg-accent" : side === "BUY" ? "bg-up" : "bg-down"
        }`}
      >
        {busy
          ? t.submitting
          : done
            ? `✓ ${t.submitted}`
            : side === "BUY"
              ? t.buy
              : t.sell}
      </motion.button>
      <ComplianceNote className="text-center" />
    </div>
  );
}

function CancelOrderBtn({ id, onDone }: { id: string; onDone: () => void }) {
  const t = useT("market");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // 移动端命中区扩到 44px(负 margin 吃掉多出的占位, 行高不变); sm 以上维持现状
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/api/orders/${id}`, { method: "DELETE" });
          toast("ok", t.cancelled);
          onDone();
        } catch (e) {
          toast("err", (e as Error).message);
          setBusy(false);
        }
      }}
      className="text-xs text-muted hover:text-down disabled:opacity-40 inline-flex items-center justify-center min-h-11 min-w-11 -my-2 sm:min-h-0 sm:min-w-0 sm:my-0"
    >
      {t.cancel}
    </button>
  );
}
