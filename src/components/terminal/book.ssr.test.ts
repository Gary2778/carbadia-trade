import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderBookLevel, TapeEntry } from "@/shared";
import { AGG_STEPS, DEPTH_OPTIONS, auditRefOf } from "@/shared";
import type { Lang } from "@/i18n/config";
import zhCN from "@/i18n/messages/zh-CN";
import { EMPTY_MINE, buildBookView, createFlashState, resetBookViewCache, type MinePrices } from "@/lib/market/book-view";
import { PREFS_KEY } from "@/lib/market/prefs";
import { createInitialState, useMarketStore, type BookState } from "@/lib/market/store";
import { BookSide, nextRovingIndex, rovingPrice } from "./BookSide";
import { DepthSelector } from "./DepthSelector";
import { OrderBookPanel, aggStepsFor, handleBookPick, resolveAgg } from "./OrderBookPanel";
import { focusAfterBookPick, tabAfterBookPick } from "./MobileTabs";
import { OrderBookRow, type OrderBookRowProps } from "./OrderBookRow";
import { SpreadBar } from "./SpreadBar";
import { TapeRow } from "./TapeRow";
import { TradesTape, newestFirst, tapePanelState } from "./TradesTape";

// §9.1 第 7 条:不引 jsdom,组件只做 renderToStaticMarkup 的服务端标记测试;交互(点价填单、Profiler 只提交变化行、
// 虚拟列表 DOM 行数)靠内置浏览器手工验收。语言按模块边界打桩成可切换的当前语言(默认 en,同 meta.ssr.test.ts),
// 断言默认按 en.ts 的文案写;需要中文的用例临时切到 zh-CN。

const i18n = vi.hoisted(() => ({ lang: "en" as Lang }));
vi.mock("@/i18n/LangProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/LangProvider")>();
  // 完整文案(核心 + terminal)直接取合并对象:useT 整个被换掉,不经 TerminalMessagesProvider(P2-01 起 @/i18n 的 MESSAGES 只有核心命名空间)。
  // 不能在这个工厂里引入 @/i18n/test-support:它经 TerminalMessages 又引入正在被替换的 LangProvider,会互相等待
  const ALL = { en: (await import("@/i18n/messages/en")).default, "zh-CN": (await import("@/i18n/messages/zh-CN")).default };
  return {
    ...actual,
    useLang: () => ({ lang: i18n.lang, setLang: () => {} }),
    useT: (ns: keyof typeof ALL.en) => ALL[i18n.lang][ns],
  };
});
// 「组件 prop 不得叫 ref」由 tokens-only.test.ts 对整个 components/terminal 目录做静态扫描,这里不重复。

const count = (html: string, needle: string) => html.split(needle).length - 1;
const L = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const ladder = (from: number, step: number, n: number): OrderBookLevel[] => Array.from({ length: n }, (_, i) => L(from + i * step, 10 + i, 1 + (i % 3)));
let version = 0;
const book = (bids: OrderBookLevel[], asks: OrderBookLevel[]): BookState => ({
  bids: new Map(bids.map((l) => [l.price, l] as const)),
  asks: new Map(asks.map((l) => [l.price, l] as const)),
  seq: 1,
  version: ++version,
  ts: 1,
});
const mine = (bids: number[] = [], asks: number[] = []): MinePrices => ({ bids: new Set(bids), asks: new Set(asks) });
const noop = () => {};

// 30 档买盘(7000 往下)、30 档卖盘(7010 往上),原始 tick = 1 分
const BOOK = () => book(ladder(7000, -1, 30), ladder(7010, 1, 30));
/** 行标记里的价格文本,按出现顺序 */
const pricesIn = (html: string) => [...html.matchAll(/data-price="(\d+)"/g)].map((m) => Number(m[1]));

beforeEach(() => {
  resetBookViewCache();
  i18n.lang = "en";
});

describe("BookSide", () => {
  it("renders exactly depth rows per side (buildBookView truncates, BookSide renders what it is given)", () => {
    for (const depth of DEPTH_OPTIONS) {
      const view = buildBookView(BOOK(), EMPTY_MINE, 1, depth);
      const bids = renderToStaticMarkup(createElement(BookSide, { side: "BUY", rows: view.bids, precision: 2, onPick: noop }));
      const asks = renderToStaticMarkup(createElement(BookSide, { side: "SELL", rows: view.asks, precision: 2, onPick: noop }));
      expect(count(bids, "data-book-row")).toBe(Math.min(depth, 30));
      expect(count(asks, "data-book-row")).toBe(Math.min(depth, 30));
    }
  });

  it("draws bids best-first from the top and asks best-last so both best prices sit against the spread bar", () => {
    const view = buildBookView(BOOK(), EMPTY_MINE, 1, 15);
    const bids = pricesIn(renderToStaticMarkup(createElement(BookSide, { side: "BUY", rows: view.bids, precision: 2, onPick: noop })));
    const asks = pricesIn(renderToStaticMarkup(createElement(BookSide, { side: "SELL", rows: view.asks, precision: 2, onPick: noop })));
    expect(bids[0]).toBe(7000);
    expect(bids.at(-1)).toBe(6986);
    expect(asks[0]).toBe(7024);
    expect(asks.at(-1)).toBe(7010);
  });

  it("marks the aggregated level that holds the user's own order with data-mine, per side", () => {
    // 自家买单 6995 与卖单 7013;按 0.05 聚合后分别落进 6995 与 7015 两档
    const view = buildBookView(BOOK(), mine([6995], [7013]), 5, 15);
    const bids = renderToStaticMarkup(createElement(BookSide, { side: "BUY", rows: view.bids, precision: 2, onPick: noop }));
    const asks = renderToStaticMarkup(createElement(BookSide, { side: "SELL", rows: view.asks, precision: 2, onPick: noop }));
    expect(count(bids, "data-mine")).toBe(1);
    expect(bids).toMatch(/<li[^>]*data-price="6995"[^>]*data-mine=""/);
    expect(count(asks, "data-mine")).toBe(1);
    expect(asks).toMatch(/<li[^>]*data-price="7015"[^>]*data-mine=""/);
    expect(bids).toContain("Includes your order");
  });

  it("gives every row a transform: scaleX depth bar in the side's soft colour", () => {
    const view = buildBookView(book([L(7000, 5), L(6990, 5)], [L(7010, 1), L(7020, 3)]), EMPTY_MINE, 1, 15);
    const bids = renderToStaticMarkup(createElement(BookSide, { side: "BUY", rows: view.bids, precision: 2, onPick: noop }));
    const asks = renderToStaticMarkup(createElement(BookSide, { side: "SELL", rows: view.asks, precision: 2, onPick: noop }));
    expect(bids).toContain("transform:scaleX(0.5)");
    expect(bids).toContain("transform:scaleX(1)");
    expect(count(bids, "t-depth-bar bg-up-soft")).toBe(2);
    expect(asks).toContain("transform:scaleX(0.25)");
    expect(count(asks, "t-depth-bar bg-down-soft")).toBe(2);
  });

  it("is one Tab stop per side (roving tabindex): only the best price row has tabindex 0, the rest -1", () => {
    // 深度 50 时每侧最多 50 个按钮;键盘用户不该要 Tab 过整本盘口才到下单面板
    const view = buildBookView(BOOK(), EMPTY_MINE, 1, 50);
    const bids = renderToStaticMarkup(createElement(BookSide, { side: "BUY", rows: view.bids, precision: 2, onPick: noop }));
    const asks = renderToStaticMarkup(createElement(BookSide, { side: "SELL", rows: view.asks, precision: 2, onPick: noop }));
    for (const html of [bids, asks]) {
      expect(count(html, 'tabindex="0"')).toBe(1);
      expect(count(html, 'tabindex="-1"')).toBe(29);
    }
    // 默认停在贴着中缝的最优价:买一 7000(买盘第一行)、卖一 7010(卖盘最后一行)
    expect(bids).toMatch(/data-price="7000"[^>]*><button[^>]*tabindex="0"/);
    expect(asks).toMatch(/data-price="7010"[^>]*><button[^>]*tabindex="0"/);
  });
});

describe("roving tabindex helpers", () => {
  const rows = buildBookView(BOOK(), EMPTY_MINE, 1, 15).bids;

  it("rovingPrice: the last focused row while it is still in the book, else the best price, null for an empty side", () => {
    expect(rovingPrice(rows, 6995)).toBe(6995);
    expect(rovingPrice(rows, null)).toBe(7000);
    expect(rovingPrice(rows, 1234)).toBe(7000); // 那一档已经没了(成交 / 撤单 / 换档)
    expect(rovingPrice([], 7000)).toBeNull();
  });

  it("nextRovingIndex: ↑ / ↓ one row in DOM order, Home / End to the ends, clamped; other keys are not handled", () => {
    expect(nextRovingIndex("ArrowDown", 3, 10)).toBe(4);
    expect(nextRovingIndex("ArrowUp", 3, 10)).toBe(2);
    expect(nextRovingIndex("ArrowUp", 0, 10)).toBe(0);
    expect(nextRovingIndex("ArrowDown", 9, 10)).toBe(9);
    expect(nextRovingIndex("Home", 5, 10)).toBe(0);
    expect(nextRovingIndex("End", 5, 10)).toBe(9);
    for (const key of ["Enter", " ", "Tab", "ArrowLeft", "a"]) expect(nextRovingIndex(key, 3, 10), key).toBeNull();
    expect(nextRovingIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("OrderBookRow", () => {
  const row = (over: Partial<OrderBookRowProps> = {}) =>
    renderToStaticMarkup(
      createElement(OrderBookRow, {
        price: 7037,
        quantity: 1250,
        cum: 3400,
        pct: 0.4,
        orders: 3,
        mine: false,
        flashKey: 0,
        precision: 2,
        side: "SELL",
        tabbable: false,
        onPick: noop,
        ...over,
      }),
    );

  it("is a keyboard-reachable button (click and Enter both pick the price) with formatted price, qty, cum and orders", () => {
    const html = row();
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("70.37");
    expect(html).toContain("1,250");
    expect(html).toContain("3,400");
    expect(html).toContain('aria-label="Price 70.37 · Qty (t) 1,250 · Cum. 3,400 · Orders 3"');
    expect(html).not.toContain("data-mine");
  });

  it("formats quantity and cumulative by the instrument's qtyStep (default 1 = whole tonnes)", () => {
    expect(row({ qtyStep: 0.1 })).toContain("1,250.0");
    expect(row({ qtyStep: 0.1 })).toContain("3,400.0");
    expect(row({ qtyStep: 0.1 })).toContain("Qty (t) 1,250.0 · Cum. 3,400.0");
    expect(row()).not.toContain("1,250.0");
  });

  it("takes part in the side's roving tabindex (tabbable → 0, otherwise -1)", () => {
    expect(row({ tabbable: true })).toMatch(/<button[^>]*tabindex="0"/);
    expect(row({ tabbable: false })).toMatch(/<button[^>]*tabindex="-1"/);
  });

  it("colours the price by side (asks down, bids up) with the book's own direction tokens, which follow the up/down axis", () => {
    expect(row({ side: "SELL" })).toContain("text-(--terminal-book-down)");
    expect(row({ side: "BUY" })).toContain("text-(--terminal-book-up)");
    // 深度条会盖到价格列:盘口不用站点的 --up / --down(浅色在深度条上不到 AA,见 contrast.test.ts)
    expect(row({ side: "SELL" })).not.toMatch(/\btext-(up|down)\b/);
    expect(row({ side: "BUY" })).not.toMatch(/\btext-(up|down)\b/);
  });

  it("renders no flash on first appearance (flashKey 0) and a side-coloured flash span once the quantity changed", () => {
    expect(row({ flashKey: 0 })).not.toMatch(/flash-(up|down)/);
    expect(row({ flashKey: 2, side: "SELL" })).toContain("t-row-flash flash-down");
    expect(row({ flashKey: 1, side: "BUY" })).toContain("t-row-flash flash-up");
  });

  it("flashKey from buildBookView increments when an aggregated level's quantity changes", () => {
    const flash = createFlashState();
    buildBookView(book([L(7000, 5)], [L(7010, 1)]), EMPTY_MINE, 1, 15, flash);
    const next = buildBookView(book([L(7000, 8)], [L(7010, 1)]), EMPTY_MINE, 1, 15, flash);
    expect(next.bids[0].flashKey).toBe(1);
    expect(next.asks[0].flashKey).toBe(0);
    const html = renderToStaticMarkup(createElement(BookSide, { side: "BUY", rows: next.bids, precision: 2, onPick: noop }));
    expect(html).toContain("flash-up");
  });
});

describe("SpreadBar", () => {
  it("shows last price, absolute spread and spread in basis points", () => {
    // bid 70.00 / ask 70.10:abs 10 分,中间价 7005 → 10 / 7005 × 10000 ≈ 14.3 bps
    const html = renderToStaticMarkup(createElement(SpreadBar, { bestBid: 7000, bestAsk: 7010, lastPrice: 7005, precision: 2 }));
    expect(html).toContain("70.05");
    expect(html).toContain("Spread");
    expect(html).toContain("0.10");
    expect(html).toContain(">14.3 bps<");
    expect(html).not.toContain("‱");
  });

  it("writes the basis-point unit from terminal.book.bps (基点 in zh-CN)", () => {
    i18n.lang = "zh-CN";
    const html = renderToStaticMarkup(createElement(SpreadBar, { bestBid: 7000, bestAsk: 7010, lastPrice: 7005, precision: 2 }));
    expect(html).toContain(`>14.3 ${zhCN.terminal.book.bps}<`);
    expect(zhCN.terminal.book.bps).toBe("基点");
    expect(html).not.toContain("bps");
  });

  it("shows em dashes when a side or the last price is missing", () => {
    const html = renderToStaticMarkup(createElement(SpreadBar, { bestBid: null, bestAsk: 7010, lastPrice: null, precision: 2 }));
    expect(count(html, "—")).toBe(2);
    expect(html).not.toContain("bps");
  });
});

describe("DepthSelector", () => {
  it("offers AGG_STEPS × tickSize and DEPTH_OPTIONS with the current values selected", () => {
    const steps = aggStepsFor(5);
    expect(steps).toEqual(AGG_STEPS.map((s) => s * 5));
    const html = renderToStaticMarkup(createElement(DepthSelector, { steps, value: 25, depth: 25, onChange: noop }));
    expect(count(html, "<option")).toBe(steps.length + DEPTH_OPTIONS.length);
    expect(html).toContain("0.05");
    expect(html).toContain("5.00");
    expect(html).toMatch(/<option value="25" selected="">0\.25<\/option>/);
    expect(html).toMatch(/<option value="25" selected="">25<\/option>/);
    expect(html).toContain("Aggregate");
    expect(html).toContain("Depth");
  });

  it("resolveAgg falls back to tickSize when the stored step is missing or not offered for this instrument", () => {
    const steps = aggStepsFor(1);
    expect(resolveAgg(null, steps)).toBe(1);
    expect(resolveAgg(10, steps)).toBe(10);
    expect(resolveAgg(7, steps)).toBe(1);
    expect(resolveAgg(10, aggStepsFor(5))).toBe(5);
  });
});

describe("TapeRow", () => {
  const entry = (over: Partial<TapeEntry> = {}): TapeEntry => ({
    id: "trd_1",
    symbol: "VCS-FOR-2021",
    price: 7037,
    quantity: 12,
    takerSide: "BUY",
    ts: Date.UTC(2026, 8, 28, 9, 30, 5),
    auditRef: auditRefOf("trd_1"),
    ...over,
  });
  const render = (e: TapeEntry, qtyStep?: number) =>
    renderToStaticMarkup(createElement(TapeRow, { price: e.price, quantity: e.quantity, takerSide: e.takerSide, ts: e.ts, auditRef: e.auditRef, precision: 2, qtyStep }));

  it("carries the SIM-TRD audit reference and the simulated-trade note in its tooltip", () => {
    const html = render(entry());
    expect(html).toContain("SIM-TRD-trd_1");
    expect(html).toContain("Simulated trade reference, not a registry record");
    expect(html).toMatch(/title="Audit ref SIM-TRD-trd_1/);
  });

  it("also gives screen-reader users the audit reference with its note (a title on a non-focusable row is never announced)", () => {
    const html = render(entry());
    expect(html).toMatch(/<span class="sr-only">[^<]*Audit ref SIM-TRD-trd_1[^<]*Simulated trade reference, not a registry record[^<]*<\/span>/);
  });

  it("formats the quantity by the instrument's qtyStep (default whole tonnes)", () => {
    expect(render(entry({ quantity: 1250 }))).toContain(">1,250<");
    expect(render(entry({ quantity: 1250 }), 0.1)).toContain(">1,250.0<");
  });

  it("colours the price by taker side and names the side for screen readers", () => {
    const buy = render(entry({ takerSide: "BUY" }));
    const sell = render(entry({ takerSide: "SELL" }));
    expect(buy).toContain("text-(--terminal-up)");
    expect(buy).toContain("Buy");
    expect(sell).toContain("text-(--terminal-down)");
    expect(sell).toContain("Sell");
    expect(buy).toContain("70.37");
    expect(buy).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

describe("TradesTape helpers", () => {
  it("tapePanelState: a tape → list; no tape but the trades snapshot arrived (even empty) → empty; else error when offline, skeleton otherwise", () => {
    expect(tapePanelState(true, true, false)).toBe("list");
    expect(tapePanelState(true, false, true)).toBe("list"); // 已有数据时断线照常显示最后的数据
    expect(tapePanelState(false, true, false)).toBe("empty");
    expect(tapePanelState(false, true, true)).toBe("empty");
    expect(tapePanelState(false, false, true)).toBe("error");
    expect(tapePanelState(false, false, false)).toBe("loading");
  });

  it("newestFirst returns the tape newest → oldest without touching the store array", () => {
    const tape = [1, 2, 3].map((i) => ({ id: `t${i}` }) as TapeEntry);
    const out = newestFirst(tape);
    expect(out.map((e) => e.id)).toEqual(["t3", "t2", "t1"]);
    expect(tape.map((e) => e.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("panels on the server (store is empty during SSR: skeletons, never store writes)", () => {
  it("OrderBookPanel renders the title, the aggregation / depth controls and a skeleton", () => {
    const html = renderToStaticMarkup(createElement(OrderBookPanel, { symbol: "VCS-FOR-2021" }));
    expect(html).toContain('data-area="book"');
    expect(html).toContain("Order book");
    expect(html).toContain("<select");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("data-book-row");
  });

  describe("with a stored depth preference", () => {
    // 同 prefs.test.ts 的 fakeStorage:localStorage 里存着 depth 50,服务端快照仍是默认 15(usePrefs 的 getServerSnapshot)。
    // 经属性描述符换掉再还原:不读 Node 自带的 localStorage 访问器(读它会打一条 --localstorage-file 的实验性警告)
    let saved: PropertyDescriptor | undefined;
    beforeEach(() => {
      saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
      const map = new Map<string, string>([[PREFS_KEY, JSON.stringify({ depth: 50 })]]);
      const fake = {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
          return map.size;
        },
      } as Storage;
      Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true, writable: true });
    });
    afterEach(() => {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    });

    it("OrderBookPanel's depth select starts at the prefs default (15) on the server, whatever localStorage holds", () => {
      expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ depth: 50 });
      const html = renderToStaticMarkup(createElement(OrderBookPanel, { symbol: "VCS-FOR-2021" }));
      expect(html).toMatch(/<option value="15" selected="">15<\/option>/);
      expect(html).toMatch(/<option value="50">50<\/option>/);
      expect(html).not.toMatch(/<option value="50" selected="">/);
    });
  });

  it("TradesTape renders the title and a skeleton", () => {
    const html = renderToStaticMarkup(createElement(TradesTape, { symbol: "VCS-FOR-2021" }));
    expect(html).toContain('data-area="tape"');
    expect(html).toContain("Trades");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("SIM-TRD");
  });
});

// P1-25d 终审修复:手机(< 48rem)上盘口与下单框在不同页签,点价后原来什么也不变(种子要等用户自己切到下单页签才被消费)。
// 点价动作写对手方草稿后通知壳层;壳层在手机布局下切到「下单」页签(页签切换本身就是可见反馈,价格已带入)。
describe("book price pick (mobile switches to the order tab)", () => {
  beforeEach(() => useMarketStore.setState(createInitialState()));

  it("writes the opposite-side draft with the picked price, then notifies the caller once", () => {
    const picked = vi.fn();
    handleBookPick("VCS-FOR-2021", "SELL", 7010, picked);
    expect(useMarketStore.getState().draft).toMatchObject({ symbol: "VCS-FOR-2021", side: "BUY", price: 7010, nonce: 1 });
    expect(picked).toHaveBeenCalledTimes(1);
    handleBookPick("VCS-FOR-2021", "BUY", 7000, picked);
    expect(useMarketStore.getState().draft).toMatchObject({ symbol: "VCS-FOR-2021", side: "SELL", price: 7000, nonce: 2 });
    expect(picked).toHaveBeenCalledTimes(2);
  });

  it("works without a listener (desktop and tablet keep the form beside the book)", () => {
    handleBookPick("VCS-FOR-2021", "SELL", 7010);
    expect(useMarketStore.getState().draft).toMatchObject({ side: "BUY", price: 7010 });
  });

  it("switches to the order tab only in the mobile layout", () => {
    expect(tabAfterBookPick("mobile")).toBe("order");
    expect(tabAfterBookPick("tablet")).toBeNull();
    expect(tabAfterBookPick("desktop")).toBeNull();
  });

  // 终审复核:MobileTabs 只挂载激活页签,切过去时刚被激活的盘口行随面板卸载,焦点掉到 <body>(读屏与 400% 缩放的键盘用户丢位置)。
  // 切了页签就把焦点交给选中的页签按钮(念「下单,页签,已选中」;不是价格框 —— input 会弹软键盘);焦点原本在面板外就不抢。
  it("hands focus to the selected tab when the pick unmounts the focused row (or focus was already on <body>)", () => {
    expect(focusAfterBookPick("order", "inPanel")).toBe("selectedTab");
    expect(focusAfterBookPick("order", "body")).toBe("selectedTab");
    expect(focusAfterBookPick("order", "elsewhere")).toBeNull();
    // 平板 / 桌面不切页签,盘口行还在,焦点不动
    for (const focus of ["inPanel", "body", "elsewhere"] as const) expect(focusAfterBookPick(tabAfterBookPick("desktop"), focus)).toBeNull();
  });
});
