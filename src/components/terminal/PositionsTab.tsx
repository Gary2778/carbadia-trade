"use client";

import { memo } from "react";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import type { CostBasisStatus, Instrument, Position } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { useLang, useT } from "@/i18n/LangProvider";
import { usePositions } from "@/lib/market/account-store";
import { switchSymbol } from "@/lib/market/navigation";
import { marketActions, useMarketStore } from "@/lib/market/store";
import { CELL_END, CELL_START, fmtCents, fmtQuantity, fmtRowPrice, fmtSignedCents, numberLocale, pnlTone, ROW_CLASS, TabTable, usePricePrecisions, type Columns } from "./TabTable";

/** 标的 / vintage / 可交易 / 已锁定 / 已注销 / 平均成本 / 市值 / 未实现盈亏 / 操作 */
const COLUMNS: Columns = {
  template: "minmax(8rem,1.4fr) 3.5rem minmax(4rem,0.8fr) minmax(4rem,0.8fr) minmax(4rem,0.8fr) minmax(4.5rem,1fr) minmax(5.5rem,1fr) minmax(5.5rem,1fr) 7.5rem",
  minWidth: "52rem",
};

export const retirementHref = (assetId: string): string => `/retirement?asset=${encodeURIComponent(assetId)}`;

/** 标的代码 → vintage(纯函数;与 TabTable 的 pricePrecisionsOf 同形,值是原始类型,浅比较订阅才有效) */
export function vintagesOf(instruments: Readonly<Record<string, Instrument>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const symbol in instruments) out[symbol] = instruments[symbol].vintage;
  return out;
}

/**
 * 持仓行 Sell 按钮的点击处理(只在事件里调用,不在渲染期):先写下单草稿种子,再换到该标的(OrderPanel 在 symbol 变化时按 draft.side 重置)。
 * setDraft 整颗替换种子,不带 price 即没有价格 —— 之前在别的标的盘口点过的价格不会跟着带进这张卖单。
 */
export function handlePositionSell(symbol: string): void {
  marketActions.setDraft({ symbol, side: "SELL" });
  switchSymbol(symbol);
}

export type PositionRowProps = {
  assetId: string;
  symbol: string;
  vintage: number | null;
  isScenario: boolean;
  /** tradable = Position.available(总量 − 挂单锁定) */
  available: number;
  locked: number;
  retired: number;
  averagePurchasePrice: number | null;
  /** 标的最新价;null = 从未成交过 —— 服务端的 marketValue 此时按 0 算,这里显示「—」而不是编一个 0 */
  lastPrice: number | null;
  marketValue: number;
  unrealisedPnl: number | null;
  costBasisStatus: CostBasisStatus;
  precision: number;
  onSell: (symbol: string) => void;
};

/**
 * 持仓一行(计划 §3.1):React.memo + 原始类型 props。三态 tradable / locked / retired 分列;
 * 成本基础不完整(costBasisStatus ≠ complete)时均价与盈亏都不猜,显示「—」并以 title 说明(terminal.tabs.pnlUnavailable)。
 * 不显示 24 h 估值变化(§9.1 第 31 条:不用市场涨跌代替账户估值)。
 * Sell → 下单草稿种子 side = SELL + 换到该标的;Retire → /retirement?asset=<assetId>,情景标的不可注销(禁用态,不是链接)。
 */
export const PositionRow = memo(function PositionRow(p: PositionRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const complete = p.costBasisStatus === "complete";
  const pnl = complete ? p.unrealisedPnl : null;
  const avg = complete ? p.averagePurchasePrice : null;
  const unavailable = complete ? undefined : t.tabs.pnlUnavailable;
  return (
    <div data-asset-id={p.assetId} className={`${ROW_CLASS} hover:bg-(--terminal-row-hover)`} style={{ gridTemplateColumns: COLUMNS.template }}>
      <span className={`${CELL_START} flex items-center gap-gap`}>
        <span className="truncate font-medium">{p.symbol}</span>
        {p.isScenario ? <span className="shrink-0 rounded-chip bg-warning-soft px-1 text-t-2xs text-warning">{t.tabs.scenarioTag}</span> : null}
      </span>
      <span className="tnum text-muted">{p.vintage ?? "—"}</span>
      <span className={CELL_END}>{fmtQuantity(p.available, locale)}</span>
      <span className={`${CELL_END} text-muted`}>{fmtQuantity(p.locked, locale)}</span>
      <span className={`${CELL_END} text-muted`}>{fmtQuantity(p.retired, locale)}</span>
      <span className={CELL_END} title={unavailable}>
        {fmtRowPrice(avg, p.precision, lang)}
      </span>
      <span data-market-value="" className={CELL_END}>
        {p.lastPrice == null ? "—" : fmtCents(p.marketValue, locale)}
      </span>
      <span data-pnl="" className={`${CELL_END} ${pnlTone(pnl)}`} title={unavailable}>
        {pnl == null ? "—" : fmtSignedCents(pnl, locale)}
        {unavailable ? <span className="sr-only">{` · ${unavailable}`}</span> : null}
      </span>
      <span className="flex items-center justify-end gap-gap">
        <button
          type="button"
          onClick={() => p.onSell(p.symbol)}
          className="rounded-chip border border-down/40 px-2 text-t-xs font-medium text-(--terminal-down) hover:bg-down-soft focus-visible:outline-none focus-visible:shadow-focus"
        >
          {t.order.sell}
        </button>
        {p.isScenario ? (
          // 情景标的不可注销:真正的 disabled 按钮(读屏报「不可用」),不是链接
          <button type="button" disabled className="cursor-not-allowed px-1 text-t-xs text-muted-2">
            {t.tabs.retire}
          </button>
        ) : (
          <Link
            href={retirementHref(p.assetId)}
            prefetch={false}
            title={t.tabs.retireHint}
            className="rounded-chip px-1 text-t-xs font-medium text-accent hover:underline focus-visible:outline-none focus-visible:shadow-focus"
          >
            {t.tabs.retire}
          </Link>
        )}
      </span>
    </div>
  );
});

export type PositionsViewProps = {
  positions: readonly Position[];
  /** symbol → 价格精度 / vintage(市场 store 的 instruments 派生;缺的标的精度按 2、vintage 显示「—」) */
  precisions: Readonly<Record<string, number>>;
  vintages: Readonly<Record<string, number>>;
  onSell: (symbol: string) => void;
};

/** 纯展示(tabs.ssr.test.ts 直接渲染):表头含 tradable / locked / retired 三列;空态 EmptyState */
export function PositionsView({ positions, precisions, vintages, onSell }: PositionsViewProps) {
  const t = useT("terminal");
  return (
    <TabTable<Position>
      columns={COLUMNS}
      headers={[
        { label: t.tabs.colSymbol },
        { label: t.meta.vintage },
        { label: t.tabs.tradable, align: "end" },
        { label: t.tabs.locked, align: "end" },
        { label: t.tabs.retired, align: "end" },
        { label: t.tabs.colAvgCost, align: "end" },
        { label: t.tabs.colMarketValue, align: "end" },
        { label: t.tabs.colPnl, align: "end" },
        { label: "" },
      ]}
      items={positions}
      getKey={(p) => p.assetId}
      label={t.a11y.positionsRegion}
      empty={<EmptyState title={t.tabs.emptyPositions} />}
      renderRow={(p) => (
        <PositionRow
          assetId={p.assetId}
          symbol={p.symbol}
          vintage={vintages[p.symbol] ?? null}
          isScenario={p.isScenario}
          available={p.available}
          locked={p.locked}
          retired={p.retired}
          averagePurchasePrice={p.averagePurchasePrice}
          lastPrice={p.lastPrice}
          marketValue={p.marketValue}
          unrealisedPnl={p.unrealisedPnl}
          costBasisStatus={p.costBasisStatus}
          precision={precisions[p.symbol] ?? 2}
          onSell={onSell}
        />
      )}
    />
  );
}

/**
 * 持仓(计划 §3.1):usePositions()(account store:WS 的 position 事件 / 轮询快照,≤ 1 帧或 ≤ 5 s 更新)。
 * vintage 与价格精度取市场 store 的 instruments(TerminalShell 挂载后灌入),都是浅比较订阅的派生表:
 * 轮询每 2 s 整体替换 instruments 时值没变就不重渲染(§3.1 面板只订阅自己的选择器)。
 */
export function PositionsTab() {
  const positions = usePositions();
  const precisions = usePricePrecisions();
  const vintages = useMarketStore(useShallow((s) => vintagesOf(s.instruments)));
  return <PositionsView positions={positions} precisions={precisions} vintages={vintages} onSell={handlePositionSell} />;
}
