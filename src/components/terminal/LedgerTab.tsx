"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { ActivityType, LedgerAccount, LedgerActivity, LedgerActivityResponse } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useLang, useT } from "@/i18n/LangProvider";
import { ACTIVITY_TYPES, LEDGER_ACCOUNTS } from "@/lib/exchange/ledger-activity";
import { api } from "@/lib/http/client";
import { useAccountStore } from "@/lib/market/account-store";
import { onSignOut, useRefreshOnAccountChange } from "@/lib/market/account-refresh";
import { createUserQueryCache, usePagedSnapshot, type Page, type PagedQuery, type PagedSnapshot, type UserQueryCache } from "@/lib/market/paged-query";
import { ExportCsvLink } from "./ExportCsvLink";
import { CELL_END, CELL_START, fmtLedgerDelta, fmtTs, isCashAccount, ledgerTone, numberLocale, ROW_CLASS, TabTable, type Columns } from "./TabTable";

// 终端「流水」页签(计划 §6.2.3 P2-07):本人的账本行,数据来自 GET /api/transactions(§6.2.2 C4)。
// 本文件经 BottomTabs 的 next/dynamic 懒加载,选中该页签才取代码,不进 /trade/[symbol] 的首屏。
// 筛选状态只在组件里(不进 URL、不持久化);筛选一变就换一份查询(缓存键 = 筛选组合 + 时间段当天的起点),切回来时已翻的页还在。

// 成交详情对话框只在点开时加载(与 FillsTab 同一个 chunk)
const FillDetailDialog = dynamic(() => import("./FillDetailDialog").then((m) => m.FillDetailDialog), {
  ssr: false,
  loading: () => <Skeleton rows={1} />,
});

export const LEDGER_PAGE_LIMIT = 50;

/** 时间段:今天 / 7 天 / 30 天 / 全部;顺序即下拉的顺序 */
export const LEDGER_RANGES = ["today", "7d", "30d", "all"] as const;
export type LedgerRange = (typeof LEDGER_RANGES)[number];
/** 标的筛选:全部,或终端当前的标的(跟着换标的走) */
export type LedgerScope = "all" | "current";

/** 筛选条的状态;null = 不限 */
export type LedgerFilterState = { account: LedgerAccount | null; type: ActivityType | null; scope: LedgerScope; range: LedgerRange };
export const DEFAULT_LEDGER_FILTERS: LedgerFilterState = Object.freeze({ account: null, type: null, scope: "all", range: "all" });

export const isDefaultLedgerFilters = (f: LedgerFilterState): boolean => f.account === null && f.type === null && f.scope === "all" && f.range === "all";

/** 筛选状态落到具体标的之后的样子。时间段还是名字:换算成 from 要有「此刻」(rangeFrom),查询的身份见 ledgerRequestKey */
export type LedgerRequest = { account: LedgerAccount | null; type: ActivityType | null; symbol: string | null; range: LedgerRange };

export function ledgerRequest(filters: LedgerFilterState, symbol: string): LedgerRequest {
  return { account: filters.account, type: filters.type, symbol: filters.scope === "current" ? symbol : null, range: filters.range };
}

/**
 * 时间段 → from(毫秒,含);"all" 为 null。按用户本地的日历日起算:today = 今天 0 点,7d / 30d = 今天连同之前的 6 / 29 天。
 * 取整到本地 0 点而不是「此刻往前 N 个 24 小时」:一天之内边界不动,所以它能进缓存键(见 ledgerRequestKey)。
 */
export function rangeFrom(range: LedgerRange, now: number): number | null {
  if (range === "all") return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range !== "today") start.setDate(start.getDate() - (range === "7d" ? 6 : 29));
  return start.getTime();
}

/**
 * 查询缓存键里的筛选部分:四项各占一段,不限写 *。有下界的时间段带上当天算出的 from(`7d@<from>`)——
 * 模块级缓存在切页签之后还在,键里只有时间段的名字的话,过了本地午夜取回的还是昨天那份,里面留着已经掉出窗口的行。
 * from 一天之内不变(rangeFrom),所以当天是同一个键、同一份查询;换了一天就是新键、新查询,旧的那份按最近使用淘汰。
 * 一份查询建好之后 from 不再变:翻页与刷新用的都是键里的那个 from(见 createLedgerQueries)。
 * 页签开着跨过午夜时,组件手里还是原来那份查询(窗口仍是前一天的);换筛选、换标的或重新进页签时才按新的一天取。
 */
export function ledgerRequestKey(request: LedgerRequest, now: number): string {
  const from = rangeFrom(request.range, now);
  return [request.account ?? "*", request.type ?? "*", request.symbol ?? "*", from === null ? request.range : `${request.range}@${from}`].join("|");
}

/**
 * 筛选 → 查询参数(纯函数;参数名与 src/lib/server/ledger-activity-page.ts 的 readLedgerFilters 一致:account / type / symbol / from)。
 * 不带 limit / cursor,也不传 to(到此刻为止)—— CSV 导出用的是同一组筛选参数(计划 §6.2.2 C5)。
 */
export function ledgerQueryParams(request: LedgerRequest, now: number): URLSearchParams {
  const params = new URLSearchParams();
  if (request.account) params.set("account", request.account);
  if (request.type) params.set("type", request.type);
  if (request.symbol) params.set("symbol", request.symbol);
  const from = rangeFrom(request.range, now);
  if (from !== null) params.set("from", String(from));
  return params;
}

export function ledgerPageUrl(request: LedgerRequest, cursor: string | null, now: number): string {
  const params = new URLSearchParams({ limit: String(LEDGER_PAGE_LIMIT) });
  for (const [name, value] of ledgerQueryParams(request, now)) params.set(name, value);
  if (cursor) params.set("cursor", cursor);
  return `/api/transactions?${params.toString()}`;
}

/**
 * CSV 导出的地址(计划 §6.2.2 C5):/api/transactions.csv + 与列表同一组筛选参数(ledgerQueryParams,不带 limit / cursor)。
 * now 与列表的查询取同一天:时间段的 from 按本地日历日起算,一天之内不变(rangeFrom)。
 */
export function ledgerCsvHref(request: LedgerRequest, now: number = Date.now()): string {
  const query = ledgerQueryParams(request, now).toString();
  return `/api/transactions.csv${query ? `?${query}` : ""}`;
}

/** 与 /api/transactions 的键集分页同序:入账时刻 desc, id desc(同一毫秒常有多行:一次冻结就是现金与冻结现金两条腿) */
export const newestLedgerFirst = (a: LedgerActivity, b: LedgerActivity): number => b.ts - a.ts || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);
const ledgerKey = (entry: LedgerActivity): string => entry.id;

/** now = 这份查询建立的时刻(不是发请求的时刻):同一份查询的每一页、每一次刷新都用同一个 from */
async function fetchLedgerPage(request: LedgerRequest, cursor: string | null, now: number): Promise<Page<LedgerActivity>> {
  const data = await api<LedgerActivityResponse>(ledgerPageUrl(request, cursor, now));
  return { items: data.items, nextCursor: data.nextCursor };
}

/** 同时留着的筛选组合数:切回最近用过的筛选不重拉;标的会一直换,所以要有上限 */
export const LEDGER_CACHE_MAX = 6;

/**
 * 模块级缓存:每个筛选组合一份 createUserQueryCache(每位用户一份分页查询,写法同 OrderHistoryTab / FillsTab),
 * 键 = `ledger:<筛选>:<用户>`(筛选部分见 ledgerRequestKey,有下界的时间段带当天的 from)。forUser 幂等,可在渲染期(useMemo)调用:
 * 同一用户、同一筛选在同一个本地日历日里永远是同一实例;过了午夜再取是一份新查询。now 只有测试才传。
 * 最多留 LEDGER_CACHE_MAX 个组合,按最近使用淘汰——每次取用都把它挪到最新,所以被淘汰的不会是页面正订阅着的那一份
 * (淘汰时 clear 会通知订阅者,渲染期不能让它落到挂着的组件上)。
 * 账本行只增不改,不需要 markStale;新行靠 refresh 读到顶上。
 */
function createLedgerQueries(max: number) {
  const caches = new Map<string, UserQueryCache<LedgerActivity>>();
  return {
    forUser(meId: string | null, request: LedgerRequest, now: number = Date.now()): PagedQuery<LedgerActivity> | null {
      if (!meId) return null;
      const key = ledgerRequestKey(request, now);
      let cache = caches.get(key);
      if (cache) caches.delete(key);
      else cache = createUserQueryCache<LedgerActivity>(`ledger:${key}`, { fetchPage: (cursor) => fetchLedgerPage(request, cursor, now), getKey: ledgerKey, compare: newestLedgerFirst });
      caches.set(key, cache);
      for (const [oldest, stale] of caches) {
        if (caches.size <= max) break;
        stale.clear();
        caches.delete(oldest);
      }
      return cache.forUser(meId);
    },
    /** 作废并丢弃全部组合(登出 / 换号) */
    clear(): void {
      for (const cache of caches.values()) cache.clear();
      caches.clear();
    },
  };
}

// 登出 / 换号即丢弃上一位用户的流水 —— BottomTabs 未登录时不挂 Tab,所以挂在账户 store 上(只在浏览器里订阅)
export const ledgerQueries = createLedgerQueries(LEDGER_CACHE_MAX);
if (typeof window !== "undefined") onSignOut(ledgerQueries.clear);

export type LedgerUnit = "cash" | "tonnes" | "scenario";

/**
 * 变动的单位:先看账户(现金 / 冻结现金是整数分),再看 isScenario —— 情景标的成交的现金行 isScenario 也是 true,
 * 它仍是现金;只有持仓账户上的情景标的才写「情景单位」(不是碳信用,不写吨)。
 */
export function ledgerUnit(account: LedgerAccount, isScenario: boolean): LedgerUnit {
  if (isCashAccount(account)) return "cash";
  return isScenario ? "scenario" : "tonnes";
}

export type LedgerRefKind = "fill" | "certificate" | "text";

/**
 * 引用怎么展示:成交(TRADE)→ 打开成交详情;注销(RETIREMENT)→ 凭证链接;其余(订单、OTC 挂单 / 成交、不认识的类别)→ 文字。
 * 没有引用(赠金、期初余额)→ null,显示「—」。
 */
export function ledgerRefKind(refType: string | null, refId: string | null): LedgerRefKind | null {
  if (!refType || !refId) return null;
  if (refType === "TRADE") return "fill";
  if (refType === "RETIREMENT") return "certificate";
  return "text";
}

/** 私有的模拟注销凭证(本人才能打开;与旧 /transactions 页的「查看凭证」同一地址) */
export const certificateHref = (retirementId: string): string => `/api/retirements/${encodeURIComponent(retirementId)}/certificate`;

/** 引用 id 的尾段(完整 id 在 title 里) */
export const refTail = (id: string): string => (id.length > 8 ? `…${id.slice(-8)}` : id);

/** 有文案的引用类别(terminal.ledger.refs 的键 = 账本写入器的 refType) */
const KNOWN_REFS = ["TRADE", "ORDER", "RETIREMENT", "LISTING", "DEAL"] as const;
type KnownRef = (typeof KNOWN_REFS)[number];
const isKnownRef = (refType: string): refType is KnownRef => (KNOWN_REFS as readonly string[]).includes(refType);

/** 时间 / 类型 / 标的 / 账户 / 变动 / 引用(引用列的下限含 REF_PAD 的 0.75rem;六列下限 + 间距 = 45.5rem,不超过表格最小宽) */
const COLUMNS: Columns = {
  template: "minmax(6.5rem,1fr) minmax(7.5rem,1.3fr) minmax(7rem,1.2fr) minmax(6rem,1fr) minmax(8rem,1.1fr) minmax(8.75rem,1.2fr)",
  minWidth: "46rem",
};

/**
 * 引用列与前一列拉开的距离:变动列右对齐、引用列左对齐,两列之间只有 gap-gap 的话读起来连成一串(「+685.00 USD Order …」)。
 * 表头与文字格用起始内边距;按钮 / 链接用同样大小的起始外边距,焦点环与悬停下划线仍贴着文字。
 */
const REF_PAD = "ps-panel";
const REF_ACTION =
  "ms-panel truncate rounded-chip text-start text-t-xs text-muted underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:shadow-focus";

type LedgerRefProps = { refType: string | null; refId: string | null; onOpenFill: (fillId: string) => void };

/** 引用格(见 ledgerRefKind)。成交的 id 就是成交详情接口的 id;注销凭证在新标签页打开 */
function LedgerRef({ refType, refId, onOpenFill }: LedgerRefProps) {
  const t = useT("terminal");
  const kind = ledgerRefKind(refType, refId);
  if (kind === null || refType === null || refId === null) return <span className={`${CELL_START} ${REF_PAD} text-muted`}>—</span>;
  if (kind === "fill") {
    return (
      <button type="button" data-fill-ref={refId} title={t.ledger.refFillHint} onClick={() => onOpenFill(refId)} className={`tnum ${REF_ACTION}`}>
        {`${t.ledger.refs.TRADE} ${refTail(refId)}`}
      </button>
    );
  }
  if (kind === "certificate") {
    return (
      <a href={certificateHref(refId)} target="_blank" rel="noopener noreferrer" title={t.ledger.refCertificateHint} className={REF_ACTION}>
        {t.ledger.refs.RETIREMENT}
        <span className="sr-only">{` ${t.ledger.newTab}`}</span>
      </a>
    );
  }
  // 不认识的类别原样显示账本里的代码,不猜它是什么
  const name = isKnownRef(refType) ? t.ledger.refs[refType] : refType;
  return (
    <span className={`${CELL_START} ${REF_PAD} tnum text-t-xs text-muted`} title={refId}>
      {`${name} ${refTail(refId)}`}
    </span>
  );
}

export type LedgerRowProps = {
  id: string;
  ts: number;
  type: ActivityType;
  symbol: string | null;
  account: LedgerAccount;
  delta: number;
  isScenario: boolean;
  refType: string | null;
  refId: string | null;
  onOpenFill: (fillId: string) => void;
};

/**
 * 流水一行:React.memo + 原始类型 props。类型与账户按代码取 terminal.ledger 的文案(不显示接口里的英文 label)。
 * 变动带正负号与单位;增减用正负号加一个读屏词表示,不用涨跌色(TabTable 的 ledgerTone,成交详情的账本行同样处理)。
 */
export const LedgerRow = memo(function LedgerRow(p: LedgerRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const direction = p.delta > 0 ? "in" : p.delta < 0 ? "out" : "none";
  const typeLabel = t.ledger.types[p.type];
  return (
    <div data-ledger-id={p.id} className={`${ROW_CLASS} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <span className={`${CELL_START} tnum text-muted`}>{fmtTs(p.ts, locale)}</span>
      <span className={CELL_START} title={typeLabel}>
        {typeLabel}
      </span>
      {p.symbol ? <span className={`${CELL_START} font-medium`}>{p.symbol}</span> : <span className={`${CELL_START} text-muted`}>—</span>}
      <span className={`${CELL_START} text-muted`}>{t.ledger.accounts[p.account]}</span>
      <span data-direction={direction} className={`${CELL_END} ${ledgerTone(p.delta)}`}>
        {direction === "none" ? null : <span className="sr-only">{`${direction === "in" ? t.ledger.increase : t.ledger.decrease} `}</span>}
        {fmtLedgerDelta(p.account, p.delta, locale)}
        {/* 数字与单位之间是一个真的空格(不是外边距):读屏与复制出来的文字都是「+685.00 USD」 */}
        <span className="text-t-2xs text-muted">{` ${t.ledger.units[ledgerUnit(p.account, p.isScenario)]}`}</span>
      </span>
      <LedgerRef refType={p.refType} refId={p.refId} onOpenFill={p.onOpenFill} />
    </div>
  );
});

const SELECT =
  "min-h-touch shrink-0 rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-1 text-t-xs text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-0.5";

export type LedgerViewProps = {
  /** 终端当前的标的:标的筛选的「当前标的」一项 */
  symbol: string;
  filters: LedgerFilterState;
  onFilters: (next: LedgerFilterState) => void;
  items: readonly LedgerActivity[];
  /** 当前查询的分页状态与翻页动作;没有查询(身份未知)时不传 */
  pager?: { status: PagedSnapshot<LedgerActivity>["status"]; onLoadMore: () => void };
  onOpenFill: (fillId: string) => void;
  /** CSV 导出的地址(ledgerCsvHref,带着当前筛选);不传就不显示导出入口 */
  exportHref?: string;
};

/**
 * 流水的筛选条 + 表格(纯展示,ledger.ssr.test.ts 直接渲染)。
 * 筛选条是四个原生 <select>(键盘、读屏、触屏都现成;各带 aria-label),窄视口下筛选组自己横向滚动,不折行挤占表格;
 * 导出入口是筛选组外、不收缩的兄弟节点,手机上也总在可见处(P2-12:原来整行一起滚,375 宽时要把筛选条滚到头才看得到它);
 * 加载中 / 出错 / 空三态由 TabTable 与 ui/ 的统一反馈件给出,筛选条在三态下都在,能换一个筛选再试。
 */
export function LedgerView({ symbol, filters, onFilters, items, pager, onOpenFill, exportHref }: LedgerViewProps) {
  const t = useT("terminal");
  const filtered = !isDefaultLedgerFilters(filters);
  return (
    <>
      {/* 工具行:左边四个筛选(窄视口时筛选组自己横向滚动;内边距给焦点环留位置),右边导出(P2-06,不收缩、不随筛选组滚走) */}
      <div className="flex shrink-0 items-center gap-gap">
        <div role="group" aria-label={t.ledger.filtersLabel} className="flex min-w-0 flex-1 items-center gap-gap overflow-x-auto p-0.5">
          <select
            aria-label={t.ledger.filterAccount}
            value={filters.account ?? ""}
            onChange={(e) => onFilters({ ...filters, account: LEDGER_ACCOUNTS.find((account) => account === e.target.value) ?? null })}
            className={SELECT}
          >
            <option value="">{t.ledger.allAccounts}</option>
            {LEDGER_ACCOUNTS.map((account) => (
              <option key={account} value={account}>
                {t.ledger.accounts[account]}
              </option>
            ))}
          </select>
          <select
            aria-label={t.ledger.filterType}
            value={filters.type ?? ""}
            onChange={(e) => onFilters({ ...filters, type: ACTIVITY_TYPES.find((type) => type === e.target.value) ?? null })}
            className={SELECT}
          >
            <option value="">{t.ledger.allTypes}</option>
            {ACTIVITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {t.ledger.types[type]}
              </option>
            ))}
          </select>
          <select
            aria-label={t.ledger.filterSymbol}
            value={filters.scope}
            onChange={(e) => onFilters({ ...filters, scope: e.target.value === "current" ? "current" : "all" })}
            className={SELECT}
          >
            <option value="all">{t.ledger.allSymbols}</option>
            <option value="current">{symbol}</option>
          </select>
          <select
            aria-label={t.ledger.filterRange}
            value={filters.range}
            onChange={(e) => onFilters({ ...filters, range: LEDGER_RANGES.find((range) => range === e.target.value) ?? "all" })}
            className={SELECT}
          >
            {LEDGER_RANGES.map((range) => (
              <option key={range} value={range}>
                {t.ledger.ranges[range]}
              </option>
            ))}
          </select>
        </div>
        {exportHref ? (
          <div className="flex shrink-0 p-0.5">
            <ExportCsvLink href={exportHref} filtered={filtered} />
          </div>
        ) : null}
      </div>
      <TabTable<LedgerActivity>
        columns={COLUMNS}
        headers={[
          { label: t.tabs.colTime },
          { label: t.tabs.colType },
          { label: t.tabs.colSymbol },
          { label: t.tabs.colAccount },
          { label: t.tabs.colDelta, align: "end" },
          { label: t.ledger.colRef, className: REF_PAD },
        ]}
        items={items}
        getKey={ledgerKey}
        label={t.ledger.region}
        empty={
          filtered ? (
            <EmptyState
              title={t.ledger.emptyFiltered}
              action={
                <button
                  type="button"
                  onClick={() => onFilters(DEFAULT_LEDGER_FILTERS)}
                  className="rounded-control border border-(--terminal-border) px-3 py-1 text-t-sm font-medium text-foreground hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus"
                >
                  {t.ledger.clearFilters}
                </button>
              }
            />
          ) : (
            <EmptyState title={t.ledger.empty} />
          )
        }
        pager={pager}
        renderRow={(entry) => (
          <LedgerRow
            id={entry.id}
            ts={entry.ts}
            type={entry.type}
            symbol={entry.symbol}
            account={entry.account}
            delta={entry.delta}
            isScenario={entry.isScenario}
            refType={entry.refType}
            refId={entry.refId}
            onOpenFill={onOpenFill}
          />
        )}
      />
    </>
  );
}

/**
 * 流水页签(计划 §6.2.3 P2-07):/api/transactions 键集分页(每页 50,滚到底自动加载,按 id 去重)。
 * 筛选(账户、类型、标的、时间段)一变就换一份查询;「当前标的」跟着终端换标的走。
 * 实时性同历史委托 / 成交记录:挂载与换查询时 refresh 一次,之后账户有动静(下单冻结、撤单解冻、成交、注销……)就重读第一页,
 * 新行并到顶上(WS 下每次委托结果都带 balance 事件;轮询模式 ≤ 5 s 跟上)。
 * 登录态由 BottomTabs 判定,这里只在 ready 时挂载。
 */
export function LedgerTab({ symbol }: { symbol: string }) {
  const meId = useAccountStore((s) => s.me?.id ?? null);
  const [filters, setFilters] = useState<LedgerFilterState>(DEFAULT_LEDGER_FILTERS);
  const request = useMemo(() => ledgerRequest(filters, symbol), [filters, symbol]);
  const query = useMemo(() => ledgerQueries.forUser(meId, request), [meId, request]);
  // 与查询同时算:两者的 from 取同一天(页签开着跨过午夜时两者都还是前一天的窗口,见 ledgerRequestKey)
  const exportHref = useMemo(() => ledgerCsvHref(request), [request]);
  const snapshot = usePagedSnapshot(query);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    void query?.refresh();
  }, [query]);
  useRefreshOnAccountChange(query ? query.refresh : null);

  const handleOpen = useCallback((fillId: string) => setDetailId(fillId), []);
  const handleClose = useCallback(() => setDetailId(null), []);

  return (
    <>
      <LedgerView
        symbol={symbol}
        filters={filters}
        onFilters={setFilters}
        items={snapshot.items}
        pager={query ? { status: snapshot.status, onLoadMore: query.loadMore } : undefined}
        onOpenFill={handleOpen}
        exportHref={exportHref}
      />
      {detailId ? <FillDetailDialog key={detailId} fillId={detailId} onClose={handleClose} /> : null}
    </>
  );
}
