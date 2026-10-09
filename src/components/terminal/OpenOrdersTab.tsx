"use client";

import { memo, useCallback, useRef, useState } from "react";
import type { Order, OrderStatus, Side } from "@/shared";
import { useToast } from "@/components/anim/Toast";
import { EmptyState } from "@/components/ui/EmptyState";
import { useLang, useT } from "@/i18n/LangProvider";
import { accountActions, useOpenOrders } from "@/lib/market/account-store";
import { useTimeZone } from "@/providers/useTimeZone";
import { CELL_END, CELL_START, fmtQuantity, fmtRowPrice, fmtTs, numberLocale, ROW_CLASS, sideTone, statusTone, TabTable, usePricePrecisions, type Columns } from "./TabTable";
import { useArmedCancel } from "./useArmedCancel";

export type OrderScope = "all" | "current";

/** 时间 / 标的 / 方向 / 类型 / 价格 / 数量 / 已成交 / 状态 / 撤单 */
const COLUMNS: Columns = {
  template: "minmax(6.5rem,1fr) minmax(7rem,1.2fr) 3rem 3.5rem minmax(4.5rem,1fr) minmax(3.5rem,0.8fr) minmax(3.5rem,0.8fr) 4.5rem 7rem",
  minWidth: "46rem",
};

export type CancelResult = { ok: true; order: Order } | { ok: false; status: number; retryAfter: number | null };

/**
 * DELETE /api/orders/[id](计划 §3.4):信封 { ok, data: { order } };429 带 Retry-After(秒)。
 * 不用 @/lib/http/client 的 api():它不暴露响应头,429 的倒计时就拿不到。网络失败 status 0。
 */
export async function cancelOrderRequest(id: string, fetchImpl: typeof fetch = fetch): Promise<CancelResult> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    return { ok: false, status: 0, retryAfter: null };
  }
  const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: { order?: Order } } | null;
  if (res.ok && json?.ok && json.data?.order) return { ok: true, order: json.data.order };
  const retryAfter = Number(res.headers.get("Retry-After"));
  return { ok: false, status: res.status, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
}

type OpenOrderRowProps = {
  id: string;
  createdAt: number;
  symbol: string;
  side: Side;
  type: Order["type"];
  price: number | null;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  precision: number;
  /** 两步撤单的第一步已按下:同一个按钮变成「确认撤单」(焦点不离开它) */
  armed: boolean;
  busy: boolean;
  onCancel: (id: string) => void;
};

/**
 * 当前委托的一行:React.memo + 原始类型 props;撤单按钮带 data-cancel-for,Esc 取消时焦点经它还原。
 * 请求在途时按钮是 aria-disabled 而不是 disabled:disabled 会把焦点从它身上拿走,失败(429 等)后焦点就回不来了。
 * 撤单按钮看得见的字是「撤单 / 确认撤单」,可访问名按行说清撤哪一张(方向 + 标的;武装后说明这一下是确认)。
 */
export const OpenOrderRow = memo(function OpenOrderRow(p: OpenOrderRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const tz = useTimeZone();
  return (
    <div data-order-id={p.id} className={`${ROW_CLASS} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <span className={`${CELL_START} tnum text-muted`}>{fmtTs(p.createdAt, locale, tz)}</span>
      <span className={`${CELL_START} font-medium`}>{p.symbol}</span>
      <span className={`${CELL_START} ${sideTone(p.side)}`}>{p.side === "BUY" ? t.order.buy : t.order.sell}</span>
      <span className={CELL_START}>{p.type === "LIMIT" ? t.order.limit : t.order.market}</span>
      <span className={CELL_END}>{fmtRowPrice(p.price, p.precision, lang)}</span>
      <span className={CELL_END}>{fmtQuantity(p.quantity, locale)}</span>
      <span className={CELL_END}>{fmtQuantity(p.filledQuantity, locale)}</span>
      <span className={`${CELL_START} ${statusTone(p.status)}`}>{t.tabs.status[p.status]}</span>
      <span className="flex justify-end">
        <button
          type="button"
          data-cancel-for={p.id}
          data-armed={p.armed ? "" : undefined}
          aria-label={t.tabs.cancelOrderLabel({ buy: p.side === "BUY", symbol: p.symbol, armed: p.armed })}
          aria-disabled={p.busy || undefined}
          aria-busy={p.busy || undefined}
          onClick={() => {
            if (!p.busy) p.onCancel(p.id);
          }}
          className={`rounded-chip border px-2 text-t-xs font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus aria-disabled:opacity-50 ${
            p.armed ? "border-danger bg-danger-soft text-danger" : "border-(--terminal-border) text-muted hover:border-danger/40 hover:text-danger"
          }`}
        >
          {p.armed ? t.tabs.cancelConfirm : t.tabs.cancel}
        </button>
      </span>
    </div>
  );
});

export type OpenOrdersViewProps = {
  symbol: string;
  scope: OrderScope;
  onScope: (scope: OrderScope) => void;
  orders: readonly Order[];
  /** symbol → 价格精度(usePricePrecisions;缺的按 2) */
  precisions: Readonly<Record<string, number>>;
  armedId: string | null;
  /** 撤单请求在途的委托(可以同时有几张:确认 B 时 A 的 DELETE 可能还没回来) */
  busyIds: ReadonlySet<string>;
  onCancel: (id: string) => void;
};

/** 纯展示:范围切换(全部 / 当前标的)+ 表格;空态用 EmptyState(tabs.ssr.test.ts 直接渲染它) */
export function OpenOrdersView({ symbol, scope, onScope, orders, precisions, armedId, busyIds, onCancel }: OpenOrdersViewProps) {
  const t = useT("terminal");
  // 范围切换的两个按钮:「全部」(terminal.instruments.all)与标的代码本身(symbol 不译,§4.8);按钮组的可访问名 terminal.tabs.scopeLabel
  const scopes: { key: OrderScope; label: string }[] = [
    { key: "all", label: t.instruments.all },
    { key: "current", label: symbol },
  ];
  return (
    <>
      <div role="group" aria-label={t.tabs.scopeLabel} className="flex shrink-0 items-center gap-gap">
        {scopes.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={scope === s.key}
            onClick={() => onScope(s.key)}
            className={`rounded-chip px-2 text-t-xs font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
              scope === s.key ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <TabTable<Order>
        columns={COLUMNS}
        headers={[
          { label: t.tabs.colTime },
          { label: t.tabs.colSymbol },
          { label: t.tabs.colSide },
          { label: t.tabs.colType },
          { label: t.tabs.colPrice, align: "end" },
          { label: t.tabs.colQty, align: "end" },
          { label: t.tabs.colFilled, align: "end" },
          { label: t.tabs.colStatus },
          { label: "" },
        ]}
        items={orders}
        getKey={(o) => o.id}
        label={t.a11y.ordersRegion}
        empty={<EmptyState title={t.tabs.emptyOpen} />}
        renderRow={(o) => (
          <OpenOrderRow
            id={o.id}
            createdAt={o.createdAt}
            symbol={o.symbol}
            side={o.side}
            type={o.type}
            price={o.price}
            quantity={o.quantity}
            filledQuantity={o.filledQuantity}
            status={o.status}
            precision={precisions[o.symbol] ?? 2}
            armed={armedId === o.id}
            busy={busyIds.has(o.id)}
            onCancel={onCancel}
          />
        )}
      />
    </>
  );
}

// 两步撤单的武装状态、Esc / 点别处取消与焦点还原在 ./useArmedCancel.ts(条件单页签共用);纯函数在那里,这里原样再导出(tabs.ssr.test.ts 从这里引)
export { armedEscapeAction, liveArmedId, reconcileArmed, type ArmedEscapeAction } from "./useArmedCancel";

/**
 * 当前委托(计划 §3.1):useOpenOrders(scope === "current" ? symbol : undefined),WS 的 order 事件 / 轮询快照即时反映。
 * 两步撤单:第一次点「撤单」→ 同一个按钮变成「确认撤单」(danger);再点才 DELETE /api/orders/[id];
 * 武装期间 Esc 取消(见 armedEscapeAction:对话框里的 Esc 不抢),点别处、切换范围也取消,武装的单离开列表同样视为取消(liveArmedId);
 * 成功后用响应里的订单(CANCELLED)经 account store
 * 的 action 移出挂单,不等 WS / 轮询;429 按 Retry-After 提示。几张单可以同时在撤(busyIds),每张各自防重。
 * 登录态由 BottomTabs 判定,这里只在 ready 时挂载。
 */
export function OpenOrdersTab({ symbol }: { symbol: string }) {
  const t = useT("terminal");
  const ui = useT("ui");
  const push = useToast();
  const [scope, setScope] = useState<OrderScope>("all");
  const orders = useOpenOrders(scope === "current" ? symbol : undefined);
  const precisions = usePricePrecisions();
  // 武装状态、Esc / 点别处取消、武装的单离开列表视同取消(含焦点还原):useArmedCancel(与条件单页签共用)
  const { armed, rootRef, press, disarm } = useArmedCancel(orders);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // 在途集合的 ref 同步更新,两次点击落在同一帧(state 还没提交)也不会对同一张单发两次 DELETE
  const busyRef = useRef<Set<string>>(new Set());

  const handleCancel = useCallback(
    async (id: string) => {
      if (busyRef.current.has(id)) return;
      // 第一次点只武装;已武装的同一张单再点才撤
      if (!press(id)) return;
      busyRef.current.add(id);
      setBusyIds(new Set(busyRef.current));
      const trigger = rootRef.current?.querySelector(`[data-cancel-for="${CSS.escape(id)}"]`);
      const hadFocus = trigger != null && document.activeElement === trigger;
      const result = await cancelOrderRequest(id);
      busyRef.current.delete(id);
      setBusyIds(new Set(busyRef.current));
      if (result.ok) {
        // 服务端的终态订单:CANCELLED → account store 把它移出挂单(seq 0 = 无序号,同 poll-frames 的 NO_SEQ)
        accountActions.applyAccountEvent({ t: "order", topic: "account", seq: 0, order: result.order });
        push("ok", t.toast.orderCancelled, { dedupeKey: `cancel:${id}` });
        // 行随之消失,焦点不能掉到 body:交给本面板容器
        if (hadFocus) requestAnimationFrame(() => rootRef.current?.focus());
      } else if (result.status === 429) {
        push("warning", t.toast.rateLimited(result.retryAfter ?? 1), { dedupeKey: "cancel:rate" });
      } else {
        push("err", ui.error, { dedupeKey: `cancel:${id}` });
      }
    },
    [push, t, ui, press, rootRef],
  );

  // 切换范围也取消武装(键盘切换不经过 pointerdown):否则切到「仅当前标的」藏起来的武装单,切回来时又是武装态
  const handleScope = useCallback(
    (next: OrderScope) => {
      disarm();
      setScope(next);
    },
    [disarm],
  );

  return (
    <div ref={rootRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col gap-gap focus-visible:outline-none">
      <OpenOrdersView
        symbol={symbol}
        scope={scope}
        onScope={handleScope}
        orders={orders}
        precisions={precisions}
        armedId={armed}
        busyIds={busyIds}
        onCancel={handleCancel}
      />
    </div>
  );
}
