"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { Instrument } from "@/shared";
import { DEFAULT_FEE_SCHEDULE } from "@/shared";
import { ComplianceNote } from "@/components/ComplianceNote";
import { Dialog } from "@/components/ui/Dialog";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import type { OrderReview } from "@/lib/market/order-draft";
import { ORDERS_HISTORY_HREF } from "@/lib/market/order-submit";
import { formatPrice, formatQty } from "@/shared/precision";
import { FeeLine } from "./FeeLine";
import type { TriggerReview } from "./trigger-ticket";
import { showTriggersTab } from "./useConditionalTicket";

/** 两种确认单:普通委托(review)或条件单(trigger,P3-07),二选一 */
export type OrderConfirmDialogProps = ({ review: OrderReview; trigger?: undefined } | { trigger: TriggerReview; review?: undefined }) & {
  /** 显示用:代码、价格精度、数量步长(确认单的请求里只有 assetId) */
  instrument: Pick<Instrument, "symbol" | "pricePrecision" | "qtyStep">;
  onConfirm: () => void;
  /**
   * Esc / 背景 / 关闭按钮 / 取消都走这里。提交在途(busy)时也照样转给调用方:由 OrderPanel 记下「要关」、等结果出来再关,
   * 并把结果(未确认 / 被拒)改在面板里显示 —— Chromium 连按两次 Esc 会经 close watcher 直接关掉原生 <dialog>(不可取消),
   * 这里若吞掉关闭请求,对话框已经看不见而 review 还在,面板就卡住了。
   */
  onCancel: () => void;
  /** 提交在途:确认 / 取消按钮禁用 */
  busy: boolean;
  /** 已本地化的错误说明;null = 无 */
  error: string | null;
  /**
   * 结果未确认(断网 / 5xx / 响应对不上):引导先去 /orders?status=ALL 核对(条件单:切到本页的「条件单」页签);
   * 同一 clientOrderId(条件单是同一个幂等键)重试是安全的,确认按钮变「重试」
   */
  uncertain: boolean;
  /** 401(会话失效):给登录入口而不是重试;null = 不显示 */
  loginHref?: string | null;
};

/**
 * 确认按钮的 keydown:自动重复的按键(按住 Enter 从数量框一路按过来)不激活确认 —— Enter 对按钮的激活是 keydown 的默认动作,
 * 在这里 preventDefault 拦下;松开再按(repeat 为 false)照常确认。
 */
export function blockRepeatActivation(e: Pick<KeyboardEvent, "repeat" | "preventDefault">): void {
  if (e.repeat) e.preventDefault();
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-gap">
      <dt className="text-muted">{label}</dt>
      <dd className="tnum text-foreground">{children}</dd>
    </div>
  );
}

/**
 * 下单二次确认(计划 §3.1;条件单的摘要 P3-07):基于 ui/Dialog(原生 <dialog>、Esc / 背景关闭、焦点还原);由 OrderPanel 经
 * next/dynamic({ ssr: false }) 懒加载、只在打开时挂载。
 * 展示方向 / 类型、价格、数量、预估均价(市价)、预估名义额、手续费行(0.00 · 演示)、合规行与演示说明;
 * 条件单(trigger)换成:条件(说成话)、触发后下的单、核对时的最新成交价、预估合计(市价按触发价粗估)、手续费行,外加一段引擎实际做什么的说明。
 * phase 焦点管理沿用 SimpleTrade:打开时焦点落在确认按钮(再按一次 Enter 即确认),出错时移到错误说明;
 * 结果未确认时给出去委托记录核对的链接,确认按钮变「重试」(同一张确认单、同一 clientOrderId,服务端幂等);
 * 明确被拒(4xx)时按钮仍是「确认」(原样重发不会有别的结果,不暗示是瞬时故障),401 另给登录入口。
 * 按住 Enter 不放:数量框里的第一下打开本框、焦点落到确认按钮,之后的自动重复 keydown(e.repeat)不许触发确认 —— 必须松开再按。
 */
export function OrderConfirmDialog({ review, trigger, instrument, onConfirm, onCancel, busy, error, uncertain, loginHref = null }: OrderConfirmDialogProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const confirmRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const bodyId = useId();
  const triggerBodyId = useId();

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const side = review ? review.request.side : trigger.fields.side;
  const isBuy = side === "BUY";
  const sideText = isBuy ? t.order.buy : t.order.sell;
  const price = (cents: number | null | undefined) => fmtPrice(cents, instrument, lang);
  const money = (cents: number) => formatPrice(cents, 2, locale);
  const typeText = review ? (review.request.type === "LIMIT" ? t.order.limit : t.order.market) : t.order.conditional;

  return (
    <Dialog
      open
      onClose={onCancel}
      title={trigger ? t.order.confirmConditionalTitle({ buy: isBuy, symbol: instrument.symbol }) : t.order.confirmTitle({ side: sideText, symbol: instrument.symbol })}
      initialFocusRef={confirmRef} describedBy={trigger ? `${triggerBodyId} ${bodyId}` : bodyId}>
      <p className="flex items-center gap-gap text-t-sm">
        <span className={`rounded-chip px-2 py-0.5 font-semibold ${isBuy ? "bg-up-soft text-(--terminal-up)" : "bg-down-soft text-(--terminal-down)"}`}>{sideText}</span>
        <span className="text-muted">{typeText}</span>
      </p>
      {review ? (
        <dl data-order-review="" className="flex flex-col gap-1 rounded-panel border border-border p-panel text-t-sm">
          <Row label={t.order.price}>{review.request.type === "LIMIT" ? price(review.request.price) : t.order.market}</Row>
          <Row label={t.order.qty}>{formatQty(review.request.quantity, instrument.qtyStep, locale)}</Row>
          {review.request.type === "MARKET" ? <Row label={t.order.estAvg}>{price(review.estAvgPrice)}</Row> : null}
          <Row label={t.order.estTotal}>{money(review.estNotional)}</Row>
          {/* 手续费取确认单自己的 estFee(与请求同一次 toReview 算出),费率只用来判断演示标记 */}
          <FeeLine notionalCents={review.estNotional} feeCents={review.estFee} fees={DEFAULT_FEE_SCHEDULE} />
        </dl>
      ) : (
        // 条件单:条件说成话、触发后下的单、核对时的最新成交价、预估合计(市价单按触发价粗估)与手续费行;下面一段说清引擎实际做什么
        <dl data-trigger-review="" className="flex flex-col gap-1 rounded-panel border border-border p-panel text-t-sm">
          <Row label={t.tabs.colCondition}>
            {trigger.fields.direction === "ABOVE" ? t.triggers.whenAbove(price(trigger.fields.triggerPrice)) : t.triggers.whenBelow(price(trigger.fields.triggerPrice))}
          </Row>
          <Row label={t.triggers.after}>
            {trigger.fields.orderType === "LIMIT"
              ? t.triggers.actionLimit({ buy: isBuy, qty: formatQty(trigger.fields.quantity, instrument.qtyStep, locale), price: price(trigger.fields.limitPrice) })
              : t.triggers.actionMarket({ buy: isBuy, qty: formatQty(trigger.fields.quantity, instrument.qtyStep, locale) })}
          </Row>
          <Row label={t.triggers.lastTrade}>{price(trigger.lastPrice)}</Row>
          <Row label={trigger.fields.orderType === "LIMIT" ? t.order.estTotal : t.order.estTotalAtTrigger}>{money(trigger.estNotional ?? 0)}</Row>
          <FeeLine notionalCents={trigger.estNotional ?? 0} fees={DEFAULT_FEE_SCHEDULE} />
        </dl>
      )}
      {/* 条件单的说明也是对话框的描述(aria-describedby 先念它,再念演示说明) */}
      {trigger ? (
        <p id={triggerBodyId} className="text-t-sm text-foreground">
          {t.order.conditionalBody}
        </p>
      ) : null}
      {review?.warnings.includes("partialFill") ? (
        // 市价单按当前盘口(买单再按可用现金)估计吃不满:提交前的提示是「可能只成交一部分,余量撤销」,
        // 不用 order.partial(「部分成交」读起来像已经成交了)
        <p data-warning="partialFill" className="rounded-control bg-warning-soft px-2 py-1 text-t-xs text-warning">
          {t.order.partialWarning}
        </p>
      ) : null}
      <p id={bodyId} className="text-t-sm text-muted">
        {t.order.confirmBody}
      </p>
      <ComplianceNote />
      {error ? (
        <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-control border border-danger/25 bg-danger-soft p-panel text-t-sm text-danger focus-visible:outline-none">
          {error}
        </p>
      ) : null}
      {uncertain && trigger ? (
        // 条件单的结果去本页的「条件单」页签核对:切过去并关掉对话框(同一个幂等键,回来再提交也不会建出第二条)
        <button
          type="button"
          onClick={() => {
            showTriggersTab();
            onCancel();
          }}
          className="inline-flex min-h-touch items-center justify-center rounded-control border border-warning/40 px-3 text-t-sm font-medium text-warning focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-2"
        >
          {t.triggers.checkTab}
        </button>
      ) : uncertain ? (
        <Link
          href={ORDERS_HISTORY_HREF}
          className="inline-flex min-h-touch items-center justify-center rounded-control border border-warning/40 px-3 text-t-sm font-medium text-warning focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-2"
        >
          {t.order.uncertainAction}
        </Link>
      ) : null}
      {loginHref ? (
        <Link
          href={loginHref}
          className="inline-flex min-h-touch items-center justify-center rounded-control border border-border px-3 text-t-sm font-medium text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-2"
        >
          {t.order.login}
        </Link>
      ) : null}
      <div className="grid grid-cols-2 gap-gap">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="min-h-touch rounded-control border border-border px-3 text-t-sm font-medium text-foreground focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 lg:min-h-0 lg:py-2"
        >
          {ui.cancel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          onClick={onConfirm}
          onKeyDown={blockRepeatActivation}
          disabled={busy}
          aria-busy={busy}
          className={`min-h-touch rounded-control px-3 text-t-sm font-semibold text-background focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 lg:min-h-0 lg:py-2 ${isBuy ? "bg-(--terminal-up)" : "bg-(--terminal-down)"}`}
        >
          {busy ? t.order.submitting : uncertain ? ui.retry : t.order.confirm}
        </button>
      </div>
    </Dialog>
  );
}
