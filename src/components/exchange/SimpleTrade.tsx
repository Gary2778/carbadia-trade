"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/http/client";
import { fmtMoney, fmtQty } from "@/lib/format";
import { useLang } from "@/i18n/LangProvider";
import { isChinese } from "@/i18n/config";
import {
  estimateMarketOrder,
  type MarketEstimate,
  type TradeLevel,
} from "@/lib/exchange/trade-estimate";

type Side = "BUY" | "SELL";
type Execution = {
  order: { id: string; status: string; quantity: number };
  filledQty: number;
  filledCost: number;
};
type Review = { side: Side; quantity: number; estimate: MarketEstimate };

export function SimpleTrade({
  asset,
  asks,
  bids,
  holding,
  cashBalance,
  loggedIn,
  initialSide = "BUY",
  onSideChange,
  onDone,
}: {
  asset: { id: string; symbol: string; isScenario: boolean };
  asks: TradeLevel[];
  bids: TradeLevel[];
  holding: { quantity: number; locked: number } | null;
  cashBalance: number | null;
  loggedIn: boolean | null;
  initialSide?: Side;
  onSideChange: (side: Side) => void;
  onDone: () => Promise<void>;
}) {
  const { lang } = useLang();
  const zh = isChinese(lang);
  const side = initialSide;
  const [quantity, setQuantity] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [receipt, setReceipt] = useState<(Execution & { side: Side }) | null>(
    null,
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const quantityRef = useRef<HTMLInputElement>(null);
  const reviewTitleRef = useRef<HTMLHeadingElement>(null);
  const receiptTitleRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const phase = receipt ? "receipt" : review ? "review" : "entry";
  const previousPhase = useRef(phase);

  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (phase === "entry") quantityRef.current?.focus();
    else if (phase === "review") reviewTitleRef.current?.focus();
    else receiptTitleRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const available = Math.max(
    0,
    (holding?.quantity ?? 0) - (holding?.locked ?? 0),
  );
  const qty = Number(quantity);
  const validQty =
    quantity.trim() !== "" &&
    Number.isSafeInteger(qty) &&
    qty > 0 &&
    qty <= 2147483647;
  const levels = side === "BUY" ? asks : bids;
  const estimate = validQty
    ? estimateMarketOrder(levels, qty, side === "BUY" ? cashBalance : null)
    : null;
  const overHolding =
    loggedIn === true && side === "SELL" && validQty && qty > available;
  const noLiquidity = levels.length === 0;
  const cannotAfford =
    side === "BUY" && validQty && estimate?.quantity === 0 && !noLiquidity;
  const canReview =
    loggedIn === true &&
    validQty &&
    !overHolding &&
    !!estimate &&
    estimate.quantity > 0 &&
    (side === "SELL" || cashBalance !== null);
  const unit = asset.isScenario
    ? zh
      ? "模拟单位"
      : "demo units"
    : zh
      ? "碳信用"
      : "credits";
  const money = (cents: number) => `$${fmtMoney(cents)}`;
  const selectedEstimate = review?.estimate ?? estimate;
  const selectedQty = review?.quantity ?? (validQty ? qty : 0);
  const selectedSide = review?.side ?? side;

  async function confirm() {
    if (!review || submitting.current || uncertain) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<Execution>("/api/orders", {
        method: "POST",
        body: JSON.stringify({
          assetId: asset.id,
          side: review.side,
          type: "MARKET",
          price: null,
          quantity: review.quantity,
        }),
      });
      // A successful HTTP response alone cannot prove what was executed.
      // Market orders must end filled or cancelled, with consistent totals.
      if (
        typeof result?.order?.id !== "string" ||
        !result.order.id ||
        result.order.quantity !== review.quantity ||
        !Number.isSafeInteger(result.filledQty) ||
        result.filledQty < 0 ||
        result.filledQty > review.quantity ||
        !Number.isSafeInteger(result.filledCost) ||
        (result.filledQty === 0
          ? result.filledCost !== 0
          : result.filledCost <= 0) ||
        result.order.status !==
          (result.filledQty === review.quantity ? "FILLED" : "CANCELLED")
      ) {
        throw new Error("Unverifiable order response");
      }
      setReceipt({ ...result, side: review.side });
      setReview(null);
      setQuantity("");
      void onDone().catch(() => {});
    } catch (e) {
      const ambiguous =
        !(e instanceof ApiError) ||
        e.status === 0 ||
        (e.status >= 200 && e.status < 300) ||
        e.status >= 500;
      setUncertain(ambiguous);
      setError(
        ambiguous
          ? zh
            ? "未能确认订单结果。请先查看订单记录，避免重复提交。"
            : "The order result could not be confirmed. Check your order history before placing another order."
          : (e as Error).message,
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (receipt) {
    const full = receipt.filledQty === receipt.order.quantity;
    const partial = receipt.filledQty > 0 && !full;
    return (
      <section
        aria-live="polite"
        className="mx-auto max-w-2xl rounded-2xl border border-border bg-surface p-5 shadow-card"
      >
        <div
          className={`mb-5 inline-flex rounded-full px-3 py-1 text-xs font-medium ${receipt.filledQty > 0 ? "bg-accent/10 text-accent" : "bg-surface-2 text-muted"}`}
        >
          {zh ? "模拟订单结果" : "Demo order result"}
        </div>
        <h2
          ref={receiptTitleRef}
          tabIndex={-1}
          className="text-lg font-semibold"
        >
          {full
            ? zh
              ? "全部成交"
              : "Order filled"
            : partial
              ? zh
                ? "部分成交，余额已取消"
                : "Partially filled; remainder cancelled"
              : zh
                ? "未成交，订单已取消"
                : "No fill; order cancelled"}
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          {zh
            ? `已${receipt.side === "BUY" ? "买入" : "卖出"} ${fmtQty(receipt.filledQty)} / ${fmtQty(receipt.order.quantity)} ${unit}。`
            : `${receipt.side === "BUY" ? "Bought" : "Sold"} ${fmtQty(receipt.filledQty)} of ${fmtQty(receipt.order.quantity)} ${unit}.`}
          {!full &&
            (zh
              ? " 市价单未成交的部分不会保留于订单簿。"
              : " Unfilled market-order quantities do not remain in the order book.")}
        </p>
        <dl className="my-6 divide-y divide-border border-y border-border text-sm">
          <SummaryRow
            label={zh ? "实际成交总额" : "Executed total"}
            value={money(receipt.filledCost)}
          />
          <SummaryRow label={zh ? "模拟手续费" : "Demo fee"} value="$0.00" />
          <SummaryRow
            label={zh ? "名义碳量" : "Nominal carbon quantity"}
            value={`${fmtQty(receipt.filledQty)} tCO₂e`}
          />
        </dl>
        <p className="text-xs leading-5 text-muted">
          {zh
            ? "此操作只更新模拟资金与持仓，不会转移或注销真实碳信用，也不构成减排声明。"
            : "This updates simulated funds and holdings. It does not transfer or retire real carbon credits, or establish an emissions claim."}
        </p>
        <p className="mt-3 break-all text-xs text-muted">
          {zh ? "订单编号" : "Order ID"}: {receipt.order.id}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/portfolio"
            className="rounded-full bg-accent px-4 py-2.5 text-sm font-semibold text-background"
          >
            {zh ? "查看投资组合" : "View portfolio"}
          </Link>
          <Link
            href="/orders?status=ALL"
            className="rounded-full border border-border px-4 py-2.5 text-sm font-medium"
          >
            {zh ? "查看订单" : "View orders"}
          </Link>
          <button
            type="button"
            onClick={() => {
              setReceipt(null);
              setError("");
              setUncertain(false);
            }}
            className="px-2 py-2.5 text-sm text-muted hover:text-foreground"
          >
            {zh ? "再下一笔订单" : "Place another order"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <section
        aria-busy={busy}
        className="rounded-2xl border border-border bg-surface p-5 shadow-card lg:col-span-2"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2
              ref={reviewTitleRef}
              tabIndex={-1}
              className="text-lg font-semibold"
            >
              {review
                ? zh
                  ? "确认模拟订单"
                  : "Review demo order"
                : zh
                  ? "简易交易"
                  : "Simple trade"}
            </h2>
            <p className="mt-1 text-sm text-muted">
              {zh
                ? "以市场当前可成交价格买入或卖出。"
                : "Buy or sell at the available market prices."}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted">
            {zh ? "市价单" : "Market order"}
          </span>
        </div>

        {review ? (
          <div className="space-y-4">
            <div className="rounded-xl bg-surface-2 p-4">
              <p className="text-lg font-semibold">
                {review.side === "BUY"
                  ? zh
                    ? "买入"
                    : "Buy"
                  : zh
                    ? "卖出"
                    : "Sell"}{" "}
                {fmtQty(review.quantity)} {unit}
              </p>
              <p className="mt-1 text-sm text-muted">
                {asset.symbol} · {fmtQty(review.quantity)} tCO₂e{" "}
                {zh ? "名义碳量" : "nominal quantity"}
              </p>
            </div>
            <p className="text-sm leading-6 text-muted">
              {zh
                ? "市价单没有价格上限或下限。确认后的价格可能变动；可用资金或流动性不足时，只会部分成交，余额自动取消。"
                : "A market order has no price limit. Prices can change before execution. Available cash or liquidity may allow only a partial fill; any remainder is automatically cancelled."}
            </p>
            <p className="text-sm leading-6 text-muted">
              {zh
                ? "右方估算于进入确认步骤时截取。这不是保证报价；实际成交结果会于提交后显示。"
                : "The estimate was captured when you opened this review. It is not a guaranteed quote. Your actual execution will appear after confirmation."}
            </p>
            {error && (
              <p
                ref={errorRef}
                tabIndex={-1}
                role="alert"
                className="rounded-xl border border-down/25 bg-down/5 p-3 text-sm text-down"
              >
                {error}
              </p>
            )}
            {uncertain ? (
              <Link
                href="/orders?status=ALL"
                className="block rounded-full bg-accent px-4 py-3 text-center text-sm font-semibold text-background"
              >
                {zh ? "先查看订单记录" : "Check order history"}
              </Link>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={confirm}
                className="w-full rounded-full bg-accent px-4 py-3 text-sm font-semibold text-background hover:bg-accent-strong disabled:opacity-50"
              >
                {busy
                  ? zh
                    ? "正在提交…"
                    : "Placing order…"
                  : selectedSide === "BUY"
                    ? zh
                      ? "确认模拟买入"
                      : "Confirm demo buy"
                    : zh
                      ? "确认模拟卖出"
                      : "Confirm demo sell"}
              </button>
            )}
            {!uncertain && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setReview(null);
                  setError("");
                }}
                className="w-full rounded-full border border-border px-4 py-2.5 text-sm disabled:opacity-50"
              >
                {zh ? "返回修改" : "Back to edit"}
              </button>
            )}
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canReview && estimate) {
                setReview({ side, quantity: qty, estimate });
                setError("");
              }
            }}
            className="space-y-4"
          >
            <div
              role="group"
              aria-label={zh ? "交易方向" : "Order side"}
              className="grid grid-cols-2 gap-1 rounded-full bg-surface-2 p-1"
            >
              {(["BUY", "SELL"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={side === value}
                  onClick={() => {
                    onSideChange(value);
                    setError("");
                  }}
                  className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${side === value ? "bg-accent text-background shadow-sm" : "text-muted"}`}
                >
                  {value === "BUY"
                    ? zh
                      ? "买入"
                      : "Buy"
                    : zh
                      ? "卖出"
                      : "Sell"}
                </button>
              ))}
            </div>
            <div>
              <label
                htmlFor="simple-quantity"
                className="block text-sm font-medium"
              >
                {zh ? `数量（${unit}）` : `Quantity (${unit})`}
              </label>
              <input
                ref={quantityRef}
                id="simple-quantity"
                type="number"
                min="1"
                max="2147483647"
                step="1"
                inputMode="numeric"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                placeholder={zh ? "输入整数数量" : "Enter a whole number"}
                aria-describedby="simple-quantity-help simple-quantity-error"
                aria-invalid={quantity !== "" && (!validQty || overHolding)}
                className="mt-2 w-full rounded-xl border border-border bg-surface-2 px-4 py-3 text-base tnum outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
              />
              <p
                id="simple-quantity-help"
                className="mt-2 text-xs leading-5 text-muted"
              >
                {zh
                  ? "每 1 单位代表 1 tCO₂e 名义碳量。只接受整数数量。"
                  : "1 unit represents 1 tCO₂e of nominal carbon quantity. Whole numbers only."}
              </p>
              <p
                id="simple-quantity-error"
                role="status"
                className="mt-1 text-xs text-down"
              >
                {quantity !== "" && !validQty
                  ? zh
                    ? "请输入 1 至 2,147,483,647 的整数。"
                    : "Enter a whole number from 1 to 2,147,483,647."
                  : overHolding
                    ? zh
                      ? "数量超过可用持仓，请减少数量。"
                      : "This exceeds your available holdings. Reduce the quantity."
                    : ""}
              </p>
            </div>
            <div className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
              {side === "BUY" ? (
                <div className="flex justify-between gap-3">
                  <span className="text-muted">
                    {zh ? "可用模拟资金" : "Available demo cash"}
                  </span>
                  <span className="font-medium tnum">
                    {loggedIn && cashBalance !== null
                      ? money(cashBalance)
                      : "—"}
                  </span>
                </div>
              ) : (
                <div className="flex justify-between gap-3">
                  <span className="text-muted">
                    {zh ? "可用持仓" : "Available holdings"}
                  </span>
                  <span className="font-medium tnum">
                    {loggedIn ? `${fmtQty(available)} ${unit}` : "—"}
                  </span>
                </div>
              )}
              {side === "SELL" && holding && holding.locked > 0 && (
                <p className="mt-1 text-xs text-muted">
                  {zh
                    ? `${fmtQty(holding.locked)} 单位已被现有订单锁定。`
                    : `${fmtQty(holding.locked)} units are reserved by existing orders.`}
                </p>
              )}
            </div>
            {noLiquidity && (
              <p className="text-sm leading-6 text-muted">
                {zh
                  ? "目前没有可成交的对手方报价。您可以稍后再试，或使用高级模式提交限价单。"
                  : "There are no available counterparty prices right now. Try again later, or use Advanced to place a limit order."}
              </p>
            )}
            {cannotAfford && (
              <p className="text-sm text-down">
                {zh
                  ? "目前模拟资金不足以按显示价格买入 1 单位。"
                  : "Your demo cash cannot buy one whole unit at the displayed prices."}
              </p>
            )}
            {loggedIn === false ? (
              <Link
                href={`/login?returnTo=${encodeURIComponent(`/market/${asset.symbol}?tab=trade&side=${side}`)}`}
                className="block rounded-full bg-accent px-4 py-3 text-center text-sm font-semibold text-background"
              >
                {zh ? "登录以模拟交易" : "Sign in to trade with demo funds"}
              </Link>
            ) : (
              <button
                type="submit"
                disabled={!canReview}
                className="w-full rounded-full bg-accent px-4 py-3 text-sm font-semibold text-background hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-40"
              >
                {loggedIn === null
                  ? zh
                    ? "确认登录状态…"
                    : "Checking sign-in…"
                  : zh
                    ? "检查订单"
                    : "Review order"}
              </button>
            )}
          </form>
        )}
        <p className="mt-5 border-t border-border pt-4 text-xs leading-5 text-muted">
          {zh
            ? "仅使用模拟资金。此交易不购买、不转移、不注销真实碳信用。"
            : "Simulated funds only. This trade does not buy, transfer, or retire real carbon credits."}
        </p>
      </section>

      <aside className="space-y-4">
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 className="font-semibold">
            {zh ? "订单估算" : "Order estimate"}
          </h2>
          <p className="mt-1 text-xs text-muted">
            {zh
              ? "根据显示的订单簿深度"
              : "Based on displayed order-book liquidity"}
          </p>
          <dl className="mt-4 divide-y divide-border text-sm">
            <SummaryRow
              label={zh ? "要求数量" : "Requested quantity"}
              value={selectedQty ? `${fmtQty(selectedQty)} ${unit}` : "—"}
            />
            <SummaryRow
              label={zh ? "预估可成交数量" : "Estimated fill quantity"}
              value={
                selectedEstimate
                  ? `${fmtQty(selectedEstimate.quantity)} ${unit}`
                  : "—"
              }
            />
            <SummaryRow
              label={zh ? "参考平均单价" : "Indicative average price"}
              value={
                selectedEstimate && selectedEstimate.quantity > 0
                  ? `≈ ${money(selectedEstimate.totalCents / selectedEstimate.quantity)}`
                  : "—"
              }
            />
            <SummaryRow label={zh ? "模拟手续费" : "Demo fee"} value="$0.00" />
            <SummaryRow
              label={
                selectedSide === "BUY"
                  ? zh
                    ? "预估支出"
                    : "Estimated cost"
                  : zh
                    ? "预估所得"
                    : "Estimated proceeds"
              }
              value={
                selectedEstimate
                  ? `≈ ${money(selectedEstimate.totalCents)}`
                  : "—"
              }
              emphasis
            />
          </dl>
          {selectedEstimate && selectedEstimate.unfilledQuantity > 0 && (
            <p
              role="status"
              className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs leading-5 text-muted"
            >
              {zh
                ? `目前估算只能成交 ${fmtQty(selectedEstimate.quantity)} / ${fmtQty(selectedQty)} 单位。流动性或可用资金不足；结果可能是部分成交。`
                : `The current estimate covers ${fmtQty(selectedEstimate.quantity)} of ${fmtQty(selectedQty)} units. Limited liquidity or available cash may cause a partial fill.`}
            </p>
          )}
          <p className="mt-4 text-xs leading-5 text-muted">
            {zh
              ? "估算会随订单簿改变。显示的流动性可能包含您自己的挂单，但不允许自成交。"
              : "Estimates change with the order book. Displayed liquidity can include your own orders, which cannot trade with each other."}
          </p>
        </section>
        <div className="px-1 text-sm leading-6 text-muted">
          <h3 className="font-medium text-foreground">
            {zh ? "持有与注销有何不同？" : "What does holding a credit mean?"}
          </h3>
          <p className="mt-2">
            {zh
              ? "在真实市场，购买碳信用只代表持有。注销是另一个步骤，通常用于支持特定的碳声明。本平台仅记录模拟持仓，不会注销真实碳信用。"
              : "In a real market, buying a credit creates a holding. Retirement is a separate registry action used to support a specific carbon claim. This platform records simulated holdings and does not retire real credits."}
          </p>
          <Link
            href={`/market/${asset.symbol}?side=${side}`}
            className="mt-3 inline-block font-medium text-accent"
          >
            {zh ? "返回碳信用详情" : "Read the credit overview"}
          </Link>
        </div>
      </aside>
    </div>
  );
}

function SummaryRow({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={`flex justify-between gap-4 py-3 ${emphasis ? "font-semibold" : ""}`}
    >
      <dt className={emphasis ? "text-foreground" : "text-muted"}>{label}</dt>
      <dd className="text-end tnum">{value}</dd>
    </div>
  );
}
