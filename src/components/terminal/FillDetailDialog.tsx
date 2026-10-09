"use client";

import { useEffect, useId, useState } from "react";
import { FILL_DISCLOSURE, type FillDetailResponse } from "@/shared";
import { Dialog } from "@/components/ui/Dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useLang, useT } from "@/i18n/LangProvider";
import { api } from "@/lib/http/client";
import { useMarketStore, type MarketState } from "@/lib/market/store";
import { useTimeZone } from "@/providers/useTimeZone";
import { fmtCents, fmtLedgerDelta, fmtQuantity, fmtRowPrice, fmtTs, ledgerTone, numberLocale, sideTone } from "./TabTable";

export const fillDetailUrl = (fillId: string): string => `/api/account/fills/${encodeURIComponent(fillId)}`;

/**
 * 对话框的 store selector:这一笔成交所在标的的价格精度(原始值),symbol 未知时 undefined。
 * 轮询模式下 instruments 每 2 s 整体替换;选原始值,整张表换了引用而精度没变时前后 Object.is 相等,打开的对话框不跟着重渲染。
 */
export const fillPrecisionSelector =
  (symbol: string | null) =>
  (s: MarketState): number | undefined =>
    symbol ? s.instruments[symbol]?.pricePrecision : undefined;

/** 账本表的单元格:单行、放不下截断 */
const LEDGER_CELL = "truncate px-0.5 py-gap whitespace-nowrap";

/**
 * 成交详情的内容(纯展示,tabs.ssr.test.ts 直接渲染):审计引用 SIM-TRD-… + auditNote、成交字段、对手方类型(只说是不是做市机器人,
 * 不带身份)、本人在这笔成交下的账本行(表头 account / delta / reason / 时间;变动带正负号、中性色)、disclosure 对应的披露文案。
 * 没有登记机构序列号,也不编造(计划 D5):审计链路就是这三样。
 */
export function FillDetailView({ detail, precision }: { detail: FillDetailResponse; precision: number }) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const tz = useTimeZone();
  const ledgerId = useId();
  const { fill, ledger } = detail;
  const fields: { label: string; value: string; tone?: string }[] = [
    { label: t.tabs.colTime, value: fmtTs(fill.ts, locale, tz) },
    { label: t.tabs.colSymbol, value: fill.symbol },
    { label: t.tabs.colSide, value: fill.side === "BUY" ? t.order.buy : t.order.sell, tone: sideTone(fill.side) },
    { label: t.tabs.colRole, value: fill.role === "MAKER" ? t.tabs.maker : t.tabs.taker },
    { label: t.tabs.colPrice, value: fmtRowPrice(fill.price, precision, lang) },
    { label: t.tabs.colQty, value: fmtQuantity(fill.quantity, locale) },
    { label: t.tabs.colNotional, value: fmtCents(fill.notional, locale) },
    { label: t.tabs.colFee, value: fmtCents(fill.feeCents, locale) },
  ];
  return (
    <div className="flex flex-col gap-panel text-t-sm">
      <div className="flex flex-col gap-gap">
        <span className="text-t-xs text-muted">{t.tabs.colAuditRef}</span>
        <span data-audit-ref="" className="tnum font-mono break-all">
          {fill.auditRef}
        </span>
        <span className="text-t-xs text-muted">{t.tape.auditNote}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-panel gap-y-gap">
        {fields.map((f) => (
          <div key={f.label} className="flex items-baseline justify-between gap-gap border-b border-(--terminal-border) pb-gap">
            <dt className="text-t-xs text-muted">{f.label}</dt>
            <dd className={`tnum text-end ${f.tone ?? ""}`}>{f.value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-t-xs text-muted">{detail.counterpartyIsBot ? t.tabs.counterpartyBot : t.tabs.counterpartyUser}</p>

      <section className="flex flex-col gap-gap">
        <h3 id={ledgerId} className="text-t-md font-semibold leading-t-tight">
          {t.tabs.ledger}
        </h3>
        {/* account 与 reason 是账本里的原始代码(CASH / HOLDING_LOCKED、TRADE_SETTLE …),原样显示,不翻译、不改写;列标题走 i18n */}
        {ledger.length === 0 ? (
          <p className="text-t-xs text-muted">—</p>
        ) : (
          <table aria-labelledby={ledgerId} className="w-full table-fixed border-collapse text-t-xs">
            <thead>
              <tr className="border-b border-(--terminal-border) text-muted">
                <th scope="col" className={`${LEDGER_CELL} text-start font-normal`}>
                  {t.tabs.colAccount}
                </th>
                <th scope="col" className={`${LEDGER_CELL} text-end font-normal`}>
                  {t.tabs.colDelta}
                </th>
                <th scope="col" className={`${LEDGER_CELL} text-start font-normal`}>
                  {t.tabs.colReason}
                </th>
                <th scope="col" className={`${LEDGER_CELL} text-end font-normal`}>
                  {t.tabs.colTime}
                </th>
              </tr>
            </thead>
            <tbody>
              {ledger.map((line) => (
                <tr key={line.id} data-ledger-line="" className="border-b border-(--terminal-border)">
                  <td className={`${LEDGER_CELL} font-mono`}>{line.account}</td>
                  {/* 变动与流水页签同一种呈现:正负号 + 中性色 + 读屏的增 / 减,不用涨跌色(见 TabTable 的 ledgerTone) */}
                  <td data-direction={line.delta > 0 ? "in" : line.delta < 0 ? "out" : "none"} className={`${LEDGER_CELL} tnum text-end ${ledgerTone(line.delta)}`}>
                    {line.delta === 0 ? null : <span className="sr-only">{`${line.delta > 0 ? t.ledger.increase : t.ledger.decrease} `}</span>}
                    {fmtLedgerDelta(line.account, line.delta, locale)}
                  </td>
                  <td className={`${LEDGER_CELL} font-mono text-muted`}>{line.reason}</td>
                  <td className={`${LEDGER_CELL} tnum text-end text-muted`}>{fmtTs(line.createdAt, locale, tz)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {detail.disclosure === FILL_DISCLOSURE ? (
        <p role="note" className="rounded-control bg-warning-soft p-panel text-t-xs text-warning">
          {t.tabs.disclosure}
        </p>
      ) : null}
    </div>
  );
}

type DetailState = { status: "loading" } | { status: "error" } | { status: "ready"; detail: FillDetailResponse };

/**
 * 成交详情对话框(计划 §3.1:由 FillsTab 经 next/dynamic({ ssr: false }) 懒加载,按 fillId 以 key 重挂载):
 * 挂载即 GET /api/account/fills/[id](私有,非本人成交 404);加载中 Skeleton,失败 ErrorState 可重试,关闭 / 卸载时中止请求。
 * 基于 ui/Dialog:Esc、点背景、关闭按钮都走 onClose,焦点还给打开前的元素(成交行的审计引用按钮)。
 */
export function FillDetailDialog({ fillId, onClose }: { fillId: string; onClose: () => void }) {
  const t = useT("terminal");
  const ui = useT("ui");
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const describedBy = useId();
  // 只订阅这一笔成交所在标的的价格精度(原始值,见 fillPrecisionSelector),不订阅整张 instruments
  const symbol = state.status === "ready" ? state.detail.fill.symbol : null;
  const precision = useMarketStore(fillPrecisionSelector(symbol)) ?? 2;

  useEffect(() => {
    const controller = new AbortController();
    api<FillDetailResponse>(fillDetailUrl(fillId), { signal: controller.signal }).then(
      (detail) => {
        if (!controller.signal.aborted) setState({ status: "ready", detail });
      },
      () => {
        if (!controller.signal.aborted) setState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [fillId, attempt]);

  const handleRetry = () => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  return (
    <Dialog open onClose={onClose} title={t.tabs.fillDetail} describedBy={describedBy}>
      <p id={describedBy} className="sr-only">
        {t.tape.auditNote}
      </p>
      {state.status === "loading" ? (
        <Skeleton rows={6} />
      ) : state.status === "error" ? (
        <ErrorState message={ui.error} onRetry={handleRetry} />
      ) : (
        <FillDetailView detail={state.detail} precision={precision} />
      )}
    </Dialog>
  );
}
