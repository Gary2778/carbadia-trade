"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { AuditRef, Fill, FillsResponse, Side } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useLang, useT } from "@/i18n/LangProvider";
import { api } from "@/lib/http/client";
import { useAccountStore } from "@/lib/market/account-store";
import { onSignOut, useRefreshOnAccountChange } from "@/lib/market/account-refresh";
import { createUserQueryCache, mergeNewest, usePagedSnapshot, type Page } from "@/lib/market/paged-query";
import { ExportCsvBar, FILLS_CSV_HREF } from "./ExportCsvLink";
import { CELL_END, CELL_START, fmtCents, fmtQuantity, fmtRowPrice, fmtTs, numberLocale, ROW_CLASS, sideTone, TabTable, usePricePrecisions, type Columns } from "./TabTable";

// 成交详情对话框只在点开时加载(计划 §3.1、§3.6:next/dynamic({ ssr: false }),loading 统一 Skeleton)
const FillDetailDialog = dynamic(() => import("./FillDetailDialog").then((m) => m.FillDetailDialog), {
  ssr: false,
  loading: () => <Skeleton rows={1} />,
});

export const FILLS_PAGE_LIMIT = 50;

/** 时间 / 标的 / 方向 / 角色 / 价格 / 数量 / 金额 / 手续费 / 审计引用 */
const COLUMNS: Columns = {
  template: "minmax(6.5rem,1fr) minmax(7rem,1.2fr) 3rem 3.5rem minmax(4.5rem,1fr) minmax(3.5rem,0.8fr) minmax(5.5rem,1fr) 4rem minmax(10rem,1.6fr)",
  minWidth: "52rem",
};

/** 与 /api/account/fills 的键集分页同序:成交时间 desc, id desc */
export const newestFillFirst = (a: Fill, b: Fill): number => b.ts - a.ts || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
const fillKey = (f: Fill): string => f.id;

export function fillsPageUrl(cursor: string | null): string {
  const params = new URLSearchParams({ limit: String(FILLS_PAGE_LIMIT) });
  if (cursor) params.set("cursor", cursor);
  return `/api/account/fills?${params.toString()}`;
}

/** CSV 导出(计划 §6.2.2 C5):本页签没有筛选,导出本人全部成交;定义在 ExportCsvLink(BottomTabs 也要用) */
export { FILLS_CSV_HREF };

async function fetchFillsPage(cursor: string | null): Promise<Page<Fill>> {
  const data = await api<FillsResponse>(fillsPageUrl(cursor));
  return { items: data.fills, nextCursor: data.nextCursor };
}

// 模块级缓存(每位用户一份,同 OrderHistoryTab):切走 Tab 再回来不重拉、不丢已翻的页。forUser 幂等,可在渲染期调用;
// 登出 / 换号即丢弃上一位用户已翻的页 —— BottomTabs 未登录时不挂 Tab,所以挂在账户 store 上(只在浏览器里订阅)
export const fillsQueries = createUserQueryCache<Fill>("fills", { fetchPage: fetchFillsPage, getKey: fillKey, compare: newestFillFirst });
if (typeof window !== "undefined") onSignOut(fillsQueries.clear);

export type FillRowProps = {
  id: string;
  ts: number;
  symbol: string;
  side: Side;
  role: Fill["role"];
  price: number;
  quantity: number;
  notional: number;
  feeCents: number;
  auditRef: AuditRef;
  precision: number;
  onOpen: (id: string) => void;
};

/**
 * 成交一行(计划 §3.1、§4.8、D5):React.memo + 原始类型 props(审计引用的 prop 叫 auditRef,不叫 ref)。
 * 行尾显示 SIM-TRD-<tradeId> 并配 terminal.tape.auditNote(title + 读屏文本):模拟成交引用,不是登记机构记录;
 * 22 px 的行放不下第二行字,可见的那一份在表下(FillsTab 的 footnote),触屏 / 不悬停的用户也看得到。
 * 点整行或审计引用按钮打开 FillDetailDialog(账本行、对手方类型、披露文案)。
 */
export const FillRow = memo(function FillRow(p: FillRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  return (
    <div
      data-fill-id={p.id}
      onClick={() => p.onOpen(p.id)}
      className={`${ROW_CLASS} cursor-pointer hover:bg-(--terminal-row-hover)`}
      style={{ gridTemplateColumns: COLUMNS.template }}
    >
      <span className={`${CELL_START} tnum text-muted`}>{fmtTs(p.ts, locale)}</span>
      <span className={`${CELL_START} font-medium`}>{p.symbol}</span>
      <span className={`${CELL_START} ${sideTone(p.side)}`}>{p.side === "BUY" ? t.order.buy : t.order.sell}</span>
      <span className={`${CELL_START} text-muted`}>{p.role === "MAKER" ? t.tabs.maker : t.tabs.taker}</span>
      <span className={CELL_END}>{fmtRowPrice(p.price, p.precision, lang)}</span>
      <span className={CELL_END}>{fmtQuantity(p.quantity, locale)}</span>
      <span className={CELL_END}>{fmtCents(p.notional, locale)}</span>
      <span className={`${CELL_END} text-muted`}>{fmtCents(p.feeCents, locale)}</span>
      <button
        type="button"
        title={t.tape.auditNote}
        onClick={(e) => {
          e.stopPropagation();
          p.onOpen(p.id);
        }}
        className="tnum truncate rounded-chip text-start font-mono text-t-xs text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus"
      >
        {p.auditRef}
        <span className="sr-only">{` · ${t.tape.auditNote}`}</span>
      </button>
    </div>
  );
});

/**
 * 成交记录(计划 §3.1):/api/account/fills 游标分页(每页 50,滚到底自动加载,去重)+ store 的 recentFills(WS fill 事件前插)合并,
 * 新成交出现在顶上。两种传输都挂 useRefreshOnAccountChange:轮询模式没有 fill 事件,账户指纹一变就重读第一页(≤ 5 s 跟上);
 * WS 模式下重连期间、account 主题欠账 / 重同步(D16)期间的成交不会以 fill 事件补发(订阅快照里也没有成交),
 * 靠随后的快照改动指纹、或连接重新 open 时重读第一页补上。按 id 去重,多出的一次请求不会产生重复行。
 */
export function FillsTab() {
  const t = useT("terminal");
  const meId = useAccountStore((s) => s.me?.id ?? null);
  const live = useAccountStore((s) => s.recentFills);
  const precisions = usePricePrecisions();
  const query = useMemo(() => fillsQueries.forUser(meId), [meId]);
  const snapshot = usePagedSnapshot(query);
  const fills = useMemo(() => mergeNewest(live, snapshot.items, fillKey, newestFillFirst), [live, snapshot.items]);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    void query?.refresh();
  }, [query]);
  useRefreshOnAccountChange(query ? query.refresh : null);

  const handleOpen = useCallback((id: string) => setDetailId(id), []);
  const handleClose = useCallback(() => setDetailId(null), []);

  return (
    <>
      <ExportCsvBar href={FILLS_CSV_HREF} />
      <TabTable<Fill>
        columns={COLUMNS}
        headers={[
          { label: t.tabs.colTime },
          { label: t.tabs.colSymbol },
          { label: t.tabs.colSide },
          { label: t.tabs.colRole },
          { label: t.tabs.colPrice, align: "end" },
          { label: t.tabs.colQty, align: "end" },
          { label: t.tabs.colNotional, align: "end" },
          { label: t.tabs.colFee, align: "end" },
          { label: t.tabs.colAuditRef, title: t.tape.auditNote },
        ]}
        items={fills}
        getKey={fillKey}
        label={t.a11y.fillsRegion}
        empty={<EmptyState title={t.tabs.emptyFills} />}
        // 审计引用的说明每张表可见一次(§4.8、D5:每处展示 auditRef 都带 auditNote);行里的 title + 读屏文本保留
        footnote={t.tape.auditNote}
        pager={query ? { status: snapshot.status, onLoadMore: query.loadMore } : undefined}
        renderRow={(f) => (
          <FillRow
            id={f.id}
            ts={f.ts}
            symbol={f.symbol}
            side={f.side}
            role={f.role}
            price={f.price}
            quantity={f.quantity}
            notional={f.notional}
            feeCents={f.feeCents}
            auditRef={f.auditRef}
            precision={precisions[f.symbol] ?? 2}
            onOpen={handleOpen}
          />
        )}
      />
      {detailId ? <FillDetailDialog key={detailId} fillId={detailId} onClose={handleClose} /> : null}
    </>
  );
}
