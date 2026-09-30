"use client";

import { memo, useEffect, useMemo } from "react";
import type { AccountOrdersResponse, CancelReason, Order, OrderStatus, Side } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { useLang, useT } from "@/i18n/LangProvider";
import { api } from "@/lib/http/client";
import { useAccountStore } from "@/lib/market/account-store";
import { onOpenOrdersClosed, onSignOut, useRefreshOnAccountChange } from "@/lib/market/account-refresh";
import { createUserQueryCache, usePagedSnapshot, type Page } from "@/lib/market/paged-query";
import { CELL_END, CELL_START, fmtQuantity, fmtRowPrice, fmtTs, numberLocale, ROW_CLASS, sideTone, statusTone, TabTable, usePricePrecisions, type Columns } from "./TabTable";

export const HISTORY_PAGE_LIMIT = 50;

/** 时间 / 标的 / 方向 / 类型 / 价格 / 数量 / 已成交 / 均价 / 状态(状态格带可见的短撤单原因「Cancelled · self-trade」,8rem 放得下) */
const COLUMNS: Columns = {
  template: "minmax(6.5rem,1fr) minmax(7rem,1.2fr) 3rem 3.5rem minmax(4.5rem,1fr) minmax(3.5rem,0.8fr) minmax(3.5rem,0.8fr) minmax(4.5rem,1fr) 8rem",
  minWidth: "49rem",
};

/** 与 /api/account/orders 的键集分页同序:createdAt desc, id desc */
export const newestOrderFirst = (a: Order, b: Order): number => b.createdAt - a.createdAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);

export function historyPageUrl(cursor: string | null): string {
  const params = new URLSearchParams({ status: "history", limit: String(HISTORY_PAGE_LIMIT) });
  if (cursor) params.set("cursor", cursor);
  return `/api/account/orders?${params.toString()}`;
}

async function fetchHistoryPage(cursor: string | null): Promise<Page<Order>> {
  const data = await api<AccountOrdersResponse>(historyPageUrl(cursor));
  return { items: data.orders, nextCursor: data.nextCursor };
}

// 模块级缓存(每位用户一份):切走 Tab 再回来不重拉、不丢已翻的页;换用户 key 变了就换新的。forUser 幂等,可在渲染期调用。
// 两个账户 store 订阅(只在浏览器里挂;Tab 没挂载时也要生效,所以不放在组件里):
//   - 登出 / 换号即丢弃上一位用户已翻的页 —— BottomTabs 未登录时不挂 Tab,渲染期走不到 forUser(null);
//   - 挂单离开 openOrders(机器人吃完、在别处撤掉、本面板撤单):它按自己当初的 createdAt 进历史,可能落在第一页之后、
//     已加载的范围之内,只重读第一页永远看不到它 —— 记成 markStale,下一次 refresh(挂载时、账户有动静时)读到覆盖它的位置。
//     只对已经打开过的列表记(peek 不新建);排在已加载末行之后的由翻页读到终态。
export const historyQueries = createUserQueryCache<Order>("history", { fetchPage: fetchHistoryPage, getKey: (o) => o.id, compare: newestOrderFirst });
if (typeof window !== "undefined") {
  onSignOut(historyQueries.clear);
  onOpenOrdersClosed((meId, orders) => historyQueries.peek(meId)?.markStale(orders));
}

type HistoryRowProps = {
  createdAt: number;
  symbol: string;
  side: Side;
  type: Order["type"];
  price: number | null;
  quantity: number;
  filledQuantity: number;
  avgFillPrice: number | null;
  status: OrderStatus;
  cancelReason: CancelReason | null;
  precision: number;
};

/**
 * 纯函数:撤销原因的文字(terminal.tabs.cancelReason.<CancelReason>:用户撤单 / 市价余量取消 / 自成交防护撤单,计划 §9.2 D20);
 * 没有原因或该原因没有文案时为 undefined(不给 title)。
 */
export function cancelReasonText(reasons: Partial<Record<CancelReason, string>>, reason: CancelReason | null): string | undefined {
  return reason ? reasons[reason] : undefined;
}

/**
 * 历史委托一行:React.memo + 原始类型 props。撤销原因(用户撤单 / 市价余量取消 / 自成交防护撤单)在状态格里可见 ——
 * 状态之后一段短原因(tabs.cancelReasonShort,aria-hidden),读屏念完整原因(sr-only),悬停提示也是完整原因;
 * 触屏与键盘用户不靠悬停也能看到「是被自成交防护撤掉的」(自成交 toast 一闪而过,历史行是唯一留得住的说明)。
 */
export const HistoryRow = memo(function HistoryRow(p: HistoryRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const reason = cancelReasonText(t.tabs.cancelReason, p.cancelReason);
  const shortReason = cancelReasonText(t.tabs.cancelReasonShort, p.cancelReason);
  return (
    <div className={`${ROW_CLASS} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <span className={`${CELL_START} tnum text-muted`}>{fmtTs(p.createdAt, locale)}</span>
      <span className={`${CELL_START} font-medium`}>{p.symbol}</span>
      <span className={`${CELL_START} ${sideTone(p.side)}`}>{p.side === "BUY" ? t.order.buy : t.order.sell}</span>
      <span className={CELL_START}>{p.type === "LIMIT" ? t.order.limit : t.order.market}</span>
      <span className={CELL_END}>{fmtRowPrice(p.price, p.precision, lang)}</span>
      <span className={CELL_END}>{fmtQuantity(p.quantity, locale)}</span>
      <span className={CELL_END}>{fmtQuantity(p.filledQuantity, locale)}</span>
      <span className={CELL_END}>{fmtRowPrice(p.avgFillPrice, p.precision, lang)}</span>
      <span className={`${CELL_START} ${statusTone(p.status)}`} title={reason}>
        {t.tabs.status[p.status]}
        {shortReason ? <span aria-hidden="true" className="ms-1 text-t-2xs text-muted">{`· ${shortReason}`}</span> : null}
        {reason ? <span className="sr-only">{` · ${reason}`}</span> : null}
      </span>
    </div>
  );
});

/**
 * 历史委托(计划 §3.1、§3.6):createPagedQuery 走 /api/account/orders?status=history,键集游标、每页 50;
 * 滚到底(哨兵行进入虚拟列表的挂载范围)自动拉下一页,按 id 去重。store 不保留终态单,所以实时性靠 useRefreshOnAccountChange
 * 触发 refresh(成交、撤单改动账户指纹;WS 下每次委托结果都带 balance 事件,零成交即取消的市价单也能看到;重连时补一次);
 * 挂载时若已有缓存也 refresh 一次,补上离开期间完成的单。refresh 从第一页往下读到与已加载的行接上为止(离开期间多于一页也不漏),
 * 并读到覆盖 markStale 记下的旧单(见上面的模块级订阅)。
 */
export function OrderHistoryTab() {
  const t = useT("terminal");
  const meId = useAccountStore((s) => s.me?.id ?? null);
  const query = useMemo(() => historyQueries.forUser(meId), [meId]);
  const snapshot = usePagedSnapshot(query);
  const precisions = usePricePrecisions();

  useEffect(() => {
    void query?.refresh();
  }, [query]);
  useRefreshOnAccountChange(query ? query.refresh : null);

  return (
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
        { label: t.tabs.colAvg, align: "end" },
        { label: t.tabs.colStatus },
      ]}
      items={snapshot.items}
      getKey={(o) => o.id}
      label={t.a11y.ordersRegion}
      empty={<EmptyState title={t.tabs.emptyHistory} />}
      pager={query ? { status: snapshot.status, onLoadMore: query.loadMore } : undefined}
      renderRow={(o) => (
        <HistoryRow
          createdAt={o.createdAt}
          symbol={o.symbol}
          side={o.side}
          type={o.type}
          price={o.price}
          quantity={o.quantity}
          filledQuantity={o.filledQuantity}
          avgFillPrice={o.avgFillPrice}
          status={o.status}
          cancelReason={o.cancelReason}
          precision={precisions[o.symbol] ?? 2}
        />
      )}
    />
  );
}
