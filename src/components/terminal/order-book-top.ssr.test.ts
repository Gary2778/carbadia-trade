import { createElement } from "react";
import { renderToStaticMarkup } from "@/i18n/test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Instrument, OrderBookLevel } from "@/shared";
import { bookTopOf } from "@/lib/market/order-draft";
import { useBookTop } from "@/lib/market/selectors";
import { createInitialState, type BookState, type MarketState } from "@/lib/market/store";
import { OrderPanel } from "./OrderPanel";

// 计划 §7.1「盘口更新时 OrderPanel 零提交」、§9.1 第 45 条(P2-08)。node 环境没有 DOM 渲染器,数不了重渲染次数;
// 这里钉的是重渲染的来源:渲染期挂在市场 store 上的每一个 selector(useSyncExternalStore 的快照函数)。
// 在模块边界给 useMarketStore 包一层,记下下单面板渲染时交给它的全部 selector,再拿两份「只有盘口顶档不同」的状态去喂:
// 每个 selector 两次的结果都 Object.is 相等 ⇒ 顶档怎么动,React 都不会因为这些订阅重渲染下单面板。
// (不经渲染的那一路 —— store.subscribe → bookTopWatcher → refreshChanges —— 在 order-draft.test.ts;浏览器里的提交统计在 docs/perf-report.md。)
type Selector = (state: MarketState) => unknown;
const probe = vi.hoisted(() => ({ selectors: [] as Selector[] }));
vi.mock("@/lib/market/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/market/store")>();
  const hook = (selector: Selector) => {
    probe.selectors.push(selector);
    return real.useMarketStore(selector);
  };
  // zustand 的 hook 本身带着 getState / setState / subscribe / getInitialState:原样挂回去
  return { ...real, useMarketStore: Object.assign(hook, real.useMarketStore) };
});

// 下单表单用 useRouter(toast 动作做客户端导航);App Router 之外没有上下文,同 order.ssr.test.ts
vi.mock("next/navigation", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/navigation")>();
  return { ...real, useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }) };
});

afterEach(() => {
  probe.selectors.length = 0;
});

const SYMBOL = "VCS-FOR-2021";
const instrument: Instrument = {
  id: "asset-1",
  symbol: SYMBOL,
  name: "Forest 2021",
  standard: "VCS",
  projectType: "Forestry",
  vintage: 2021,
  country: "Brazil",
  registry: "Verra",
  isScenario: false,
  projectId: null,
  methodology: null,
  verificationStatus: null,
  tickSize: 5,
  pricePrecision: 2,
  qtyStep: 1,
  minQty: 1,
  currency: "USD",
  lastPrice: 10_000,
};
const lvl = (price: number, quantity: number): OrderBookLevel => ({ price, quantity, orders: 1 });
const book = (asks: OrderBookLevel[], bids: OrderBookLevel[], version: number): BookState => ({
  asks: new Map(asks.map((l) => [l.price, l])),
  bids: new Map(bids.map((l) => [l.price, l])),
  seq: version,
  version,
  ts: version,
});
/** 两份状态只差盘口:卖一 100.05 → 100.10、买一 99.95 → 99.90(别的切片是同一批引用,与 store 的结构共享一致) */
const base: MarketState = { ...createInitialState(), instruments: { [SYMBOL]: instrument } };
const before: MarketState = { ...base, books: { [SYMBOL]: book([lvl(10_005, 30), lvl(10_010, 50)], [lvl(9_995, 40), lvl(9_990, 100)], 1) } };
const after: MarketState = { ...base, books: { [SYMBOL]: book([lvl(10_010, 50)], [lvl(9_990, 100)], 2) } };

/** 同一个 selector 先后喂两份状态,结果是不是同一个(Object.is;useShallow 包过的 selector 浅相等时返回上一次的引用) */
const unchanged = (selector: Selector): boolean => Object.is(selector(before), selector(after));

describe("下单面板渲染期的市场 store 订阅", () => {
  it("两份状态的顶档确实不同(否则下面的断言是空转)", () => {
    expect(bookTopOf(before.books[SYMBOL])).toEqual({ bestBid: 9_995, bestAsk: 10_005 });
    expect(bookTopOf(after.books[SYMBOL])).toEqual({ bestBid: 9_990, bestAsk: 10_010 });
  });

  it("阳性对照:订阅顶档的 selector(改动前面板用的 useBookTop)会被这套办法记下,并且随顶档变", () => {
    const Probe = () => {
      useBookTop(SYMBOL);
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(probe.selectors).toHaveLength(1);
    expect(unchanged(probe.selectors[0])).toBe(false);
  });

  it("下单面板(表单)渲染时挂上的 selector 没有一个随盘口顶档变:顶档变化时面板零提交", () => {
    for (const initialSide of [undefined, "SELL"] as const) {
      probe.selectors.length = 0;
      const html = renderToStaticMarkup(createElement(OrderPanel, { symbol: SYMBOL, initialSide }));
      expect(html).toContain("<form");
      // 扫到了订阅(标的、草稿种子、校验结果),不是空转
      expect(probe.selectors.length).toBeGreaterThanOrEqual(3);
      expect(probe.selectors.map(unchanged)).toEqual(probe.selectors.map(() => true));
    }
  });
});
