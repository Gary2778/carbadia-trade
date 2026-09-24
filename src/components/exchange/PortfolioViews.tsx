"use client";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { htmlLang, useLang, useT } from "@/i18n/LangProvider";
import { tName, tCountry } from "@/i18n/data";
import { api, ApiError } from "@/lib/http/client";
import { fmtMoney, fmtQty, fmtTime } from "@/lib/format";
import { NumberTicker } from "@/components/anim/NumberTicker";
import { Reveal } from "@/components/anim/Reveal";
import { useToast } from "@/components/anim/Toast";
import { getCreditProfile } from "@/lib/exchange/carbon";
import { useExchangeText, useMarket, useWatchlist } from "./useExchange";
import { ExchangeIcon } from "./ExchangeIcon";
import { Stat } from "./MarketPlace";
import { TableViewport } from "./TableViewport";
import {
  usePortfolio,
  AccountGate,
  type Position,
  type AccountPortfolio,
} from "./AccountData";
export function PortfolioViews({ dashboard = false }: { dashboard?: boolean }) {
  const c = useExchangeText();
  const t = useT("portfolio");
  const p = usePortfolio();
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">
            {dashboard
              ? c("Your carbon overview", "碳资产总览")
              : t.myPortfolio}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <Link
            href="/"
            className="rounded-full bg-accent px-4 py-2 font-medium text-background hover:bg-accent-strong"
          >
            {c("Buy carbon credits", "买入碳信用")}
          </Link>
        </div>
      </div>
      <nav
        aria-label={c("Portfolio tools", "资产工具")}
        className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted"
      >
        {[
          ["/orders", t.openOrders],
          ["/transactions", c("Transactions", "资产流水")],
          ["/retirement", c("Retire credits", "注销碳信用")],
          ["/account", c("Account", "账户")],
          [
            dashboard ? "/portfolio" : "/dashboard",
            dashboard ? t.myPortfolio : c("Account overview", "账户总览"),
          ],
        ].map(([href, label]) => (
          <Link key={href} href={href} className="py-1 hover:text-accent">
            {label}
          </Link>
        ))}
      </nav>
      {p.unauthorized || !p.data ? (
        <AccountGate
          error={p.error}
          loading={!p.loaded}
          unauthorized={p.unauthorized}
          retry={p.reload}
          returnTo={dashboard ? "/dashboard" : "/portfolio"}
        />
      ) : (
        <>
          {p.error && (
            <div className="ex-error" role="alert">
              {c(
                "Refresh failed. Showing last received account data.",
                "更新失败，显示最近账户数据。",
              )}
            </div>
          )}
          {dashboard ? (
            <div className="ex-market-stats ex-large-value-stats">
              <Stat
                label={c("Total portfolio value", "资产总值")}
                value={`$${fmtMoney(p.data.totalAssets)}`}
                note={
                  p.data.valuationComplete
                    ? c(
                        "Cash + marked holdings · demo USD",
                        "现金与持仓市值 · 模拟美元",
                      )
                    : c(
                        "Partial valuation: unpriced holdings excluded",
                        "部分估值：不含无报价持仓",
                      )
                }
                icon="portfolio"
              />
              <Stat
                label={c("Carbon credits held", "持有碳信用")}
                value={fmtQty(p.data.heldCredits)}
                unit={c("credits", "份")}
                note={c(
                  `${fmtQty(p.data.heldCredits)} nominal tCO₂e · not retired`,
                  `${fmtQty(p.data.heldCredits)} 名义 tCO₂e · 未注销`,
                )}
                icon="layers"
              />
              <Stat
                label={c("Credits retired", "已注销碳信用")}
                value={fmtQty(p.data.retiredCredits)}
                unit={c("credits", "份")}
                note={c(
                  "Simulated retirements · no offset claim",
                  "模拟注销 · 非真实抵换",
                )}
                icon="retire"
              />
              <Stat
                label={c("Available cash", "可用现金")}
                value={`$${fmtMoney(p.data.cashBalance)}`}
                note={c(
                  `$${fmtMoney(p.data.lockedCash)} reserved for orders`,
                  `$${fmtMoney(p.data.lockedCash)} 已保留予挂单`,
                )}
                icon="account"
              />
            </div>
          ) : (
            <>
              <Reveal>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <MoneyStat
                    label={t.totalAssets}
                    value={p.data.totalAssets}
                    accent
                  />
                  <MoneyStat
                    label={t.availableCash}
                    value={p.data.cashBalance}
                  />
                  <MoneyStat label={t.lockedCash} value={p.data.lockedCash} />
                  <MoneyStat
                    label={t.holdingsValue}
                    value={p.data.holdingsValue}
                  />
                </div>
              </Reveal>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
                <span>
                  {c("Carbon credits held", "持有碳信用")}:{" "}
                  <strong className="tnum font-medium text-foreground">
                    {fmtQty(p.data.heldCredits)}
                  </strong>{" "}
                  {c("nominal tCO₂e", "名义 tCO₂e")}
                </span>
                <Link href="/retirement" className="hover:text-accent">
                  {c("Credits retired", "已注销碳信用")}:{" "}
                  <strong className="tnum font-medium text-foreground">
                    {fmtQty(p.data.retiredCredits)}
                  </strong>
                </Link>
                <span>
                  {c("Demo funds and simulated credits", "模拟资金与碳信用")}
                </span>
              </div>
              {!p.data.valuationComplete && (
                <p role="status" className="text-xs text-muted">
                  {c(
                    "Partial valuation: holdings without a current price are excluded from the totals.",
                    "部分估值：总额不含缺少目前报价的持仓。",
                  )}
                </p>
              )}
            </>
          )}
          {dashboard ? (
            <DashboardBody data={p.data} />
          ) : (
            <>
              <Reveal delay={0.05}>
                <Holdings positions={p.data.positions} />
              </Reveal>
              <PortfolioActivity
                data={p.data}
                reload={p.reload}
                expireSession={p.expireSession}
              />
              <details className="rounded-2xl border border-border bg-surface shadow-card">
                <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
                  {c("Portfolio composition & performance", "资产配置与表现")}
                </summary>
                <div className="grid gap-4 border-t border-border p-4 lg:grid-cols-2">
                  <Allocation positions={p.data.positions} />
                  <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
                    <div className="mb-4 flex items-center justify-between gap-3 text-sm font-semibold">
                      <h2 className="text-sm">
                        {c("Portfolio performance", "资产表现")}
                      </h2>
                      <ExchangeIcon name="research" size={18} />
                    </div>
                    <p className="ex-muted">
                      {c("Unrealised profit / loss", "未实现损益")}
                    </p>
                    <div
                      className={`tnum my-3 text-xl font-semibold ${p.data.unrealisedPnl == null ? "" : p.data.unrealisedPnl >= 0 ? "text-up" : "text-down"}`}
                    >
                      {p.data.unrealisedPnl == null
                        ? "—"
                        : `${p.data.unrealisedPnl >= 0 ? "+" : "−"}$${fmtMoney(Math.abs(p.data.unrealisedPnl))}`}
                    </div>
                    <p className="ex-muted leading-relaxed">
                      {c(
                        "Weighted-average remaining acquisition cost. Granted credits or an incomplete ledger have no reliable cost basis; their P&L is not estimated.",
                        "以移动加权平均成本计算。赠送信用或不完整帐本无可靠成本基础，因此不估算损益。",
                      )}
                    </p>
                    <div className="border-t border-border mt-5 pt-4 flex justify-between text-xs">
                      <span className="text-muted">
                        {c("24h portfolio change", "24 小时资产变化")}
                      </span>
                      <span
                        title={c(
                          "Account valuation history is not available.",
                          "没有账户历史估值。",
                        )}
                      >
                        —
                      </span>
                    </div>
                  </div>
                </div>
              </details>
            </>
          )}
        </>
      )}
    </div>
  );
}
function MoneyStat({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={`tnum mt-1 break-all text-lg font-semibold ${accent ? "text-accent" : ""}`}
      >
        $<NumberTicker value={value} />
      </div>
    </div>
  );
}

function PortfolioCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function PortfolioTable({
  label,
  head,
  children,
}: {
  label: string;
  head: string[];
  children: ReactNode;
}) {
  return (
    <TableViewport label={label} className="overflow-x-auto">
      <table className="w-full whitespace-nowrap text-sm">
        <thead className="text-xs text-muted">
          <tr className="border-b border-border">
            {head.map((label, index) => (
              <th
                scope="col"
                key={label}
                className={`px-3 py-2 font-medium ${index === 0 ? "px-4 text-start" : "text-end"}`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </TableViewport>
  );
}

function PortfolioActivity({
  data,
  reload,
  expireSession,
}: {
  data: AccountPortfolio;
  reload: () => Promise<void>;
  expireSession: () => void;
}) {
  const t = useT("portfolio");
  const c = useExchangeText();
  const { lang } = useLang();
  return (
    <>
      <Reveal delay={0.1}>
        <PortfolioCard
          title={t.openOrders}
          action={
            <Link
              href="/orders"
              className="text-xs text-accent hover:underline"
            >
              {c("All orders", "完整订单记录")} →
            </Link>
          }
        >
          {data.openOrders.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">
              {t.noOpenOrders}
            </p>
          ) : (
            <PortfolioTable
              label={t.openOrders}
              head={[
                t.instrument,
                t.side,
                t.type,
                t.price,
                t.filledTotal,
                c("Status", "状态"),
                t.action,
              ]}
            >
              {data.openOrders.map((order) => (
                <tr
                  key={order.id}
                  className="border-b border-border/40 last:border-b-0 hover:bg-surface-2"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/market/${order.asset.symbol}`}
                      className="font-medium hover:text-accent"
                    >
                      {order.asset.symbol}
                    </Link>
                    <div className="max-w-[200px] truncate text-xs text-muted">
                      {tName(order.asset.symbol, order.asset.name, lang)}
                    </div>
                  </td>
                  <td
                    className={`px-3 py-2.5 text-end font-medium ${order.side === "BUY" ? "text-up" : "text-down"}`}
                  >
                    {order.side === "BUY" ? t.buy : t.sell}
                  </td>
                  <td className="px-3 py-2.5 text-end text-muted">
                    {order.type === "LIMIT" ? t.limit : t.market}
                  </td>
                  <td className="tnum px-3 py-2.5 text-end">
                    {order.price == null
                      ? t.market
                      : `$${fmtMoney(order.price)}`}
                  </td>
                  <td className="tnum px-3 py-2.5 text-end">
                    {fmtQty(order.filledQuantity)} / {fmtQty(order.quantity)}
                  </td>
                  <td className="px-3 py-2.5 text-end text-xs text-muted">
                    {order.status === "PARTIAL"
                      ? c("Partially filled", "部分成交")
                      : c("Open", "待成交")}
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    <CancelPositionAction
                      url={`/api/orders/${order.id}`}
                      label={t.cancel}
                      recordName={order.asset.symbol}
                      onDone={reload}
                      onUnauthorized={expireSession}
                    />
                  </td>
                </tr>
              ))}
            </PortfolioTable>
          )}
        </PortfolioCard>
      </Reveal>
      {data.otcListings.length > 0 && (
        <Reveal delay={0.15}>
          <PortfolioCard
            title={t.myOtcListings}
            action={
              <Link
                href="/otc"
                className="text-xs text-accent hover:underline"
              >
                {c("OTC market", "OTC 市场")} →
              </Link>
            }
          >
            <PortfolioTable
              label={t.myOtcListings}
              head={[t.instrument, t.unitPrice, t.availableTonnes, t.action]}
            >
              {data.otcListings.map((listing) => (
                <tr
                  key={listing.id}
                  className="border-b border-border/40 last:border-b-0 hover:bg-surface-2"
                >
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/market/${listing.asset.symbol}`}
                      className="font-medium hover:text-accent"
                    >
                      {listing.asset.symbol}
                    </Link>
                    <div className="max-w-[200px] truncate text-xs text-muted">
                      {tName(listing.asset.symbol, listing.asset.name, lang)}
                    </div>
                  </td>
                  <td className="tnum px-3 py-2.5 text-end text-accent">
                    ${fmtMoney(listing.pricePerUnit)}
                  </td>
                  <td className="tnum px-3 py-2.5 text-end">
                    {fmtQty(listing.quantity)}
                  </td>
                  <td className="px-4 py-2.5 text-end">
                    <CancelPositionAction
                      url={`/api/otc/${listing.id}`}
                      label={t.cancelListing}
                      recordName={listing.asset.symbol}
                      onDone={reload}
                      onUnauthorized={expireSession}
                    />
                  </td>
                </tr>
              ))}
            </PortfolioTable>
          </PortfolioCard>
        </Reveal>
      )}
      <Reveal delay={0.2}>
        <PortfolioCard
          title={t.tradeHistory}
          action={
            <Link
              href="/transactions"
              className="text-xs text-accent hover:underline"
            >
              {c("All account activity", "完整资产流水")} →
            </Link>
          }
        >
          {data.trades.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">{t.noTrades}</p>
          ) : (
            <>
              <PortfolioTable
                label={t.tradeHistory}
                head={[
                  t.time,
                  t.instrument,
                  t.side,
                  t.price,
                  t.qtyTonnes,
                  t.amount,
                ]}
              >
                {data.trades.map((trade) => (
                  <tr
                    key={trade.id}
                    className="border-b border-border/40 last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-2.5 text-xs text-muted">
                      {fmtTime(trade.createdAt, htmlLang(lang))}
                    </td>
                    <td className="px-3 py-2.5 text-end">
                      <Link
                        href={`/market/${trade.asset.symbol}`}
                        className="font-medium hover:text-accent"
                      >
                        {trade.asset.symbol}
                      </Link>
                    </td>
                    <td
                      className={`px-3 py-2.5 text-end font-medium ${trade.direction === "BUY" ? "text-up" : "text-down"}`}
                    >
                      {trade.direction === "BUY" ? t.buy : t.sell}
                    </td>
                    <td className="tnum px-3 py-2.5 text-end">
                      ${fmtMoney(trade.price)}
                    </td>
                    <td className="tnum px-3 py-2.5 text-end">
                      {fmtQty(trade.quantity)}
                    </td>
                    <td className="tnum px-4 py-2.5 text-end">
                      ${fmtMoney(trade.price * trade.quantity)}
                    </td>
                  </tr>
                ))}
              </PortfolioTable>
              <p className="border-t border-border px-4 py-2 text-[11px] text-muted">
                {c(
                  "Latest 30 matched trades. OTC settlements and retirement entries are available in account activity.",
                  "最近 30 笔撮合成交。OTC 结算与注销记录可于完整资产流水中查看。",
                )}
              </p>
            </>
          )}
        </PortfolioCard>
      </Reveal>
    </>
  );
}

function CancelPositionAction({
  url,
  label,
  recordName,
  onDone,
  onUnauthorized,
}: {
  url: string;
  label: string;
  recordName: string;
  onDone: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const t = useT("market");
  const toast = useToast();
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  async function cancel() {
    if (guard.current || completed) return;
    guard.current = true;
    setBusy(true);
    try {
      await api(url, { method: "DELETE" });
      setCompleted(true);
      toast("ok", t.cancelled);
      // A failed refresh must not overwrite a confirmed cancellation receipt.
      await onDone().catch(() => {});
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      else await onDone().catch(() => {});
      toast("err", (error as Error).message);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={cancel}
      disabled={busy || completed}
      aria-label={`${label}: ${recordName}`}
      className="-my-2 inline-flex min-h-11 min-w-11 items-center justify-center text-xs text-muted hover:text-down disabled:opacity-40 sm:my-0 sm:min-h-0 sm:min-w-0"
    >
      {completed ? t.cancelled : busy ? "…" : label}
    </button>
  );
}

function Allocation({ positions }: { positions: Position[] }) {
  const c = useExchangeText(),
    { lang } = useLang();
  const [group, setGroup] = useState("type");
  const credits = positions.filter((p) => !p.isScenario);
  const map = new Map<string, number>();
  for (const p of credits) {
    const pr = getCreditProfile(p);
    const key =
      group === "country"
        ? tCountry(p.country, lang)
        : group === "approach"
          ? c(pr.approach, pr.approachZh)
          : c(pr.category, pr.categoryZh);
    map.set(key, (map.get(key) || 0) + p.quantity);
  }
  const total = credits.reduce((s, p) => s + p.quantity, 0);
  const rows = [...map].sort((a, b) => b[1] - a[1]);
  const colors = [
    "#218c80",
    "#6a90ab",
    "#b49357",
    "#8474a1",
    "#79a297",
    "#a17b6e",
  ];
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-card">
      <div className="ex-panel-heading">
        <div>
          <h2>{c("Portfolio composition", "资产配置")}</h2>
          <p>
            {c(
              "Share of credits held · scenario units excluded",
              "按持有信用数量 · 不含情景单位",
            )}
          </p>
        </div>
        <select
          className="ex-select"
          value={group}
          aria-label={c("Group portfolio by", "资产分类方式")}
          onChange={(e) => setGroup(e.target.value)}
        >
          <option value="type">{c("Project type", "项目类型")}</option>
          <option value="country">{c("Geography", "地区")}</option>
          <option value="approach">{c("Credit type", "信用类型")}</option>
        </select>
      </div>
      {total === 0 ? (
        <div className="py-7">
          <p className="ex-muted mb-4">
            {c(
              "Your allocation will appear after your first credit purchase.",
              "首次买入碳信用后即可查看配置。",
            )}
          </p>
          <Link className="ex-learn-link" href="/">
            {c("Explore the marketplace", "探索碳信用市场")}
            <ExchangeIcon name="arrow" size={15} />
          </Link>
        </div>
      ) : (
        <>
          <div className="ex-allocation-bar" aria-hidden="true">
            {rows.map(([key, q], i) => (
              <div
                key={key}
                style={{
                  width: `${(q / total) * 100}%`,
                  background: colors[i % colors.length],
                }}
              />
            ))}
          </div>
          {rows.map(([key, q], i) => (
            <div className="ex-allocation-row" key={key}>
              <span
                className="ex-allocation-dot"
                style={{ background: colors[i % colors.length] }}
              />
              <span>{key}</span>
              <strong>
                {((q / total) * 100).toFixed(1)}%{" "}
                <span className="text-muted font-normal ms-2">{fmtQty(q)}</span>
              </strong>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
function Holdings({ positions }: { positions: Position[] }) {
  const c = useExchangeText(),
    { lang } = useLang();
  const t = useT("portfolio");
  const [search, setSearch] = useState("");
  const rows = positions.filter((p) =>
    `${p.symbol} ${tName(p.symbol, p.name, lang)}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{t.holdings}</h2>
        <label className="ex-search-field">
          <ExchangeIcon name="search" size={14} />
          <input
            aria-label={c("Search holdings", "搜索持仓")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={c("Search holdings", "搜索持仓")}
          />
        </label>
      </div>
      {rows.length === 0 ? (
        <div className="ex-empty">
          <ExchangeIcon name="portfolio" size={30} />
          <h2>
            {search
              ? c("No matching holdings", "没有符合条件的持仓")
              : t.noHoldings}
          </h2>
          <p>
            {search
              ? c(
                  "Try a different name or symbol.",
                  "请尝试其他项目名称或交易代码。",
                )
              : c(
                  "Explore a project, review its credit details, then buy with your demo balance.",
                  "探索项目、查看信用详情，再使用模拟余额买入。",
                )}
          </p>
          <Link href="/" className="ex-button primary">
            {t.noHoldingsCta}
          </Link>
        </div>
      ) : (
        <TableViewport label={t.holdings}>
          <table className="ex-table">
            <thead>
              <tr>
                {[
                  t.instrument,
                  c("Quantity / available", "数量／可用"),
                  c("Average purchase", "平均买入价"),
                  t.lastPrice,
                  t.marketValue,
                  c("Unrealised P&L", "未实现损益"),
                  c("Vintage / registry", "减排年份／登记标准"),
                  t.action,
                ].map((label, index) => (
                  <th
                    scope="col"
                    key={label}
                    className={index > 0 && index < 6 ? "numeric" : undefined}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.assetId}>
                  <td>
                    <div className="min-w-[180px] max-w-[230px]">
                      <Link
                        href={`/market/${p.symbol}`}
                        className="font-medium hover:text-accent"
                      >
                        {p.symbol}
                      </Link>
                      <div
                        className="truncate text-xs text-muted"
                        title={tName(p.symbol, p.name, lang)}
                      >
                        {tName(p.symbol, p.name, lang)}
                      </div>
                      <div className="mt-1 text-[11px] text-muted">
                        {p.isScenario
                          ? c("Scenario instrument", "情景标的")
                          : c(
                              getCreditProfile(p).category,
                              getCreditProfile(p).categoryZh,
                            )}{" "}
                        · {tCountry(p.country, lang)}
                      </div>
                    </div>
                  </td>
                  <td className="tnum numeric">
                    {fmtQty(p.quantity)}
                    <span className="ex-subline">
                      {fmtQty(p.available)} {c("available", "可用")}
                    </span>
                    <span className="ex-subline">
                      {fmtQty(p.locked)} {t.locked}
                    </span>
                  </td>
                  <td className="tnum numeric">
                    {p.averagePurchasePrice == null
                      ? "—"
                      : `$${fmtMoney(p.averagePurchasePrice)}`}
                    <span className="ex-subline">
                      {!p.costBasisComplete &&
                        c("Cost not recorded", "未记录成本")}
                    </span>
                  </td>
                  <td className="tnum numeric">
                    {p.lastPrice == null ? "—" : `$${fmtMoney(p.lastPrice)}`}
                  </td>
                  <td className="tnum numeric">
                    {p.valuationComplete ? `$${fmtMoney(p.marketValue)}` : "—"}
                  </td>
                  <td
                    className={`tnum numeric ${
                      p.unrealisedPnl == null
                        ? ""
                        : p.unrealisedPnl >= 0
                          ? "text-up"
                          : "text-down"
                    }`}
                  >
                    {p.unrealisedPnl == null
                      ? "—"
                      : `${p.unrealisedPnl >= 0 ? "+" : "−"}$${fmtMoney(Math.abs(p.unrealisedPnl))}`}
                  </td>
                  <td>
                    {p.vintage}
                    <span className="ex-subline">{p.standard}</span>
                    {p.registry && p.registry !== p.standard && (
                      <span className="ex-subline">{p.registry}</span>
                    )}
                  </td>
                  <td>
                    <div className="ex-actions">
                      <Link
                        className="ex-learn-link"
                        href={`/market/${p.symbol}?tab=trade&side=SELL`}
                      >
                        {t.sell}
                      </Link>
                      {!p.isScenario && p.available > 0 && (
                        <Link
                          className="ex-learn-link"
                          href={`/retirement?asset=${encodeURIComponent(p.assetId)}`}
                        >
                          {c("Retire", "注销")}
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
      <div className="ex-table-note">
        {c(
          "A purchase transfers simulated ownership. Only retirement removes credits from this simulator’s circulation.",
          "买入会移转模拟持有权。唯有注销才会将信用从模拟市场中移除。",
        )}
      </div>
    </section>
  );
}
function DashboardBody({ data }: { data: AccountPortfolio }) {
  const c = useExchangeText(),
    { lang } = useLang(),
    market = useMarket(),
    watch = useWatchlist();
  const watched = market.assets.filter(
    (a) => watch.symbols.includes(a.symbol) && !a.isScenario,
  );
  return (
    <>
      <div className="ex-two-column">
        <div>
          <section className="ex-panel">
            <div className="ex-panel-heading">
              <div>
                <h2>{c("Make your next move", "您的下一步")}</h2>
                <p>
                  {c(
                    "From understanding a credit to keeping a complete record.",
                    "从理解碳信用，到保留完整资产记录。",
                  )}
                </p>
              </div>
              <span className="ex-status-tag">
                {data.openOrders.length} {c("open orders", "笔未完成订单")}
              </span>
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              {[
                {
                  href: "/",
                  icon: "search" as const,
                  title: c("Find a credit", "寻找信用"),
                  text: c(
                    "Compare projects, standards and vintages.",
                    "比较项目、标准及减排年份。",
                  ),
                },
                {
                  href: "/portfolio",
                  icon: "portfolio" as const,
                  title: c("Manage holdings", "管理持仓"),
                  text: c(
                    "Review your assets and available credits.",
                    "检查资产与可用信用。",
                  ),
                },
                {
                  href: "/retirement",
                  icon: "retire" as const,
                  title: c("Retire & record", "注销与留档"),
                  text: c(
                    "Remove credits and save a simulation receipt.",
                    "移除信用并存储模拟凭证。",
                  ),
                },
              ].map((i) => (
                <Link
                  href={i.href}
                  key={i.href}
                  className="border border-border rounded-md p-4 hover:bg-surface-2"
                >
                  <ExchangeIcon name={i.icon} className="text-accent mb-3" />
                  <h3 className="text-xs mb-2">{i.title}</h3>
                  <p className="text-[10px] text-muted leading-relaxed">
                    {i.text}
                  </p>
                </Link>
              ))}
            </div>
          </section>
          <section className="ex-panel">
            <div className="ex-panel-heading">
              <h2>{c("Recent trades", "最近成交")}</h2>
              <Link className="ex-learn-link" href="/transactions">
                {c("View all activity", "查看所有流水")}
              </Link>
            </div>
            {data.trades.length === 0 ? (
              <p className="ex-muted py-4">
                {c(
                  "No trades yet. Your completed purchases and sales will appear here.",
                  "尚无成交。已完成的买卖会显示于此。",
                )}
              </p>
            ) : (
              <TableViewport label={c("Recent trades", "最近成交")}>
                <table className="ex-table">
                  <thead>
                    <tr>
                      <th>{c("Project", "项目")}</th>
                      <th>{c("Side / quantity", "方向／数量")}</th>
                      <th>{c("Total", "总额")}</th>
                      <th>{c("Status", "状态")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trades.slice(0, 5).map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Link href={`/market/${t.asset.symbol}`}>
                            {tName(t.asset.symbol, t.asset.name, lang)}
                          </Link>
                          <span className="ex-subline">
                            {fmtTime(t.createdAt)}
                          </span>
                        </td>
                        <td
                          className={
                            t.direction === "BUY"
                              ? "ex-positive"
                              : "ex-negative"
                          }
                        >
                          {t.direction === "BUY"
                            ? c("Buy", "买入")
                            : c("Sell", "卖出")}{" "}
                          · {fmtQty(t.quantity)}
                        </td>
                        <td>${fmtMoney(t.quantity * t.price)}</td>
                        <td>
                          <span className="ex-status-tag filled">
                            {c("Settled", "已结算")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableViewport>
            )}
          </section>
        </div>
        <div>
          <Allocation positions={data.positions} />
          <section className="ex-panel">
            <div className="ex-panel-heading">
              <h2>{c("Your watchlist", "关注列表")}</h2>
              <Link href="/watchlist" className="ex-learn-link">
                {c("View all", "查看全部")}
              </Link>
            </div>
            {market.error && (
              <div className="ex-error mb-4" role="alert">
                <span>
                  {market.hasData
                    ? c(
                        "Watchlist prices could not be refreshed. Showing the last received market data.",
                        "无法更新关注列表价格，目前显示上次加载的市场数据。",
                      )
                    : c(
                        "Market data for your watchlist could not be loaded.",
                        "无法加载关注列表的市场数据。",
                      )}
                </span>
                <button
                  type="button"
                  onClick={() => void market.reload().catch(() => {})}
                >
                  {c("Retry", "重试")}
                </button>
              </div>
            )}
            {!market.loaded ? (
              <p className="ex-muted py-4" role="status">
                {c("Loading watchlist prices…", "正在加载关注列表价格…")}
              </p>
            ) : !market.hasData ? null : watched.length > 0 ? (
              watched.slice(0, 4).map((a) => (
                <Link
                  key={a.id}
                  href={`/market/${a.symbol}`}
                  className="flex justify-between items-center py-3 border-b border-border last:border-0"
                >
                  <span className="text-xs">
                    {a.symbol}
                    <span className="ex-subline">
                      {getCreditProfile(a).category}
                    </span>
                  </span>
                  <span className="text-xs">
                    {a.lastPrice == null ? "—" : `$${fmtMoney(a.lastPrice)}`}
                  </span>
                </Link>
              ))
            ) : market.error ? null : watch.symbols.length > 0 ? (
              <p className="ex-muted py-4">
                {c(
                  "Your saved credits are not available in the current market data.",
                  "目前市场数据中没有您已存储的关注信用。",
                )}
              </p>
            ) : (
              <>
                <p className="ex-muted mb-4">
                  {c(
                    "Follow credits to keep an eye on their price and availability.",
                    "追踪信用的价格与可成交数量。",
                  )}
                </p>
                <Link href="/" className="ex-learn-link">
                  {c("Add your first credit", "加入首个关注信用")}
                  <ExchangeIcon name="plus" size={14} />
                </Link>
              </>
            )}
          </section>
        </div>
      </div>
      <div className="ex-info-strip">
        <ExchangeIcon name="info" size={22} />
        <div>
          <strong>
            {c(
              "Held credits are not retired credits.",
              "持有信用不等于已注销信用。",
            )}
          </strong>
          <p>
            {c(
              "Your nominal tCO₂e balance measures units held, not verified personal or corporate emissions reductions.",
              "名义 tCO₂e 余额代表持有单位，不是已核实的个人或企业减排量。",
            )}
          </p>
        </div>
        <Link href="/learn#retirement">
          {c("Learn why", "了解原因")}
        </Link>
      </div>
    </>
  );
}
