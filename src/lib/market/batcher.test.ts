import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderBookLevel, ServerEvent, TapeEntry } from "@/shared";
import { MAX_TAPE, auditRefOf } from "@/shared";
import { LATENCY_SAMPLES, collapseEvents, createBatcher } from "./batcher";

const SYM = "VCS-FOR-2021";
const L = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const snapshot = (bids: OrderBookLevel[], asks: OrderBookLevel[], seq = 1, symbol = SYM): ServerEvent => ({ t: "book.snapshot", topic: `book:${symbol}`, seq, symbol, bids, asks, ts: seq });
const delta = (bids: OrderBookLevel[], asks: OrderBookLevel[], seq = 2, symbol = SYM): ServerEvent => ({ t: "book.delta", topic: `book:${symbol}`, seq, symbol, bids, asks, ts: seq });
const trade = (id: string, ts = 1): TapeEntry => ({ id, symbol: SYM, price: 100, quantity: 1, takerSide: "BUY", ts, auditRef: auditRefOf(id) });
const trades = (entries: TapeEntry[], seq = 1): ServerEvent => ({ t: "trades", topic: `trades:${SYM}`, seq, symbol: SYM, trades: entries });
const tickerEv = (partial: Record<string, number | null>, seq = 1, ts = 1): ServerEvent => ({ t: "ticker", topic: `ticker:${SYM}`, seq, symbol: SYM, ticker: { symbol: SYM, ts, ...partial } });
const candle = (t: number, c: number, seq = 1): ServerEvent => ({ t: "candle", topic: `candles:${SYM}:1m`, seq, symbol: SYM, interval: "1m", candle: { t, o: c, h: c, l: c, c, v: 1 } });
const hello: ServerEvent = { t: "hello", v: 1, serverTime: 1, heartbeatMs: 25_000, userId: null, maxTopics: 64 };

/** 假 rAF:回调排队,tick() 才执行 */
function fakeRaf() {
  const queue: FrameRequestCallback[] = [];
  const raf = ((cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  }) as typeof requestAnimationFrame;
  const tick = () => {
    const cbs = queue.splice(0);
    for (const cb of cbs) cb(performance.now());
  };
  return { raf, tick, size: () => queue.length };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createBatcher", () => {
  it("多帧合成一次 apply,顺序保持;flush 后积压清空", () => {
    const apply = vi.fn();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false });
    b.push([snapshot([L(1, 1)], [])]);
    b.push([delta([L(1, 2)], []), tickerEv({ lastPrice: 1 })]);
    expect(apply).not.toHaveBeenCalled();
    tick();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0].map((e: ServerEvent) => e.t)).toEqual(["book.snapshot", "book.delta", "ticker"]);
    tick();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(b.stats()).toMatchObject({ flushes: 1, events: 3, frames: 2, fallbackFlushes: 0, collapses: 0, pending: 0 });
  });

  it("rAF 之后再 push 会再排一帧;空帧不排", () => {
    const apply = vi.fn();
    const { raf, tick, size } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false });
    b.push([]);
    expect(size()).toBe(0);
    b.push([hello]);
    tick();
    b.push([hello]);
    expect(size()).toBe(1);
    tick();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("hidden 时不排 rAF,500 ms 定时器兜底 apply,并计入 fallbackFlushes", () => {
    const apply = vi.fn();
    const { raf, size } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => true });
    b.push([hello]);
    expect(size()).toBe(0);
    vi.advanceTimersByTime(499);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(b.stats().fallbackFlushes).toBe(1);
  });

  it("hiddenFallbackMs 可配置;可见时 rAF 先到则定时器被取消、不重复 apply", () => {
    const apply = vi.fn();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false, hiddenFallbackMs: 100 });
    b.push([hello]);
    tick();
    vi.advanceTimersByTime(1_000);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(b.stats().fallbackFlushes).toBe(0);
  });

  it("没有 rAF(node)时只走定时器", () => {
    const apply = vi.fn();
    const b = createBatcher(apply, { hidden: () => false, hiddenFallbackMs: 50 });
    b.push([hello]);
    vi.advanceTimersByTime(50);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("手动 flush 立即 apply 并取消已排的帧;无积压时 flush 不调用 apply", () => {
    const apply = vi.fn();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false });
    b.flush();
    expect(apply).not.toHaveBeenCalled();
    b.push([hello]);
    b.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    tick();
    vi.advanceTimersByTime(1_000);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("超过 maxPending 折叠:book 只留最后快照 + 折进的 delta,tape 留最近 MAX_TAPE", () => {
    const apply = vi.fn();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false, maxPending: 10 });
    b.push([snapshot([L(1, 1)], [L(9, 1)], 1)]);
    for (let i = 2; i <= 6; i++) b.push([delta([L(1, i)], [], i)]);
    b.push([snapshot([L(2, 2)], [L(8, 8)], 7)]);
    b.push([delta([L(2, 0, 0), L(3, 3)], [L(8, 9)], 8), delta([L(4, 4)], [], 9)]);
    const many = Array.from({ length: MAX_TAPE + 20 }, (_, i) => trade(`t${i}`, i));
    b.push([trades(many.slice(0, 100), 1), trades(many.slice(100), 2)]);
    expect(b.stats().collapses).toBeGreaterThanOrEqual(1);
    tick();
    expect(apply).toHaveBeenCalledTimes(1);
    const events = apply.mock.calls[0][0] as ServerEvent[];
    const book = events.filter((e) => e.t === "book.snapshot" || e.t === "book.delta");
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ t: "book.snapshot", seq: 9, bids: [L(4, 4), L(3, 3)], asks: [L(8, 9)] });
    const tape = events.filter((e) => e.t === "trades");
    expect(tape).toHaveLength(1);
    const entries = (tape[0] as Extract<ServerEvent, { t: "trades" }>).trades;
    expect(entries).toHaveLength(MAX_TAPE);
    expect(entries[0].id).toBe("t20");
    expect(entries[MAX_TAPE - 1].id).toBe(`t${MAX_TAPE + 19}`);
  });

  it("dispose 后不再 apply:已排的帧与定时器失效,之后的 push / flush 为空操作", () => {
    const apply = vi.fn();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false });
    b.push([hello]);
    b.dispose();
    tick();
    vi.advanceTimersByTime(1_000);
    b.push([hello]);
    b.flush();
    tick();
    expect(apply).not.toHaveBeenCalled();
    expect(b.stats().pending).toBe(0);
  });

  it("apply 抛错不会卡住 batcher:下一帧照常", () => {
    const apply = vi.fn().mockImplementationOnce(() => {
      throw new Error("boom");
    });
    const { raf, tick } = fakeRaf();
    const b = createBatcher(apply, { raf, hidden: () => false });
    b.push([hello]);
    expect(() => tick()).toThrow("boom");
    b.push([hello]);
    tick();
    expect(apply).toHaveBeenCalledTimes(2);
  });
});

describe("createBatcher 延迟样本(计划 §7.3:flush 时刻 − 本批最早一帧的客户端收到时刻)", () => {
  /** 可手动拨动的单调时钟 */
  function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  }

  it("样本取本批最早一帧的 push 时刻,后到的帧不刷新起点;每次 flush 一个样本", () => {
    const c = clock();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(vi.fn(), { raf, hidden: () => false, now: c.now });
    b.push([hello]);
    c.advance(7);
    b.push([hello]);
    c.advance(5);
    tick();
    expect(b.latencySamples()).toEqual([12]);
    b.push([hello]);
    c.advance(3);
    tick();
    expect(b.latencySamples()).toEqual([12, 3]);
  });

  it("隐藏时走兜底定时器的 flush 不记样本(只计 fallbackFlushes),但清掉起点;空 flush 不记", () => {
    const c = clock();
    const { raf, tick } = fakeRaf();
    let isHidden = true;
    const b = createBatcher(vi.fn(), { raf, hidden: () => isHidden, hiddenFallbackMs: 500, now: c.now });
    b.flush();
    expect(b.latencySamples()).toEqual([]);
    b.push([hello]);
    c.advance(500);
    vi.advanceTimersByTime(500);
    expect(b.stats()).toMatchObject({ flushes: 1, fallbackFlushes: 1 });
    expect(b.latencySamples()).toEqual([]);
    // 回到前台:下一批从自己的 push 时刻算起,不带上兜底那批的起点
    isHidden = false;
    c.advance(1_000);
    b.push([hello]);
    c.advance(4);
    tick();
    expect(b.stats()).toMatchObject({ flushes: 2, fallbackFlushes: 1 });
    expect(b.latencySamples()).toEqual([4]);
  });

  it("可见时兜底定时器抢在 rAF 之前触发(主线程卡住)照记样本,约等于 hiddenFallbackMs", () => {
    const c = clock();
    const { raf, size } = fakeRaf();
    const b = createBatcher(vi.fn(), { raf, hidden: () => false, hiddenFallbackMs: 500, now: c.now });
    b.push([hello]);
    expect(size()).toBe(1); // rAF 已排,但这一帧一直没来
    c.advance(500);
    vi.advanceTimersByTime(500);
    expect(b.stats()).toMatchObject({ flushes: 1, fallbackFlushes: 1 });
    expect(b.latencySamples()).toEqual([500]);
  });

  it("批次里有帧在隐藏时 push:回到前台后兜底 flush 也不记样本;rAF 排好后切到后台、隐藏时兜底 flush 同样不记", () => {
    const c = clock();
    const { raf, tick } = fakeRaf();
    let isHidden = true;
    const b = createBatcher(vi.fn(), { raf, hidden: () => isHidden, hiddenFallbackMs: 500, now: c.now });
    // ① 隐藏时 push(不排 rAF),未到 500 ms 就回到前台:兜底 flush 时可见,但这批等的是隐藏兜底
    b.push([hello]);
    c.advance(300);
    isHidden = false;
    c.advance(200);
    vi.advanceTimersByTime(500);
    expect(b.stats()).toMatchObject({ flushes: 1, fallbackFlushes: 1 });
    expect(b.latencySamples()).toEqual([]);
    // ② 可见时 push(rAF 已排),随后切到后台,rAF 不来,兜底在隐藏时触发
    b.push([hello]);
    isHidden = true;
    c.advance(500);
    vi.advanceTimersByTime(500);
    expect(b.stats()).toMatchObject({ flushes: 2, fallbackFlushes: 2 });
    expect(b.latencySamples()).toEqual([]);
    // ③ 标记随 flush 清掉:下一批可见时照常记样本
    isHidden = false;
    tick(); // 清掉 ② 里排下、已失效的 rAF 回调
    b.push([hello]);
    c.advance(6);
    tick();
    expect(b.stats()).toMatchObject({ flushes: 3, fallbackFlushes: 2 });
    expect(b.latencySamples()).toEqual([6]);
  });

  /** 可注入的 visibilitychange 订阅:fire() 模拟一次可见性变化,listeners() 看当前订阅数 */
  function visibility() {
    const set = new Set<() => void>();
    return {
      subscribe: (listener: () => void) => {
        set.add(listener);
        return () => void set.delete(listener);
      },
      fire: () => {
        for (const l of [...set]) l();
      },
      listeners: () => set.size,
    };
  }

  it("可见时 push,短于 hiddenFallbackMs 的一次切走再切回(期间不 push):回来后 rAF flush 不记样本", () => {
    const c = clock();
    const v = visibility();
    const { raf, tick } = fakeRaf();
    let isHidden = false;
    const b = createBatcher(vi.fn(), { raf, hidden: () => isHidden, hiddenFallbackMs: 500, now: c.now, onVisibilityChange: v.subscribe });
    b.push([hello]); // 可见时 push,rAF 已排
    isHidden = true;
    v.fire(); // 切到后台:rAF 停摆
    c.advance(300);
    isHidden = false;
    v.fire(); // 300 ms 后切回(不到兜底的 500 ms),其间没有 push
    tick(); // 浏览器在回到前台后补上那一帧
    expect(b.stats()).toMatchObject({ flushes: 1, fallbackFlushes: 0 });
    expect(b.latencySamples()).toEqual([]); // 不是约 300 ms 的「帧延迟」样本
    // 标记随 flush 清掉:下一批照常记样本
    b.push([hello]);
    c.advance(5);
    tick();
    expect(b.latencySamples()).toEqual([5]);
  });

  it("没有积压时的可见性变化不标记下一批;dispose 退订", () => {
    const c = clock();
    const v = visibility();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(vi.fn(), { raf, hidden: () => false, now: c.now, onVisibilityChange: v.subscribe });
    expect(v.listeners()).toBe(1);
    v.fire(); // 批次为空:什么都不标
    v.fire();
    b.push([hello]);
    c.advance(7);
    tick();
    expect(b.latencySamples()).toEqual([7]);
    b.dispose();
    expect(v.listeners()).toBe(0);
  });

  it("默认订阅 document 的 visibilitychange(node 里没有 document 时不订阅,也不报错)", () => {
    expect(typeof document).toBe("undefined");
    const b = createBatcher(vi.fn(), { hidden: () => false });
    b.push([hello]);
    b.flush();
    expect(b.latencySamples()).toHaveLength(1);
    b.dispose();
    const added: string[] = [];
    const removed: string[] = [];
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: (type: string) => added.push(type),
      removeEventListener: (type: string) => removed.push(type),
    });
    try {
      const d = createBatcher(vi.fn());
      expect(added).toEqual(["visibilitychange"]);
      d.dispose();
      expect(removed).toEqual(["visibilitychange"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("折叠不改变起点;dispose 清掉未 flush 的起点", () => {
    const c = clock();
    const { raf, tick } = fakeRaf();
    const b = createBatcher(vi.fn(), { raf, hidden: () => false, maxPending: 2, now: c.now });
    b.push([tickerEv({ lastPrice: 1 }, 1)]);
    c.advance(4);
    b.push([tickerEv({ lastPrice: 2 }, 2), tickerEv({ lastPrice: 3 }, 3)]);
    expect(b.stats().collapses).toBe(1);
    c.advance(6);
    tick();
    expect(b.latencySamples()).toEqual([10]);
    b.push([hello]);
    b.dispose();
    expect(b.latencySamples()).toEqual([10]);
  });

  it("时钟回拨时样本钳为 0,不出现负数", () => {
    let t = 100;
    const b = createBatcher(vi.fn(), { hidden: () => false, now: () => t });
    b.push([hello]);
    t = 90;
    b.flush();
    expect(b.latencySamples()).toEqual([0]);
  });

  it("环形缓冲只留最近 LATENCY_SAMPLES 个,按旧→新返回副本", () => {
    const c = clock();
    const b = createBatcher(vi.fn(), { hidden: () => false, now: c.now });
    for (let i = 0; i < LATENCY_SAMPLES + 3; i++) {
      b.push([hello]);
      c.advance(i);
      b.flush();
    }
    const samples = b.latencySamples();
    expect(samples).toHaveLength(LATENCY_SAMPLES);
    expect(samples[0]).toBe(3);
    expect(samples[LATENCY_SAMPLES - 1]).toBe(LATENCY_SAMPLES + 2);
    samples.length = 0;
    expect(b.latencySamples()).toHaveLength(LATENCY_SAMPLES);
  });
});

describe("collapseEvents", () => {
  it("控制事件与账户事件原序保留并排最前", () => {
    const out = collapseEvents([tickerEv({ lastPrice: 1 }), hello, { t: "resync", topic: `book:${SYM}`, reason: "backpressure" }, { t: "balance", topic: "account", seq: 1, balance: { cashBalance: 1, lockedCash: 0 } }]);
    expect(out.map((e) => e.t)).toEqual(["hello", "resync", "balance", "ticker"]);
  });

  it("没有快照时全部 delta 合成一条 delta,保留 quantity 0 让 store 删档", () => {
    const out = collapseEvents([delta([L(1, 1)], [], 1), delta([L(1, 0, 0), L(2, 2)], [L(5, 5)], 2), delta([L(2, 3)], [L(5, 0, 0)], 3)]);
    expect(out).toEqual([{ t: "book.delta", topic: `book:${SYM}`, seq: 3, symbol: SYM, bids: [L(2, 3), L(1, 0, 0)], asks: [L(5, 0, 0)], ts: 3 }]);
  });

  it("快照之前的 delta 被丢弃,之后的折进快照(quantity 0 删档),不同 topic 各自一条", () => {
    const out = collapseEvents([delta([L(1, 1)], [], 1), snapshot([L(1, 5), L(2, 5)], [L(9, 9)], 2), delta([L(2, 0, 0)], [L(9, 1)], 3), snapshot([L(7, 7)], [], 1, "GS-REN-2020")]);
    expect(out).toEqual([
      { t: "book.snapshot", topic: `book:${SYM}`, seq: 3, symbol: SYM, bids: [L(1, 5)], asks: [L(9, 1)], ts: 3 },
      { t: "book.snapshot", topic: "book:GS-REN-2020", seq: 1, symbol: "GS-REN-2020", bids: [L(7, 7)], asks: [], ts: 1 },
    ]);
  });

  it("trades 按 id 去重合成一条,seq 取最后", () => {
    const out = collapseEvents([trades([trade("a"), trade("b")], 1), trades([trade("b"), trade("c")], 2)]);
    expect(out).toEqual([trades([trade("a"), trade("b"), trade("c")], 2)]);
  });

  it("ticker 同键合并部分字段(后到覆盖),candle 同 t 留最后、不同 t 都留", () => {
    const out = collapseEvents([tickerEv({ lastPrice: 1, bestBid: 9 }, 1, 1), tickerEv({ lastPrice: 2 }, 2, 2), candle(60_000, 1, 1), candle(60_000, 2, 2), candle(120_000, 3, 3)]);
    expect(out).toEqual([tickerEv({ bestBid: 9, lastPrice: 2 }, 2, 2), candle(60_000, 2, 2), candle(120_000, 3, 3)]);
  });
});
