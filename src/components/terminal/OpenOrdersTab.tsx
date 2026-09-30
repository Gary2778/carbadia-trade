"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Order, OrderStatus, Side } from "@/shared";
import { useToast } from "@/components/anim/Toast";
import { EmptyState } from "@/components/ui/EmptyState";
import { useLang, useT } from "@/i18n/LangProvider";
import { accountActions, useOpenOrders } from "@/lib/market/account-store";
import { CELL_END, CELL_START, fmtQuantity, fmtRowPrice, fmtTs, numberLocale, ROW_CLASS, sideTone, statusTone, TabTable, usePricePrecisions, type Columns } from "./TabTable";

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
 */
export const OpenOrderRow = memo(function OpenOrderRow(p: OpenOrderRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  return (
    <div data-order-id={p.id} className={`${ROW_CLASS} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <span className={`${CELL_START} tnum text-muted`}>{fmtTs(p.createdAt, locale)}</span>
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

/** 武装期间一下 Esc 的处理方式(见 armedEscapeAction) */
export type ArmedEscapeAction = "ignore" | "disarm" | "disarm-and-focus";

/**
 * 两步撤单武装期间按下 Esc 该做什么(纯函数:tabs.ssr.test.ts 用假元素测;active = document.activeElement,root = 本面板容器):
 *   - "ignore":焦点在打开的 <dialog> 里(OrderConfirmDialog、FillDetailDialog 自己处理 Esc,不能被这里 preventDefault 截掉),
 *     或本面板在 inert 子树里(左栏抽屉是模态,Esc 归抽屉);武装保持,下一次 Esc 再取消;
 *   - "disarm-and-focus":焦点在本面板里,或掉在 body 上 —— 取消武装、preventDefault,焦点还给触发按钮;
 *   - "disarm":焦点在面板外的别处(例如搜索框)—— 取消武装、preventDefault,但不去抢焦点。
 */
export function armedEscapeAction(active: Element | null, root: Element | null, body: Element | null): ArmedEscapeAction {
  if (active?.closest("dialog[open]")) return "ignore";
  if (root?.closest("[inert]")) return "ignore";
  if (!active || active === body || root?.contains(active)) return "disarm-and-focus";
  return "disarm";
}

/**
 * 武装的单还在列表里才算武装:它被机器人吃完、在别处撤掉、或切到「仅当前标的」后看不到了,都视同取消武装 ——
 * 否则 window 上的 Esc 监听一直挂着,下一次随便在哪按 Esc 都会被它 preventDefault 吞掉。
 * OpenOrdersTab 发现它不成立时还会把 armedId 本身清掉(渲染期调整 state):同一 id 再回到列表 —— D16 订阅快照与终态事件赛跑后
 * upsert 回来、截断快照的 upsert —— 也不会悄悄重新武装。
 */
export function liveArmedId(armedId: string | null, orders: readonly Order[]): string | null {
  return armedId !== null && orders.some((o) => o.id === armedId) ? armedId : null;
}

/**
 * 纯函数:渲染期对武装 state 的调整(OpenOrdersTab 按 React「随输入调整 state」的写法调用)。
 * 武装的单不在列表里了 → 返回 armedId null、vanished true(调用方写回 state,并记一次「消失」好还原焦点);否则原样、vanished false。
 * 因为清的是 state 本身而不只是派生值,同一 id 之后再回到列表也不会悄悄重新武装。
 */
export function reconcileArmed(armedId: string | null, orders: readonly Order[]): { armedId: string | null; vanished: boolean } {
  if (armedId !== null && liveArmedId(armedId, orders) === null) return { armedId: null, vanished: true };
  return { armedId, vanished: false };
}

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
  const [armedId, setArmedId] = useState<string | null>(null);
  /** 武装的单离开列表的次数:下面的 effect 据此还原焦点 */
  const [armedVanished, setArmedVanished] = useState(0);
  // 武装的单离开了列表(被吃完、在别处撤掉):武装就此作废。渲染期按 React「随输入调整 state」的写法清掉 armedId
  // (条件只成立一次,不会循环;React 丢弃这一遍、立即以新 state 重渲染)—— 同一 id 之后再回到列表(D16 订阅快照与终态事件
  // 赛跑后 upsert 回来、截断快照的 upsert)也不会悄悄重新武装、重新挂上吞 Esc 的监听
  if (reconcileArmed(armedId, orders).vanished) {
    setArmedId(null);
    setArmedVanished((n) => n + 1);
  }
  // 派生值仍保留(liveArmedId):下面的监听、视图与 handleCancel 都只看 armed
  const armed = liveArmedId(armedId, orders);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  // handleCancel 经 ref 读武装 / 在途状态,自身引用保持稳定 —— 它是每个 memo 行的 prop,武装一次不该让整张表重渲染;
  // 在途集合的 ref 同步更新,两次点击落在同一帧(state 还没提交)也不会对同一张单发两次 DELETE
  const armedRef = useRef<string | null>(null);
  const busyRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  // 武装的那一行消失时,它的「确认撤单」按钮若有焦点,焦点会掉到 body:交还本面板容器(焦点在别处就不动)
  useEffect(() => {
    if (armedVanished === 0) return;
    if (document.activeElement === null || document.activeElement === document.body) rootRef.current?.focus();
  }, [armedVanished]);

  // 武装期间:Esc 取消(Safari 点击不聚焦按钮,所以挂在 window 上而不是按钮的 onKeyDown);在别处按下指针也取消。
  // 捕获阶段:先于 TerminalShell 与全局快捷键(P1-22)的冒泡阶段监听器运行,preventDefault 之后它们看 defaultPrevented 就知道这一下已被处理
  useEffect(() => {
    if (armed === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const action = armedEscapeAction(document.activeElement, rootRef.current, document.body);
      if (action === "ignore") return;
      e.preventDefault();
      armedRef.current = null;
      setArmedId(null);
      if (action === "disarm-and-focus") rootRef.current?.querySelector<HTMLButtonElement>(`[data-cancel-for="${CSS.escape(armed)}"]`)?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target.closest("[data-cancel-for]") : null;
      if (target?.getAttribute("data-cancel-for") === armed) return;
      armedRef.current = null;
      setArmedId(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [armed]);

  const handleCancel = useCallback(
    async (id: string) => {
      if (busyRef.current.has(id)) return;
      if (armedRef.current !== id) {
        armedRef.current = id;
        setArmedId(id);
        return;
      }
      armedRef.current = null;
      setArmedId(null);
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
    [push, t, ui],
  );

  // 切换范围也取消武装(键盘切换不经过 pointerdown):否则切到「仅当前标的」藏起来的武装单,切回来时又是武装态
  const handleScope = useCallback((next: OrderScope) => {
    armedRef.current = null;
    setArmedId(null);
    setScope(next);
  }, []);

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
