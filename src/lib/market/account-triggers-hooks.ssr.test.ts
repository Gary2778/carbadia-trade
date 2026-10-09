import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Trigger } from "@/shared";
import { createInitialAccountState, openTriggersOf, useOpenTriggers, useOpenTriggersFor, type AccountState } from "./account-store";

// useOpenTriggers / useOpenTriggersFor 的引用稳定性(node 环境没有 DOM 渲染器,数不了重渲染次数,同 order-book-top.ssr.test.ts 的办法):
// 渲染一次,记下 useShallow 交出来的 selector(也就是 useSyncExternalStore 的快照函数),再拿几份状态依次喂它 ——
// 元素没变时结果 Object.is 相等 ⇒ React 不会因为这个订阅重渲染;元素变了结果才换。
type Selector = (state: AccountState) => unknown;
const probe = vi.hoisted(() => ({ selectors: [] as Selector[] }));
vi.mock("zustand/react/shallow", async (importOriginal) => {
  const real = await importOriginal<typeof import("zustand/react/shallow")>();
  const useShallow = <S, U>(selector: (state: S) => U): ((state: S) => U) => {
    const wrapped = real.useShallow(selector);
    probe.selectors.push(wrapped as unknown as Selector);
    return wrapped;
  };
  return { ...real, useShallow };
});

const trigger = (id: string, over: Partial<Trigger> = {}): Trigger => ({
  id,
  kind: "ORDER",
  assetId: "a-vcs",
  symbol: "VCS-FOR-2021",
  direction: "ABOVE",
  triggerPrice: 7200,
  side: "SELL",
  orderType: "MARKET",
  limitPrice: null,
  quantity: 5,
  ocoGroupId: null,
  status: "PENDING",
  reason: null,
  orderId: null,
  firedPrice: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  firedAt: null,
  ...over,
});
const stateOf = (rows: Trigger[], over: Partial<AccountState> = {}): AccountState => ({ ...createInitialAccountState(), openTriggers: new Map(rows.map((t) => [t.id, t])), ...over });

function selectorsOf(): { all: Selector; forVcs: Selector } {
  probe.selectors.length = 0;
  const Probe = () => {
    useOpenTriggers();
    useOpenTriggersFor("VCS-FOR-2021");
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  expect(probe.selectors).toHaveLength(2);
  const [all, forVcs] = probe.selectors;
  return { all, forVcs };
}

describe("useOpenTriggers / useOpenTriggersFor: stable references", () => {
  const a = trigger("t-a", { createdAt: 1_000 });
  const b = trigger("t-b", { createdAt: 2_000 });
  const other = trigger("t-gs", { symbol: "GS-REN-2020", assetId: "a-gs", createdAt: 3_000 });

  it("positive control: the bare selection function builds a new array every call, so stability comes from the hooks' useShallow", () => {
    const rows = stateOf([a, b]).openTriggers;
    expect(openTriggersOf(rows)).toEqual(openTriggersOf(rows));
    expect(Object.is(openTriggersOf(rows), openTriggersOf(rows))).toBe(false);
  });

  it("the same rows give the same array, even when the Map or the whole state object is new", () => {
    const { all, forVcs } = selectorsOf();
    const first = all(stateOf([a, b]));
    expect((first as Trigger[]).map((t) => t.id)).toEqual(["t-b", "t-a"]);
    expect(Object.is(all(stateOf([a, b])), first)).toBe(true);
    expect(Object.is(all(stateOf([b, a])), first)).toBe(true); // 插入顺序不同,排序后元素相同
    const firstFor = forVcs(stateOf([a, b]));
    expect(Object.is(forVcs(stateOf([a, b])), firstFor)).toBe(true);
  });

  it("another slice changing (balance, orders, fills) does not change them", () => {
    const { all, forVcs } = selectorsOf();
    const base = stateOf([a, b]);
    const first = all(base);
    const firstFor = forVcs(base);
    const moved = { ...base, balance: { cashBalance: 5, lockedCash: 1 }, recentFills: [], openOrders: new Map() };
    expect(Object.is(all(moved), first)).toBe(true);
    expect(Object.is(forVcs(moved), firstFor)).toBe(true);
  });

  it("a row appearing, disappearing or changing gives a new array", () => {
    const { all } = selectorsOf();
    const first = all(stateOf([a]));
    const added = all(stateOf([a, b]));
    expect(Object.is(added, first)).toBe(false);
    expect((added as Trigger[]).map((t) => t.id)).toEqual(["t-b", "t-a"]);
    const changed = all(stateOf([a, trigger("t-b", { status: "TRIGGERING", updatedAt: 2_500, createdAt: 2_000 })]));
    expect(Object.is(changed, added)).toBe(false);
    const removed = all(stateOf([b]));
    expect(Object.is(removed, changed)).toBe(false);
    expect((removed as Trigger[]).map((t) => t.id)).toEqual(["t-b"]);
  });

  it("the per-symbol list ignores rows of other symbols: its reference only moves with its own symbol's rows", () => {
    const { forVcs } = selectorsOf();
    const first = forVcs(stateOf([a, b]));
    expect(Object.is(forVcs(stateOf([a, b, other])), first)).toBe(true);
    expect((first as Trigger[]).map((t) => t.id)).toEqual(["t-b", "t-a"]);
    expect(Object.is(forVcs(stateOf([a])), first)).toBe(false);
  });

  it("no rows: an empty array (and the same one again)", () => {
    const { all, forVcs } = selectorsOf();
    const empty = all(stateOf([]));
    expect(empty).toEqual([]);
    expect(Object.is(all(stateOf([])), empty)).toBe(true);
    expect(forVcs(stateOf([other]))).toEqual([]);
  });
});
