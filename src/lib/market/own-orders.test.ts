import { beforeEach, describe, expect, it } from "vitest";
import type { Me } from "@/shared";
import { createInitialAccountState, setMe, useAccountStore } from "./account-store";
import { OWN_ORDERS_MAX, clearOwnOrders, isOwnOrder, rememberOwnOrder } from "./own-orders";

// 这个标签页自己提交的订单 id 的有界登记:通知 Toast 据此跳过 taker 成交。
const alice: NonNullable<Me> = { id: "u-alice", email: "alice@example.com", name: "Alice", cashBalance: 100_000_00, lockedCash: 0, unreadNotices: 0 };
const bob: NonNullable<Me> = { id: "u-bob", email: "bob@example.com", name: "Bob", cashBalance: 50_000_00, lockedCash: 0, unreadNotices: 0 };

beforeEach(() => {
  useAccountStore.setState(createInitialAccountState(), true);
  clearOwnOrders();
});

describe("own orders", () => {
  it("knows the ids it was given and nothing else", () => {
    rememberOwnOrder("o-1");
    expect(isOwnOrder("o-1")).toBe(true);
    expect(isOwnOrder("o-2")).toBe(false);
    clearOwnOrders();
    expect(isOwnOrder("o-1")).toBe(false);
  });

  it(`keeps the newest ${OWN_ORDERS_MAX} and forgets the oldest first; remembering an id again makes it the newest`, () => {
    rememberOwnOrder("first");
    for (let i = 0; i < OWN_ORDERS_MAX - 1; i++) rememberOwnOrder(`o-${i}`);
    expect(isOwnOrder("first")).toBe(true);
    rememberOwnOrder("first"); // 刷新:成为最新
    rememberOwnOrder("one-more");
    expect(isOwnOrder("first")).toBe(true);
    expect(isOwnOrder("o-0")).toBe(false);
    expect(isOwnOrder("one-more")).toBe(true);
  });

  it("belongs to the signed-in user: a user switch or a logout (the account reset) empties it, a re-hydrate of the same user does not", () => {
    setMe(alice);
    rememberOwnOrder("o-alice");
    setMe({ ...alice, cashBalance: 1 }); // 同一个人刷新:保留
    expect(isOwnOrder("o-alice")).toBe(true);
    setMe(bob);
    expect(isOwnOrder("o-alice")).toBe(false);
    rememberOwnOrder("o-bob");
    setMe(null);
    expect(isOwnOrder("o-bob")).toBe(false);
  });
});
