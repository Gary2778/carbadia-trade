"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { CostBasisStatus, Position } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { tCountry, tProjectType } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { usePositions } from "@/lib/market/account-store";
import { switchSymbol } from "@/lib/market/navigation";
import {
  groupPositions,
  lastPriceOf,
  lockSourcesOf,
  positionMetaOf,
  positionValue,
  reconcileRetireRequest,
  type GroupedPositions,
  type PositionGroup,
  type PositionMeta,
  type RetireRequest,
} from "@/lib/market/position-groups";
import { marketActions, useMarketStore } from "@/lib/market/store";
import {
  CELL_END,
  CELL_START,
  fmtCents,
  fmtQuantity,
  fmtRowPrice,
  fmtSignedCents,
  numberLocale,
  PIN_ALT,
  PIN_END,
  PIN_ROW,
  PIN_START,
  pnlTone,
  ROW_CLASS,
  TabTable,
  type Columns,
} from "./TabTable";

// 注销对话框第一次点「注销」才下载与挂载(计划 §6.2.2 C7:next/dynamic,不进终端首屏);它是模态对话框,加载那一瞬不占位。
const RetireDialog = dynamic(() => import("@/components/account/RetireDialog").then((m) => m.RetireDialog), { ssr: false });
// 止盈止损对话框同样第一次点开才下载与挂载(P3-07);关闭即卸载,没有要保留的半成品
const TakeProfitStopLossDialog = dynamic(() => import("./TakeProfitStopLossDialog").then((m) => m.TakeProfitStopLossDialog), { ssr: false });

/**
 * 年份 · 标的 / 可交易 / 已锁定 / 已注销 / 平均成本 / 最新价 / 市值 / 未实现盈亏 / 操作。
 * 最小宽度 49.75rem(796 px)放得进 1440 宽时底部页签的约 798 px:不横向滚动就看得到每行的「卖出 / 注销 / 止盈止损」(P2-12;
 * P3-07 加第三个按钮:操作列 5.5rem → 9.5rem,英文「Take-profit / stop-loss」在按钮里均衡折成两行、行高不变;平均成本与最新价两列下限 4rem → 3.75rem 让出宽度);
 * 多出的宽度大半给首列(年份 · 标的 · 情景标记)。更窄时表格横向滚动;从 48rem 起(1280 宽约 638 px、平板)首列与操作列贴边(pinEdges),
 * 分组标题贴左。48rem 以下(手机)不贴边,整张表一起横向滚:滚动区太窄,两头一贴中间几列读不全(见 terminal.css 的贴边列一节)。
 */
const COLUMNS: Columns = {
  template: "minmax(10.5rem,2.4fr) repeat(3,minmax(3.25rem,0.6fr)) repeat(2,minmax(3.75rem,0.8fr)) repeat(2,minmax(5rem,1fr)) 9.5rem",
  minWidth: "49.75rem",
};

/** 「已注销」分组里的行去哪看证书:旧 /retirement 页保留注销记录与证书(计划 §6.2.2 C8) */
export const RETIREMENT_HISTORY_HREF = "/retirement";

/** 模拟项目编号的前缀(计划 §9.1 第 15 条:SIM-PRJ-<STANDARD>-<TYPE>,不是登记机构的项目编号) */
const SIMULATED_PROJECT_PREFIX = "SIM-PRJ-";

/**
 * 持仓行 Sell 按钮的点击处理(只在事件里调用,不在渲染期):先写下单草稿种子,再换到该标的(OrderPanel 在 symbol 变化时按 draft.side 重置)。
 * setDraft 整颗替换种子,不带 price 即没有价格 —— 之前在别的标的盘口点过的价格不会跟着带进这张卖单。
 */
export function handlePositionSell(symbol: string): void {
  marketActions.setDraft({ symbol, side: "SELL" });
  switchSymbol(symbol);
}

/**
 * 虚拟列表里的一行(分组头也是行,固定行高):
 *   group = 项目组头;position = 一个年份一行;locks = 有锁定、且服务端给了来源时跟在该行后面的「挂单 n · 场外 n」;
 *   retiredHeader = 页签底部「已注销」分组的折叠按钮(带合计吨数);retired = 展开后的整仓注销行。
 */
export type PositionListRow =
  | { kind: "group"; key: string; group: PositionGroup }
  | { kind: "position"; key: string; position: Position }
  | { kind: "locks"; key: string; assetId: string; orders: number; otc: number }
  | { kind: "retiredHeader"; key: string; count: number; tonnes: number }
  | { kind: "retired"; key: string; position: Position };

/**
 * 分组结果 → 行序列(纯函数):各项目组(组头 + 各年份,有锁定的行后跟锁定来源)在前,「已注销」分组垫底、默认只有组头。
 * 锁定来源服务端没给(lockSourcesOf 为 null:回滚到 Phase 1 的服务端)时没有来源行,那一行只显示锁定总数。
 */
export function positionRows(grouped: GroupedPositions, retiredOpen: boolean): PositionListRow[] {
  const rows: PositionListRow[] = [];
  for (const group of grouped.groups) {
    rows.push({ kind: "group", key: `group:${group.key}`, group });
    for (const position of group.positions) {
      rows.push({ kind: "position", key: position.assetId, position });
      const sources = position.locked > 0 ? lockSourcesOf(position) : null;
      if (sources) rows.push({ kind: "locks", key: `locks:${position.assetId}`, assetId: position.assetId, orders: sources.orders, otc: sources.otc });
    }
  }
  if (grouped.retired.length > 0) {
    rows.push({ kind: "retiredHeader", key: "retired", count: grouped.retired.length, tonnes: grouped.retiredTonnes });
    if (retiredOpen) for (const position of grouped.retired) rows.push({ kind: "retired", key: `retired:${position.assetId}`, position });
  }
  return rows;
}

/** 第一列:年份在前(组内按它排),标的代码在后;情景标的带标记 */
function VintageCell({ vintage, symbol, isScenario }: { vintage: number | null; symbol: string; isScenario: boolean }) {
  const t = useT("terminal");
  return (
    <span className={`${CELL_START} ${PIN_START} flex items-center gap-gap ps-panel`}>
      <span className="tnum shrink-0 font-medium">{vintage ?? "—"}</span>
      <span className="truncate text-muted">{symbol}</span>
      {isScenario ? <span className="shrink-0 rounded-chip bg-warning-soft px-1 text-t-2xs text-warning">{t.tabs.scenarioTag}</span> : null}
    </span>
  );
}

/**
 * 项目组头(一行):项目编号(没有就用标的代码)/ 类型 / 标准 / 国家。元数据缺的不猜、不补,只显示有的。
 * 模拟项目编号(SIM-PRJ-)带 terminal.meta.simulatedProjectId 的说明:它不是登记机构的项目编号。
 * props 全是原始类型(计划 §3.1):groupPositions 每次持仓变化都生成新的组对象,传对象进来 memo 永远不中。
 */
export type PositionGroupRowProps = Pick<PositionGroup, "projectId" | "symbol" | "projectType" | "standard" | "country"> & {
  /** PositionGroup.key("project:<编号>" / "symbol:<代码>") */
  groupKey: string;
};

export const PositionGroupRow = memo(function PositionGroupRow({ groupKey, projectId, symbol, projectType, standard, country }: PositionGroupRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const simulated = projectId?.startsWith(SIMULATED_PROJECT_PREFIX) ? t.meta.simulatedProjectId : undefined;
  const facts = [projectType ? tProjectType(projectType, lang) : null, standard, country ? tCountry(country, lang) : null].filter(Boolean);
  return (
    <div role="heading" aria-level={3} data-group={groupKey} className="flex h-row items-center whitespace-nowrap bg-(--terminal-panel-2) px-gap text-t-xs text-muted">
      {/* 横向滚动时整条标题贴左(pinEdges) */}
      <span className={`${PIN_START} ${PIN_ALT} flex items-center gap-gap`}>
        {projectId ? <span className="sr-only">{t.meta.projectId}</span> : null}
        <span title={simulated} className="tnum font-semibold text-foreground">
          {projectId ?? symbol}
        </span>
        {simulated ? <span className="sr-only">{simulated}</span> : null}
        {facts.map((fact, i) => (
          <span key={i}>· {fact}</span>
        ))}
      </span>
    </div>
  );
});

export type PositionRowProps = {
  assetId: string;
  symbol: string;
  vintage: number | null;
  isScenario: boolean;
  quantity: number;
  /** tradable = Position.available(总量 − 挂单与场外挂牌的锁定) */
  available: number;
  locked: number;
  /** 锁定来源;null = 服务端没给(lockSourcesOf),这一行只显示锁定总数 */
  lockedOrders: number | null;
  lockedOtc: number | null;
  retired: number;
  averagePurchasePrice: number | null;
  /** 持仓事件自带的最新价与盈亏(那一刻冻结的):行情 store 里没有这个标的的价格时才用它;null = 从未成交 */
  lastPrice: number | null;
  unrealisedPnl: number | null;
  costBasisStatus: CostBasisStatus;
  precision: number;
  onSell: (symbol: string) => void;
  onRetire: (assetId: string) => void;
  /** 止盈止损(P3-07):数量 > 0 的行才有这个按钮 */
  onProtect: (assetId: string) => void;
};

/**
 * 持仓一行(计划 §3.1:React.memo + 原始类型 props)。三态 tradable / locked / retired 分列。
 * 市值与未实现盈亏按行情的最新价现算(positionValue;不用事件里冻结的 marketValue):本行自己订阅该标的的最新价(一个数),
 * 只有它变了才重渲染;服务端与水合首帧 store 为空,退回事件自带的价格。从未成交 → 市值「—」,不把缺的价格当 0。
 * 成本基础不完整(costBasisStatus ≠ complete)时均价与盈亏都不猜,显示「—」并以 title 说明(terminal.tabs.pnlUnavailable)。
 * 不显示 24 h 估值变化(§9.1 第 31 条:不用市场涨跌代替账户估值)。
 * Sell → 下单草稿种子 side = SELL + 换到该标的;Retire → 打开注销对话框(不跳页);情景标的不可注销:禁用按钮并说明原因;
 * 止盈止损 → 打开止盈止损对话框(数量 > 0 才有)。
 */
export const PositionRow = memo(function PositionRow(p: PositionRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const live = useMarketStore((s) => lastPriceOf(s, p.symbol));
  const value = positionValue(p, live);
  const unavailable = p.costBasisStatus === "complete" ? undefined : t.tabs.pnlUnavailable;
  const lockSource =
    p.locked > 0 && p.lockedOrders != null && p.lockedOtc != null ? t.retire.lockedBy({ orders: fmtQuantity(p.lockedOrders, locale), otc: fmtQuantity(p.lockedOtc, locale) }) : undefined;
  return (
    <div data-asset-id={p.assetId} className={`${ROW_CLASS} ${PIN_ROW} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <VintageCell vintage={p.vintage} symbol={p.symbol} isScenario={p.isScenario} />
      <span className={CELL_END}>{fmtQuantity(p.available, locale)}</span>
      <span data-locked="" className={`${CELL_END} text-muted`} title={lockSource}>
        {fmtQuantity(p.locked, locale)}
      </span>
      <span className={`${CELL_END} text-muted`}>{fmtQuantity(p.retired, locale)}</span>
      <span className={CELL_END} title={unavailable}>
        {fmtRowPrice(value.averagePurchasePrice, p.precision, lang)}
      </span>
      <span data-last-price="" className={CELL_END}>
        {fmtRowPrice(value.lastPrice, p.precision, lang)}
      </span>
      <span data-market-value="" className={CELL_END}>
        {fmtCents(value.marketValue, locale)}
      </span>
      <span data-pnl="" className={`${CELL_END} ${pnlTone(value.unrealisedPnl)}`} title={unavailable}>
        {value.unrealisedPnl == null ? "—" : fmtSignedCents(value.unrealisedPnl, locale)}
        {unavailable ? <span className="sr-only">{` · ${unavailable}`}</span> : null}
      </span>
      <span className={`${PIN_END} flex items-center justify-end gap-gap`}>
        <button
          type="button"
          onClick={() => p.onSell(p.symbol)}
          aria-label={`${t.order.sell} ${p.symbol}`}
          className="rounded-chip border border-down/40 px-2 text-t-xs font-medium text-(--terminal-down) hover:bg-down-soft focus-visible:outline-none focus-visible:shadow-focus"
        >
          {t.order.sell}
        </button>
        {p.isScenario ? (
          // 情景标的不可注销:真正的 disabled 按钮(读屏报「不可用」),原因在 title 与紧随其后的 sr-only 文字里
          <span title={t.retire.scenarioBlocked} className="inline-flex">
            <button type="button" disabled className="cursor-not-allowed px-1 text-t-xs text-muted-2">
              {t.tabs.retire}
            </button>
            <span className="sr-only">{t.retire.scenarioBlocked}</span>
          </span>
        ) : (
          <button
            type="button"
            data-retire=""
            onClick={() => p.onRetire(p.assetId)}
            aria-label={`${t.tabs.retire} ${p.symbol}`}
            aria-haspopup="dialog"
            title={t.tabs.retireHint}
            className="rounded-chip px-1 text-t-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus"
          >
            {t.tabs.retire}
          </button>
        )}
        {p.quantity > 0 ? (
          // 英文两行的字靠行高挤进一行高:行距规则在 terminal.css 的 [data-terminal] [data-tpsl](紧凑行高下也成立)
          <button
            type="button"
            data-tpsl=""
            onClick={() => p.onProtect(p.assetId)}
            aria-label={`${t.triggers.tpsl} ${p.symbol}`}
            aria-haspopup="dialog"
            className="rounded-chip px-1 text-start text-t-xs font-medium whitespace-normal text-balance text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus"
          >
            {t.triggers.tpsl}
          </button>
        ) : null}
      </span>
    </div>
  );
});

/** 锁定来源(跟在有锁定的持仓行后面的一行):触屏与键盘用户看不到 title,所以另有这一行可见文字 */
export const PositionLocksRow = memo(function PositionLocksRow({ assetId, orders, otc }: { assetId: string; orders: number; otc: number }) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  return (
    <div data-locks-for={assetId} className="flex h-row items-center whitespace-nowrap px-gap ps-panel text-t-xs text-muted">
      <span className={`${PIN_START} flex min-w-0 items-center`}>
        <span aria-hidden="true" className="pe-1 text-muted-2">
          ↳
        </span>
        <span className="truncate">{t.retire.lockedBy({ orders: fmtQuantity(orders, locale), otc: fmtQuantity(otc, locale) })}</span>
      </span>
    </div>
  );
});

/** 「已注销」分组的组头:一个折叠按钮(aria-expanded),文字带行数与合计吨数;默认折叠,展开状态不持久化。memo:onToggle 由调用方保持稳定 */
export const RetiredGroupRow = memo(function RetiredGroupRow({ count, tonnes, open, onToggle }: { count: number; tonnes: number; open: boolean; onToggle: () => void }) {
  const t = useT("terminal");
  const { lang } = useLang();
  return (
    <button
      type="button"
      data-retired-group=""
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-row w-full items-center whitespace-nowrap bg-(--terminal-panel-2) px-gap text-start text-t-xs font-semibold text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus"
    >
      <span className={`${PIN_START} ${PIN_ALT} flex items-center gap-gap`}>
        <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform duration-(--motion-fast) ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3l5 5-5 5" />
        </svg>
        <span>{t.retire.retiredGroup({ count, tonnes: fmtQuantity(tonnes, numberLocale(lang)) })}</span>
      </span>
    </button>
  );
});

/**
 * 整仓注销的一行:只剩已注销数量可说;证书在注销记录页(链接文字就是「注销记录」)。
 * 链接比「卖出 / 注销」长,跨未实现盈亏与操作两列(这一行的盈亏本来就是「—」),贴右。
 */
export const RetiredRow = memo(function RetiredRow({ assetId, symbol, vintage, retired }: { assetId: string; symbol: string; vintage: number | null; retired: number }) {
  const t = useT("terminal");
  const { lang } = useLang();
  const dash = <span className={`${CELL_END} text-muted-2`}>—</span>;
  return (
    <div data-retired-asset-id={assetId} className={`${ROW_CLASS} ${PIN_ROW} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <VintageCell vintage={vintage} symbol={symbol} isScenario={false} />
      {dash}
      {dash}
      <span className={CELL_END}>{fmtQuantity(retired, numberLocale(lang))}</span>
      {dash}
      {dash}
      {dash}
      <span className={`${PIN_END} col-span-2 flex items-center justify-end`}>
        <Link
          href={RETIREMENT_HISTORY_HREF}
          prefetch={false}
          className="rounded-chip px-1 text-t-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus"
        >
          {t.retire.history}
        </Link>
      </span>
    </div>
  );
});

export type PositionsViewProps = {
  positions: readonly Position[];
  /** symbol → 标的静态元数据(行情 store 的 instruments 派生;缺的标的自成一组、年份显示「—」、精度按 2) */
  meta: Readonly<Record<string, PositionMeta>>;
  onSell: (symbol: string) => void;
  onRetire: (assetId: string) => void;
  onProtect: (assetId: string) => void;
  /** 「已注销」分组是否展开(调用方的本地状态,默认 false,不持久化) */
  retiredOpen: boolean;
  onToggleRetired: () => void;
};

/**
 * 纯展示(tabs.ssr.test.ts 直接渲染)。按项目分组、组内一个年份一行(计划 §6.2.3 P2-09);整仓注销的行(quantity 0、retired > 0)
 * 收在页签底部的「已注销」分组,默认折叠,组头带合计吨数。分组头、锁定来源、折叠按钮都是虚拟列表里的行(固定行高)。
 * 一行持仓都没有(连注销过的也没有)→ EmptyState。
 */
export function PositionsView({ positions, meta, onSell, onRetire, onProtect, retiredOpen, onToggleRetired }: PositionsViewProps) {
  const t = useT("terminal");
  const rows = useMemo(() => positionRows(groupPositions(positions, meta), retiredOpen), [positions, meta, retiredOpen]);
  return (
    <TabTable<PositionListRow>
      columns={COLUMNS}
      headers={[
        { label: `${t.meta.vintage} · ${t.tabs.colSymbol}`, className: PIN_START },
        { label: t.tabs.tradable, align: "end" },
        { label: t.tabs.locked, align: "end" },
        { label: t.tabs.retired, align: "end" },
        { label: t.tabs.colAvgCost, align: "end" },
        { label: t.header.lastPrice, align: "end" },
        { label: t.tabs.colMarketValue, align: "end" },
        { label: t.tabs.colPnl, align: "end" },
        { label: "", className: PIN_END },
      ]}
      items={rows}
      getKey={(row) => row.key}
      label={t.a11y.positionsRegion}
      empty={<EmptyState title={t.tabs.emptyPositions} />}
      pinEdges
      renderRow={(row) => {
        switch (row.kind) {
          case "group": {
            const g = row.group;
            return <PositionGroupRow groupKey={g.key} projectId={g.projectId} symbol={g.symbol} projectType={g.projectType} standard={g.standard} country={g.country} />;
          }
          case "locks":
            return <PositionLocksRow assetId={row.assetId} orders={row.orders} otc={row.otc} />;
          case "retiredHeader":
            return <RetiredGroupRow count={row.count} tonnes={row.tonnes} open={retiredOpen} onToggle={onToggleRetired} />;
          case "retired":
            return <RetiredRow assetId={row.position.assetId} symbol={row.position.symbol} vintage={meta[row.position.symbol]?.vintage ?? null} retired={row.position.retired} />;
          case "position": {
            const p = row.position;
            const sources = lockSourcesOf(p);
            return (
              <PositionRow
                assetId={p.assetId}
                symbol={p.symbol}
                vintage={meta[p.symbol]?.vintage ?? null}
                isScenario={p.isScenario}
                quantity={p.quantity}
                available={p.available}
                locked={p.locked}
                lockedOrders={sources?.orders ?? null}
                lockedOtc={sources?.otc ?? null}
                retired={p.retired}
                averagePurchasePrice={p.averagePurchasePrice}
                lastPrice={p.lastPrice}
                unrealisedPnl={p.unrealisedPnl}
                costBasisStatus={p.costBasisStatus}
                precision={meta[p.symbol]?.pricePrecision ?? 2}
                onSell={onSell}
                onRetire={onRetire}
                onProtect={onProtect}
              />
            );
          }
        }
      }}
    />
  );
}

/**
 * 焦点没有着落(落在 body 上)时把它放回持仓表的滚动区。两种来路:关闭对话框时触发它的按钮已不在(整仓注销后那一行收进了
 * 折叠的「已注销」分组);焦点所在的行随持仓变化消失(卖光、或对话框关掉之后注销才完成)。焦点在别处(搜索框、下单面板)时不动。
 */
export function focusPositionsRegion(host: Pick<Element, "querySelector"> | null, active: Element | null, body: Element | null): void {
  if (active && active !== body) return;
  host?.querySelector<HTMLElement>('[role="region"]')?.focus();
}

// 「注销」请求与它的渲染期调整在 position-groups.ts(资产页 /trade/account 同样要用,P2-10 挪过去);这里原样再导出
export { reconcileRetireRequest, type RetireRequest } from "@/lib/market/position-groups";

/**
 * 持仓(计划 §3.1、§6.2.3 P2-09):usePositions()(account store:WS 的 position 事件 / 轮询快照,≤ 1 帧或 ≤ 5 s 更新;
 * 含整仓注销的行)。分组元数据取行情 store 的 instruments(TerminalShell 挂载后灌入)经 positionMetaOf:内容不变引用就不变,
 * 轮询每 2 s 整体替换 instruments、推送改价格都不让本面板重渲染(§3.1 面板只订阅自己的选择器);价格由各行自己订阅。
 * 注销对话框:点过一次「注销」之后才挂载,之后留着(关闭只是 open = false),对话框里没做完的事再打开还在;
 * 状态按持仓隔离(RetireDialog 内部以 assetId 为 key)。请求对着的持仓从 store 里消失(卖光且没注销过)→ 请求就此作废
 *(reconcileRetireRequest),对话框卸载;之后同一标的再买回来也不会自己弹出来。对话框卸载(含本页签被切走)时,结果没定的
 * 那一份注销流程留在 retire-flow-store 里,不跟着丢。
 */
export function PositionsTab() {
  const positions = usePositions();
  const meta = useMarketStore((s) => positionMetaOf(s.instruments));
  const [retiredOpen, setRetiredOpen] = useState(false);
  const [retire, setRetire] = useState<RetireRequest | null>(null);
  /** 止盈止损对话框对着的持仓(assetId);null = 关着 */
  const [protect, setProtect] = useState<string | null>(null);
  /** 对话框(注销 / 止盈止损)开着时它的持仓消失了几次(每次都要给焦点找个着落) */
  const [dialogOrphaned, setDialogOrphaned] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  /** 本面板里最后拿到焦点的元素;正常失焦即清掉,所以它还在而节点已不在文档里 = 焦点随那一行一起没了 */
  const focusedRef = useRef<Element | null>(null);
  // 请求对着的持仓不在了:渲染期按 React「随输入调整 state」的写法清掉请求(条件只成立一次,不会循环;React 丢弃这一遍、
  // 立即以新 state 重渲染)。不清的话 retire 会一直是 { open: true },同一标的再买回来时对话框会自己打开
  const reconciled = reconcileRetireRequest(retire, positions);
  if (reconciled.dropped) {
    setRetire(null);
    if (reconciled.wasOpen) setDialogOrphaned((n) => n + 1);
  }
  const target = retire ? positions.find((p) => p.assetId === retire.assetId) : undefined;
  // 止盈止损对着的持仓卖光了(数量 0 或整行没了):对话框就此卸载(渲染期调整 state,同上),焦点与注销对话框同一套兜底
  const protectTarget = protect ? positions.find((p) => p.assetId === protect && p.quantity > 0) : undefined;
  if (protect && !protectTarget) {
    setProtect(null);
    setDialogOrphaned((n) => n + 1);
  }

  const handleFocus = useCallback((event: FocusEvent<HTMLDivElement>) => {
    focusedRef.current = event.target;
  }, []);
  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>) => {
    // 有的浏览器在节点被移除时也派发 blur:等这次提交做完再看,节点还在文档里才算正常失焦
    const blurred = event.target;
    queueMicrotask(() => {
      if (blurred.isConnected && focusedRef.current === blurred) focusedRef.current = null;
    });
  }, []);
  // 行变了(持仓事件、折叠 / 展开)之后:焦点所在的那一行不在了就把焦点接到表上,键盘用户不必从页面顶上重新 Tab 过来
  useEffect(() => {
    const focused = focusedRef.current;
    if (!focused || focused.isConnected) return;
    focusedRef.current = null;
    focusPositionsRegion(hostRef.current, document.activeElement, document.body);
  }, [positions, retiredOpen]);
  // 对话框随持仓消失而卸载(没有经过 onClose):打开它的「注销」/「止盈止损」按钮也不在了,Dialog 还不回焦点 —— 与正常关闭同样兜一次底
  useEffect(() => {
    if (dialogOrphaned === 0) return;
    const frame = requestAnimationFrame(() => focusPositionsRegion(hostRef.current, document.activeElement, document.body));
    return () => cancelAnimationFrame(frame);
  }, [dialogOrphaned]);

  const handleToggleRetired = useCallback(() => setRetiredOpen((open) => !open), []);
  const handleRetire = useCallback((assetId: string) => setRetire({ assetId, open: true }), []);
  const handleProtect = useCallback((assetId: string) => setProtect(assetId), []);
  const handleProtectClose = useCallback(() => {
    setProtect(null);
    requestAnimationFrame(() => focusPositionsRegion(hostRef.current, document.activeElement, document.body));
  }, []);
  const handleRetireClose = useCallback(() => {
    setRetire((current) => (current ? { ...current, open: false } : current));
    // Dialog 卸载时把焦点还给打开它的按钮;等这一帧过去再看焦点有没有着落
    requestAnimationFrame(() => focusPositionsRegion(hostRef.current, document.activeElement, document.body));
  }, []);

  return (
    <div ref={hostRef} onFocus={handleFocus} onBlur={handleBlur} className="flex min-h-0 flex-1 flex-col">
      <PositionsView positions={positions} meta={meta} onSell={handlePositionSell} onRetire={handleRetire} onProtect={handleProtect} retiredOpen={retiredOpen} onToggleRetired={handleToggleRetired} />
      {retire && target ? <RetireDialog position={target} instrument={meta[target.symbol]} open={retire.open} onClose={handleRetireClose} /> : null}
      {protectTarget ? <TakeProfitStopLossDialog position={protectTarget} onClose={handleProtectClose} /> : null}
    </div>
  );
}
