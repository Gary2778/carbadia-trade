"use client";

import { useCallback, useMemo } from "react";
import type { TapeEntry } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { VirtualList } from "@/components/ui/VirtualList";
import { useT } from "@/i18n/LangProvider";
import { requestTransportReconnect } from "@/lib/market/account-bridge";
import { selectFeedOffline, useInstrument, useTape, useTapeReady } from "@/lib/market/selectors";
import { useMarketStore } from "@/lib/market/store";
import { TapeRow } from "./TapeRow";

/**
 * 纯函数:store 里的 tape 是旧 → 新(追加在尾部),显示要新 → 旧。按下标从尾部取出一份新数组,不改 store 的数组。
 * TradesTape 用 useMemo 以 tape 引用为键调用它:只在该标的真的来了新成交时跑一次(≤ MAX_TAPE = 200 条),不是每帧。
 */
export function newestFirst(tape: readonly TapeEntry[]): TapeEntry[] {
  const out = new Array<TapeEntry>(tape.length);
  for (let i = 0; i < tape.length; i++) out[i] = tape[tape.length - 1 - i];
  return out;
}

const tapeKey = (entry: TapeEntry): string => entry.id;

export type TapePanelState = "list" | "empty" | "error" | "loading";

/**
 * 纯函数:成交面板显示哪一态(§4.5)。有 tape → 列表;没有 tape 但本标的的成交快照已到(空快照)→ 空态;
 * 都没有:行情源已断 → 错误态,否则骨架。只看 trades 自己的就绪标记,与盘口到没到无关。
 */
export function tapePanelState(hasTape: boolean, snapshotReady: boolean, offline: boolean): TapePanelState {
  if (hasTape) return "list";
  if (snapshotReady) return "empty";
  return offline ? "error" : "loading";
}

export type TradesTapeProps = { symbol: string };

/**
 * 最新成交面板(计划 §3.1):useTape(symbol) 的最近 ≤ 200 笔,新的在上,经 VirtualList 只渲染可视行 + overscan 8
 * (以成交 id 为 key:新成交插在顶上,已有行的 key 与 props 都不变,TapeRow 是 memo,零提交)。
 * 三态(§4.5):有 tape → 列表;没有 tape 但本标的的成交快照已到(useTapeReady:store.tapeReady,空快照也置位)→
 * EmptyState(tape.empty);都没有且行情源已断(selectFeedOffline)→ ErrorState(重试 = 传输层重连);否则 Skeleton。
 * 就绪只看 trades 自己的快照,不看盘口:两个主题的快照不保证同一帧到,有成交的标的不会因为盘口先到而闪一下「暂无成交」。
 * 面板本身不订阅书顶或 ticker,盘口跳动不会让它重渲染。
 */
export function TradesTape({ symbol }: TradesTapeProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const tape = useTape(symbol);
  const ready = useTapeReady(symbol);
  const offline = useMarketStore(selectFeedOffline);
  const instrument = useInstrument(symbol);
  const precision = instrument?.pricePrecision ?? 2;
  const qtyStep = instrument?.qtyStep ?? 1;
  const items = useMemo(() => (tape ? newestFirst(tape) : undefined), [tape]);
  const view = tapePanelState(items !== undefined, ready, offline);

  const renderRow = useCallback(
    (entry: TapeEntry) => (
      <TapeRow
        price={entry.price}
        quantity={entry.quantity}
        takerSide={entry.takerSide}
        ts={entry.ts}
        auditRef={entry.auditRef}
        precision={precision}
        qtyStep={qtyStep}
      />
    ),
    [precision, qtyStep],
  );

  return (
    <section
      data-area="tape"
      aria-label={t.tape.title}
      className="flex min-h-0 min-w-0 flex-col gap-gap overflow-hidden rounded-panel border border-(--terminal-border) bg-(--terminal-panel) p-panel"
    >
      <h2 className="text-t-md font-semibold leading-t-tight">{t.tape.title}</h2>
      {view === "list" && items ? (
        <>
          <div aria-hidden="true" className="t-tape-grid px-gap text-t-2xs text-muted-2">
            <span>{t.tape.time}</span>
            <span className="text-end">{t.tape.price}</span>
            <span className="text-end">{t.tape.qty}</span>
          </div>
          <VirtualList
            items={items}
            label={t.a11y.tapeRegion}
            renderRow={renderRow}
            getKey={tapeKey}
            empty={<EmptyState title={t.tape.empty} />}
            className="min-h-0 flex-1 overscroll-contain"
          />
        </>
      ) : view === "empty" ? (
        <EmptyState title={t.tape.empty} />
      ) : view === "error" ? (
        <ErrorState message={ui.error} onRetry={requestTransportReconnect} />
      ) : (
        <Skeleton rows={8} className="min-h-0 flex-1 overflow-hidden" />
      )}
    </section>
  );
}
