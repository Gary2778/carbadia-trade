import { describe, expect, it } from "vitest";
import { MAX_NOTIONAL_CENTS as LIB_MAX_NOTIONAL, MAX_PRICE_CENTS as LIB_MAX_PRICE } from "../lib/exchange/limits";
import {
  MAX_NOTIONAL_CENTS,
  MAX_PRICE_CENTS,
  amountFromQty,
  clampQty,
  qtyFromAmount,
  qtyFromPercent,
  roundToStep,
  roundToTick,
  validateDraft,
  type DraftAvail,
  type DraftInstrument,
  type OrderDraft,
} from "./order-math";
import type { DraftError } from "./types";

const instrument: DraftInstrument = { id: "asset-1", tickSize: 5, qtyStep: 10, minQty: 10 };
const avail: DraftAvail = { cashCents: 1_000_000, qty: 500, bestBid: 9_995, bestAsk: 10_005 };
const limitBuy: OrderDraft = { side: "BUY", type: "LIMIT", price: 10_000, quantity: 50 };

describe("护栏常量与 lib/exchange/limits.ts 同值", () => {
  it("MAX_PRICE_CENTS / MAX_NOTIONAL_CENTS 两边相等", () => {
    expect(MAX_PRICE_CENTS).toBe(LIB_MAX_PRICE);
    expect(MAX_NOTIONAL_CENTS).toBe(LIB_MAX_NOTIONAL);
  });
});

describe("roundToTick", () => {
  it("BUY 向下、SELL 向上取整到 tick", () => {
    expect(roundToTick(1_003, 5, "BUY")).toBe(1_000);
    expect(roundToTick(1_003, 5, "SELL")).toBe(1_005);
    expect(roundToTick(1_000, 5, "BUY")).toBe(1_000);
  });

  it("tick 为 1 时整数原样、小数取整", () => {
    expect(roundToTick(1_050.7, 1, "BUY")).toBe(1_050);
    expect(roundToTick(1_050.2, 1, "SELL")).toBe(1_051);
  });

  it("结果不足 1 tick 或输入非有限返回 null", () => {
    expect(roundToTick(3, 5, "BUY")).toBeNull();
    expect(roundToTick(0, 1, "SELL")).toBeNull();
    expect(roundToTick(NaN, 1, "BUY")).toBeNull();
    expect(roundToTick(Infinity, 1, "SELL")).toBeNull();
  });

  it("非法 tick 按 1", () => {
    expect(roundToTick(1_234, 0, "BUY")).toBe(1_234);
    expect(roundToTick(1_234, -5, "SELL")).toBe(1_234);
  });
});

describe("roundToStep / clampQty", () => {
  it("roundToStep 向下取整;0 合法;负数与非有限为 null", () => {
    expect(roundToStep(57, 10)).toBe(50);
    expect(roundToStep(0, 10)).toBe(0);
    expect(roundToStep(-1, 10)).toBeNull();
    expect(roundToStep(NaN, 10)).toBeNull();
  });

  it("clampQty 取整到 step,低于 minQty 抬到 ≥ minQty 的最小 step 倍数", () => {
    expect(clampQty(57, 10, 10)).toBe(50);
    expect(clampQty(3, 10, 10)).toBe(10);
    expect(clampQty(0, 15, 10)).toBe(20);
    expect(clampQty(NaN, 10, 10)).toBeNull();
  });
});

describe("qtyFromAmount / amountFromQty", () => {
  it("向下取整到 qtyStep", () => {
    expect(qtyFromAmount(1_000_000, 10_005, 10)).toBe(90); // 99.95 吨 → 99 → 90
    expect(qtyFromAmount(1_000_000, 10_005, 1)).toBe(99);
  });

  it("除零、负金额、非有限返回 null;不足一步返回 0", () => {
    expect(qtyFromAmount(1_000, 0, 1)).toBeNull();
    expect(qtyFromAmount(1_000, -5, 1)).toBeNull();
    expect(qtyFromAmount(-1, 100, 1)).toBeNull();
    expect(qtyFromAmount(NaN, 100, 1)).toBeNull();
    expect(qtyFromAmount(50, 100, 1)).toBe(0);
  });

  it("金额超 MAX_NOTIONAL 返回 null,恰好等于则合法", () => {
    expect(qtyFromAmount(MAX_NOTIONAL_CENTS + 1, 100, 1)).toBeNull();
    expect(qtyFromAmount(MAX_NOTIONAL_CENTS, 100, 1)).toBe(MAX_NOTIONAL_CENTS / 100);
  });

  it("amountFromQty 相乘,非整数 / 负数 / 超上限为 null", () => {
    expect(amountFromQty(50, 10_000)).toBe(500_000);
    expect(amountFromQty(0, 10_000)).toBe(0);
    expect(amountFromQty(1.5, 10_000)).toBeNull();
    expect(amountFromQty(-1, 10_000)).toBeNull();
    expect(amountFromQty(10, 0)).toBeNull();
    expect(amountFromQty(MAX_NOTIONAL_CENTS / 100 + 1, 100)).toBeNull();
  });
});

describe("qtyFromPercent", () => {
  it("BUY 按现金 × pct 在给定价下的吨数,取整到 step", () => {
    expect(qtyFromPercent(50, "BUY", { cashCents: 1_000_000, qty: 500 }, 10_000, 10)).toBe(50);
    expect(qtyFromPercent(100, "BUY", { cashCents: 1_000_000, qty: 500 }, 10_005, 10)).toBe(90);
    expect(qtyFromPercent(0, "BUY", { cashCents: 1_000_000, qty: 500 }, 10_000, 10)).toBe(0);
  });

  it("SELL 按持仓 × pct,忽略价格", () => {
    expect(qtyFromPercent(25, "SELL", { cashCents: 0, qty: 500 }, null, 10)).toBe(120); // 125 → 120
    expect(qtyFromPercent(100, "SELL", { cashCents: 0, qty: 7 }, null, 10)).toBe(0);
  });

  it("BUY 金额钳到 MAX_NOTIONAL,滑杆总能给出可下的数", () => {
    expect(qtyFromPercent(100, "BUY", { cashCents: MAX_NOTIONAL_CENTS * 3, qty: 0 }, 100, 1)).toBe(MAX_NOTIONAL_CENTS / 100);
  });

  it("pct 越界、BUY 缺价格、负资源返回 null", () => {
    expect(qtyFromPercent(101, "SELL", { cashCents: 0, qty: 500 }, null, 1)).toBeNull();
    expect(qtyFromPercent(-1, "BUY", { cashCents: 100, qty: 0 }, 100, 1)).toBeNull();
    expect(qtyFromPercent(50, "BUY", { cashCents: 100, qty: 0 }, null, 1)).toBeNull();
    expect(qtyFromPercent(50, "BUY", { cashCents: 100, qty: 0 }, 0, 1)).toBeNull();
    expect(qtyFromPercent(50, "SELL", { cashCents: 0, qty: -3 }, null, 1)).toBeNull();
  });
});

describe("validateDraft", () => {
  const cases: [DraftError, OrderDraft, Partial<DraftAvail>?][] = [
    ["invalidPrice", { ...limitBuy, price: null }],
    ["overMaxPrice", { ...limitBuy, price: MAX_PRICE_CENTS + 5 }],
    ["offTick", { ...limitBuy, price: 10_002 }],
    ["invalidQty", { ...limitBuy, quantity: null }],
    ["belowMinQty", { ...limitBuy, quantity: 5 }, { qty: 500 }],
    ["offStep", { ...limitBuy, quantity: 15 }],
    ["insufficientCash", { ...limitBuy, quantity: 200 }, { cashCents: 1_999_999 }],
    ["insufficientQty", { side: "SELL", type: "LIMIT", price: 10_000, quantity: 510 }],
    ["noLiquidity", { side: "BUY", type: "MARKET", price: null, quantity: 10 }, { bestAsk: null }],
    ["overMaxNotional", { ...limitBuy, price: MAX_PRICE_CENTS, quantity: 20 }, { cashCents: Number.MAX_SAFE_INTEGER }],
  ];

  it.each(cases)("%s", (reason, draft, override) => {
    expect(validateDraft(draft, instrument, { ...avail, ...override })).toEqual({ ok: false, reason });
  });

  it("十个 DraftError 字面量每个都有触发路径", () => {
    const covered = new Set(cases.map(([reason]) => reason));
    const all: DraftError[] = [
      "invalidPrice", "invalidQty", "belowMinQty", "offTick", "offStep",
      "insufficientCash", "insufficientQty", "noLiquidity", "overMaxNotional", "overMaxPrice",
    ];
    expect([...covered].sort()).toEqual([...all].sort());
  });

  it("合法限价买单给出可 POST 的请求体,clientOrderId 只在提供时带上", () => {
    expect(validateDraft(limitBuy, instrument, avail)).toEqual({
      ok: true,
      order: { assetId: "asset-1", side: "BUY", type: "LIMIT", price: 10_000, quantity: 50 },
    });
    const withId = validateDraft({ ...limitBuy, clientOrderId: "c-1" }, instrument, avail);
    expect(withId.ok && withId.order.clientOrderId).toBe("c-1");
  });

  it("市价单忽略价格,price 输出为 null;SELL 市价看买一、卖数量看持仓", () => {
    expect(validateDraft({ side: "BUY", type: "MARKET", price: 3, quantity: 10 }, instrument, avail)).toEqual({
      ok: true,
      order: { assetId: "asset-1", side: "BUY", type: "MARKET", price: null, quantity: 10 },
    });
    expect(validateDraft({ side: "SELL", type: "MARKET", price: null, quantity: 10 }, instrument, { ...avail, bestBid: null }))
      .toEqual({ ok: false, reason: "noLiquidity" });
    expect(validateDraft({ side: "SELL", type: "MARKET", price: null, quantity: 10 }, instrument, { ...avail, qty: 0 }))
      .toEqual({ ok: false, reason: "insufficientQty" });
  });

  it("市价买至少要买得起 1 吨(现金 < 卖一价 → insufficientCash),够 1 吨即放行由引擎封顶", () => {
    const draft: OrderDraft = { side: "BUY", type: "MARKET", price: null, quantity: 100 };
    expect(validateDraft(draft, instrument, { ...avail, cashCents: 10_004 })).toEqual({ ok: false, reason: "insufficientCash" });
    expect(validateDraft(draft, instrument, { ...avail, cashCents: 10_005 }).ok).toBe(true);
  });

  it("非整数价格 / 数量与 NaN 都是 invalid", () => {
    expect(validateDraft({ ...limitBuy, price: 10_000.5 }, instrument, avail)).toEqual({ ok: false, reason: "invalidPrice" });
    expect(validateDraft({ ...limitBuy, quantity: 10.5 }, instrument, avail)).toEqual({ ok: false, reason: "invalidQty" });
    expect(validateDraft({ ...limitBuy, quantity: NaN }, instrument, avail)).toEqual({ ok: false, reason: "invalidQty" });
  });

  it("限价名义额恰好等于上限合法,超过一分即 overMaxNotional", () => {
    const rich = { ...avail, cashCents: Number.MAX_SAFE_INTEGER };
    const inst = { ...instrument, tickSize: 1, qtyStep: 1, minQty: 1 };
    expect(validateDraft({ ...limitBuy, price: MAX_PRICE_CENTS, quantity: 10 }, inst, rich).ok).toBe(true);
    expect(validateDraft({ ...limitBuy, price: MAX_PRICE_CENTS, quantity: 11 }, inst, rich)).toEqual({ ok: false, reason: "overMaxNotional" });
  });
});
