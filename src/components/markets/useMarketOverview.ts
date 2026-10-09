"use client";
// 市场总览页的数据(计划 §6.3.2 C6):首屏用服务端给的标的清单(props),挂载后改读行情 store,指数在浏览器里用同一个纯函数重算。
//   - 重算按帧合并:store 里 tickers / instruments 一变就排一个 requestAnimationFrame,同一帧里再来多少次变化也只算一次
//    (batcher 本来就一帧一次 set(),这里再挡住 setInstruments、轮询帧与 WS 帧落在同一帧里的叠加);页面也只在这一拍重渲染,
//     不是每次 set() 都渲染一遍;
//   - 渲染期不读 store:首屏(服务端与水合首帧)永远是 props 派生的快照,store 的内容只经订阅回调进 state,所以 HTML 与水合一致;
//   - 快照 = 标的 + ticker 配成的 InstrumentListItem[] 和 computeIndices 的结果,同一拍算出、同一拍换上。
import { useEffect, useMemo, useState } from "react";
import type { Instrument, InstrumentListItem, MarketIndices, Ticker } from "@/shared";
import { computeIndices } from "@/shared/market-indices";
import { useMarketStore, type MarketState } from "@/lib/market/store";

export type MarketSnapshot = { items: InstrumentListItem[]; indices: MarketIndices };

/** store 里有标的却没有它的 ticker(setInstruments 总是两个一起灌,这是兜底):价格取标的上的最新价,其余为空 */
const bareTicker = (instrument: Instrument, ts: number): Ticker => ({
  symbol: instrument.symbol,
  lastPrice: instrument.lastPrice,
  bestBid: null,
  bestAsk: null,
  change24h: null,
  high24h: null,
  low24h: null,
  volume24h: 0,
  ts,
});

/** 纯函数:store 状态 → 快照;标的列表还没灌入(instrumentsVersion 为 0)时是 null,页面继续用 props */
export function snapshotOf(state: Pick<MarketState, "instruments" | "tickers" | "instrumentsVersion">, ts: number): MarketSnapshot | null {
  if (state.instrumentsVersion === 0) return null;
  const items = Object.values(state.instruments).map((instrument) => ({ instrument, ticker: state.tickers[instrument.symbol] ?? bareTicker(instrument, ts) }));
  return { items, indices: computeIndices(items, ts) };
}

/** watchMarketSnapshots 的依赖:默认是真的 store 与 requestAnimationFrame,测试传假的 */
export type SnapshotSource = {
  subscribe: (listener: (state: MarketState, prev: MarketState) => void) => () => void;
  getState: () => MarketState;
  raf: (callback: () => void) => number;
  cancelRaf: (id: number) => void;
  now: () => number;
};

const browserSource = (): SnapshotSource => ({
  subscribe: (listener) => useMarketStore.subscribe(listener),
  getState: () => useMarketStore.getState(),
  raf: (callback) => requestAnimationFrame(callback),
  cancelRaf: (id) => cancelAnimationFrame(id),
  now: () => Date.now(),
});

/**
 * 订阅行情 store:tickers 或 instruments 变了就排一帧,帧到了才算一份快照交给 onSnapshot(同一帧里的多次变化只算一次);
 * 一开始先排一帧(站内导航进来时 store 里已经有数据)。返回取消函数:退订并撤掉没跑的那一帧。
 */
export function watchMarketSnapshots(onSnapshot: (snapshot: MarketSnapshot) => void, source: SnapshotSource = browserSource()): () => void {
  let frame: number | null = null;
  const run = () => {
    frame = null;
    const snapshot = snapshotOf(source.getState(), source.now());
    if (snapshot) onSnapshot(snapshot);
  };
  const schedule = () => {
    if (frame === null) frame = source.raf(run);
  };
  const unsubscribe = source.subscribe((state, prev) => {
    if (state.tickers !== prev.tickers || state.instruments !== prev.instruments) schedule();
  });
  schedule();
  return () => {
    unsubscribe();
    if (frame !== null) source.cancelRaf(frame);
    frame = null;
  };
}

export type MarketOverview = MarketSnapshot & {
  /** 标的清单已经落地:props 里有,或 store 已灌入(哪怕是空的)。false = 还在等第一份数据(显示骨架) */
  loaded: boolean;
};

/**
 * 页面用的数据:挂载前与首帧是 fallback(服务端的标的清单,指数按服务端时刻 serverTime 算),
 * 之后是 store 派生的快照(按帧合并)。fallback 与 serverTime 来自 props,引用稳定。
 */
export function useMarketOverview(fallback: InstrumentListItem[], serverTime: number): MarketOverview {
  const [live, setLive] = useState<MarketSnapshot | null>(null);
  useEffect(() => watchMarketSnapshots(setLive), []);
  const initial = useMemo<MarketSnapshot>(() => ({ items: fallback, indices: computeIndices(fallback, serverTime) }), [fallback, serverTime]);
  const snapshot = live ?? initial;
  return { ...snapshot, loaded: live !== null || fallback.length > 0 };
}
