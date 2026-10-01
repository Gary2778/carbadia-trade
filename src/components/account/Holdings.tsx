"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { CostBasisStatus, Position } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { isChinese } from "@/i18n/config";
import { tCountry, tName, tProjectType, tRegistry } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { getCreditProfile } from "@/lib/exchange/carbon";
import { matchesHoldingQuery } from "@/lib/market/account-view";
import { terminalHref } from "@/lib/market/navigation";
import { groupPositions, lockSourcesOf, positionValue, reconcileRetireRequest, type PositionMeta, type RetireRequest } from "@/lib/market/position-groups";
import { gainTone, localeOf, signedUsd, tonnes, usd } from "./format";
import { PANEL, PANEL_TITLE } from "./styles";

// 数字的等宽由 [data-terminal] 的 font-variant-numeric 给;.tnum(等宽字体栈)只加在单独成格的数值上,带文字的说明行不加。
// 注销对话框第一次点「注销」才下载与挂载(计划 §6.2.2 C7:next/dynamic,不进首屏);与终端「持仓」页签是同一个组件、同一份按 assetId 的流程状态。
const RetireDialog = dynamic(() => import("./RetireDialog").then((m) => m.RetireDialog), { ssr: false });

/** 注销记录与证书(旧 /retirement 页保留,计划 §6.2.2 C8) */
const RETIREMENT_HISTORY_HREF = "/retirement";
/** 空状态去市场的入口 */
const MARKET_HREF = "/";
/** 模拟项目编号的前缀(计划 §9.1 第 15 条:不是登记机构的项目编号) */
const SIMULATED_PROJECT_PREFIX = "SIM-PRJ-";

/** 一格:手机上标签在上、数值在下(两列卡片);≥ 64rem 标签只给读屏(表头是 aria-hidden 的视觉表头),数值按列对齐 */
function Cell({ label, end = false, wide = false, children }: { label: string; end?: boolean; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={["flex min-w-0 flex-col", wide ? "col-span-2 lg:col-span-1" : "", end ? "lg:items-end lg:text-end" : ""].filter(Boolean).join(" ")}>
      <span className="text-t-xs text-muted lg:sr-only">{label}</span>
      {children}
    </div>
  );
}

export type HoldingRowProps = {
  assetId: string;
  symbol: string;
  /** 名称(已按界面语言取好) */
  name: string;
  vintage: number | null;
  isScenario: boolean;
  /** 标的元数据原文(未到时为 null,显示「未提供」;行内按界面语言翻译) */
  projectType: string | null;
  country: string | null;
  standard: string | null;
  registry: string | null;
  quantity: number;
  available: number;
  locked: number;
  /** 锁定来源;null = 服务端没给(回滚到 Phase 1 的服务端),只显示锁定合计 */
  lockedOrders: number | null;
  lockedOtc: number | null;
  retired: number;
  /** 持仓行自带的(服务端映射时的)价格、盈亏与均价:估值经 positionValue,与终端「持仓」页签逐分一致 */
  lastPrice: number | null;
  unrealisedPnl: number | null;
  averagePurchasePrice: number | null;
  costBasisStatus: CostBasisStatus;
  /** 行情的最新价;null = 行情里没有,退回行上的 */
  livePrice: number | null;
  precision: number;
  onRetire: (assetId: string) => void;
};

/**
 * 持仓一行(React.memo + 原始类型 props):标的(代码 → 终端、年份、情景标记、名称)| 国家 · 类别 / 标准 · 登记簿 |
 * 数量(可交易、锁定:有来源时「挂单 n · 场外 n」,没有只给合计;有注销时另起一行)| 均价(成本不完整:「—」+ 说明)| 最新价 | 市值 | 未实现盈亏 | 卖出 · 注销。
 * 市值与盈亏按最新价现算(positionValue:与终端持仓页签、页头合计同一个实现);从未成交 → 「—」,不把缺的价格当 0。
 * 卖出 → /trade/<symbol>?side=SELL(终端按 ?side= 预设方向);注销 → 打开注销对话框;情景标的不可注销:按钮禁用,说明是可见文字(触屏看不到 title)。
 */
export const HoldingRow = memo(function HoldingRow(p: HoldingRowProps) {
  const a = useT("account");
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const locale = localeOf(lang);
  const value = positionValue(p, p.livePrice);
  const costMissing = p.costBasisStatus !== "complete";
  const profile = p.projectType != null ? getCreditProfile({ symbol: p.symbol, projectType: p.projectType }) : null;
  const category = p.isScenario ? t.meta.scenario : profile ? (isChinese(lang) ? profile.categoryZh : profile.category) : null;
  const origin = [p.country ? tCountry(p.country, lang) : null, category].map((part) => part ?? ui.notProvided).join(" · ");
  const registry = p.registry ? tRegistry(p.registry, lang) : null;
  const programme = [p.standard ?? ui.notProvided, registry && registry !== p.standard ? registry : null].filter(Boolean).join(" · ");
  const sources = p.locked > 0 && p.lockedOrders != null && p.lockedOtc != null ? t.retire.lockedBy({ orders: tonnes(p.lockedOrders, locale), otc: tonnes(p.lockedOtc, locale) }) : null;
  return (
    <li data-asset-id={p.assetId} className="t-holding-grid grid items-start border-t border-(--terminal-border) px-panel py-2 first:border-t-0 hover:bg-(--terminal-row-hover)">
      <div className="col-span-2 flex min-w-0 flex-col lg:col-span-1">
        <span className="flex flex-wrap items-center gap-x-gap">
          <Link href={terminalHref(p.symbol)} prefetch={false} className="font-semibold text-foreground hover:text-accent focus-visible:outline-none focus-visible:shadow-focus">
            {p.symbol}
          </Link>
          {p.vintage != null ? <span className="tnum text-t-xs text-muted">{p.vintage}</span> : null}
          {p.isScenario ? <span className="rounded-chip bg-warning-soft px-1 text-t-2xs text-warning">{t.tabs.scenarioTag}</span> : null}
        </span>
        <span className="truncate text-t-xs text-muted" title={p.name}>
          {p.name}
        </span>
      </div>
      <Cell label={a.holdings.colOrigin} wide>
        <span className="text-t-xs text-foreground">{origin}</span>
        <span className="text-t-xs text-muted">{programme}</span>
      </Cell>
      <Cell label={a.holdings.colQuantity} end>
        <span data-quantity="" className="tnum text-t-sm font-medium">
          {tonnes(p.quantity, locale)}
        </span>
        <span className="text-t-xs text-muted">{`${t.tabs.tradable} ${tonnes(p.available, locale)}`}</span>
        <span data-locked="" className="text-t-xs text-muted">
          {sources ?? `${t.tabs.locked} ${tonnes(p.locked, locale)}`}
        </span>
        {p.retired > 0 ? <span data-retired="" className="text-t-xs text-muted">{`${t.tabs.retired} ${tonnes(p.retired, locale)}`}</span> : null}
      </Cell>
      <Cell label={t.tabs.colAvgCost} end>
        <span className="tnum text-t-sm">{usd(value.averagePurchasePrice, locale, p.precision)}</span>
        {costMissing ? <span className="text-t-xs text-muted-2">{t.tabs.pnlUnavailable}</span> : null}
      </Cell>
      <Cell label={t.header.lastPrice} end>
        <span data-last-price="" className="tnum text-t-sm">
          {usd(value.lastPrice, locale, p.precision)}
        </span>
      </Cell>
      <Cell label={t.tabs.colMarketValue} end>
        <span data-market-value="" className="tnum text-t-sm">
          {usd(value.marketValue, locale)}
        </span>
      </Cell>
      <Cell label={t.tabs.colPnl} end>
        <span data-pnl="" className={`tnum text-t-sm ${gainTone(value.unrealisedPnl)}`}>
          {signedUsd(value.unrealisedPnl, locale)}
        </span>
      </Cell>
      <div className="col-span-2 flex flex-wrap items-center gap-gap lg:col-span-1 lg:justify-end">
        <Link
          href={terminalHref(p.symbol, "side=SELL")}
          prefetch={false}
          aria-label={`${t.order.sell} ${p.symbol}`}
          className="inline-flex min-h-touch items-center rounded-chip border border-down/40 px-3 text-t-xs font-medium text-(--terminal-down) hover:bg-down-soft focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:px-2"
        >
          {t.order.sell}
        </Link>
        {p.isScenario ? (
          <>
            <button type="button" disabled className="inline-flex min-h-touch cursor-not-allowed items-center px-2 text-t-xs text-muted-2 lg:min-h-0">
              {t.tabs.retire}
            </button>
            <span className="w-full text-t-2xs text-muted-2 lg:text-end">{t.retire.scenarioBlocked}</span>
          </>
        ) : (
          <button
            type="button"
            data-retire=""
            onClick={() => p.onRetire(p.assetId)}
            aria-label={`${t.tabs.retire} ${p.symbol}`}
            aria-haspopup="dialog"
            title={t.tabs.retireHint}
            className="inline-flex min-h-touch items-center rounded-chip px-2 text-t-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0"
          >
            {t.tabs.retire}
          </button>
        )}
      </div>
    </li>
  );
});

export type HoldingsViewProps = {
  positions: readonly Position[];
  /** symbol → 标的静态元数据(行情 store 的 instruments 经 positionMetaOf);缺的标的自成一组、元数据显示「未提供」 */
  meta: Readonly<Record<string, PositionMeta>>;
  /** 持有标的的最新价(heldPrices);缺的退回持仓行自带的价格 */
  prices: Readonly<Record<string, number | null>>;
  query: string;
  onQuery: (query: string) => void;
  /** 「已注销」分组是否展开(默认 false,不持久化) */
  retiredOpen: boolean;
  onToggleRetired: () => void;
  onRetire: (assetId: string) => void;
};

/**
 * 持仓(纯展示;SSR 测试直接渲染):搜索框;按项目分组、组内按年份(与终端「持仓」页签同一个 groupPositions);
 * 整仓注销的行收在底部的「已注销」分组,默认折叠,组头带合计吨数。一行持仓都没有 → 空状态 + 去市场的入口;搜索没有命中 → 另一句空状态。
 * 版面:手机两列卡片,≥ 64rem 与表头对齐成一张表(terminal.css 的 .t-holding-grid);列表是 ul / li,表头只是视觉的(aria-hidden),
 * 每格自带读屏标签。
 */
export function HoldingsView({ positions, meta, prices, query, onQuery, retiredOpen, onToggleRetired, onRetire }: HoldingsViewProps) {
  const a = useT("account");
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = localeOf(lang);
  const grouped = useMemo(() => {
    const matched = positions.filter((position) => {
      const m = meta[position.symbol];
      return matchesHoldingQuery(query, [position.symbol, m?.projectId, m?.name, tName(position.symbol, m?.name ?? position.symbol, lang)]);
    });
    return groupPositions(matched, meta);
  }, [positions, meta, query, lang]);
  const nameOf = (symbol: string): string => tName(symbol, meta[symbol]?.name ?? symbol, lang);

  let body: React.ReactNode;
  if (positions.length === 0) {
    body = (
      <EmptyState
        title={a.holdings.empty}
        hint={a.holdings.emptyHint}
        action={
          <Link href={MARKET_HREF} className="text-t-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus">
            {a.holdings.emptyCta}
          </Link>
        }
      />
    );
  } else if (grouped.groups.length === 0 && grouped.retired.length === 0) {
    body = <EmptyState title={a.holdings.noMatch} />;
  } else {
    body = (
      <>
        <div aria-hidden="true" className="t-holding-grid hidden border-b border-(--terminal-border) px-panel py-gap text-t-xs text-muted lg:grid">
          <span>{a.holdings.colInstrument}</span>
          <span>{a.holdings.colOrigin}</span>
          <span className="text-end">{a.holdings.colQuantity}</span>
          <span className="text-end">{t.tabs.colAvgCost}</span>
          <span className="text-end">{t.header.lastPrice}</span>
          <span className="text-end">{t.tabs.colMarketValue}</span>
          <span className="text-end">{t.tabs.colPnl}</span>
          <span />
        </div>
        {grouped.groups.length > 0 ? (
          <ul aria-label={a.holdings.listLabel}>
            {grouped.groups.map((group) => {
              const simulated = group.projectId?.startsWith(SIMULATED_PROJECT_PREFIX) ? t.meta.simulatedProjectId : undefined;
              const facts = [group.projectType ? tProjectType(group.projectType, lang) : null, group.standard, group.country ? tCountry(group.country, lang) : null].filter(Boolean);
              return (
                <li key={group.key} data-group={group.key} className="border-t border-(--terminal-border) first:border-t-0">
                  <h3 className="flex flex-wrap items-center gap-x-gap bg-(--terminal-panel-2) px-panel py-1 text-t-xs text-muted">
                    {group.projectId ? <span className="sr-only">{t.meta.projectId}</span> : null}
                    <span title={simulated} className="tnum font-semibold text-foreground">
                      {group.projectId ?? group.symbol}
                    </span>
                    {simulated ? <span className="sr-only">{simulated}</span> : null}
                    {facts.map((fact, i) => (
                      <span key={i}>· {fact}</span>
                    ))}
                  </h3>
                  <ul>
                    {group.positions.map((position) => {
                      const m = meta[position.symbol];
                      const sources = lockSourcesOf(position);
                      return (
                        <HoldingRow
                          key={position.assetId}
                          assetId={position.assetId}
                          symbol={position.symbol}
                          name={nameOf(position.symbol)}
                          vintage={m?.vintage ?? null}
                          isScenario={position.isScenario}
                          projectType={m?.projectType ?? null}
                          country={m?.country ?? null}
                          standard={m?.standard ?? null}
                          registry={m?.registry ?? null}
                          quantity={position.quantity}
                          available={position.available}
                          locked={position.locked}
                          lockedOrders={sources?.orders ?? null}
                          lockedOtc={sources?.otc ?? null}
                          retired={position.retired}
                          lastPrice={position.lastPrice}
                          unrealisedPnl={position.unrealisedPnl}
                          averagePurchasePrice={position.averagePurchasePrice}
                          costBasisStatus={position.costBasisStatus}
                          livePrice={prices[position.symbol] ?? null}
                          precision={m?.pricePrecision ?? 2}
                          onRetire={onRetire}
                        />
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : null}
        {grouped.retired.length > 0 ? (
          <div data-retired-section="" className="border-t border-(--terminal-border)">
            <button
              type="button"
              data-retired-group=""
              aria-expanded={retiredOpen}
              onClick={onToggleRetired}
              className="flex min-h-touch w-full items-center gap-gap bg-(--terminal-panel-2) px-panel text-start text-t-xs font-semibold text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1"
            >
              <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform duration-(--motion-fast) ${retiredOpen ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 3l5 5-5 5" />
              </svg>
              <span>{t.retire.retiredGroup({ count: grouped.retired.length, tonnes: tonnes(grouped.retiredTonnes, locale) })}</span>
            </button>
            {retiredOpen ? (
              <ul>
                {grouped.retired.map((position) => (
                  <li key={position.assetId} data-retired-asset-id={position.assetId} className="flex flex-wrap items-center gap-x-panel gap-y-1 border-t border-(--terminal-border) px-panel py-2 text-t-sm">
                    <span className="flex min-w-0 flex-col">
                      <span className="font-semibold">
                        {position.symbol}
                        {meta[position.symbol]?.vintage != null ? <span className="tnum ps-gap text-t-xs font-normal text-muted">{meta[position.symbol]?.vintage}</span> : null}
                      </span>
                      <span className="truncate text-t-xs text-muted">{nameOf(position.symbol)}</span>
                    </span>
                    <span className="text-muted">{`${t.tabs.retired} ${tonnes(position.retired, locale)} t`}</span>
                    <Link href={RETIREMENT_HISTORY_HREF} prefetch={false} className="ms-auto text-t-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus">
                      {t.retire.history}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <section aria-labelledby="holdings-title" data-holdings="" className={`flex flex-col ${PANEL}`}>
      <div className="flex flex-wrap items-center justify-between gap-gap border-b border-(--terminal-border) p-panel">
        <h2 id="holdings-title" tabIndex={-1} className={`${PANEL_TITLE} focus-visible:outline-none`}>
          {a.holdings.title}
        </h2>
        {positions.length > 0 ? (
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            aria-label={a.holdings.searchLabel}
            placeholder={a.holdings.searchPlaceholder}
            className="min-h-touch w-full rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-2 text-t-base text-foreground placeholder:text-muted-2 focus-visible:outline-none focus-visible:shadow-focus sm:w-64 lg:min-h-0 lg:py-1"
          />
        ) : null}
      </div>
      {body}
      <p className="border-t border-(--terminal-border) px-panel py-gap text-t-xs text-muted">{a.holdings.note}</p>
    </section>
  );
}

/**
 * 焦点没有着落(落在 body 上)时把它放到持仓标题上(#holdings-title,tabIndex -1)。两种来路:关闭对话框时打开它的按钮已不在
 *(整仓注销后那一行收进了折叠的「已注销」分组);对话框开着时它的持仓从 store 里消失(卖光),对话框随之卸载、不经 onClose。
 * 焦点在别处(搜索框、别的按钮)时不动。与终端的 focusPositionsRegion 同一写法。
 */
export function focusHoldingsTitle(host: Pick<Element, "querySelector"> | null, active: Element | null, body: Element | null): void {
  if (active && active !== body) return;
  host?.querySelector<HTMLElement>("#holdings-title")?.focus();
}

/**
 * 持仓区的注销状态:request = 点了哪个持仓的「注销」、对话框开没开;orphaned = 对话框开着时它的持仓消失了几次
 *(每次都要给焦点找个着落)。两者放在同一个 state 里,渲染期一次调整(nextRetireState)同时改两样,容器不会只改一半。
 */
export type RetireState = { request: RetireRequest | null; orphaned: number };
export const RETIRE_IDLE: RetireState = { request: null, orphaned: 0 };

/**
 * 纯函数:HoldingsSection 渲染期对注销状态的调整(React「随输入调整 state」的写法;容器只做 next !== state 时 setState(next))。
 * 请求对着的持仓不在 store 里了(卖光且没注销过)→ 请求作废;作废时对话框开着(它随之卸载、不经 onClose)→ orphaned 加一,
 * 容器的 effect 以它为依赖,在下一帧把焦点放到持仓标题上。没有要调整的 → 原样返回同一个对象(不触发重渲染,也就不会循环)。
 */
export function nextRetireState(state: RetireState, positions: readonly Pick<Position, "assetId">[]): RetireState {
  const reconciled = reconcileRetireRequest(state.request, positions);
  if (!reconciled.dropped) return state;
  return { request: reconciled.request, orphaned: state.orphaned + (reconciled.wasOpen ? 1 : 0) };
}

/**
 * 持仓(容器):搜索词、「已注销」分组的展开、注销对话框。注销对话框与终端「持仓」页签同一套写法:点过一次「注销」才挂载,之后留着
 *(关闭只是 open = false);请求对着的持仓从 store 里消失(卖光且没注销过)→ 请求作废(nextRetireState,渲染期调整 state),
 * 对话框卸载;关掉之后焦点回不到按钮(那一行已收进「已注销」分组)、或对话框开着时随持仓消失,焦点都在下一帧落到持仓标题上。
 */
export function HoldingsSection({ positions, meta, prices }: { positions: readonly Position[]; meta: Readonly<Record<string, PositionMeta>>; prices: Readonly<Record<string, number | null>> }) {
  const [query, setQuery] = useState("");
  const [retiredOpen, setRetiredOpen] = useState(false);
  const [retireState, setRetireState] = useState<RetireState>(RETIRE_IDLE);
  const hostRef = useRef<HTMLDivElement>(null);
  // 渲染期按「随输入调整 state」清掉作废的请求(条件只成立一次,不会循环)
  const nextState = nextRetireState(retireState, positions);
  if (nextState !== retireState) setRetireState(nextState);
  const retire = nextState.request;
  const target = retire ? positions.find((position) => position.assetId === retire.assetId) : undefined;

  // 对话框随持仓消失而卸载(没有经过 onClose):打开它的「注销」按钮也不在了,Dialog 还不回焦点 —— 与正常关闭同样兜一次底
  const retireOrphaned = retireState.orphaned;
  useEffect(() => {
    if (retireOrphaned === 0) return;
    const frame = requestAnimationFrame(() => focusHoldingsTitle(hostRef.current, document.activeElement, document.body));
    return () => cancelAnimationFrame(frame);
  }, [retireOrphaned]);

  const handleToggleRetired = useCallback(() => setRetiredOpen((open) => !open), []);
  const handleRetire = useCallback((assetId: string) => setRetireState((state) => ({ ...state, request: { assetId, open: true } })), []);
  const handleRetireClose = useCallback(() => {
    setRetireState((state) => (state.request ? { ...state, request: { ...state.request, open: false } } : state));
    // Dialog 卸载时把焦点还给打开它的按钮;按钮已不在(整仓注销后那一行收进了折叠分组)时落到持仓标题上
    requestAnimationFrame(() => focusHoldingsTitle(hostRef.current, document.activeElement, document.body));
  }, []);

  return (
    <div ref={hostRef}>
      <HoldingsView positions={positions} meta={meta} prices={prices} query={query} onQuery={setQuery} retiredOpen={retiredOpen} onToggleRetired={handleToggleRetired} onRetire={handleRetire} />
      {retire && target ? <RetireDialog position={target} instrument={meta[target.symbol]} open={retire.open} onClose={handleRetireClose} /> : null}
    </div>
  );
}
