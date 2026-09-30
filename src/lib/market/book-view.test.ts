import { beforeEach, describe, expect, it } from "vitest";
import type { Order, OrderBookLevel } from "@/shared";
import { EMPTY_MINE, buildBookView, createFlashState, getBookView, minePricesOf, resetBookViewCache, type MinePrices } from "./book-view";
import type { BookState } from "./store";

const SYM = "VCS-FOR-2021";
const L = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const mapOf = (levels: OrderBookLevel[]) => new Map(levels.map((l) => [l.price, l] as const));
let versionSeq = 0;
const book = (bids: OrderBookLevel[], asks: OrderBookLevel[], version = ++versionSeq): BookState => ({ bids: mapOf(bids), asks: mapOf(asks), seq: 1, version, ts: 1 });
const mine = (bids: number[] = [], asks: number[] = []): MinePrices => ({ bids: new Set(bids), asks: new Set(asks) });
const order = (id: string, side: Order["side"], price: number | null, over: Partial<Order> = {}): Order => ({
  id,
  clientOrderId: null,
  assetId: "a",
  symbol: SYM,
  side,
  type: price === null ? "MARKET" : "LIMIT",
  price,
  quantity: 1,
  filledQuantity: 0,
  status: "OPEN",
  avgFillPrice: null,
  cancelReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(() => resetBookViewCache());

describe("buildBookView", () => {
  it("step 1:原始档,bids 降序、asks 升序,cum 累加,pct 按可见档总量,spread 按原始最优价", () => {
    const view = buildBookView(book([L(1000, 5), L(990, 3), L(980, 2)], [L(1010, 4), L(1020, 6)]), EMPTY_MINE, 1, 50);
    expect(view.bids.map((r) => [r.price, r.quantity, r.cum, r.pct])).toEqual([
      [1000, 5, 5, 0.5],
      [990, 3, 8, 0.8],
      [980, 2, 10, 1],
    ]);
    expect(view.asks.map((r) => [r.price, r.quantity, r.cum, r.pct])).toEqual([
      [1010, 4, 4, 0.4],
      [1020, 6, 10, 1],
    ]);
    expect(view.spread).toEqual({ abs: 10, bps: (10 / 1005) * 10_000 });
    expect(view.bids[0].orders).toBe(1);
  });

  it("聚合:BUY 向下、SELL 向上取整,量与单数相加", () => {
    const view = buildBookView(book([L(1003, 1, 1), L(1001, 2, 2), L(996, 4, 1)], [L(1007, 1), L(1009, 2), L(1011, 3)]), EMPTY_MINE, 5, 50);
    expect(view.bids.map((r) => [r.price, r.quantity, r.orders])).toEqual([
      [1000, 3, 3],
      [995, 4, 1],
    ]);
    expect(view.asks.map((r) => [r.price, r.quantity, r.orders])).toEqual([
      [1010, 3, 2],
      [1015, 3, 1],
    ]);
    // spread 仍按原始最优价 1003 / 1007
    expect(view.spread?.abs).toBe(4);
  });

  it("depth 截断,pct 以可见档总量为 1;非法 depth 显示全部;非法 step 按 1", () => {
    const b = book([L(100, 1), L(99, 1), L(98, 1), L(97, 1)], []);
    const view = buildBookView(b, EMPTY_MINE, 1, 2);
    expect(view.bids.map((r) => [r.price, r.pct])).toEqual([
      [100, 0.5],
      [99, 1],
    ]);
    expect(buildBookView(b, EMPTY_MINE, 1, 0).bids).toHaveLength(4);
    expect(buildBookView(b, EMPTY_MINE, Number.NaN, 50).bids.map((r) => r.price)).toEqual([100, 99, 98, 97]);
  });

  it("空簿:两侧空、spread null", () => {
    const view = buildBookView(book([], []), EMPTY_MINE, 1, 50);
    expect(view).toEqual({ bids: [], asks: [], spread: null });
  });

  it("mine 来自传入集合并按 side 落桶:买单只标买盘,卖单只标卖盘", () => {
    const b = book([L(1003, 1), L(996, 1)], [L(1004, 1), L(1009, 1)]);
    const raw = buildBookView(b, mine([1003], [1009]), 1, 50);
    expect(raw.bids.map((r) => [r.price, r.mine])).toEqual([
      [1003, true],
      [996, false],
    ]);
    expect(raw.asks.map((r) => [r.price, r.mine])).toEqual([
      [1004, false],
      [1009, true],
    ]);
    // step 5:买单 1003 → 买盘 1000 桶;它不会把卖盘 1005 桶标成自家(ceil(1003/5)*5 = 1005 但那是卖盘规则)
    const agg = buildBookView(b, mine([1003], []), 5, 50);
    expect(agg.bids.map((r) => [r.price, r.mine])).toEqual([
      [1000, true],
      [995, false],
    ]);
    expect(agg.asks.map((r) => [r.price, r.mine])).toEqual([
      [1005, false],
      [1010, false],
    ]);
  });

  it("flashKey:首次 0,quantity 变化 + 1,不变则保持,消失后槽被清理", () => {
    const flash = createFlashState();
    const v1 = buildBookView(book([L(100, 5), L(99, 1)], []), EMPTY_MINE, 1, 50, flash);
    expect(v1.bids.map((r) => r.flashKey)).toEqual([0, 0]);
    const v2 = buildBookView(book([L(100, 6), L(99, 1)], []), EMPTY_MINE, 1, 50, flash);
    expect(v2.bids.map((r) => r.flashKey)).toEqual([1, 0]);
    const v3 = buildBookView(book([L(100, 6), L(99, 2)], []), EMPTY_MINE, 1, 50, flash);
    expect(v3.bids.map((r) => r.flashKey)).toEqual([1, 1]);
    const v4 = buildBookView(book([L(100, 7)], []), EMPTY_MINE, 1, 50, flash);
    expect(v4.bids.map((r) => r.flashKey)).toEqual([2]);
    expect(flash.bids.has(99)).toBe(false);
    // 不传 flashState 时每次都是全新槽:恒 0
    expect(buildBookView(book([L(100, 8)], []), EMPTY_MINE, 1, 50).bids[0].flashKey).toBe(0);
  });

  it("不改入参", () => {
    const b = book([L(100, 5)], [L(101, 1)]);
    const m = mine([100], []);
    buildBookView(b, m, 5, 1);
    expect([...b.bids.values()]).toEqual([L(100, 5)]);
    expect([...b.asks.values()]).toEqual([L(101, 1)]);
    expect([...m.bids]).toEqual([100]);
  });
});

describe("getBookView 缓存", () => {
  it("同 [version, step, depth, mineVersion] 两次返回同一引用", () => {
    const b = book([L(100, 1)], [L(101, 1)]);
    const a = getBookView(SYM, b, 1, 25, EMPTY_MINE, 1);
    expect(getBookView(SYM, b, 1, 25, EMPTY_MINE, 1)).toBe(a);
    // 另一个 BookState 对象但 version 相同(理论上不会发生,但键只看 version)也命中
    expect(getBookView(SYM, book([L(1, 1)], [], b.version), 1, 25, EMPTY_MINE, 1)).toBe(a);
  });

  it("version / step / depth / mineVersion 任一变化返回新引用,换回原键后再次重算(单槽)", () => {
    const b = book([L(100, 1)], [L(101, 1)]);
    const a = getBookView(SYM, b, 1, 25, EMPTY_MINE, 1);
    expect(getBookView(SYM, book([L(100, 1)], [L(101, 1)]), 1, 25, EMPTY_MINE, 1)).not.toBe(a);
    const c = getBookView(SYM, b, 1, 25, EMPTY_MINE, 1);
    expect(c).not.toBe(a);
    expect(getBookView(SYM, b, 5, 25, EMPTY_MINE, 1)).not.toBe(c);
    const d = getBookView(SYM, b, 5, 25, EMPTY_MINE, 1);
    expect(getBookView(SYM, b, 5, 15, EMPTY_MINE, 1)).not.toBe(d);
    const e = getBookView(SYM, b, 5, 15, EMPTY_MINE, 1);
    expect(getBookView(SYM, b, 5, 15, EMPTY_MINE, 2)).not.toBe(e);
  });

  it("每 symbol 一个槽,互不干扰;闪烁历史跨重算保留", () => {
    const b1 = book([L(100, 1)], []);
    const b2 = book([L(200, 1)], []);
    const a = getBookView(SYM, b1, 1, 25, EMPTY_MINE, 1);
    const o = getBookView("GS-REN-2020", b2, 1, 25, EMPTY_MINE, 1);
    expect(getBookView(SYM, b1, 1, 25, EMPTY_MINE, 1)).toBe(a);
    expect(getBookView("GS-REN-2020", b2, 1, 25, EMPTY_MINE, 1)).toBe(o);
    const next = getBookView(SYM, book([L(100, 2)], []), 1, 25, EMPTY_MINE, 1);
    expect(next.bids[0].flashKey).toBe(1);
  });

  it("换合并档(0.01 → 0.05 → 0.01)而盘口没动:不闪 —— 换档从全新的闪烁槽算起,两档共有的桶价不因聚合量不同而 + 1", () => {
    // 7000 与 7015 在 1 分档与 5 分档下都是桶价,但聚合量不同(5 分档把 7001..7004 并进 7000、7011..7014 并进 7015)
    const b = book(
      [L(7003, 1), L(7002, 2), L(7001, 3), L(7000, 4)],
      [L(7011, 1), L(7012, 2), L(7015, 3)],
    );
    const fine = getBookView(SYM, b, 1, 15, EMPTY_MINE, 1);
    expect(fine.bids.every((r) => r.flashKey === 0)).toBe(true);
    const coarse = getBookView(SYM, b, 5, 15, EMPTY_MINE, 1);
    expect(coarse.bids.find((r) => r.price === 7000)?.quantity).toBe(10);
    expect(coarse.asks.find((r) => r.price === 7015)?.quantity).toBe(6);
    expect([...coarse.bids, ...coarse.asks].map((r) => r.flashKey)).toEqual([0, 0]);
    const back = getBookView(SYM, b, 1, 15, EMPTY_MINE, 1);
    expect([...back.bids, ...back.asks].every((r) => r.flashKey === 0)).toBe(true);
    // 同一档内的真实变化照常闪
    const moved = getBookView(SYM, book([L(7003, 1), L(7002, 2), L(7001, 3), L(7000, 9)], [L(7011, 1), L(7012, 2), L(7015, 3)]), 1, 15, EMPTY_MINE, 1);
    expect(moved.bids.find((r) => r.price === 7000)?.flashKey).toBe(1);
    expect(moved.bids.filter((r) => r.price !== 7000).every((r) => r.flashKey === 0)).toBe(true);
  });

  it("只改深度不重置闪烁历史:深度变了、数量没变的档不闪,数量变了的照常 + 1", () => {
    const b1 = book([L(100, 1), L(99, 1)], []);
    getBookView(SYM, b1, 1, 15, EMPTY_MINE, 1);
    getBookView(SYM, book([L(100, 2), L(99, 1)], []), 1, 15, EMPTY_MINE, 1); // 100 → flashKey 1
    const deeper = getBookView(SYM, book([L(100, 2), L(99, 1)], []), 1, 25, EMPTY_MINE, 1);
    expect(deeper.bids.map((r) => r.flashKey)).toEqual([1, 0]);
  });
});

describe("minePricesOf", () => {
  it("openOrders 引用不变 → 同一结果;内容相同的新 Map → 版本不变;内容变化 → 版本 + 1", () => {
    const m1 = new Map<string, Order>([["o1", order("o1", "BUY", 1000)]]);
    const r1 = minePricesOf(SYM, m1);
    expect([...r1.mine.bids]).toEqual([1000]);
    expect(minePricesOf(SYM, m1)).toBe(r1);
    const m2 = new Map(m1);
    m2.set("x", order("x", "SELL", 999, { symbol: "OTHER" }));
    const r2 = minePricesOf(SYM, m2);
    expect(r2.version).toBe(r1.version);
    expect(r2.mine).toBe(r1.mine);
    const m3 = new Map(m2);
    m3.set("o2", order("o2", "SELL", 1010, { status: "PARTIAL" }));
    const r3 = minePricesOf(SYM, m3);
    expect(r3.version).toBe(r1.version + 1);
    expect([...r3.mine.asks]).toEqual([1010]);
  });

  it("只算本 symbol 的 OPEN / PARTIAL 限价单;市价单、已成交、已撤单不算", () => {
    const m = new Map<string, Order>([
      ["a", order("a", "BUY", 100)],
      ["b", order("b", "BUY", null)],
      ["c", order("c", "SELL", 200, { status: "FILLED" })],
      ["d", order("d", "SELL", 300, { status: "CANCELLED" })],
      ["e", order("e", "SELL", 400, { status: "PARTIAL" })],
    ]);
    const r = minePricesOf(SYM, m);
    expect([...r.mine.bids]).toEqual([100]);
    expect([...r.mine.asks]).toEqual([400]);
  });
});
