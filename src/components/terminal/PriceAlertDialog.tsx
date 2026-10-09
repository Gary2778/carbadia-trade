"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { TriggerDirection } from "@/shared";
import { ComplianceNote } from "@/components/ComplianceNote";
import { useToast } from "@/components/anim/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import { useAccountStatus } from "@/lib/market/account-store";
import { parseCents } from "@/lib/market/order-draft";
import { lastPriceOf } from "@/lib/market/last-price";
import { useMarketStore } from "@/lib/market/store";
import { submitAlert } from "@/lib/market/trigger-submit";
import { validateAlertDraft } from "@/shared/trigger-drafts";
import { loginHrefFor } from "./LoginGate";
import { DIALOG_INPUT, DIALOG_PRIMARY, DIALOG_SECONDARY, FailureNotice } from "./TriggerDialogParts";
import { TriggerHint } from "./TriggerHint";
import { submitFailure, triggerErrorText, type SubmitFailure } from "./trigger-ticket";
import { showTriggersTab } from "./useConditionalTicket";

export type PriceAlertDialogProps = {
  symbol: string;
  onClose: () => void;
};

/**
 * 价格提醒对话框(P3-07;计划 §6.3.2 C3 的 kind: ALERT):终端头部最新价旁的「提醒」按钮打开,由 TerminalHeader 经 next/dynamic 懒加载、
 * 只在打开时挂载。一个价格框,方向由它与最新成交价现推并说成话(TriggerHint;最新价未知时让用户选涨到 / 跌到);下面一段说清:
 * 最新成交价达到这个价时通知你、提醒不下单、它留在条件单页签里、OTC 成交不触发。校验 validateAlertDraft,提交 submitAlert(结果已写进账户 store),
 * 成功 toast 并关闭。未登录时只给登录入口;登录态未知(水合期)时按钮禁用。
 */
export function PriceAlertDialog({ symbol, onClose }: PriceAlertDialogProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const push = useToast();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const status = useAccountStatus();
  const instrument = useMarketStore((s) => s.instruments[symbol]);
  const last = useMarketStore((s) => lastPriceOf(s, symbol));
  const [text, setText] = useState("");
  const [pick, setPick] = useState<TriggerDirection | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<SubmitFailure | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const precision = instrument?.pricePrecision ?? 2;
  const check = instrument ? validateAlertDraft({ triggerPrice: parseCents(text), direction: pick }, instrument, last) : null;
  const shown = attempted && check && !check.ok ? check : null;
  const errorId = `${ids}-error`;
  const hintId = `${ids}-hint`;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !check || status !== "ready") return;
    setAttempted(true);
    if (!check.ok) return;
    setBusy(true);
    setFailure(null);
    const res = await submitAlert(check.alert);
    // 提交在途时对话框被关掉了(之后可能又打开了一个新的):这一个实例已经卸载,不再碰它的 state,也不去关别的实例
    const live = mounted.current;
    if (live) setBusy(false);
    if (res.ok) {
      push("ok", t.triggers.placed({ type: t.triggers.types.alert, symbol }), { action: { label: t.triggers.checkTab, onClick: showTriggersTab } });
      if (live) onClose();
      return;
    }
    const failed = submitFailure(res, t, loginHrefFor(symbol));
    if (live) setFailure(failed);
    else push(failed.uncertain ? "warning" : "err", failed.message, failed.uncertain ? { action: { label: t.triggers.checkTab, onClick: showTriggersTab } } : undefined);
  };

  return (
    <Dialog open onClose={onClose} title={`${t.triggers.types.alert} · ${symbol}`} initialFocusRef={status === "anon" ? undefined : inputRef} describedBy={`${ids}-body`}>
      {status === "anon" ? (
        <div className="flex flex-col gap-panel text-t-sm">
          <p id={`${ids}-body`}>{t.toast.loginRequired}</p>
          <Link
            href={loginHrefFor(symbol)}
            className={DIALOG_SECONDARY}
          >
            {t.order.login}
          </Link>
        </div>
      ) : (
        <form onSubmit={(e) => void handleSubmit(e)} noValidate aria-busy={busy} className="flex flex-col gap-panel">
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-price`} className="text-t-xs text-muted">
              {t.triggers.alertPrice}
            </label>
            <input
              ref={inputRef}
              id={`${ids}-price`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              aria-invalid={shown?.field === "triggerPrice" || undefined}
              aria-describedby={shown ? `${hintId} ${errorId}` : hintId}
              className={DIALOG_INPUT}
            />
            <TriggerHint id={hintId} symbol={symbol} precision={precision} text={text} pick={pick} onPick={setPick} />
          </div>
          {shown ? (
            <p id={errorId} role="alert" className="text-t-sm text-danger">
              {triggerErrorText(t.triggers.errors, shown.reason, { minQty: 1, qtyStep: 1 }, fmtPrice(instrument?.tickSize ?? 1, { pricePrecision: precision }, lang))}
            </p>
          ) : null}
          <p id={`${ids}-body`} className="text-t-sm text-foreground">
            {t.triggers.alertBody}
          </p>
          <ComplianceNote />
          {failure ? <FailureNotice failure={failure} onCheckTab={onClose} /> : null}
          <div className="grid grid-cols-2 gap-gap">
            <button type="button" onClick={onClose} disabled={busy} className={DIALOG_SECONDARY}>
              {ui.cancel}
            </button>
            <button type="submit" disabled={busy || !instrument || status !== "ready"} aria-busy={busy} className={DIALOG_PRIMARY}>
              {busy ? t.order.submitting : failure?.uncertain ? ui.retry : t.order.confirm}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
