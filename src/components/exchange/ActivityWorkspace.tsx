"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/http/client";
import { fmtMoney, fmtTime, fmtQty } from "@/lib/format";
import { useExchangeText } from "./useExchange";
import { AccountGate } from "./AccountData";
import { ExchangeIcon } from "./ExchangeIcon";
import { TableViewport } from "./TableViewport";
import { legacyActivityCsv, type LegacyActivityFilter } from "./csv-export-links";
import type {
  LedgerAccount,
  LedgerActivity,
  LedgerActivityResponse,
} from "@/shared/api-shapes";
// 账户的英文标签:原来由接口随每行返回,新响应(计划 §6.2.2 C4)只给 account,标签搬到这里,文字不变
const ACCOUNT_LABELS: Record<LedgerAccount, string> = {
  CASH: "Available demo cash",
  CASH_LOCKED: "Reserved demo cash",
  HOLDING: "Credit balance",
  HOLDING_LOCKED: "Reserved credits",
};
// CASH / CASH_LOCKED 的变动是整数分,HOLDING / HOLDING_LOCKED 是吨
const isCash = (e: LedgerActivity) => !e.account.startsWith("HOLDING");
export function ActivityWorkspace() {
  const c = useExchangeText();
  const [data, setData] = useState<LedgerActivityResponse | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(true),
    [loaded, setLoaded] = useState(false),
    [unauthorized, setUnauthorized] = useState(false),
    [filter, setFilter] = useState<LegacyActivityFilter>("all");
  const guard = useRef(false);
  const lastCursor = useRef<string | undefined>(undefined);
  const load = useCallback(async (cursor?: string) => {
    if (guard.current) return;
    guard.current = true;
    lastCursor.current = cursor;
    setBusy(true);
    try {
      const r = await api<LedgerActivityResponse>(
        `/api/transactions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      setData((prev) =>
        cursor && prev
          ? {
              ...r,
              items: [
                ...prev.items,
                ...r.items.filter((e) => !prev.items.some((p) => p.id === e.id)),
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
    data?.items.filter(
      (e) =>
        filter === "all" ||
        (filter === "cash" && isCash(e)) ||
        (filter === "credits" && e.account === "HOLDING") ||
        (filter === "retirement" && e.type === "RETIREMENT"),
    ) || [];
  // CSV 导出(P2-06):导出全部记录(不只是已加载的);「现金」是两个账户,接口一次只筛一个,就导出全部并在提示里说明
  const csvHref = legacyActivityCsv(filter);
  const csvTitle =
    {
      all: c(
        "Download every account movement as a CSV file, not only the rows loaded here.",
        "把全部资产流水下载为 CSV 文件，不只是这里已加载的记录。",
      ),
      credits: c(
        "Download every credit balance movement as a CSV file, not only the rows loaded here.",
        "把全部信用余额流水下载为 CSV 文件，不只是这里已加载的记录。",
      ),
      retirement: c(
        "Download every retirement movement as a CSV file, not only the rows loaded here.",
        "把全部注销流水下载为 CSV 文件，不只是这里已加载的记录。",
      ),
      cash: c(
        "Download every account movement as a CSV file; use the account column to keep the cash rows.",
        "把全部资产流水下载为 CSV 文件；可按账户列筛出现金流水。",
      ),
    }[filter] + c(" Simulated data.", "模拟数据。");
  const amount = (e: LedgerActivity) =>
    `${e.delta > 0 ? "+" : e.delta < 0 ? "−" : ""}${isCash(e) ? "$" + fmtMoney(Math.abs(e.delta)) : fmtQty(Math.abs(e.delta))}`;
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
        <div className="ex-actions">
          {/* 已登录且有数据才显示;放在「更新流水」之前,出现时不挪动它 */}
          {data && !unauthorized ? (
            <a
              className="ex-button"
              href={csvHref}
              download
              title={csvTitle}
              data-export-csv=""
            >
              <ExchangeIcon name="download" size={14} />
              {c("Export CSV", "导出 CSV")}
            </a>
          ) : null}
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
              {(
                [
                  ["all", "All movements", "全部流水"],
                  ["credits", "Credit balance", "信用余额"],
                  ["cash", "Cash movements", "现金流水"],
                  ["retirement", "Retirements", "注销"],
                ] as const
              ).map(([v, en, zh]) => (
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
                            {fmtTime(new Date(e.ts))}
                          </span>
                        </td>
                        <td>
                          {e.symbol ? (
                            <Link href={`/market/${e.symbol}`}>{e.symbol}</Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{ACCOUNT_LABELS[e.account] ?? e.account}</td>
                        <td
                          className={e.delta > 0 ? "ex-positive" : "ex-negative"}
                        >
                          {amount(e)}
                          <span className="ex-subline">
                            {isCash(e)
                              ? c("demo USD", "模拟美元")
                              : e.isScenario // 行上自带(计划 §6.2.2 C4),首次渲染就是对的,不另外取标的列表
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
                      `${rows.length} matching · ${data.items.length} movements loaded · filters apply to loaded records`,
                      `${rows.length} 笔符合 · 已加载 ${data.items.length} 笔 · 筛选适用于已加载记录`,
                    )}
              </span>
              {data.nextCursor && (
                <button
                  className="ex-button"
                  disabled={busy}
                  onClick={() => {
                    void load(data.nextCursor!);
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
