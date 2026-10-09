import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeIndices } from "@/shared/market-indices";
import { createInitialState, marketActions, useMarketStore, type MarketState } from "@/lib/market/store";
import { snapshotOf, watchMarketSnapshots, type MarketSnapshot, type SnapshotSource } from "./useMarketOverview";
import { CREDITS, ITEMS, TS } from "./test-support";

// 重算按帧合并(计划 §6.3.3 P3-05):一帧里 tickers / instruments 变多少次,快照只算一次;没有 jsdom,用假的 rAF 与假的 store 来源,
// 另用真的 zustand store(marketActions)走一遍灌入与 ticker 合并。

/** 假来源:set() 模拟 store 变化,runFrame() 跑一帧(只跑当前排着的那一个) */
function fakeSource(initial: MarketState) {
  let state = initial;
  const listeners = new Set<(state: MarketState, prev: MarketState) => void>();
  const frames = new Map<number, () => void>();
  let nextId = 1;
  let scheduled = 0;
  let cancelled = 0;
  const source: SnapshotSource = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    raf: (callback) => {
      const id = nextId++;
      scheduled++;
      frames.set(id, callback);
      return id;
    },
    cancelRaf: (id) => {
      cancelled++;
      frames.delete(id);
    },
    now: () => TS + 1,
  };
  return {
    source,
    set(patch: Partial<MarketState>) {
      const prev = state;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener(state, prev);
    },
    runFrame() {
      const [id, callback] = [...frames][0] ?? [];
      if (id === undefined || !callback) return false;
      frames.delete(id);
      callback();
      return true;
    },
    pending: () => frames.size,
    scheduled: () => scheduled,
    cancelled: () => cancelled,
    listeners: () => listeners.size,
  };
}

const loadedState = (items = ITEMS): MarketState => {
  const state = createInitialState();
  for (const { instrument, ticker } of items) {
    state.instruments[instrument.symbol] = instrument;
    state.tickers[instrument.symbol] = ticker;
  }
  return { ...state, instrumentsVersion: 1, tickersVersion: 1 };
};

describe("snapshotOf", () => {
  it("标的列表还没灌入(instrumentsVersion 为 0)→ null,页面继续用 props", () => {
    expect(snapshotOf(createInitialState(), TS)).toBeNull();
  });

  it("灌入之后:标的与 ticker 配成 InstrumentListItem,指数 = 同一份数据上的 computeIndices(情景标的不计)", () => {
    const snapshot = snapshotOf(loadedState(), TS)!;
    expect(snapshot.items).toEqual(ITEMS);
    expect(snapshot.indices).toEqual(computeIndices(ITEMS, TS));
    expect(snapshot.indices.all).toMatchObject({ members: 11, counted: 10, change24h: 0.43, level: 100.43 });
  });

  it("store 里有标的却没有它的 ticker:价格取标的上的最新价、涨跌为空(不当 0 算)", () => {
    const state = loadedState(CREDITS.slice(0, 2));
    delete state.tickers[CREDITS[1].instrument.symbol];
    const snapshot = snapshotOf(state, TS)!;
    expect(snapshot.items[1].ticker).toMatchObject({ symbol: CREDITS[1].instrument.symbol, lastPrice: CREDITS[1].instrument.lastPrice, change24h: null, volume24h: 0 });
    expect(snapshot.indices.all).toMatchObject({ members: 2, counted: 1, change24h: 3.5 });
  });
});

describe("watchMarketSnapshots: recompute at most once per animation frame", () => {
  it("一帧里 tickers 变 50 次只排一帧、只算一份快照,里面是最新的数据", () => {
    const fake = fakeSource(loadedState());
    const snapshots: MarketSnapshot[] = [];
    const stop = watchMarketSnapshots((s) => snapshots.push(s), fake.source);
    expect(fake.scheduled()).toBe(1); // 一开始排一帧:站内导航进来时 store 里已经有数据
    expect(fake.runFrame()).toBe(true);
    expect(snapshots).toHaveLength(1);

    for (let i = 1; i <= 50; i++) {
      fake.set({ tickers: { ...fake.source.getState().tickers, "VCS-FOR-2021": { ...CREDITS[0].ticker, change24h: i / 10, ts: TS + i } } });
    }
    expect(fake.scheduled()).toBe(2); // 50 次变化只多排了一帧
    expect(fake.pending()).toBe(1);
    expect(snapshots).toHaveLength(1); // 帧没到,不重算
    fake.runFrame();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1].items.find((item) => item.instrument.symbol === "VCS-FOR-2021")!.ticker.change24h).toBe(5); // 第 50 次
    expect(fake.runFrame()).toBe(false);
    stop();
  });

  it("下一帧的变化再排一帧,每帧各算一份", () => {
    const fake = fakeSource(loadedState());
    const snapshots: MarketSnapshot[] = [];
    const stop = watchMarketSnapshots((s) => snapshots.push(s), fake.source);
    fake.runFrame();
    for (const change of [1, 2, 3]) {
      fake.set({ tickers: { ...fake.source.getState().tickers, "GS-WIND-2021": { ...CREDITS[4].ticker, change24h: change } } });
      fake.runFrame();
    }
    expect(snapshots).toHaveLength(4);
    expect(fake.scheduled()).toBe(4);
    stop();
  });

  it("只有 tickers 或 instruments 变才排帧:连接状态、盘口之类的变化不触发重算", () => {
    const fake = fakeSource(loadedState());
    const stop = watchMarketSnapshots(() => {}, fake.source);
    fake.runFrame();
    fake.set({ connection: { transport: "ws", state: "open", lastMessageAt: TS, rttMs: 12 } });
    fake.set({ watchlist: ["VCS-FOR-2021"] });
    expect(fake.pending()).toBe(0);
    fake.set({ instruments: { ...fake.source.getState().instruments } });
    expect(fake.pending()).toBe(1);
    stop();
  });

  it("标的列表还没灌入时帧到了也不交快照(页面继续用 props);灌入后的那一帧才交", () => {
    const fake = fakeSource(createInitialState());
    const snapshots: MarketSnapshot[] = [];
    const stop = watchMarketSnapshots((s) => snapshots.push(s), fake.source);
    fake.runFrame();
    expect(snapshots).toEqual([]);
    fake.set({ ...loadedState() });
    fake.runFrame();
    expect(snapshots).toHaveLength(1);
    stop();
  });

  it("取消:退订并撤掉还没跑的那一帧,之后的变化不再排帧", () => {
    const fake = fakeSource(loadedState());
    const snapshots: MarketSnapshot[] = [];
    const stop = watchMarketSnapshots((s) => snapshots.push(s), fake.source);
    expect(fake.pending()).toBe(1);
    stop();
    expect(fake.pending()).toBe(0);
    expect(fake.cancelled()).toBe(1);
    expect(fake.listeners()).toBe(0);
    fake.set({ tickers: {} });
    expect(fake.pending()).toBe(0);
    expect(snapshots).toEqual([]);
  });
});

describe("with the real market store", () => {
  beforeEach(() => {
    useMarketStore.setState(createInitialState(), true);
  });
  afterEach(() => {
    useMarketStore.setState(createInitialState(), true);
  });

  /** 真的 store + 手动推进的帧 */
  function realSource() {
    const frames: Array<() => void> = [];
    const source: SnapshotSource = {
      subscribe: (listener) => useMarketStore.subscribe(listener),
      getState: () => useMarketStore.getState(),
      raf: (callback) => frames.push(callback),
      cancelRaf: () => {},
      now: () => TS + 5,
    };
    return { source, runFrames: () => frames.splice(0).forEach((callback) => callback()) };
  }

  it("setInstruments 灌入后的第一帧给出快照;ticker 事件(部分字段)合并进去,指数跟着变", () => {
    const { source, runFrames } = realSource();
    const snapshots: MarketSnapshot[] = [];
    const stop = watchMarketSnapshots((s) => snapshots.push(s), source);
    marketActions.setInstruments(ITEMS, { onlyIfEmpty: true });
    runFrames();
    expect(snapshots.at(-1)!.indices.all).toMatchObject({ change24h: 0.43, level: 100.43 });

    // VCS-FOR-2021 的涨跌 3.5 → −1.5:全部 = (0.43 × 10 − 3.5 − 1.5)/ 10 = −0.07
    marketActions.applyEvents([{ t: "ticker", topic: "ticker:*", seq: 0, symbol: "VCS-FOR-2021", ticker: { symbol: "VCS-FOR-2021", ts: TS + 1, change24h: -1.5 } }]);
    runFrames();
    const latest = snapshots.at(-1)!;
    expect(latest.items.find((item) => item.instrument.symbol === "VCS-FOR-2021")!.ticker).toMatchObject({ change24h: -1.5, lastPrice: 1_000 });
    expect(latest.indices.all).toMatchObject({ change24h: -0.07, level: 99.93, advancers: 5, decliners: 4 });
    stop();
  });
});
