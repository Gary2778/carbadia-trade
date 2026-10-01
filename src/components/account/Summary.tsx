"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { AccountTotals, Balance, EquityChange } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { PANEL } from "./styles";
import { gainTone, localeOf, shortTime, signedPct, signedUsd, tonnes, usd } from "./format";

export type AccountSummaryProps = {
  /** 按最新价重算的合计(liveTotals) */
  totals: AccountTotals;
  balance: Balance;
  /** 总览接口的 24 小时变化;null = 算不出(显示「—」并说明原因) */
  change24h: EquityChange | null;
  /** 最近一次重取失败:24 小时变化与 OTC 挂牌是上一份 */
  stale: boolean;
};

const CARD = `flex min-w-0 flex-col gap-1 p-panel ${PANEL}`;

/** 一个数:标签、数值(等宽数字)、可选的一行说明。dl 里的一组(div 包 dt / dd) */
function Stat({ id, label, value, tone = "text-foreground", large = false, note, children }: { id: string; label: string; value: ReactNode; tone?: string; large?: boolean; note?: string; children?: ReactNode }) {
  return (
    <div data-stat={id} className={CARD}>
      <dt className="text-t-xs text-muted">{label}</dt>
      <dd className={`tnum break-all font-semibold ${large ? "text-t-xl" : "text-t-lg"} ${tone}`}>{value}</dd>
      {children}
      {note ? <dd className="text-t-xs text-muted-2">{note}</dd> : null}
    </div>
  );
}

/**
 * 页头的数字(计划 §6.2.3 P2-10):第一行总资产 / 可用现金 / 冻结现金 / 持仓市值;第二行 24 小时变化(金额与百分比,算不出显示「—」
 * 并说明原因)、未实现盈亏(成本或估值不完整显示「—」并说明)、持有吨数(不含情景标的)、已注销吨数(链到注销记录)。
 * 24 小时变化叫「24 小时变化」,不叫持仓盈亏:窗口内注销的数量按现价折算计入,会随价格再动(计划 §6.2.2 C6)。
 * 估值不完整(有持有的标的没有价格)时总资产与持仓市值下面说明一句。
 */
export function AccountSummary({ totals, balance, change24h, stale }: AccountSummaryProps) {
  const a = useT("account");
  const { lang } = useLang();
  const locale = localeOf(lang);
  const partial = totals.valuationComplete ? undefined : a.summary.partialValuation;
  return (
    <section aria-labelledby="account-summary-title" className="flex flex-col gap-gap">
      <h2 id="account-summary-title" className="sr-only">
        {a.summary.label}
      </h2>
      <dl className="grid grid-cols-2 gap-gap lg:grid-cols-4">
        <Stat id="total-assets" label={a.summary.totalAssets} value={usd(totals.totalAssets, locale)} tone="text-accent" large note={partial} />
        <Stat id="available-cash" label={a.summary.availableCash} value={usd(balance.cashBalance, locale)} />
        <Stat id="locked-cash" label={a.summary.lockedCash} value={usd(balance.lockedCash, locale)} />
        <Stat id="holdings-value" label={a.summary.holdingsValue} value={usd(totals.holdingsValue, locale)} note={partial} />
      </dl>
      <dl className="grid grid-cols-2 gap-gap lg:grid-cols-4">
        <Stat
          id="change-24h"
          label={a.summary.change24h}
          value={change24h ? signedUsd(change24h.amount, locale) : "—"}
          tone={change24h ? gainTone(change24h.amount) : "text-muted"}
          note={change24h ? a.summary.change24hSince(shortTime(change24h.since, locale)) : a.summary.change24hUnavailable}
        >
          {change24h && change24h.pct != null ? <dd className={`tnum text-t-sm ${gainTone(change24h.amount)}`}>{signedPct(change24h.pct, locale)}</dd> : null}
        </Stat>
        <Stat
          id="unrealised-pnl"
          label={a.summary.unrealisedPnl}
          value={signedUsd(totals.unrealisedPnl, locale)}
          tone={gainTone(totals.unrealisedPnl)}
          note={totals.unrealisedPnl == null ? a.summary.pnlUnavailable : undefined}
        />
        <Stat id="held-credits" label={a.summary.held} value={`${tonnes(totals.heldCredits, locale)} t`} note={a.summary.heldNote} />
        <Stat
          id="retired-credits"
          label={a.summary.retired}
          value={
            <Link href="/retirement" prefetch={false} className="rounded-chip hover:text-accent focus-visible:outline-none focus-visible:shadow-focus">
              {`${tonnes(totals.retiredCredits, locale)} t`}
            </Link>
          }
          note={a.summary.retiredNote}
        />
      </dl>
      {stale ? (
        <p role="status" className={`px-panel py-gap text-t-xs text-warning ${PANEL}`}>
          {a.summary.refreshFailed}
        </p>
      ) : null}
    </section>
  );
}
