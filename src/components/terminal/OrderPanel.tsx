"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { DraftError, Order, OrderType, Side } from "@/shared";
import { DEFAULT_FEE_SCHEDULE } from "@/shared";
import { ComplianceNote } from "@/components/ComplianceNote";
import { useToast, type ToastAction } from "@/components/anim/Toast";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Messages } from "@/i18n";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import { accountActions, useAccountStatus, useAccountStore, useBalance, usePosition } from "@/lib/market/account-store";
import {
  PCT_MARKS,
  bookLevels,
  draftError,
  initialDraft,
  reduceDraft,
  requestError,
  shouldConsumeSeed,
  type Draft,
  type DraftAction,
  type DraftBookTop,
  type DraftCtx,
  type DraftInstrumentInfo,
  type OrderReview,
} from "@/lib/market/order-draft";
import {
  ORDERS_HISTORY_HREF,
  accountEventsOf,
  failureAfterClose,
  failureSurface,
  openReview,
  placedNotice,
  rejectionReason,
  submitReview,
  type PlacedNotice,
  type PlacedState,
  type SubmitOutcome,
} from "@/lib/market/order-submit";
import { useBookTop, useDraft, useInstrument } from "@/lib/market/selectors";
import { useMarketStore } from "@/lib/market/store";
import { formatPrice, formatQty } from "@/shared/precision";
import { FeeLine } from "./FeeLine";
import { LoginGate, loginHrefFor } from "./LoginGate";
import { PositionSlider } from "./PositionSlider";

// 二次确认对话框只在打开时挂载,懒加载(计划 §3.6「渲染纪律」:四个 next/dynamic({ ssr: false }) 之一);
// 指针移到 / 焦点落到「核对订单」按钮时预取同一个 chunk,点下去时多半已经到了
const OrderConfirmDialog = dynamic(() => import("./OrderConfirmDialog").then((m) => m.OrderConfirmDialog), {
  ssr: false,
  loading: () => <Skeleton rows={1} />,
});
const preloadConfirmDialog = () => void import("./OrderConfirmDialog");

/**
 * 已消费的草稿种子 nonce(模块级):种子(盘口点价、手机底部买卖条、持仓 Sell)是一次性事件 ——
 * 面板在种子写入之后才挂载(手机先点底部「买入」再切到下单页签)时照样消费;面板重挂载(换标的、页签来回切)不重放旧种子。
 */
let consumedSeedNonce = 0;

const SIDES: readonly Side[] = ["BUY", "SELL"];
const TYPES: readonly OrderType[] = ["LIMIT", "MARKET"];
const NO_TOP: DraftBookTop = { bestBid: null, bestAsk: null };

type TerminalText = Messages["terminal"];
type DraftMsg = { action: DraftAction; ctx: DraftCtx };
const draftReducer = (d: Draft, msg: DraftMsg): Draft => reduceDraft(d, msg.action, msg.ctx);

/** store 还没有这个标的时(首屏 / 水合期)的精度默认值;review 按钮在拿到真实标的之前禁用 */
const fallbackInstrument = (symbol: string): DraftInstrumentInfo => ({ id: "", symbol, tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1 });

/** 校验失败归到哪个输入框(aria-invalid);noLiquidity 不属于任何一个 */
const ERROR_FIELD: Record<DraftError, "price" | "qty" | "amount" | null> = {
  invalidPrice: "price",
  overMaxPrice: "price",
  offTick: "price",
  invalidQty: "qty",
  belowMinQty: "qty",
  offStep: "qty",
  insufficientQty: "qty",
  overMaxNotional: "amount",
  insufficientCash: "amount",
  noLiquidity: null,
};

/** terminal.order.errors[DraftError] → 文案;带参数的三条按标的精度填 */
function draftErrorText(errors: TerminalText["order"]["errors"], error: DraftError, info: DraftInstrumentInfo, lang: string): string {
  switch (error) {
    case "belowMinQty":
      return errors.belowMinQty(info.minQty);
    case "offTick":
      return errors.offTick(fmtPrice(info.tickSize, info, lang));
    case "offStep":
      return errors.offStep(info.qtyStep);
    default:
      return errors[error];
  }
}

/** 提交没成功时要给用户看的:已本地化的说明;uncertain → 去委托记录核对的链接(且确认按钮变重试);loginHref → 401 的登录入口 */
type Failure = { message: string; uncertain: boolean; loginHref: string | null };

/** 下单成功后的一条 toast;ordersAction = 带「去委托记录」动作 */
export type PlacedToast = { type: "ok" | "warning" | "info"; text: string; ordersAction: boolean };

/**
 * 下单成功(服务端确认了结果)之后弹的 toast(纯函数,order.ssr.test.ts 直接测):
 * - 主提示:新单「已提交 … · 状态」;重放「这张单此前已提交,这次没有重复下单 · 状态」(toast.orderReplayed),语气与动作按 placedNotice;
 * - 自成交防护(§9.1 第 41 条)撤掉了本人价格交叉的挂单(selfTradeCancelled > 0):另一条 info,toast.selfTradeCancelled(条数)。
 */
export function placedToasts(order: Pick<Order, "side" | "quantity" | "symbol">, notice: PlacedNotice, text: TerminalText): PlacedToast[] {
  const stateText: Record<PlacedState, string> = {
    filled: text.toast.orderFilled,
    partialResting: text.toast.orderPartial,
    partialCancelled: text.order.partial,
    cancelled: text.toast.orderCancelled,
    resting: text.order.resting,
  };
  const args = { side: order.side === "BUY" ? text.order.buy : text.order.sell, qty: order.quantity, symbol: order.symbol };
  const head = notice.replayed ? text.toast.orderReplayed(args) : text.toast.orderPlaced(args);
  const toasts: PlacedToast[] = [{ type: notice.tone, text: `${head} · ${stateText[notice.state]}`, ordersAction: notice.showOrdersAction }];
  if (notice.selfTradeCancelled > 0) toasts.push({ type: "info", text: text.toast.selfTradeCancelled(notice.selfTradeCancelled), ordersAction: false });
  return toasts;
}

const LINK_BUTTON =
  "inline-flex min-h-touch items-center justify-center rounded-control border px-3 text-t-sm font-medium focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-2";

const INPUT =
  "tnum min-h-touch w-full rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-2 text-t-base text-foreground placeholder:text-muted-2 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-60 aria-invalid:border-danger lg:min-h-0 lg:py-1.5";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-t-xs text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

export type OrderPanelProps = {
  symbol: string;
  /** ?side=BUY|SELL:初始方向;换标的时草稿按它(或待消费种子的 side)重置 */
  initialSide?: Side;
};

/**
 * 下单面板(计划 §3.1、§3.6):限价 / 市价、买卖切换、数量 ↔ 金额互算、仓位滑杆、手续费行(0.00 · 演示)、二次确认、幂等提交。
 * - 未登录(status anon)渲染 LoginGate 替换表单;idle / loading 时表单照画(SSR 与水合首帧就是这一态),核对按钮禁用;
 * - 草稿是本地 reducer state(order-draft.ts 的 reduceDraft,纯函数);按 symbol 作 key 重挂载 = 换标的时草稿按
 *   initialSide 或待消费种子的 side 重置价格与数量;
 * - 订阅:useInstrument / useBalance / usePosition / useBookTop / useDraft / useAccountStatus —— 不订阅整本盘口,
 *   市价走档需要的逐档在事件里从 store 现取,盘口跳动只有顶档变化才让本面板重渲染;
 * - 盘口点价经 store.draft 注入:按 nonce 消费一次、核对 seed.symbol === 当前 symbol;
 * - clientOrderId 在打开确认框时生成(openReview → toReview);提交(submitReview)前把确认单登记进 order-submit 的模块级「未确认」登记簿,
 *   服务端确认了结果才移除 —— 对话框里重试、关掉再以同样参数核对、换标的 / 手机切页签 / 离开 /trade 再回来(表单重挂载)之后再核对,
 *   都复用同一个 id(服务端按 userId + clientOrderId 幂等,不会下出第二单;登记有效期见 UNSETTLED_TTL_MS);
 * - 提交在途时的关闭请求(Esc / 背景 / 关闭按钮)先记下,结果出来再关;没成功的结果改在面板里显示(ErrorState + 核对 / 登录链接);
 *   表单在途中卸载了(换标的 / 手机切页签)就改用 toast(结果未确认带「去委托记录」动作);
 *   关掉确认框时,结果未确认的提示留在面板里,直到下一次核对或成功;
 * - 成功:把订单与本次成交写进账户 store(accountActions.applyAccountEvents,一次 set();已被 account 推送超过的订单只写成交);
 *   新单 toast ok 并清空草稿;服务端重放(replayed:之前那张单已在,这次没有下新单)用 toast.orderReplayed 明说 ——
 *   对话框里对「结果未确认」的重试被重放是预期的完成(ok、清空草稿),关掉对话框后重新核对却被重放则 warning、不清空草稿(placedNotice);
 *   自成交防护撤掉了本人挂单时另弹一条 info(toast.selfTradeCancelled);余额 / 持仓由 account 推送或轮询补上;
 * - 可用现金 / 持仓 / 顶档 / 标的精度变了:派发 refresh,金额 / 滑杆 / 预估合计按 lastEdited 重算(不必等用户再动一下输入框);
 * - ComplianceNote 固定在提交按钮正上方。
 */
export function OrderPanel({ symbol, initialSide }: OrderPanelProps) {
  const t = useT("terminal");
  const status = useAccountStatus();
  const titleId = useId();
  return (
    <section
      data-area="order"
      aria-labelledby={titleId}
      className="flex min-h-0 min-w-0 flex-col gap-panel overflow-y-auto rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel"
    >
      <h2 id={titleId} className="text-t-md font-semibold leading-t-tight">
        {t.order.title}
      </h2>
      {status === "anon" ? <LoginGate symbol={symbol} /> : <OrderForm key={symbol} symbol={symbol} initialSide={initialSide} ready={status === "ready"} />}
    </section>
  );
}

function OrderForm({ symbol, initialSide, ready }: { symbol: string; initialSide?: Side; ready: boolean }) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const push = useToast();
  const router = useRouter();
  const ids = useId();

  const instrument = useInstrument(symbol);
  const balance = useBalance();
  const position = usePosition(instrument?.id ?? "");
  const top = useBookTop(symbol) ?? NO_TOP;
  const seed = useDraft();
  const info = useMemo(() => instrument ?? fallbackInstrument(symbol), [instrument, symbol]);
  const cash = balance?.cashBalance ?? 0;
  const held = position?.available ?? 0;

  const [draft, dispatch] = useReducer(draftReducer, initialSide ?? "BUY", initialDraft);
  const [review, setReview] = useState<OrderReview | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const submitting = useRef(false);
  /**
   * 这个对话框(这一次核对)里,之前有一次提交的结果未确认:之后的确认就是对同一张确认单的重试,被服务端重放是预期的完成(placedNotice)。
   * 打开新的核对、关掉对话框时清掉 —— 关掉后重新核对即使沿用了登记簿里的旧 id,也按「有意再下一张」处理。
   */
  const uncertainInDialog = useRef(false);
  /** 提交在途时收到的关闭请求:结果出来之后再关,没成功的结果改在面板里显示 */
  const closeRequested = useRef(false);
  /** 表单是否还挂着:提交在途时换标的 / 手机切页签会卸载本表单,结果出来后面板 state 没人看了,改用 toast */
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 事件时的上下文:最新的标的 / 可用资源 / 顶档经 ref 交给稳定的处理函数(滑杆等 memo 子组件不因每次渲染换回调而重渲染);
  // 市价走档要的逐档在事件里从 store 现取 —— 渲染期不读 store 的逐档,盘口跳动不重渲染本面板
  const live = useRef({ info, cash, held, top });
  useLayoutEffect(() => {
    live.current = { info, cash, held, top };
  });
  const buildCtx = useCallback((): DraftCtx => {
    const now = live.current;
    return {
      instrument: now.info,
      avail: { cashCents: now.cash, qty: now.held },
      bookTop: now.top,
      ...bookLevels(useMarketStore.getState().books[now.info.symbol]),
    };
  }, []);
  const send = useCallback((action: DraftAction) => dispatch({ action, ctx: buildCtx() }), [buildCtx]);

  // 草稿种子(盘口点价 / 手机买卖条 / 持仓 Sell):每个 nonce 只消费一次,且只认当前标的的种子
  useEffect(() => {
    if (!shouldConsumeSeed(seed, symbol, consumedSeedNonce)) return;
    consumedSeedNonce = seed.nonce;
    send({ kind: "applySeed", seed });
  }, [seed, symbol, send]);

  // 上下文变了(账户就绪 / 余额与持仓变动、顶档移动、标的精度到了):派生的金额 / 滑杆 / 预估合计按 lastEdited 重算。
  // 这些值本面板本来就订阅着,不多订阅盘口深度;reducer 无变化时返回同一引用,不引起多余渲染。
  // 市价单只在顶档变化时重新走档(深度变化不触发);确认框另按打开时的盘口重算,不会因此下错单
  useEffect(() => {
    send({ kind: "refresh" });
  }, [send, cash, held, top.bestBid, top.bestAsk, info]);

  const handleSide = (side: Side) => send({ kind: "setSide", side });
  const handleType = (orderType: OrderType) => send({ kind: "setType", orderType });
  const handlePct = useCallback((pct: number) => send({ kind: "setPct", pct }), [send]);

  const handleReview = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready || !instrument || review) return;
    setAttempted(true);
    // 登记簿里有同样参数、结果未确认的确认单 → 沿用它的 clientOrderId(表单重挂载过也一样)
    const next = openReview(draft, buildCtx(), DEFAULT_FEE_SCHEDULE);
    if ("error" in next) return;
    uncertainInDialog.current = false;
    setFailure(null);
    setReview(next);
  };

  const handleCancel = useCallback(() => {
    if (submitting.current) {
      closeRequested.current = true;
      return;
    }
    uncertainInDialog.current = false;
    setReview(null);
    // 结果未确认的提示(去委托记录核对)留在面板里,直到下一次核对或成功;被拒的说明随对话框清掉
    setFailure(failureAfterClose);
  }, []);

  /** toast 上的动作:结果未确认 → 去委托记录核对;401 → 登录(客户端导航,不清模块级登记簿) */
  const failureAction = (f: Failure): ToastAction | undefined => {
    if (f.uncertain) return { label: t.order.uncertainAction, onClick: () => router.push(ORDERS_HISTORY_HREF) };
    const loginHref = f.loginHref;
    return loginHref ? { label: t.order.login, onClick: () => router.push(loginHref) } : undefined;
  };

  /** 明确被拒(4xx):按状态码取文案,服务端的英文原文不上界面;400 按最新可用资源重新校验,映射回 order.errors */
  const rejectionFailure = (outcome: Extract<SubmitOutcome, { kind: "rejected" }>, request: OrderReview["request"]): Failure => {
    const reason = rejectionReason(outcome);
    switch (reason.kind) {
      case "rateLimited":
        return { message: t.toast.rateLimited(reason.retryAfter), uncertain: false, loginHref: null };
      case "loginRequired":
        return { message: t.toast.loginRequired, uncertain: false, loginHref: loginHrefFor(symbol) };
      case "invalid": {
        const now = buildCtx();
        const reasonError = requestError(request, now);
        return { message: reasonError ? draftErrorText(t.order.errors, reasonError, now.instrument, lang) : ui.error, uncertain: false, loginHref: null };
      }
      case "other":
        return { message: ui.error, uncertain: false, loginHref: null };
    }
  };

  const handleConfirm = async () => {
    const current = review;
    if (!current || submitting.current) return;
    submitting.current = true;
    closeRequested.current = false;
    // 这次是不是对话框里对「结果未确认」的重试:之前一次在这个对话框里结果未确认(之后哪怕又被拒过一次)
    const retryOfUncertain = uncertainInDialog.current;
    setBusy(true);
    setFailure(null);
    // 提交前登记、服务端确认了结果(ok,含重放)才移除:请求可能到了服务端而响应丢了,之后同样参数再核对要沿用这个 id
    const outcome = await submitReview(current);
    submitting.current = false;
    setBusy(false);
    const dismissed = closeRequested.current;
    closeRequested.current = false;

    if (outcome.kind === "ok") {
      accountActions.applyAccountEvents(accountEventsOf(outcome.data, useAccountStore.getState()));
      // 新单「已提交」;重放明说「此前已提交、没有重复下单」(对话框里的重试 → 预期完成;关掉后重新核对 → warning + 去委托记录);
      // 自成交防护撤掉了本人挂单 → 另一条 info
      const notice = placedNotice(outcome.data, { retryOfUncertain });
      for (const toast of placedToasts(outcome.data.order, notice, t)) {
        push(toast.type, toast.text, toast.ordersAction ? { action: { label: t.order.uncertainAction, onClick: () => router.push(ORDERS_HISTORY_HREF) } } : undefined);
      }
      uncertainInDialog.current = false;
      setReview(null);
      if (notice.resetDraft) {
        setAttempted(false);
        send({ kind: "reset" });
      }
      return;
    }
    // 结果未确认:确认单留在登记簿,同一 clientOrderId 重试是安全的;明确被拒(4xx):没有下单,登记也留着
    if (outcome.kind === "uncertain") uncertainInDialog.current = true;
    const failed: Failure = outcome.kind === "uncertain" ? { message: t.order.uncertain, uncertain: true, loginHref: null } : rejectionFailure(outcome, current.request);
    switch (failureSurface({ mounted: mounted.current, dismissed })) {
      case "toast": {
        // 表单在途中卸载了(换标的 / 手机切页签):面板 state 没人看了,改用 toast
        const action = failureAction(failed);
        push(failed.uncertain ? "warning" : "err", failed.message, action ? { action } : undefined);
        return;
      }
      case "panel":
        // 提交在途时用户要关对话框(Chromium 连按 Esc 可能已经把原生 <dialog> 关掉了):现在关,结果在面板里显示
        setFailure(failed);
        setReview(null);
        return;
      case "dialog":
        setFailure(failed);
        return;
    }
  };

  const error = attempted ? draftError(draft, { instrument: info, avail: { cashCents: cash, qty: held }, bookTop: top }) : null;
  const errorField = error ? ERROR_FIELD[error] : null;
  const errorId = `${ids}-error`;
  const isBuy = draft.side === "BUY";
  const isLimit = draft.type === "LIMIT";
  // 预估合计:reducer 派生(限价 = 价 × 量;市价 = 当前数量沿对手盘走档的金额 —— 按预算输入时也不是金额框里的预算),与确认框同一口径
  const notional = draft.estNotional ?? 0;
  const safeNotional = Number.isFinite(notional) ? notional : 0;
  const invalid = (field: "price" | "qty" | "amount") => (errorField === field ? { "aria-invalid": true, "aria-describedby": errorId } : {});

  return (
    <>
      <form onSubmit={handleReview} noValidate className="flex flex-col gap-panel">
        <div role="group" aria-label={t.tabs.colSide} className="grid grid-cols-2 gap-1 rounded-control bg-(--terminal-panel-2) p-1">
          {SIDES.map((side) => (
            <button
              key={side}
              type="button"
              aria-pressed={draft.side === side}
              onClick={() => handleSide(side)}
              className={`min-h-touch rounded-control text-t-base font-semibold transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1.5 ${
                draft.side === side ? (side === "BUY" ? "bg-(--terminal-up) text-background" : "bg-(--terminal-down) text-background") : "text-muted hover:text-foreground"
              }`}
            >
              {side === "BUY" ? t.order.buy : t.order.sell}
            </button>
          ))}
        </div>

        {/* data-order-type:TerminalShell 的 l / m 快捷键按它找按钮(不依赖翻译后的可访问名与按钮顺序) */}
        <div role="group" aria-label={t.tabs.colType} className="flex gap-panel border-b border-(--terminal-border)">
          {TYPES.map((type) => (
            <button
              key={type}
              type="button"
              data-order-type={type}
              aria-pressed={draft.type === type}
              onClick={() => handleType(type)}
              className={`-mb-px min-h-touch border-b-2 px-1 text-t-sm font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1 ${
                draft.type === type ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {type === "LIMIT" ? t.order.limit : t.order.market}
            </button>
          ))}
        </div>

        <Field id={`${ids}-price`} label={t.order.price}>
          <input
            id={`${ids}-price`}
            data-price-field=""
            type="text"
            inputMode="decimal"
            autoComplete="off"
            disabled={!isLimit}
            placeholder={isLimit ? undefined : t.order.market}
            value={isLimit ? draft.priceText : ""}
            onChange={(e) => send({ kind: "setPrice", text: e.currentTarget.value })}
            className={INPUT}
            {...invalid("price")}
          />
        </Field>
        <Field id={`${ids}-qty`} label={t.order.qty}>
          <input
            id={`${ids}-qty`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft.qtyText}
            onChange={(e) => send({ kind: "setQty", text: e.currentTarget.value })}
            className={INPUT}
            {...invalid("qty")}
          />
        </Field>
        <Field id={`${ids}-amount`} label={t.order.amount}>
          <input
            id={`${ids}-amount`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={draft.amountText}
            onChange={(e) => send({ kind: "setAmount", text: e.currentTarget.value })}
            className={INPUT}
            {...invalid("amount")}
          />
        </Field>

        <PositionSlider value={draft.pct} onChange={handlePct} marks={PCT_MARKS} side={draft.side} disabled={!ready} />

        <dl className="flex flex-col gap-1 text-t-xs">
          <div className="flex items-baseline justify-between gap-gap">
            <dt className="text-muted">{isBuy ? t.order.availableCash : t.order.availableQty}</dt>
            <dd className="tnum text-foreground">{!ready || !balance ? "—" : isBuy ? formatPrice(cash, 2, locale) : formatQty(held, info.qtyStep, locale)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-gap">
            <dt className="text-muted">{t.order.estTotal}</dt>
            <dd className="tnum text-foreground">{formatPrice(safeNotional, 2, locale)}</dd>
          </div>
          <FeeLine notionalCents={safeNotional} fees={DEFAULT_FEE_SCHEDULE} />
        </dl>

        {error ? (
          <p id={errorId} role="alert" className="text-t-xs text-danger">
            {draftErrorText(t.order.errors, error, info, lang)}
          </p>
        ) : null}

        {!review && failure ? (
          <div data-order-failure="" className="flex flex-col gap-gap">
            <ErrorState message={failure.message} />
            {failure.uncertain ? (
              <Link href={ORDERS_HISTORY_HREF} className={`${LINK_BUTTON} border-warning/40 text-warning`}>
                {t.order.uncertainAction}
              </Link>
            ) : null}
            {failure.loginHref ? (
              <Link href={failure.loginHref} className={`${LINK_BUTTON} border-(--terminal-border) text-foreground`}>
                {t.order.login}
              </Link>
            ) : null}
          </div>
        ) : null}

        <ComplianceNote />
        <button
          type="submit"
          disabled={!ready || !instrument}
          onPointerEnter={preloadConfirmDialog}
          onFocus={preloadConfirmDialog}
          className={`min-h-touch rounded-control text-t-md font-semibold text-background transition-opacity duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 lg:py-2 ${
            isBuy ? "bg-(--terminal-up)" : "bg-(--terminal-down)"
          }`}
        >
          {t.order.review}
        </button>
      </form>

      {review ? (
        <OrderConfirmDialog
          review={review}
          instrument={info}
          onConfirm={() => void handleConfirm()}
          onCancel={handleCancel}
          busy={busy}
          error={failure?.message ?? null}
          uncertain={failure?.uncertain ?? false}
          loginHref={failure?.loginHref ?? null}
        />
      ) : null}
    </>
  );
}
