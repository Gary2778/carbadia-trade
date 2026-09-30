import { describe, expect, it } from "vitest";
import { aggregateLevels, applyDelta, cumulate, diffBook, spread } from "./orderbook";
import type { OrderBookLevel, OrderBookSnapshot } from "./types";

const L = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const mapOf = (levels: OrderBookLevel[]) => new Map(levels.map((l) => [l.price, l] as const));
const snap = (bids: OrderBookLevel[], asks: OrderBookLevel[], ts = 1_000): OrderBookSnapshot => ({ symbol: "VCS-FOR-2021", bids, asks, ts });

/** 确定性伪随机(LCG),让 20 组随机簿可复现 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}
function randomLevels(rand: () => number, base: number, dir: 1 | -1): OrderBookLevel[] {
  const n = 1 + Math.floor(rand() * 8);
  const prices = new Set<number>();
  while (prices.size < n) prices.add(base + dir * (1 + Math.floor(rand() * 40)));
  return [...prices].map((price) => L(price, 1 + Math.floor(rand() * 500), 1 + Math.floor(rand() * 4)));
}
const sortedLevels = (m: Map<number, OrderBookLevel>) => [...m.values()].sort((a, b) => a.price - b.price);

describe("applyDelta", () => {
  it("新增档", () => {
    const next = applyDelta(mapOf([L(1000, 5)]), [L(1010, 3)]);
    expect(sortedLevels(next)).toEqual([L(1000, 5), L(1010, 3)]);
  });

  it("改档(同价覆盖量与单数)", () => {
    const next = applyDelta(mapOf([L(1000, 5, 1)]), [L(1000, 8, 3)]);
    expect([...next.values()]).toEqual([L(1000, 8, 3)]);
  });

  it("quantity 0 删档,删不存在的档不报错", () => {
    const next = applyDelta(mapOf([L(1000, 5), L(1010, 2)]), [L(1000, 0, 0), L(2000, 0, 0)]);
    expect([...next.values()]).toEqual([L(1010, 2)]);
  });

  it("空增量返回等价副本,且不改入参", () => {
    const prev = mapOf([L(1000, 5)]);
    const next = applyDelta(prev, []);
    expect(next).not.toBe(prev);
    expect([...next.values()]).toEqual([L(1000, 5)]);
    applyDelta(prev, [L(1000, 0, 0)]);
    expect(prev.get(1000)).toEqual(L(1000, 5));
  });
});

describe("diffBook", () => {
  it("prev 为 null 时整个 next 就是增量", () => {
    const next = snap([L(990, 1)], [L(1010, 2)]);
    expect(diffBook(null, next)).toEqual(next);
  });

  it("只输出变化档,消失的档以 quantity 0 输出,bids 降序 asks 升序", () => {
    const prev = snap([L(990, 1), L(980, 4)], [L(1010, 2), L(1020, 6)]);
    const next = snap([L(990, 1), L(995, 7)], [L(1010, 3), L(1020, 6)], 2_000);
    expect(diffBook(prev, next)).toEqual({
      symbol: "VCS-FOR-2021",
      bids: [L(995, 7), L(980, 0, 0)],
      asks: [L(1010, 3)],
      ts: 2_000,
    });
  });

  it("同样的簿差分为空", () => {
    const a = snap([L(990, 1)], [L(1010, 2)]);
    const d = diffBook(a, { ...a, ts: 3 });
    expect(d.bids).toEqual([]);
    expect(d.asks).toEqual([]);
  });

  it("只有 orders 变化也算变化档", () => {
    const prev = snap([L(990, 1, 1)], []);
    const next = snap([L(990, 1, 2)], []);
    expect(diffBook(prev, next).bids).toEqual([L(990, 1, 2)]);
  });

  it("与 applyDelta 往返恒等(20 组随机簿)", () => {
    const rand = lcg(20260926);
    for (let i = 0; i < 20; i++) {
      const prev = snap(randomLevels(rand, 1000, -1), randomLevels(rand, 1000, 1));
      const next = snap(randomLevels(rand, 1000, -1), randomLevels(rand, 1000, 1));
      const delta = diffBook(prev, next);
      expect(sortedLevels(applyDelta(mapOf(prev.bids), delta.bids))).toEqual(sortedLevels(mapOf(next.bids)));
      expect(sortedLevels(applyDelta(mapOf(prev.asks), delta.asks))).toEqual(sortedLevels(mapOf(next.asks)));
    }
  });
});

describe("aggregateLevels", () => {
  it("BUY 按 0.05(5 分)向下取整合并,降序输出", () => {
    const out = aggregateLevels([L(1003, 2, 1), L(1001, 3, 2), L(996, 1, 1)], 5, "BUY");
    expect(out).toEqual([L(1000, 5, 3), L(995, 1, 1)]);
  });

  it("SELL 按 0.05 向上取整合并,升序输出", () => {
    const out = aggregateLevels([L(1007, 2, 1), L(1009, 3, 2), L(1011, 1, 1)], 5, "SELL");
    expect(out).toEqual([L(1010, 5, 3), L(1015, 1, 1)]);
  });

  it("整档价不动;step 1 只排序不合并", () => {
    expect(aggregateLevels([L(1000, 1), L(1005, 1)], 5, "BUY")).toEqual([L(1005, 1), L(1000, 1)]);
    expect(aggregateLevels([L(1001, 1), L(1000, 1)], 1, "SELL")).toEqual([L(1000, 1), L(1001, 1)]);
  });

  it("接受 Map 的 values() 迭代器;非法 step 按 1", () => {
    const m = mapOf([L(1002, 1), L(1001, 2)]);
    expect(aggregateLevels(m.values(), 0, "BUY")).toEqual([L(1002, 1), L(1001, 2)]);
    expect(aggregateLevels(m.values(), -5, "SELL")).toEqual([L(1001, 2), L(1002, 1)]);
  });

  it("不改入参档位对象", () => {
    const a = L(1003, 2, 1);
    aggregateLevels([a, L(1001, 3, 2)], 5, "BUY");
    expect(a).toEqual(L(1003, 2, 1));
  });
});

describe("cumulate", () => {
  it("cum 单调递增,pct 以总量为 1", () => {
    const out = cumulate([L(1000, 1), L(990, 3), L(980, 4)]);
    expect(out.map((r) => r.cum)).toEqual([1, 4, 8]);
    expect(out.map((r) => r.pct)).toEqual([1 / 8, 4 / 8, 1]);
    for (let i = 1; i < out.length; i++) expect(out[i].cum).toBeGreaterThanOrEqual(out[i - 1].cum);
  });

  it("空输入返回空;总量 0 时 pct 为 0", () => {
    expect(cumulate([])).toEqual([]);
    expect(cumulate([L(1000, 0, 0)])).toEqual([{ level: L(1000, 0, 0), cum: 0, pct: 0 }]);
  });

  it("聚合后的累计与聚合前一致", () => {
    const raw = [L(1003, 2), L(1001, 3), L(996, 1)];
    const agg = cumulate(aggregateLevels(raw, 5, "BUY"));
    expect(agg[agg.length - 1].cum).toBe(6);
  });
});

describe("spread", () => {
  it("abs 为分差,bps 按中间价", () => {
    const s = spread(9_990, 10_010);
    expect(s?.abs).toBe(20);
    expect(s?.bps).toBeCloseTo(20, 10);
  });

  it("任一侧缺失或非正数返回 null", () => {
    expect(spread(null, 1000)).toBeNull();
    expect(spread(1000, undefined)).toBeNull();
    expect(spread(0, 1000)).toBeNull();
    expect(spread(NaN, 1000)).toBeNull();
  });

  it("相等时价差为 0", () => {
    expect(spread(1000, 1000)).toEqual({ abs: 0, bps: 0 });
  });
});
