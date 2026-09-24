"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/http/client";
import { fmtMoney, fmtTime, fmtQty } from "@/lib/format";
import { useExchangeText } from "./useExchange";
import { AccountGate } from "./AccountData";
import { ExchangeIcon } from "./ExchangeIcon";
import { TableViewport } from "./TableViewport";
type Entry = {
  id: string;
  account: string;
  accountLabel: string;
  delta: number | string;
  deltaIsExactNumber: boolean;
  type: string;
  label: string;
  unit: string;
  refType: string | null;
  refId: string | null;
  createdAt: string;
  asset: { symbol: string; name: string; isScenario: boolean } | null;
};
type Result = {
  entries: Entry[];
  pagination: { total: number; hasMore: boolean; nextCursor: string | null };
};
export function ActivityWorkspace() {
  const c = useExchangeText();
  const [data, setData] = useState<Result | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [loaded, setLoaded] = useState(false),
    [unauthorized, setUnauthorized] = useState(false),
    [filter, setFilter] = useState("all");
  const guard = useRef(false);
  const lastCursor = useRef<string | undefined>(undefined);
  const load = useCallback(async (cursor?: string) => {
    if (guard.current) return;
    guard.current = true;
    lastCursor.current = cursor;
    setBusy(true);
    try {
      const r = await api<Result>(
        `/api/transactions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setData((prev) =>
        cursor && prev
          ? {
              ...r,
              entries: [
                ...prev.entries,
                ...r.entries.filter(
                  (e) => !prev.entries.some((p) => p.id === e.id),
                ),
              ],
            }
          : r,
      );
      setError("");
      setUnauthorized(false);
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 401) {
        setData(null);
        setUnauthorized(true);
      }
    } finally {
      setBusy(false);
      setLoaded(true);
      guard.current = false;
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(() => load());
  }, [load]);
  const rows =
    data?.entries.filter(
      (e) =>
        filter === "all" ||
        (filter === "cash" && e.unit === "USD_CENTS") ||
        (filter === "credits" && e.account === "HOLDING") ||
        (filter === "retirement" && e.type === "RETIREMENT"),
    ) || [];
  const amount = (e: Entry) => {
    if (!e.deltaIsExactNumber)
      return `${e.delta} ${e.unit === "USD_CENTS" ? c("cents (exact)", "分（精确）") : c("units", "单位")}`;
    const n = Number(e.delta);
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${e.unit === "USD_CENTS" ? "$" + fmtMoney(Math.abs(n)) : fmtQty(Math.abs(n))}`;
  };
  return (
    <>
      <div className="ex-page-heading">
        <div>
          <h1>{c("Transactions & activity", "交易与资产流水")}</h1>
          <p>
            {c(
              "A traceable record of purchases, sales, reserved balances and simulated retirements.",
              "追踪买入、卖出、保留余额与模拟注销的完整记录。",
            )}
          </p>
        </div>
        <button
          className="ex-button"
          disabled={busy}
          onClick={() => {
            void load();
          }}
        >
          <ExchangeIcon name="activity" size={14} />
          {busy
            ? c("Refreshing…", "更新中…")
            : c("Refresh activity", "更新流水")}
        </button>
      </div>
      {unauthorized || !data ? (
        <AccountGate
          error={error}
          loading={!loaded || (busy && !data)}
          unauthorized={unauthorized}
          retry={() => load(lastCursor.current)}
          returnTo="/transactions"
        />
      ) : (
        <>
          {error && (
            <div className="ex-error" role="alert">
              <span>{error}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void load(lastCursor.current)}
              >
                {busy
                  ? c("Retrying…", "重试中…")
                  : c("Retry request", "重试此请求")}
              </button>
            </div>
          )}
          <section className="ex-market-body" aria-busy={busy}>
            <div
              className="ex-market-tabs"
              role="group"
              aria-label={c("Activity categories", "流水分类")}
            >
              {[
                ["all", "All movements", "全部流水"],
                ["credits", "Credit balance", "信用余额"],
                ["cash", "Cash movements", "现金流水"],
                ["retirement", "Retirements", "注销"],
              ].map(([v, en, zh]) => (
                <button
                  key={v}
                  aria-pressed={filter === v}
                  onClick={() => setFilter(v)}
                >
                  {c(en, zh)}
                </button>
              ))}
            </div>
            <div className="ex-table-note">
              <span>
                {c(
                  "Related movements share a reference. Cash and credit rows are parts of one transaction, not separate trades.",
                  "同一交易的现金与信用流水共用参考编号，并非多笔独立成交。",
                )}
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="ex-empty">
                <ExchangeIcon name="activity" size={30} />
                <h2>
                  {c(
                    "No matching activity loaded",
                    "已加载数据中没有符合的流水",
                  )}
                </h2>
                <p>
                  {c(
                    "Balances, purchases and retirements will appear here. Load older activity to search earlier records.",
                    "余额、买卖及注销会显示于此。可加载较旧流水查看早期记录。",
                  )}
                </p>
              </div>
            ) : (
              <TableViewport
                label={c("Account activity table", "资产流水表格")}
              >
                <table className="ex-table">
                  <thead>
                    <tr>
                      {[
                        c("Activity / time", "流水／时间"),
                        c("Credit", "碳信用"),
                        c("Account", "账户"),
                        c("Movement", "变动"),
                        c("Reference", "参考编号"),
                      ].map((s) => (
                        <th key={s} scope="col">
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <strong className="font-medium">{e.label}</strong>
                          <span className="ex-subline">
                            {fmtTime(e.createdAt)}
                          </span>
                        </td>
                        <td>
                          {e.asset ? (
                            <Link href={`/market/${e.asset.symbol}`}>
                              {e.asset.symbol}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{e.accountLabel}</td>
                        <td
                          className={
                            Number(e.delta) > 0 ? "ex-positive" : "ex-negative"
                          }
                        >
                          {amount(e)}
                          <span className="ex-subline">
                            {e.unit === "USD_CENTS"
                              ? c("demo USD", "模拟美元")
                              : e.asset?.isScenario
                                ? c("scenario units", "情景单位")
                                : c("credits", "份信用")}
                          </span>
                        </td>
                        <td>
                          {e.refId ? (
                            <>
                              <span className="ex-subline">{e.refType}</span>
                              <span
                                className="block max-w-[190px] whitespace-normal break-all text-[10px]"
                                title={e.refId}
                              >
                                {e.refId}
                              </span>
                              {e.refType === "RETIREMENT" && (
                                <Link
                                  href={`/api/retirements/${e.refId}/certificate`}
                                  target="_blank"
                                  className="ex-subline text-accent"
                                >
                                  {c("View certificate", "查看凭证")}
                                </Link>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableViewport>
            )}
            <div className="ex-table-note">
              <span role="status" aria-atomic="true">
                {busy
                  ? c("Loading account activity…", "正在加载资产流水…")
                  : c(
                      `${rows.length} matching · ${data.entries.length} of ${data.pagination.total} movements loaded · filters apply to loaded records`,
                      `${rows.length} 笔符合 · ${data.pagination.total} 笔中已加载 ${data.entries.length} 笔 · 筛选适用于已加载记录`,
                    )}
              </span>
              {data.pagination.hasMore && (
                <button
                  className="ex-button"
                  disabled={busy}
                  onClick={() => {
                    void load(data.pagination.nextCursor!);
                  }}
                >
                  {busy
                    ? c("Loading…", "加载中…")
                    : c("Load older activity", "加载较旧流水")}
                </button>
              )}
            </div>
          </section>
        </>
      )}
    </>
  );
}
