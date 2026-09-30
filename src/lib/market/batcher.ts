// rAF 批处理(计划 §3.3「合帧 / rAF」、§3.6、§7.3):ws-client / poll-frames 把 ServerFrame push 进来,
// 下一帧 requestAnimationFrame 一次 apply(events)(即 marketActions.applyEvents 的一次 set());
// document.hidden 时 rAF 不来,用 hiddenFallbackMs 的 setTimeout 兜底(可见时它也常驻作为 rAF 被节流的保险);
// 积压期间标签页切走 / 切回(visibilitychange)的批次不记收到→flush 延迟样本(P1-25f);
// pending 超过 maxPending 时折叠:每个 book topic 只留最后快照并把 delta 折进去、tape 留最近 MAX_TAPE、
// ticker / candle 每键留最后一条;dispose 后 push / flush 均为空操作。
// 全部依赖(rAF、hidden 判定、可见性订阅)可注入,测试用假 rAF + vitest 假定时器,不需要 jsdom。
import type { OrderBookLevel, ServerEvent, ServerFrame, TapeEntry, TickerUpdate } from "@/shared";
import { MAX_TAPE } from "@/shared";

export type BatcherOptions = {
  /** 默认 globalThis.requestAnimationFrame;不存在(node / 测试)时只走定时器 */
  raf?: typeof requestAnimationFrame;
  /** 默认 500 ms */
  hiddenFallbackMs?: number;
  /** 默认 2000 条事件 */
  maxPending?: number;
  /** 默认读 document.visibilityState === "hidden";无 document 视为可见 */
  hidden?: () => boolean;
  /** 单调时钟(ms),默认 performance.now();只用于客户端内的收到→flush 延迟样本,不与服务端时钟比较 */
  now?: () => number;
  /**
   * 订阅可见性变化,返回退订函数;默认 document 的 visibilitychange,无 document(node / 测试)时不订阅。
   * 有积压时收到一次变化 = 本批「见过隐藏」,flush 时不记延迟样本(见 latencySamples);dispose 时退订。
   */
  onVisibilityChange?: (listener: () => void) => () => void;
};

/** 延迟样本环的容量:60 fps 下约 8 s 的 flush;PerfHud 取它算 p50 / p95。标签页隐藏期间的批次不收样本(见 latencySamples) */
export const LATENCY_SAMPLES = 512;

/** PerfHud(§7.3)读的计数:flush 次数、合并的事件 / 帧数、走兜底定时器的 flush 次数、折叠次数、当前积压 */
export type BatcherStats = { flushes: number; events: number; frames: number; fallbackFlushes: number; collapses: number; pending: number };

export type Batcher = {
  push(frame: ServerFrame): void;
  flush(): void;
  dispose(): void;
  stats(): BatcherStats;
  /**
   * 最近至多 LATENCY_SAMPLES 次 flush 的延迟样本(ms,旧→新,副本):每个样本 = flush 时刻 − 本批最早一帧
   * 被 push 的时刻(客户端收到时刻)。两端都读同一个客户端单调时钟,不涉及服务端时间,不会出现负数(计划 §7.3)。
   * 标签页隐藏期间的批次不记样本:本批任一帧 push 时或 flush 时 hidden() 为真、或积压期间发生过可见性变化就跳过 ——
   * 那时 rAF 停摆,等的是 hiddenFallbackMs 兜底或切回前台,不是帧延迟;若也进环,回到标签页后的几分钟里 p95 会一直显示约 500 ms,
   * 短于 hiddenFallbackMs 的一次切走(可见时 push → 切走 → 切回,其间不 push)也会漏进一个等于切走时长的样本(P1-25f)。
   * 可见时兜底定时器抢在 rAF 之前触发(主线程卡住超过 hiddenFallbackMs)的 flush 照记:这正是 p95 要暴露的最坏样本。
   * 两种兜底 flush 都计入 stats().fallbackFlushes。
   */
  latencySamples(): number[];
};

const defaultHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";
const defaultRaf = (): typeof requestAnimationFrame | undefined =>
  typeof requestAnimationFrame === "function" ? requestAnimationFrame.bind(globalThis) : undefined;
const defaultNow = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const defaultOnVisibilityChange = (listener: () => void): (() => void) => {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

export function createBatcher(apply: (events: ServerEvent[]) => void, opts: BatcherOptions = {}): Batcher {
  const raf = opts.raf ?? defaultRaf();
  const hiddenFallbackMs = opts.hiddenFallbackMs ?? 500;
  const maxPending = opts.maxPending ?? 2000;
  const hidden = opts.hidden ?? defaultHidden;
  const now = opts.now ?? defaultNow;

  let pending: ServerEvent[] = [];
  // 本批最早一帧的收到时刻(push 时读 now());flush 或 dispose 清空。折叠不改变它(最早的事件仍在批里,只是被合并)
  let oldestPendingAt: number | null = null;
  // 本批是否「见过隐藏」:有帧在标签页隐藏时 push 进来,或积压期间发生过可见性变化(隐藏批次不记延迟样本);flush 或 dispose 清空
  let batchSawHidden = false;
  // 延迟样本环:固定容量,写满后覆盖最旧的
  const latency: number[] = [];
  let latencyHead = 0;
  let disposed = false;
  // 调度令牌:每次 schedule / cancel 递增,过期的 rAF 回调自动失效(不依赖 cancelAnimationFrame)
  let token = 0;
  let scheduled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stats: BatcherStats = { flushes: 0, events: 0, frames: 0, fallbackFlushes: 0, collapses: 0, pending: 0 };
  // 可见性变化时有积压:本批跨过了一段隐藏(切走或切回都说明它等过隐藏期,rAF 停摆),flush 时不记样本
  const unsubscribeVisibility = (opts.onVisibilityChange ?? defaultOnVisibilityChange)(() => {
    if (pending.length > 0) batchSawHidden = true;
  });

  const cancel = (): void => {
    token++;
    scheduled = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flushFrom = (viaFallback: boolean): void => {
    cancel();
    if (disposed || pending.length === 0) return;
    const events = pending;
    pending = [];
    // 隐藏期间的批次不进延迟环(见 latencySamples 的注释);可见时的兜底 flush 照记。起点照常清空
    if (oldestPendingAt !== null && !batchSawHidden && !hidden()) {
      const sample = Math.max(0, now() - oldestPendingAt);
      if (latency.length < LATENCY_SAMPLES) latency.push(sample);
      else {
        latency[latencyHead] = sample;
        latencyHead = (latencyHead + 1) % LATENCY_SAMPLES;
      }
    }
    oldestPendingAt = null;
    batchSawHidden = false;
    stats.flushes++;
    stats.events += events.length;
    stats.pending = 0;
    if (viaFallback) stats.fallbackFlushes++;
    apply(events);
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    const mine = ++token;
    if (raf && !hidden()) {
      raf(() => {
        if (mine === token) flushFrom(false);
      });
    }
    timer = setTimeout(() => {
      timer = null;
      if (mine === token) flushFrom(true);
    }, hiddenFallbackMs);
  };

  return {
    push(frame) {
      if (disposed || frame.length === 0) return;
      if (pending.length === 0) oldestPendingAt = now();
      if (hidden()) batchSawHidden = true;
      stats.frames++;
      for (const ev of frame) pending.push(ev);
      if (pending.length > maxPending) {
        pending = collapseEvents(pending);
        stats.collapses++;
      }
      stats.pending = pending.length;
      schedule();
    },
    flush() {
      flushFrom(false);
    },
    dispose() {
      cancel();
      if (!disposed) unsubscribeVisibility();
      disposed = true;
      pending = [];
      oldestPendingAt = null;
      batchSawHidden = false;
      stats.pending = 0;
    },
    stats() {
      return { ...stats };
    },
    latencySamples() {
      return latency.length < LATENCY_SAMPLES ? latency.slice() : [...latency.slice(latencyHead), ...latency.slice(0, latencyHead)];
    },
  };
}

type BookEvent = Extract<ServerEvent, { t: "book.snapshot" | "book.delta" }>;
type TradesEvent = Extract<ServerEvent, { t: "trades" }>;
type TickerEvent = Extract<ServerEvent, { t: "ticker" }>;
type CandleEvent = Extract<ServerEvent, { t: "candle" }>;

type BookFold = { base: "snapshot" | "delta"; symbol: string; topic: BookEvent["topic"]; seq: number; ts: number; bids: Map<number, OrderBookLevel>; asks: Map<number, OrderBookLevel> };

/** 快照基底:quantity 0 删档;增量基底:0 也要保留,让 store 去删 */
function foldSide(levels: Map<number, OrderBookLevel>, delta: OrderBookLevel[], base: BookFold["base"]): void {
  for (const level of delta) {
    if (base === "snapshot" && level.quantity === 0) levels.delete(level.price);
    else levels.set(level.price, level);
  }
}

/**
 * 折叠一批积压事件(纯函数,push 超过 maxPending 时调用):
 * - 控制类事件(hello / subscribed / unsubscribed / pong / error / resync)与账户事件原序保留并排在最前;
 * - 每个 book topic 折成一条:有快照则「最后快照 + 之后的 delta」→ 一条 book.snapshot,否则全部 delta 合成一条 book.delta;
 * - 每个 trades topic 折成一条:按 id 去重、只留最近 MAX_TAPE 笔;
 * - ticker 按 topic + symbol 合并部分字段(后到覆盖)成一条;
 * - candle 按 topic + t 只留最后一条。
 * seq 一律取该键最后一条事件的 seq。
 */
export function collapseEvents(events: readonly ServerEvent[]): ServerEvent[] {
  const control: ServerEvent[] = [];
  const books = new Map<string, BookFold>();
  const trades = new Map<string, { ev: TradesEvent; entries: TapeEntry[]; ids: Set<string> }>();
  const tickers = new Map<string, TickerEvent>();
  const candles = new Map<string, CandleEvent>();

  for (const ev of events) {
    switch (ev.t) {
      case "book.snapshot": {
        books.set(ev.topic, { base: "snapshot", symbol: ev.symbol, topic: ev.topic, seq: ev.seq, ts: ev.ts, bids: new Map(ev.bids.map((l) => [l.price, l])), asks: new Map(ev.asks.map((l) => [l.price, l])) });
        break;
      }
      case "book.delta": {
        let fold = books.get(ev.topic);
        if (!fold) {
          fold = { base: "delta", symbol: ev.symbol, topic: ev.topic, seq: ev.seq, ts: ev.ts, bids: new Map(), asks: new Map() };
          books.set(ev.topic, fold);
        }
        foldSide(fold.bids, ev.bids, fold.base);
        foldSide(fold.asks, ev.asks, fold.base);
        fold.seq = ev.seq;
        fold.ts = ev.ts;
        break;
      }
      case "trades": {
        let slot = trades.get(ev.topic);
        if (!slot) {
          slot = { ev, entries: [], ids: new Set() };
          trades.set(ev.topic, slot);
        }
        slot.ev = ev;
        for (const entry of ev.trades) {
          if (slot.ids.has(entry.id)) continue;
          slot.ids.add(entry.id);
          slot.entries.push(entry);
        }
        break;
      }
      case "ticker": {
        const key = `${ev.topic}|${ev.symbol}`;
        const prev = tickers.get(key);
        if (!prev) tickers.set(key, ev);
        else {
          const merged: TickerUpdate = { ...prev.ticker };
          for (const k of Object.keys(ev.ticker) as (keyof TickerUpdate)[]) {
            const value = ev.ticker[k];
            if (value !== undefined) (merged as unknown as Record<string, unknown>)[k] = value;
          }
          tickers.set(key, { ...ev, ticker: merged });
        }
        break;
      }
      case "candle": {
        candles.set(`${ev.topic}|${ev.candle.t}`, ev);
        break;
      }
      default:
        control.push(ev);
    }
  }

  const out: ServerEvent[] = control;
  for (const fold of books.values()) {
    const bids = [...fold.bids.values()].sort((a, b) => b.price - a.price);
    const asks = [...fold.asks.values()].sort((a, b) => a.price - b.price);
    out.push({ t: fold.base === "snapshot" ? "book.snapshot" : "book.delta", topic: fold.topic, seq: fold.seq, symbol: fold.symbol, bids, asks, ts: fold.ts });
  }
  for (const slot of trades.values()) {
    const entries = slot.entries.length > MAX_TAPE ? slot.entries.slice(slot.entries.length - MAX_TAPE) : slot.entries;
    out.push({ ...slot.ev, trades: entries });
  }
  for (const ev of tickers.values()) out.push(ev);
  for (const ev of candles.values()) out.push(ev);
  return out;
}
