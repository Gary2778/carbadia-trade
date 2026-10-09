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
  triggerDirection,
  validateDraft,
  validateTriggerDraft,
  type DraftAvail,
  type DraftInstrument,
  type OrderDraft,
  type TriggerDraft,
  type TriggerDraftField,
} from "./order-math";
import { validateOcoDraft } from "./trigger-drafts";
import type { DraftError, TriggerDraftError, TriggerDirection } from "./types";

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

describe("triggerDirection", () => {
  const cases: [string, number, number | null, TriggerDirection | null][] = [
    ["高于最新价 → ABOVE", 10_100, 10_000, "ABOVE"],
    ["低于最新价 → BELOW", 9_900, 10_000, "BELOW"],
    ["等于最新价 → null(创建即触发)", 10_000, 10_000, null],
    ["最新价未知 → null,由调用方让用户选", 10_100, null, null],
    ["最新价是 0 或非整数也算未知", 10_100, 0, null],
    ["触发价不是整数 → null", 10_000.5, 10_000, null],
    ["触发价 NaN → null", NaN, 10_000, null],
  ];
  it.each(cases)("%s", (_name, price, last, expected) => {
    expect(triggerDirection(price, last)).toBe(expected);
  });
  it("最新价差一分就能定方向", () => {
    expect(triggerDirection(10_001, 10_000)).toBe("ABOVE");
    expect(triggerDirection(9_999, 10_000)).toBe("BELOW");
  });
});

describe("validateTriggerDraft", () => {
  const LAST = 10_000;
  const limitBuyTrigger: TriggerDraft = { side: "BUY", orderType: "LIMIT", triggerPrice: 10_500, limitPrice: 10_550, quantity: 50 };
  const marketSellTrigger: TriggerDraft = { side: "SELL", orderType: "MARKET", triggerPrice: 9_500, limitPrice: null, quantity: 50 };
  const rich = { ...instrument, tickSize: 1, qtyStep: 1, minQty: 1 };

  const cases: [string, TriggerDraftError, TriggerDraftField, TriggerDraft, (number | null)?, DraftInstrument?][] = [
    ["触发价空", "invalidTrigger", "triggerPrice", { ...limitBuyTrigger, triggerPrice: null }],
    ["触发价 NaN(垃圾输入)", "invalidTrigger", "triggerPrice", { ...limitBuyTrigger, triggerPrice: NaN }],
    ["触发价 0", "invalidTrigger", "triggerPrice", { ...limitBuyTrigger, triggerPrice: 0 }],
    ["触发价非整数", "invalidTrigger", "triggerPrice", { ...limitBuyTrigger, triggerPrice: 10_500.5 }],
    ["触发价超上限", "overMaxPrice", "triggerPrice", { ...limitBuyTrigger, triggerPrice: MAX_PRICE_CENTS + 5 }],
    ["触发价不在 tick 上", "offTick", "triggerPrice", { ...limitBuyTrigger, triggerPrice: 10_502 }],
    ["触发价等于最新价", "wouldTriggerNow", "triggerPrice", { ...limitBuyTrigger, triggerPrice: LAST }],
    ["最新价未知又没选方向", "directionNeeded", "direction", limitBuyTrigger, null],
    ["最新价未知,选的方向不是 ABOVE / BELOW", "directionNeeded", "direction", { ...limitBuyTrigger, direction: null }, null],
    ["限价空", "invalidPrice", "limitPrice", { ...limitBuyTrigger, limitPrice: null }],
    ["限价 0", "invalidPrice", "limitPrice", { ...limitBuyTrigger, limitPrice: 0 }],
    ["限价超上限", "overMaxPrice", "limitPrice", { ...limitBuyTrigger, limitPrice: MAX_PRICE_CENTS + 5 }],
    ["限价不在 tick 上", "offTick", "limitPrice", { ...limitBuyTrigger, limitPrice: 10_552 }],
    ["数量空", "invalidQty", "quantity", { ...limitBuyTrigger, quantity: null }],
    ["数量非整数", "invalidQty", "quantity", { ...limitBuyTrigger, quantity: 10.5 }],
    ["数量 0", "invalidQty", "quantity", { ...marketSellTrigger, quantity: 0 }],
    ["数量低于最小量", "belowMinQty", "quantity", { ...limitBuyTrigger, quantity: 5 }],
    ["数量不是 step 倍数", "offStep", "quantity", { ...limitBuyTrigger, quantity: 15 }],
    ["限价名义额超上限", "overMaxNotional", "quantity", { ...limitBuyTrigger, triggerPrice: MAX_PRICE_CENTS - 5, limitPrice: MAX_PRICE_CENTS, quantity: 20 }, 1, rich],
  ];

  it.each(cases)("%s → %s(归到 %s)", (_name, reason, field, draft, last = LAST, inst = instrument) => {
    expect(validateTriggerDraft(draft, inst, last)).toEqual({ ok: false, reason, field });
  });

  it("触发价相关的错误排在限价与数量之前,限价的排在数量之前", () => {
    expect(validateTriggerDraft({ ...limitBuyTrigger, triggerPrice: null, limitPrice: null, quantity: null }, instrument, LAST)).toMatchObject({ reason: "invalidTrigger" });
    expect(validateTriggerDraft({ ...limitBuyTrigger, triggerPrice: LAST, limitPrice: null, quantity: null }, instrument, LAST)).toMatchObject({ reason: "wouldTriggerNow" });
    expect(validateTriggerDraft({ ...limitBuyTrigger, limitPrice: null, quantity: null }, instrument, LAST)).toMatchObject({ reason: "invalidPrice" });
  });

  it("市价条件单忽略限价(空 / 垃圾都不报错),名义额不查,输出的 limitPrice 为 null", () => {
    for (const limitPrice of [null, NaN, 3, MAX_PRICE_CENTS * 2]) {
      expect(validateTriggerDraft({ ...marketSellTrigger, limitPrice }, instrument, LAST)).toEqual({
        ok: true,
        trigger: { assetId: "asset-1", direction: "BELOW", triggerPrice: 9_500, side: "SELL", orderType: "MARKET", limitPrice: null, quantity: 50 },
      });
    }
    const huge: TriggerDraft = { ...marketSellTrigger, triggerPrice: MAX_PRICE_CENTS, quantity: 100_000 };
    expect(validateTriggerDraft(huge, rich, 1).ok).toBe(true);
  });

  it("合法限价条件单给出 submitOrderTrigger 的输入:ABOVE 买、限价带上", () => {
    expect(validateTriggerDraft(limitBuyTrigger, instrument, LAST)).toEqual({
      ok: true,
      trigger: { assetId: "asset-1", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_550, quantity: 50 },
    });
  });

  it("买卖方向与触发方向互不相干:BELOW 的买单(抄底)、ABOVE 的卖单(止盈)都合法", () => {
    expect(validateTriggerDraft({ ...limitBuyTrigger, triggerPrice: 9_500, limitPrice: 9_505 }, instrument, LAST)).toMatchObject({ ok: true, trigger: { direction: "BELOW", side: "BUY" } });
    expect(validateTriggerDraft({ ...marketSellTrigger, triggerPrice: 10_500 }, instrument, LAST)).toMatchObject({ ok: true, trigger: { direction: "ABOVE", side: "SELL" } });
  });

  it("不查现金与持仓:数量远超任何资源也通过", () => {
    expect(validateTriggerDraft({ ...limitBuyTrigger, quantity: 90 }, instrument, LAST).ok).toBe(true);
    expect(validateTriggerDraft({ ...marketSellTrigger, quantity: 90 }, instrument, LAST).ok).toBe(true);
  });

  it("最新价未知时用用户选的方向,任何触发价都放行(与服务端「最新价为空时放行」一致);最新价已知时选的方向被忽略", () => {
    expect(validateTriggerDraft({ ...limitBuyTrigger, direction: "BELOW" }, instrument, null)).toMatchObject({ ok: true, trigger: { direction: "BELOW", triggerPrice: 10_500 } });
    expect(validateTriggerDraft({ ...limitBuyTrigger, direction: "ABOVE" }, instrument, null)).toMatchObject({ ok: true, trigger: { direction: "ABOVE" } });
    expect(validateTriggerDraft({ ...limitBuyTrigger, direction: "BELOW" }, instrument, LAST)).toMatchObject({ ok: true, trigger: { direction: "ABOVE" } });
    expect(validateTriggerDraft({ ...limitBuyTrigger, triggerPrice: LAST, direction: "ABOVE" }, instrument, LAST)).toMatchObject({ reason: "wouldTriggerNow" });
  });

  it("名义额恰好等于上限合法,多一分即 overMaxNotional", () => {
    const draft: TriggerDraft = { side: "BUY", orderType: "LIMIT", triggerPrice: MAX_PRICE_CENTS, limitPrice: MAX_PRICE_CENTS, quantity: 10 };
    expect(validateTriggerDraft(draft, rich, 1).ok).toBe(true);
    expect(validateTriggerDraft({ ...draft, quantity: 11 }, rich, 1)).toEqual({ ok: false, reason: "overMaxNotional", field: "quantity" });
  });

  it("assetId 取自标的", () => {
    const result = validateTriggerDraft(limitBuyTrigger, { ...instrument, id: "asset-9" }, LAST);
    expect(result.ok && result.trigger.assetId).toBe("asset-9");
  });
});

describe("TriggerDraftError 字面量", () => {
  it("十四个字面量每个都有触发路径", () => {
    const all: TriggerDraftError[] = [
      "invalidTrigger", "wouldTriggerNow", "directionNeeded", "invalidPrice", "overMaxPrice", "offTick", "invalidQty",
      "belowMinQty", "offStep", "overMaxNotional", "ocoNeedsOne", "takeProfitTooLow", "stopLossTooHigh", "overPosition",
    ];
    const seen = new Set<TriggerDraftError>();
    const note = (r: { ok: boolean; reason?: TriggerDraftError }) => void (!r.ok && r.reason && seen.add(r.reason));
    const t: TriggerDraft = { side: "BUY", orderType: "LIMIT", triggerPrice: 10_500, limitPrice: 10_550, quantity: 50 };
    const inst = { ...instrument, tickSize: 1, qtyStep: 10, minQty: 10 };
    note(validateTriggerDraft({ ...t, triggerPrice: null }, inst, 10_000));
    note(validateTriggerDraft({ ...t, triggerPrice: 10_000 }, inst, 10_000));
    note(validateTriggerDraft(t, inst, null));
    note(validateTriggerDraft({ ...t, limitPrice: null }, inst, 10_000));
    note(validateTriggerDraft({ ...t, limitPrice: MAX_PRICE_CENTS + 1 }, inst, 10_000));
    note(validateTriggerDraft({ ...t, quantity: null }, inst, 10_000));
    note(validateTriggerDraft({ ...t, quantity: 5 }, inst, 10_000));
    note(validateTriggerDraft({ ...t, quantity: 15 }, inst, 10_000));
    note(validateTriggerDraft({ ...t, limitPrice: MAX_PRICE_CENTS, quantity: 20 }, inst, 10_000));
    note(validateTriggerDraft({ ...t, limitPrice: 10_552 }, { ...instrument, tickSize: 5 }, 10_000));
    note(validateOcoDraft({ takeProfit: null, stopLoss: null, quantity: 10 }, inst, 10_000, 100));
    note(validateOcoDraft({ takeProfit: 9_000, stopLoss: null, quantity: 10 }, inst, 10_000, 100));
    note(validateOcoDraft({ takeProfit: null, stopLoss: 11_000, quantity: 10 }, inst, 10_000, 100));
    note(validateOcoDraft({ takeProfit: 11_000, stopLoss: null, quantity: 110 }, inst, 10_000, 100));
    expect([...seen].sort()).toEqual([...all].sort());
  });
});
