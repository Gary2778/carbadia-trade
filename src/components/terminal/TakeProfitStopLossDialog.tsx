"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { OcoFields, Position } from "@/shared";
import type { Messages } from "@/i18n";
import { ComplianceNote } from "@/components/ComplianceNote";
import { useToast } from "@/components/anim/Toast";
import { Dialog } from "@/components/ui/Dialog";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import { parseCents, parseQty } from "@/lib/market/order-draft";
import { lastPriceOf } from "@/lib/market/last-price";
import { useMarketStore } from "@/lib/market/store";
import { submitOco } from "@/lib/market/trigger-submit";
import type { TriggerDraftField } from "@/shared/order-math";
import { validateOcoDraft } from "@/shared/trigger-drafts";
import { formatQty } from "@/shared/precision";
import { loginHrefFor } from "./LoginGate";
import { Field } from "./Field";
import { numberLocale } from "./TabTable";
import { DIALOG_INPUT, DIALOG_PRIMARY, DIALOG_SECONDARY, FailureNotice } from "./TriggerDialogParts";
import { submitFailure, triggerErrorText, type SubmitFailure } from "./trigger-ticket";
import { showTriggersTab } from "./useConditionalTicket";

/** 成功 toast 里说这次设了什么:止盈、止损,或两个都设了(按提交的字段,不按服务端回了几条) */
export function tpslPlacedType(oco: Pick<OcoFields, "takeProfit" | "stopLoss">, text: Messages["terminal"]["triggers"]): string {
  if (oco.takeProfit !== null && oco.stopLoss !== null) return text.tpslBoth;
  return oco.takeProfit !== null ? text.types.takeProfit : text.types.stopLoss;
}

export type TakeProfitStopLossDialogProps = {
  /** 持仓行的活数据(account store):数量默认可交易数量,上限是持仓总数量(服务端按总持仓查) */
  position: Position;
  onClose: () => void;
};

/**
 * 止盈止损对话框(P3-07;计划 §6.3.2 C3 的 POST /api/account/triggers/oco):持仓页签里数量 > 0 的行点「止盈止损」打开,
 * 由 PositionsTab 经 next/dynamic 懒加载、只在打开时挂载(关闭即卸载)。
 * 显示标的与最新成交价、可交易 / 锁定数量;止盈价、止损价可以只填一个;下面一段话说清它们是市价卖出的条件单、两个都填时先触发的那张
 * 撤掉另一张、那张委托没能提交或一吨都没成交这一组就结束、等待期间不冻结。校验 validateOcoDraft(第一次提交之后随输入与最新价实时更新),
 * 提交 submitOco(结果已写进账户 store),成功 toast(说清设了止盈、止损还是两个)并关闭;结果未确认可原样重试(同一个幂等键)。
 */
export function TakeProfitStopLossDialog({ position, onClose }: TakeProfitStopLossDialogProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const push = useToast();
  const ids = useId();
  const tpRef = useRef<HTMLInputElement>(null);
  const symbol = position.symbol;
  const instrument = useMarketStore((s) => s.instruments[symbol]);
  const last = useMarketStore((s) => lastPriceOf(s, symbol));
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [qtyText, setQtyText] = useState(position.available > 0 ? String(position.available) : "");
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

  const precision = { pricePrecision: instrument?.pricePrecision ?? 2 };
  const price = (cents: number | null) => fmtPrice(cents, precision, lang);
  const qty = (n: number) => formatQty(n, instrument?.qtyStep ?? 1, locale);
  const check = instrument ? validateOcoDraft({ takeProfit: parseCents(takeProfit), stopLoss: parseCents(stopLoss), quantity: parseQty(qtyText) }, instrument, last, position.quantity) : null;
  const shown = attempted && check && !check.ok ? check : null;
  const errorId = `${ids}-error`;
  const invalid = (field: TriggerDraftField) => (shown?.field === field ? { "aria-invalid": true, "aria-describedby": errorId } : {});

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || !check) return;
    setAttempted(true);
    if (!check.ok) return;
    setBusy(true);
    setFailure(null);
    const { oco } = check;
    const res = await submitOco(oco);
    // 提交在途时对话框被关掉了(之后可能又打开了一个新的):这一个实例已经卸载,不再碰它的 state,也不去关别的实例
    const live = mounted.current;
    if (live) setBusy(false);
    if (res.ok) {
      push("ok", t.triggers.placed({ type: tpslPlacedType(oco, t.triggers), symbol }), { action: { label: t.triggers.checkTab, onClick: showTriggersTab } });
      if (live) onClose();
      return;
    }
    const failed = submitFailure(res, t, loginHrefFor(symbol));
    if (live) setFailure(failed);
    else push(failed.uncertain ? "warning" : "err", failed.message, failed.uncertain ? { action: { label: t.triggers.checkTab, onClick: showTriggersTab } } : undefined);
  };

  return (
    <Dialog open onClose={onClose} title={`${t.triggers.tpsl} · ${symbol}`} initialFocusRef={tpRef} describedBy={`${ids}-body`}>
      <form onSubmit={(e) => void handleSubmit(e)} noValidate aria-busy={busy} className="flex flex-col gap-panel">
        <div data-tpsl-position="" className="flex flex-col gap-1 rounded-panel border border-border p-panel text-t-sm">
          <p>
            {t.triggers.lastTrade} {price(last)}
          </p>
          <p className="text-t-xs text-muted">
            {t.tabs.tradable} {qty(position.available)} · {t.tabs.locked} {qty(position.locked)}
          </p>
        </div>
        <div className="grid gap-panel sm:grid-cols-2">
          <Field id={`${ids}-tp`} label={t.triggers.takeProfitPrice}>
            <input ref={tpRef} id={`${ids}-tp`} type="text" inputMode="decimal" autoComplete="off" value={takeProfit} onChange={(e) => setTakeProfit(e.currentTarget.value)} className={DIALOG_INPUT} {...invalid("takeProfit")} />
          </Field>
          <Field id={`${ids}-sl`} label={t.triggers.stopLossPrice}>
            <input id={`${ids}-sl`} type="text" inputMode="decimal" autoComplete="off" value={stopLoss} onChange={(e) => setStopLoss(e.currentTarget.value)} className={DIALOG_INPUT} {...invalid("stopLoss")} />
          </Field>
        </div>
        <Field id={`${ids}-qty`} label={t.order.qty}>
          <input id={`${ids}-qty`} type="text" inputMode="numeric" autoComplete="off" value={qtyText} onChange={(e) => setQtyText(e.currentTarget.value)} className={DIALOG_INPUT} {...invalid("quantity")} />
        </Field>
        {shown ? (
          <p id={errorId} role="alert" className="text-t-sm text-danger">
            {triggerErrorText(t.triggers.errors, shown.reason, instrument ?? { minQty: 1, qtyStep: 1 }, price(instrument?.tickSize ?? 1))}
          </p>
        ) : null}
        <p id={`${ids}-body`} className="text-t-sm text-foreground">
          {t.triggers.tpslBody}
        </p>
        <ComplianceNote />
        {failure ? <FailureNotice failure={failure} onCheckTab={onClose} /> : null}
        <div className="grid grid-cols-2 gap-gap">
          <button type="button" onClick={onClose} disabled={busy} className={DIALOG_SECONDARY}>
            {ui.cancel}
          </button>
          <button type="submit" disabled={busy || !instrument} aria-busy={busy} className={DIALOG_PRIMARY}>
            {busy ? t.order.submitting : failure?.uncertain ? ui.retry : t.order.confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
