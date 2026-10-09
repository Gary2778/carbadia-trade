"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountTriggersResponse, OrderType, Side, Trigger, TriggerDirection, TriggerKind, TriggerReason, TriggerStatus } from "@/shared";
import { useToast } from "@/components/anim/Toast";
import { EmptyState } from "@/components/ui/EmptyState";
import type { Messages } from "@/i18n";
import { useLang, useT } from "@/i18n/LangProvider";
import { api } from "@/lib/http/client";
import { useAccountStore, useOpenTriggers } from "@/lib/market/account-store";
import { onSignOut } from "@/lib/market/account-refresh";
import { createUserQueryCache, usePagedSnapshot, type Page, type PagedSnapshot } from "@/lib/market/paged-query";
import { cancelTrigger } from "@/lib/market/trigger-submit";
import { useTimeZone } from "@/providers/useTimeZone";
import { CELL_START, fmtQuantity, fmtRowPrice, fmtTs, numberLocale, PIN_END, PIN_ROW, ROW_CLASS, sideTone, TabTable, usePricePrecisions, type Columns } from "./TabTable";
import { useArmedCancel } from "./useArmedCancel";

type TerminalText = Messages["terminal"];

export const TRIGGER_HISTORY_PAGE_LIMIT = 50;

/**
 * 进行中:时间 / 标的 / 类型 / 条件 / 触发后 / 状态 / 撤销;历史:时间 / 标的 / 类型 / 条件 / 状态 / 触发后(状态在前:1280 宽时先看得到结果)。
 * 两张表都比 1280 宽时的底部页签(约 660 px)宽:进行中的撤销列贴右(TabTable 的 pinEdges,同持仓页签的操作列),横向滚动时撤销按钮一直看得见;
 * 手机上不贴边,整张表一起滚(terminal.css 的贴边只在 ≥ 48rem)。类型、条件、触发后三格被截断时悬停看得到全文(title)。
 * 「触发后」列 10rem 起:「Limit 1,234.56 buy 1,000 t」这样的一句放得下。
 * 历史的状态格下面还有一行原因(被拒 / 被撤),最多折两行:列宽 12.5rem 起,行高用 --spacing-row-touch(TabTable 的 tallRows),最长的原因(INSUFFICIENT_QTY / NO_FILL 的买入那句)在 320 宽的手机上也读得全。
 */
const LEAD_TEMPLATE = "minmax(7.5rem,1fr) minmax(7rem,1.2fr) minmax(6.5rem,0.9fr) minmax(4.5rem,0.8fr)";
const AFTER_COLUMN = "minmax(10rem,1.4fr)";
const OPEN_COLUMNS: Columns = { template: `${LEAD_TEMPLATE} ${AFTER_COLUMN} minmax(6rem,1fr) 7rem`, minWidth: "50.5rem" };
const HISTORY_COLUMNS: Columns = { template: `${LEAD_TEMPLATE} minmax(12.5rem,2fr) ${AFTER_COLUMN}`, minWidth: "50rem" };

/** 「类型」列:ALERT → 价格提醒;同组成对的 ORDER(止盈止损)ABOVE 是止盈、BELOW 是止损;其余是条件单 */
export type TriggerType = keyof TerminalText["triggers"]["types"];
export function triggerTypeOf(trigger: Pick<Trigger, "kind" | "ocoGroupId" | "direction">): TriggerType {
  if (trigger.kind === "ALERT") return "alert";
  if (trigger.ocoGroupId) return trigger.direction === "ABOVE" ? "takeProfit" : "stopLoss";
  return "conditional";
}

/** 「条件」列:≥ / ≤ 触发价(最新成交价达到它时触发) */
export const conditionText = (direction: TriggerDirection, price: string): string => `${direction === "ABOVE" ? "≥" : "≤"} ${price}`;

/** 「触发后」列:市价买 / 卖多少吨,限价另带委托价;价格提醒不下单,「—」 */
export function actionText(
  text: TerminalText,
  p: { kind: TriggerKind; side: Side | null; orderType: OrderType | null; quantity: number | null; limit: string },
  locale: string,
): string {
  if (p.kind === "ALERT" || p.side === null || p.quantity === null) return "—";
  const args = { buy: p.side === "BUY", qty: fmtQuantity(p.quantity, locale) };
  return p.orderType === "LIMIT" ? text.triggers.actionLimit({ ...args, price: p.limit }) : text.triggers.actionMarket(args);
}

/**
 * 状态文案:价格提醒不下单 —— 触发中不说「正在下单」、触发了不说「委托已提交」;
 * 被拒但原因是 NO_FILL(市价单交上去了、一吨都没成交)不是「下单失败」,说「已触发 · 没有成交」,与通知("Triggered, but nothing filled")同一个意思。
 */
export function triggerStatusText(text: TerminalText, kind: TriggerKind, status: TriggerStatus, reason: TriggerReason | null = null): string {
  if (kind === "ALERT" && status === "TRIGGERING") return text.triggers.alertTriggering;
  if (kind === "ALERT" && status === "TRIGGERED") return text.triggers.alertTriggered;
  if (status === "REJECTED" && reason === "NO_FILL") return text.triggers.noFill.status;
  return text.triggers.status[status];
}

/**
 * 状态格下面那一行原因(被拒 / 被撤才有):NO_FILL 按那张单的方向说(买:没钱或没人卖;卖:没人买),没有方向就不编;其余按 TriggerReason 取字。
 * NO_FILL 只属于被拒的行,别的状态带着它(脏数据)不显示。USER(本人撤销)不另起一行:状态「已撤销」已经说了。
 */
export function triggerReasonText(text: TerminalText, status: TriggerStatus, reason: TriggerReason | null, side: Side | null): string | undefined {
  if (reason === null || reason === "USER") return undefined;
  if (reason === "NO_FILL") return status !== "REJECTED" || side === null ? undefined : side === "BUY" ? text.triggers.noFill.buy : text.triggers.noFill.sell;
  return text.triggers.reason[reason];
}

/** 状态着色:语义色(触发 success、拒绝 danger、正在下单 warning、撤销 muted),不随涨跌轴翻转;「已触发 · 没有成交」不是失败,用 warning */
export const triggerStatusTone = (status: TriggerStatus, reason: TriggerReason | null = null): string =>
  status === "TRIGGERED"
    ? "text-success"
    : status === "REJECTED"
      ? reason === "NO_FILL"
        ? "text-warning"
        : "text-danger"
      : status === "TRIGGERING"
        ? "text-warning"
        : status === "CANCELLED"
          ? "text-muted"
          : "text-foreground";

/** 与 /api/account/triggers 的键集分页同序:createdAt desc, id desc */
export const newestTriggerFirst = (a: Trigger, b: Trigger): number => b.createdAt - a.createdAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);

export function triggerHistoryUrl(cursor: string | null): string {
  const params = new URLSearchParams({ status: "history", limit: String(TRIGGER_HISTORY_PAGE_LIMIT) });
  if (cursor) params.set("cursor", cursor);
  return `/api/account/triggers?${params.toString()}`;
}

async function fetchHistoryPage(cursor: string | null): Promise<Page<Trigger>> {
  const data = await api<AccountTriggersResponse>(triggerHistoryUrl(cursor));
  return { items: data.triggers, nextCursor: data.nextCursor };
}

/**
 * 同一位已登录用户的条件单离开 openTriggers(触发、被撤、被拒、快照收口)时调用 listener(meId, 离开的行);返回解除函数。
 * 登出 / 换号时整个清空不算(那由 onSignOut 处理)。同 account-refresh 的 onOpenOrdersClosed。
 */
export function onOpenTriggersClosed(listener: (meId: string, gone: Trigger[]) => void): () => void {
  return useAccountStore.subscribe((state, prev) => {
    if (state.openTriggers === prev.openTriggers) return;
    const me = state.me?.id;
    if (!me || prev.me?.id !== me) return;
    const gone: Trigger[] = [];
    for (const [id, trigger] of prev.openTriggers) if (!state.openTriggers.has(id)) gone.push(trigger);
    if (gone.length > 0) listener(me, gone);
  });
}

// 历史的模块级缓存(每位用户一份,同 OrderHistoryTab):切走再回来不重拉、不丢已翻的页;登出即丢弃。
// 条件单离开进行中列表时它按自己当初的 createdAt 进历史,可能落在第一页之后:记 markStale,下一次 refresh 读到覆盖它的位置
export const triggerHistoryQueries = createUserQueryCache<Trigger>("trigger-history", { fetchPage: fetchHistoryPage, getKey: (row) => row.id, compare: newestTriggerFirst });
if (typeof window !== "undefined") {
  onSignOut(triggerHistoryQueries.clear);
  onOpenTriggersClosed((meId, gone) => triggerHistoryQueries.peek(meId)?.markStale(gone));
}

export type TriggerRowProps = {
  id: string;
  /** 时间列:进行中是创建时间,历史是结束的时间(firedAt ?? updatedAt) */
  time: number;
  symbol: string;
  kind: TriggerKind;
  /** 「类型」列(triggerTypeOf) */
  type: TriggerType;
  direction: TriggerDirection;
  triggerPrice: number;
  side: Side | null;
  orderType: OrderType | null;
  limitPrice: number | null;
  quantity: number | null;
  status: TriggerStatus;
  reason: TriggerReason | null;
  precision: number;
  /** 进行中列表的撤销列(历史列表没有这一列,onCancel 不传) */
  onCancel?: (id: string) => void;
  armed?: boolean;
  busy?: boolean;
};

/**
 * 条件单表的一行(React.memo + 原始类型 props)。撤销只给 PENDING:正在下单(TRIGGERING)的那一下撤不了,格子留空。
 * 两步撤销与当前委托一样:第一次点「撤单」变「确认撤单」,再点才发请求;请求在途与「已经撤不了、等它离开列表」时按钮 aria-disabled。
 * 状态格:状态一行,被拒 / 被撤时下面单独一行原因(最多两行,不靠悬停也读得到;历史列表的行高是 --spacing-row-touch,放得下)。
 * 列序:进行中(有 onCancel)「触发后」在状态前,历史状态在前(见 HISTORY_COLUMNS)。
 */
export const TriggerRow = memo(function TriggerRow(p: TriggerRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const tz = useTimeZone();
  const price = (cents: number | null) => fmtRowPrice(cents, p.precision, lang);
  const reason = triggerReasonText(t, p.status, p.reason, p.side);
  const type = t.triggers.types[p.type];
  const condition = conditionText(p.direction, price(p.triggerPrice));
  const action = actionText(t, { kind: p.kind, side: p.side, orderType: p.orderType, quantity: p.quantity, limit: price(p.limitPrice) }, locale);
  const after = (
    <span title={action} className={`${CELL_START} ${p.side && p.kind === "ORDER" ? sideTone(p.side) : "text-muted"}`}>
      {action}
    </span>
  );
  const status = (
    <span data-status="" className={`flex min-w-0 flex-col leading-t-tight ${triggerStatusTone(p.status, p.reason)}`}>
      <span className="truncate">{triggerStatusText(t, p.kind, p.status, p.reason)}</span>
      {reason ? (
        // 最多两行;万一被截断,悬停仍看得到全文
        <span title={reason} className="line-clamp-2 whitespace-normal text-t-2xs text-muted">
          {reason}
        </span>
      ) : null}
    </span>
  );
  return (
    <div
      data-trigger-id={p.id}
      className={`${ROW_CLASS}${p.onCancel ? ` ${PIN_ROW}` : ""} hover:bg-(--terminal-row-hover)`}
      style={{ gridTemplateColumns: (p.onCancel ? OPEN_COLUMNS : HISTORY_COLUMNS).template }}
    >
      <span className={`${CELL_START} tnum text-muted`}>{fmtTs(p.time, locale, tz)}</span>
      <span className={`${CELL_START} font-medium`}>{p.symbol}</span>
      <span title={type} className={CELL_START}>
        {type}
      </span>
      <span title={condition} className={`${CELL_START} tnum`}>
        {condition}
      </span>
      {p.onCancel ? (
        <>
          {after}
          {status}
          <span className={`${PIN_END} flex items-center justify-end`}>
            {p.status === "PENDING" ? <CancelButton id={p.id} label={{ type, symbol: p.symbol }} armed={p.armed ?? false} busy={p.busy ?? false} onCancel={p.onCancel} /> : null}
          </span>
        </>
      ) : (
        <>
          {status}
          {after}
        </>
      )}
    </div>
  );
});

/**
 * 撤销按钮:同当前委托(data-cancel-for 供 Esc 还原焦点;在途时 aria-disabled 而不是 disabled,失败后焦点还在它身上)。
 * 看得见的字是「撤单 / 确认撤单」,可访问名按行说清撤的是哪一条(类型 + 标的;武装后说明这一下是确认)
 */
function CancelButton({ id, label, armed, busy, onCancel }: { id: string; label: { type: string; symbol: string }; armed: boolean; busy: boolean; onCancel: (id: string) => void }) {
  const t = useT("terminal");
  return (
    <button
      type="button"
      data-cancel-for={id}
      data-armed={armed ? "" : undefined}
      aria-label={t.triggers.cancelLabel({ ...label, armed })}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={() => {
        if (!busy) onCancel(id);
      }}
      className={`rounded-chip border px-2 text-t-xs font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus aria-disabled:opacity-50 ${
        armed ? "border-danger bg-danger-soft text-danger" : "border-(--terminal-border) text-muted hover:border-danger/40 hover:text-danger"
      }`}
    >
      {armed ? t.tabs.cancelConfirm : t.tabs.cancel}
    </button>
  );
}

/** finished = 历史列表:时间列取结束的时间(触发的 firedAt;被撤 / 没触发就结束的取 updatedAt),进行中取创建时间 */
const rowProps = (row: Trigger, precisions: Readonly<Record<string, number>>, finished = false): TriggerRowProps => ({
  id: row.id,
  time: finished ? (row.firedAt ?? row.updatedAt) : row.createdAt,
  symbol: row.symbol,
  kind: row.kind,
  type: triggerTypeOf(row),
  direction: row.direction,
  triggerPrice: row.triggerPrice,
  side: row.side,
  orderType: row.orderType,
  limitPrice: row.limitPrice,
  quantity: row.quantity,
  status: row.status,
  reason: row.reason,
  precision: precisions[row.symbol] ?? 2,
});

const headersOf = (text: TerminalText, history: boolean) => {
  const lead = [{ label: text.tabs.colTime }, { label: text.tabs.colSymbol }, { label: text.tabs.colType }, { label: text.tabs.colCondition }];
  return history ? [...lead, { label: text.tabs.colStatus }, { label: text.triggers.after }] : [...lead, { label: text.triggers.after }, { label: text.tabs.colStatus }];
};

export type OpenTriggersViewProps = {
  triggers: readonly Trigger[];
  precisions: Readonly<Record<string, number>>;
  armedId: string | null;
  /** 撤销在途、或已答「撤不了」等它离开列表的行 */
  busyIds: ReadonlySet<string>;
  onCancel: (id: string) => void;
};

/** 纯展示:进行中的条件单与价格提醒(triggers.ssr.test.ts 直接渲染) */
export function OpenTriggersView({ triggers, precisions, armedId, busyIds, onCancel }: OpenTriggersViewProps) {
  const t = useT("terminal");
  return (
    <TabTable<Trigger>
      columns={OPEN_COLUMNS}
      headers={[...headersOf(t, false), { label: "", className: PIN_END }]}
      items={triggers}
      getKey={(row) => row.id}
      label={t.a11y.triggersRegion}
      empty={<EmptyState title={t.tabs.emptyTriggers} />}
      pinEdges
      renderRow={(row) => <TriggerRow {...rowProps(row, precisions)} armed={armedId === row.id} busy={busyIds.has(row.id)} onCancel={onCancel} />}
    />
  );
}

/** 纯展示:已结束的条件单与价格提醒,分页(triggers.ssr.test.ts 直接渲染) */
export function TriggerHistoryView({ snapshot, precisions, onLoadMore }: { snapshot: PagedSnapshot<Trigger>; precisions: Readonly<Record<string, number>>; onLoadMore?: () => void }) {
  const t = useT("terminal");
  return (
    <TabTable<Trigger>
      columns={HISTORY_COLUMNS}
      headers={headersOf(t, true)}
      items={snapshot.items}
      getKey={(row) => row.id}
      label={t.a11y.triggersRegion}
      empty={<EmptyState title={t.tabs.emptyTriggerHistory} />}
      pager={onLoadMore ? { status: snapshot.status, onLoadMore } : undefined}
      tallRows
      renderRow={(row) => <TriggerRow {...rowProps(row, precisions, true)} />}
    />
  );
}

/**
 * 进行中(计划 §6.3.2 C2):useOpenTriggers()(全部标的,同当前委托的「全部」),WS 的 trigger 事件 / 轮询快照即时反映。
 * 两步撤销照当前委托(OpenOrdersTab)的做法:Esc / 点别处取消武装,武装的行离开列表视同取消;成功后撤销结果已由 cancelTrigger 写进 store,
 * 行随之消失,toast 带去重键。服务端答「撤不了」(已在触发或刚被撤):它很快会离开列表,按钮一直保持在途,不让人再点出第二个 409。
 */
function OpenTriggersList() {
  const t = useT("terminal");
  const push = useToast();
  const triggers = useOpenTriggers();
  const precisions = usePricePrecisions();
  // 能撤的只有 PENDING:正在触发的行撤不了,武装状态只对着 PENDING 的行对账(行开始触发 → 视同取消武装,Esc 监听随之卸掉)
  const pending = useMemo(() => triggers.filter((row) => row.status === "PENDING"), [triggers]);
  const { armed, rootRef, press } = useArmedCancel(pending);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set());
  // 在途集合的 ref 同步更新:两次点击落在同一帧也不会对同一行发两次 DELETE
  const busyRef = useRef<Set<string>>(new Set());

  const handleCancel = useCallback(
    async (id: string) => {
      if (busyRef.current.has(id)) return;
      // 第一次点只武装;已武装的同一行再点才撤
      if (!press(id)) return;
      busyRef.current.add(id);
      setBusyIds(new Set(busyRef.current));
      const button = rootRef.current?.querySelector(`[data-cancel-for="${CSS.escape(id)}"]`);
      const hadFocus = button != null && document.activeElement === button;
      const res = await cancelTrigger(id);
      const dedupeKey = `cancel-trigger:${id}`;
      if (res.ok) {
        // 行已随撤销结果离开列表;它的 id 留在在途集合里无妨(撤销过的 id 不会再回到进行中)
        push("ok", t.triggers.cancelled(t.triggers.types[triggerTypeOf(res.trigger)]), { dedupeKey });
        if (hadFocus) requestAnimationFrame(() => rootRef.current?.focus());
        return;
      }
      if (res.code === "notCancellable") {
        // 已在触发或刚被撤:保持在途,直到触发 / 撤销的事件把它移出列表
        push("info", t.triggers.submitErrors.notCancellable, { dedupeKey });
        return;
      }
      busyRef.current.delete(id);
      setBusyIds(new Set(busyRef.current));
      if (res.code === "rateLimited") push("warning", res.retryAfter !== null ? t.toast.rateLimited(res.retryAfter) : t.triggers.submitErrors.rateLimited, { dedupeKey: "cancel-trigger:rate" });
      else push("err", t.triggers.submitErrors[res.code], { dedupeKey });
    },
    [push, t, press, rootRef],
  );

  return (
    <div ref={rootRef} tabIndex={-1} className="flex min-h-0 flex-1 flex-col focus-visible:outline-none">
      <OpenTriggersView triggers={triggers} precisions={precisions} armedId={armed} busyIds={busyIds} onCancel={handleCancel} />
    </div>
  );
}

/** 历史:GET /api/account/triggers?status=history 键集分页;挂载时与每次有条件单离开进行中列表时 refresh(读到与已加载的行接上为止) */
function TriggerHistoryList() {
  const meId = useAccountStore((s) => s.me?.id ?? null);
  const query = useMemo(() => triggerHistoryQueries.forUser(meId), [meId]);
  const snapshot = usePagedSnapshot(query);
  const precisions = usePricePrecisions();
  useEffect(() => {
    if (!query) return;
    void query.refresh();
    return onOpenTriggersClosed(() => void query.refresh());
  }, [query]);
  return <TriggerHistoryView snapshot={snapshot} precisions={precisions} onLoadMore={query?.loadMore} />;
}

type TriggerView = "open" | "history";
const VIEWS: readonly TriggerView[] = ["open", "history"];

/**
 * 底部「条件单」页签(P3-07;计划 §6.3.2 C2 / C3):两项开关 进行中 / 历史。进行中 = 账户 store 的未完结条件单与价格提醒(全部标的),
 * 历史 = 分页的 REST 列表。列:时间、标的、类型(条件单 / 止盈 / 止损 / 价格提醒)、条件(≥ / ≤ 触发价)、触发后(市价 / 限价买卖多少吨,
 * 提醒「—」)、状态(被拒 / 被撤带原因),进行中另有撤销。由 BottomTabs 经 next/dynamic 懒加载,只在登录态就绪时挂载。
 */
export function TriggersTab() {
  const t = useT("terminal");
  const [view, setView] = useState<TriggerView>("open");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-gap">
      <div role="group" aria-label={t.tabs.triggerScopeLabel} className="flex shrink-0 items-center gap-gap">
        {VIEWS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={`rounded-chip px-2 text-t-xs font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
              view === key ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {key === "open" ? t.tabs.triggerOpen : t.tabs.triggerHistory}
          </button>
        ))}
      </div>
      {view === "open" ? <OpenTriggersList /> : <TriggerHistoryList />}
    </div>
  );
}
