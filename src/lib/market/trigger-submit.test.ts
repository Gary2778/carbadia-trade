import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertFields, OcoFields, OrderTriggerFields, Trigger } from "@/shared";
import { UNSETTLED_TTL_MS } from "./order-submit";
import { applyAccountEvent, createInitialAccountState, useAccountStore } from "./account-store";
import {
  OCO_URL,
  TRIGGERS_URL,
  cancelTrigger,
  clearPendingTriggerKeys,
  readTrigger,
  submitAlert,
  submitOco,
  submitOrderTrigger,
  verifyCancelResponse,
  verifyOcoResponse,
  verifyTriggerResponse,
  type TriggerSubmitError,
} from "./trigger-submit";

// 条件单的提交函数(P3-06):信封请求、错误码映射、应答核对、幂等键沿用、成功后写进账户 store。node 环境,注入的 fetch。

const ASSET = "asset-1";
const SYMBOL = "VCS-FOR-2021";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 服务端形状的一行(默认:PENDING 的市价卖出条件单,涨到 72.00 触发) */
const row = (id: string, over: Partial<Trigger> = {}): Trigger => ({
  id,
  kind: "ORDER",
  assetId: ASSET,
  symbol: SYMBOL,
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

const marketSell: OrderTriggerFields = { assetId: ASSET, direction: "ABOVE", triggerPrice: 7200, side: "SELL", orderType: "MARKET", limitPrice: null, quantity: 5 };
const limitBuy: OrderTriggerFields = { assetId: ASSET, direction: "BELOW", triggerPrice: 6500, side: "BUY", orderType: "LIMIT", limitPrice: 6510, quantity: 8 };
const alertFields: AlertFields = { assetId: ASSET, direction: "BELOW", triggerPrice: 6000 };
const alertRow = (id: string, over: Partial<Trigger> = {}): Trigger => row(id, { kind: "ALERT", direction: "BELOW", triggerPrice: 6000, side: null, orderType: null, quantity: null, ...over });
const ocoFields: OcoFields = { assetId: ASSET, quantity: 5, takeProfit: 7500, stopLoss: 6500 };
const takeProfitRow = (id: string, over: Partial<Trigger> = {}): Trigger => row(id, { direction: "ABOVE", triggerPrice: 7500, ocoGroupId: "g-1", ...over });
const stopLossRow = (id: string, over: Partial<Trigger> = {}): Trigger => row(id, { direction: "BELOW", triggerPrice: 6500, ocoGroupId: "g-1", ...over });

type Call = { url: string; method: string | undefined; body: Record<string, unknown> | undefined; init: RequestInit | undefined };
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const ok = (data: unknown) => json(200, { ok: true, data });
const rejected = (status: number, error: string, headers: Record<string, string> = {}) => json(status, { ok: false, error }, headers);
const offline = () => {
  throw new TypeError("Failed to fetch");
};

const openIds = () => [...useAccountStore.getState().openTriggers.keys()].sort();
const keyOf = (call: Call): unknown => call.body?.clientKey;

beforeEach(() => {
  clearPendingTriggerKeys();
  // 先落回未登录:身份变化才会清掉账户 store 里「已终结条件单」的记录(它是模块级的,不然上一条测试记下的 id 会留到这一条)
  useAccountStore.setState(createInitialAccountState(), true);
  useAccountStore.setState(
    { ...createInitialAccountState(), me: { id: "u1", email: "e", name: "n", cashBalance: 100_000, lockedCash: 0, unreadNotices: 0 }, balance: { cashBalance: 100_000, lockedCash: 0 }, status: "ready" },
    true,
  );
});

describe("submitOrderTrigger", () => {
  it("POSTs the order fields with a fresh uuid clientKey, returns the row and writes it into openTriggers", async () => {
    const created = row("t-1", { orderType: "LIMIT", side: "BUY", direction: "BELOW", triggerPrice: 6500, limitPrice: 6510, quantity: 8 });
    const { impl, calls } = fakeFetch([ok({ trigger: created })]);
    const result = await submitOrderTrigger(limitBuy, impl);
    expect(result).toEqual({ ok: true, trigger: created });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TRIGGERS_URL);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(calls[0].body).toEqual({ kind: "ORDER", ...limitBuy, clientKey: expect.stringMatching(UUID) });
    expect(openIds()).toEqual(["t-1"]);
    expect(useAccountStore.getState().openTriggers.get("t-1")).toEqual(created);
  });

  it("a market conditional order sends limitPrice null whatever the caller passed", async () => {
    const { impl, calls } = fakeFetch([ok({ trigger: row("t-1") })]);
    const result = await submitOrderTrigger({ ...marketSell, limitPrice: 7300 }, impl);
    expect(result.ok).toBe(true);
    expect(calls[0].body).toMatchObject({ kind: "ORDER", orderType: "MARKET", limitPrice: null });
  });

  it("sends only the order fields (an object with extra properties does not leak them into the request)", async () => {
    const { impl, calls } = fakeFetch([ok({ trigger: row("t-1") })]);
    await submitOrderTrigger({ ...marketSell, secret: "x" } as OrderTriggerFields, impl);
    expect(Object.keys(calls[0].body ?? {}).sort()).toEqual(["assetId", "clientKey", "direction", "kind", "limitPrice", "orderType", "quantity", "side", "triggerPrice"]);
  });

  type Case = [string, () => Response | Promise<Response>, TriggerSubmitError, (number | null)?];
  const failures: Case[] = [
    ["400 wouldTriggerNow", rejected(400, "wouldTriggerNow"), "wouldTriggerNow"],
    ["400 tooManyTriggers", rejected(400, "tooManyTriggers"), "tooManyTriggers"],
    ["400 overPosition", rejected(400, "overPosition"), "insufficientQty"],
    ["400 zod message", rejected(400, "Price exceeds maximum"), "invalid"],
    ["400 Instrument not found", rejected(400, "Instrument not found"), "invalid"],
    ["400 Limit orders require a price greater than 0", rejected(400, "Limit orders require a price greater than 0"), "invalid"],
    ["400 without a message", () => new Response("", { status: 400 }), "invalid"],
    ["409 clientKey reused with different parameters", rejected(409, "clientKey already used with a different trigger"), "invalid"],
    ["401", rejected(401, "Not logged in"), "unauthorized"],
    ["401 without an envelope", () => new Response("", { status: 401 }), "unauthorized"],
    ["429 with Retry-After", rejected(429, "Too many requests, please retry later", { "Retry-After": "7" }), "rateLimited", 7],
    ["429 without Retry-After (an edge rule)", () => new Response("", { status: 429 }), "rateLimited", null],
    ["403", rejected(403, "Forbidden"), "invalid"],
    ["404", rejected(404, "Not found"), "invalid"],
    ["500", rejected(500, "Internal server error"), "uncertain"],
    ["503 busy", rejected(503, "Busy", { "Retry-After": "1" }), "uncertain"],
    ["503 triggersDisabled", rejected(503, "triggersDisabled"), "triggersDisabled"],
    ["offline", offline, "network"],
  ];
  it.each(failures)("%s → %s, nothing is written to the store", async (_name, respond, code, retryAfter = null) => {
    const { impl } = fakeFetch([respond]);
    expect(await submitOrderTrigger(marketSell, impl)).toEqual({ ok: false, code, retryAfter });
    expect(openIds()).toEqual([]);
  });

  it("a 2xx whose envelope is not { ok: true } or whose body is unreadable is uncertain", async () => {
    for (const respond of [json(200, { ok: false, error: "?" }), () => new Response("<html>", { status: 200 })]) {
      const { impl } = fakeFetch([respond]);
      expect(await submitOrderTrigger(marketSell, impl)).toEqual({ ok: false, code: "uncertain", retryAfter: null });
    }
    expect(openIds()).toEqual([]);
  });

  describe("response verification: the answer must be the trigger that was asked for", () => {
    const bad: [string, unknown][] = [
      ["no trigger", {}],
      ["null data", null],
      ["a list instead of one row", { triggers: [row("t-1")] }],
      ["another trigger price", { trigger: row("t-1", { triggerPrice: 7300 }) }],
      ["another direction", { trigger: row("t-1", { direction: "BELOW" }) }],
      ["another asset", { trigger: row("t-1", { assetId: "asset-2" }) }],
      ["another side", { trigger: row("t-1", { side: "BUY" }) }],
      ["another order type", { trigger: row("t-1", { orderType: "LIMIT", limitPrice: 7210 }) }],
      ["another quantity", { trigger: row("t-1", { quantity: 6 }) }],
      ["an alert", { trigger: alertRow("t-1") }],
      ["part of an OCO pair", { trigger: row("t-1", { ocoGroupId: "g-1" }) }],
      ["an empty id", { trigger: row("") }],
      ["an unknown status", { trigger: { ...row("t-1"), status: "WEIRD" } }],
      ["a fractional price", { trigger: row("t-1", { triggerPrice: 7200.5 }) }],
      ["a missing field", { trigger: { ...row("t-1"), createdAt: undefined } }],
    ];
    it.each(bad)("%s → uncertain, store untouched, the key is kept for a retry", async (_name, data) => {
      const { impl, calls } = fakeFetch([ok(data), ok({ trigger: row("t-1") })]);
      expect(await submitOrderTrigger(marketSell, impl)).toEqual({ ok: false, code: "uncertain", retryAfter: null });
      expect(openIds()).toEqual([]);
      expect((await submitOrderTrigger(marketSell, impl)).ok).toBe(true);
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    });

    it("a replay that comes back already moved on (the row is TRIGGERED) is accepted; it is not an open trigger, so the store gets nothing", async () => {
      const fired = row("t-1", { status: "TRIGGERED", orderId: "o-5", firedPrice: 7200, firedAt: 2_000, updatedAt: 2_000 });
      const { impl } = fakeFetch([ok({ trigger: fired })]);
      expect(await submitOrderTrigger(marketSell, impl)).toEqual({ ok: true, trigger: fired });
      expect(openIds()).toEqual([]);
    });
  });

  describe("idempotency: identical retries reuse the clientKey", () => {
    it("offline, then the same parameters again: the same key; after the server confirms, the next identical submit is a new trigger with a new key", async () => {
      const { impl, calls } = fakeFetch([offline, ok({ trigger: row("t-1") }), ok({ trigger: row("t-2") })]);
      expect(await submitOrderTrigger(marketSell, impl)).toMatchObject({ ok: false, code: "network" });
      expect((await submitOrderTrigger(marketSell, impl)).ok).toBe(true);
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
      expect((await submitOrderTrigger(marketSell, impl)).ok).toBe(true);
      expect(keyOf(calls[2])).not.toBe(keyOf(calls[0]));
      expect(keyOf(calls[2])).toEqual(expect.stringMatching(UUID));
    });

    it("a 5xx keeps the key too", async () => {
      const { impl, calls } = fakeFetch([rejected(503, "Busy", { "Retry-After": "1" }), ok({ trigger: row("t-1") })]);
      await submitOrderTrigger(marketSell, impl);
      await submitOrderTrigger(marketSell, impl);
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    });

    it("a definite rejection (4xx: nothing was created) lets the key go: the next attempt gets a new one", async () => {
      const { impl, calls } = fakeFetch([rejected(400, "wouldTriggerNow"), ok({ trigger: row("t-1") })]);
      await submitOrderTrigger(marketSell, impl);
      await submitOrderTrigger(marketSell, impl);
      expect(keyOf(calls[1])).not.toBe(keyOf(calls[0]));
    });

    it("503 triggersDisabled is a definite refusal too (nothing was created): the key goes", async () => {
      const { impl, calls } = fakeFetch([rejected(503, "triggersDisabled"), ok({ trigger: row("t-1") })]);
      await submitOrderTrigger(marketSell, impl);
      await submitOrderTrigger(marketSell, impl);
      expect(keyOf(calls[1])).not.toBe(keyOf(calls[0]));
    });

    it("different parameters (any field) get different keys", async () => {
      const { impl, calls } = fakeFetch(Array.from({ length: 8 }, () => offline));
      const variants: OrderTriggerFields[] = [
        marketSell,
        { ...marketSell, quantity: 6 },
        { ...marketSell, triggerPrice: 7300 },
        { ...marketSell, direction: "BELOW" },
        { ...marketSell, side: "BUY" },
        { ...marketSell, assetId: "asset-2" },
        { ...marketSell, orderType: "LIMIT", limitPrice: 7210 },
        { ...marketSell, orderType: "LIMIT", limitPrice: 7220 },
      ];
      for (const variant of variants) await submitOrderTrigger(variant, impl);
      expect(new Set(calls.map(keyOf)).size).toBe(variants.length);
    });

    it("the same parameters while the first request is still in flight share its key (a double click creates one trigger)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const created = JSON.stringify({ ok: true, data: { trigger: row("t-1") } });
      const { impl, calls } = fakeFetch([() => gate.then(() => new Response(created, { status: 200 })), ok({ trigger: row("t-1") })]);
      const first = submitOrderTrigger(marketSell, impl);
      const second = submitOrderTrigger(marketSell, impl);
      release();
      await Promise.all([first, second]);
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
      expect(openIds()).toEqual(["t-1"]);
    });

    it("a market order ignores the limit price in its signature (the same market order with a different limitPrice is the same request)", async () => {
      const { impl, calls } = fakeFetch([offline, offline]);
      await submitOrderTrigger(marketSell, impl);
      await submitOrderTrigger({ ...marketSell, limitPrice: 9_999 }, impl);
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    });

    it(`the key is only kept for ${UNSETTLED_TTL_MS / 60_000} minutes: much later the same parameters are a deliberate new trigger`, async () => {
      const { impl, calls } = fakeFetch([offline, offline, offline]);
      await submitOrderTrigger(marketSell, impl, 1_000_000);
      await submitOrderTrigger(marketSell, impl, 1_000_000 + UNSETTLED_TTL_MS); // 刚好到期那一刻仍沿用
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
      await submitOrderTrigger(marketSell, impl, 1_000_000 + 2 * UNSETTLED_TTL_MS + 1);
      expect(keyOf(calls[2])).not.toBe(keyOf(calls[0]));
    });

    it("the registry is bounded: the oldest unsettled key is forgotten past 32", async () => {
      const { impl, calls } = fakeFetch(Array.from({ length: 34 }, () => offline));
      for (let i = 0; i < 33; i++) await submitOrderTrigger({ ...marketSell, triggerPrice: 7_000 + i }, impl);
      await submitOrderTrigger({ ...marketSell, triggerPrice: 7_000 }, impl);
      expect(keyOf(calls[33])).not.toBe(keyOf(calls[0]));
      // 最近的仍沿用
      const again = fakeFetch([offline]);
      await submitOrderTrigger({ ...marketSell, triggerPrice: 7_032 }, again.impl);
      expect(keyOf(again.calls[0])).toBe(keyOf(calls[32]));
    });
  });

  it("goes through the same fold as a push: a TRIGGERED event that overtook the response is not resurrected by it", async () => {
    // 触发得足够快:引擎的 trigger 事件(TRIGGERED)先到,POST 的响应(PENDING)后到
    applyAccountEvent({ t: "trigger", topic: "account", seq: 5, trigger: row("t-1", { status: "TRIGGERED", orderId: "o-5", firedPrice: 7200, firedAt: 1_500, updatedAt: 1_500 }) });
    const { impl } = fakeFetch([ok({ trigger: row("t-1") })]);
    expect((await submitOrderTrigger(marketSell, impl)).ok).toBe(true);
    expect(openIds()).toEqual([]);
  });

  it("a push that already delivered the row first: the response overwrites it with the same row, no duplicate", async () => {
    applyAccountEvent({ t: "trigger", topic: "account", seq: 5, trigger: row("t-1") });
    const { impl } = fakeFetch([ok({ trigger: row("t-1") })]);
    await submitOrderTrigger(marketSell, impl);
    expect(openIds()).toEqual(["t-1"]);
  });
});

describe("submitAlert", () => {
  it("POSTs { kind: ALERT, assetId, direction, triggerPrice, clientKey } and writes the row into openTriggers", async () => {
    const created = alertRow("t-a");
    const { impl, calls } = fakeFetch([ok({ trigger: created })]);
    expect(await submitAlert(alertFields, impl)).toEqual({ ok: true, trigger: created });
    expect(calls[0].url).toBe(TRIGGERS_URL);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ kind: "ALERT", ...alertFields, clientKey: expect.stringMatching(UUID) });
    expect(openIds()).toEqual(["t-a"]);
  });

  const failures: [string, () => Response | Promise<Response>, TriggerSubmitError][] = [
    ["wouldTriggerNow", rejected(400, "wouldTriggerNow"), "wouldTriggerNow"],
    ["tooManyTriggers", rejected(400, "tooManyTriggers"), "tooManyTriggers"],
    ["other 400", rejected(400, "Instrument not found"), "invalid"],
    ["401", rejected(401, "Not logged in"), "unauthorized"],
    ["429", rejected(429, "Too many requests", { "Retry-After": "3" }), "rateLimited"],
    ["500", rejected(500, "Internal server error"), "uncertain"],
    ["503 triggersDisabled", rejected(503, "triggersDisabled"), "triggersDisabled"],
    ["offline", offline, "network"],
  ];
  it.each(failures)("%s → %s", async (_name, respond, code) => {
    const { impl } = fakeFetch([respond]);
    expect(await submitAlert(alertFields, impl)).toMatchObject({ ok: false, code });
    expect(openIds()).toEqual([]);
  });

  it("verifies the answer: an order trigger, another price or another direction is uncertain", async () => {
    for (const trigger of [row("t-a"), alertRow("t-a", { triggerPrice: 6100 }), alertRow("t-a", { direction: "ABOVE" }), { ...alertRow("t-a"), side: "BUY" }]) {
      const { impl } = fakeFetch([ok({ trigger })]);
      expect(await submitAlert(alertFields, impl)).toMatchObject({ ok: false, code: "uncertain" });
    }
    expect(openIds()).toEqual([]);
  });

  it("an identical retry after a lost response reuses the key; a different price does not", async () => {
    const { impl, calls } = fakeFetch([offline, offline, ok({ trigger: alertRow("t-a") })]);
    await submitAlert(alertFields, impl);
    await submitAlert({ ...alertFields, triggerPrice: 6100 }, impl);
    expect(keyOf(calls[1])).not.toBe(keyOf(calls[0]));
    await submitAlert(alertFields, impl);
    expect(keyOf(calls[2])).toBe(keyOf(calls[0]));
  });

  it("an alert and a conditional order never share a key even with overlapping fields", async () => {
    const { impl, calls } = fakeFetch([offline, offline]);
    await submitAlert({ assetId: ASSET, direction: "ABOVE", triggerPrice: 7200 }, impl);
    await submitOrderTrigger(marketSell, impl);
    expect(keyOf(calls[1])).not.toBe(keyOf(calls[0]));
  });
});

describe("submitOco", () => {
  it("POSTs { assetId, quantity, takeProfit, stopLoss, clientKey } and writes both legs into openTriggers with one set()", async () => {
    const legs = [takeProfitRow("t-tp"), stopLossRow("t-sl")];
    const { impl, calls } = fakeFetch([ok({ triggers: legs })]);
    const listener = vi.fn();
    const unsub = useAccountStore.subscribe(listener);
    expect(await submitOco(ocoFields, impl)).toEqual({ ok: true, triggers: legs });
    unsub();
    expect(calls[0].url).toBe(OCO_URL);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ ...ocoFields, clientKey: expect.stringMatching(UUID) });
    expect(openIds()).toEqual(["t-sl", "t-tp"]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("only a take-profit: one leg, the stop-loss is sent as null; only a stop-loss likewise", async () => {
    const tp = fakeFetch([ok({ triggers: [takeProfitRow("t-tp")] })]);
    expect(await submitOco({ ...ocoFields, stopLoss: null }, tp.impl)).toEqual({ ok: true, triggers: [takeProfitRow("t-tp")] });
    expect(tp.calls[0].body).toMatchObject({ takeProfit: 7500, stopLoss: null });
    const sl = fakeFetch([ok({ triggers: [stopLossRow("t-sl")] })]);
    expect(await submitOco({ ...ocoFields, takeProfit: null }, sl.impl)).toEqual({ ok: true, triggers: [stopLossRow("t-sl")] });
    expect(sl.calls[0].body).toMatchObject({ takeProfit: null, stopLoss: 6500 });
    expect(openIds()).toEqual(["t-sl", "t-tp"]);
  });

  const failures: [string, () => Response | Promise<Response>, TriggerSubmitError][] = [
    ["400 overPosition", rejected(400, "overPosition"), "insufficientQty"],
    ["400 wouldTriggerNow", rejected(400, "wouldTriggerNow"), "wouldTriggerNow"],
    ["400 tooManyTriggers", rejected(400, "tooManyTriggers"), "tooManyTriggers"],
    ["400 Take-profit price must be above the stop-loss price", rejected(400, "Take-profit price must be above the stop-loss price"), "invalid"],
    ["400 Give a take-profit price, a stop-loss price, or both", rejected(400, "Give a take-profit price, a stop-loss price, or both"), "invalid"],
    ["409", rejected(409, "clientKey already used with a different trigger"), "invalid"],
    ["401", rejected(401, "Not logged in"), "unauthorized"],
    ["429", rejected(429, "Too many requests", { "Retry-After": "9" }), "rateLimited"],
    ["503", rejected(503, "Busy"), "uncertain"],
    ["503 triggersDisabled", rejected(503, "triggersDisabled"), "triggersDisabled"],
    ["offline", offline, "network"],
  ];
  it.each(failures)("%s → %s, nothing is written", async (_name, respond, code) => {
    const { impl } = fakeFetch([respond]);
    expect(await submitOco(ocoFields, impl)).toMatchObject({ ok: false, code });
    expect(openIds()).toEqual([]);
  });

  describe("response verification", () => {
    const tp = takeProfitRow("t-tp");
    const sl = stopLossRow("t-sl");
    const bad: [string, unknown][] = [
      ["no list", {}],
      ["one leg for two prices", { triggers: [tp] }],
      ["three legs", { triggers: [tp, sl, sl] }],
      ["no legs", { triggers: [] }],
      ["the stop-loss first (the take-profit comes first)", { triggers: [sl, tp] }],
      ["another group id on the second leg", { triggers: [tp, stopLossRow("t-sl", { ocoGroupId: "g-2" })] }],
      ["a leg without a group id", { triggers: [tp, stopLossRow("t-sl", { ocoGroupId: null })] }],
      ["another quantity", { triggers: [takeProfitRow("t-tp", { quantity: 6 }), sl] }],
      ["a buy leg", { triggers: [tp, stopLossRow("t-sl", { side: "BUY" })] }],
      ["a limit leg", { triggers: [tp, stopLossRow("t-sl", { orderType: "LIMIT", limitPrice: 6490 })] }],
      ["another take-profit price", { triggers: [takeProfitRow("t-tp", { triggerPrice: 7600 }), sl] }],
      ["an alert as a leg", { triggers: [tp, alertRow("t-sl", { ocoGroupId: "g-1" })] }],
    ];
    it.each(bad)("%s → uncertain, store untouched, key kept", async (_name, data) => {
      const { impl, calls } = fakeFetch([ok(data), ok({ triggers: [tp, sl] })]);
      expect(await submitOco(ocoFields, impl)).toEqual({ ok: false, code: "uncertain", retryAfter: null });
      expect(openIds()).toEqual([]);
      expect((await submitOco(ocoFields, impl)).ok).toBe(true);
      expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    });

    it("a replay whose legs have moved on (one TRIGGERED, the other CANCELLED / OCO) is accepted; no open row is stored", async () => {
      const legs = [takeProfitRow("t-tp", { status: "TRIGGERED", updatedAt: 3_000 }), stopLossRow("t-sl", { status: "CANCELLED", reason: "OCO", updatedAt: 3_000 })];
      const { impl } = fakeFetch([ok({ triggers: legs })]);
      expect(await submitOco(ocoFields, impl)).toEqual({ ok: true, triggers: legs });
      expect(openIds()).toEqual([]);
    });
  });

  it("an identical retry reuses the key until the server answers; different quantity or prices get another one", async () => {
    const { impl, calls } = fakeFetch([offline, offline, offline, ok({ triggers: [takeProfitRow("t-tp"), stopLossRow("t-sl")] }), offline]);
    await submitOco(ocoFields, impl);
    await submitOco(ocoFields, impl);
    expect(keyOf(calls[1])).toBe(keyOf(calls[0]));
    await submitOco({ ...ocoFields, quantity: 6 }, impl);
    expect(keyOf(calls[2])).not.toBe(keyOf(calls[0]));
    await submitOco(ocoFields, impl);
    expect(keyOf(calls[3])).toBe(keyOf(calls[0]));
    await submitOco(ocoFields, impl); // 已确认:这是有意的又一对
    expect(keyOf(calls[4])).not.toBe(keyOf(calls[0]));
  });
});

describe("cancelTrigger", () => {
  const cancelled = (id: string, over: Partial<Trigger> = {}): Trigger => row(id, { status: "CANCELLED", reason: "USER", updatedAt: 3_000, ...over });

  it("DELETEs /api/account/triggers/<id> (encoded, no body); the returned CANCELLED row takes the trigger out of openTriggers", async () => {
    applyAccountEvent({ t: "trigger", topic: "account", seq: 1, trigger: row("t-1") });
    applyAccountEvent({ t: "trigger", topic: "account", seq: 2, trigger: row("t-2", { createdAt: 2_000 }) });
    const { impl, calls } = fakeFetch([ok({ trigger: cancelled("t-1") })]);
    expect(await cancelTrigger("t-1", impl)).toEqual({ ok: true, trigger: cancelled("t-1") });
    expect(calls[0]).toMatchObject({ url: `${TRIGGERS_URL}/t-1`, method: "DELETE", body: undefined });
    expect(openIds()).toEqual(["t-2"]);
  });

  it("encodes the id in the path", async () => {
    const { impl, calls } = fakeFetch([rejected(400, "Trigger not found")]);
    await cancelTrigger("a/b c", impl);
    expect(calls[0].url).toBe(`${TRIGGERS_URL}/a%2Fb%20c`);
  });

  it("remembers the cancellation: a PENDING that was in flight before it cannot bring the row back", async () => {
    applyAccountEvent({ t: "trigger", topic: "account", seq: 1, trigger: row("t-1") });
    const { impl } = fakeFetch([ok({ trigger: cancelled("t-1") })]);
    await cancelTrigger("t-1", impl);
    applyAccountEvent({ t: "trigger", topic: "account", seq: 2, trigger: row("t-1", { status: "TRIGGERING", updatedAt: 2_500 }) });
    expect(openIds()).toEqual([]);
  });

  type Case = [string, () => Response | Promise<Response>, TriggerSubmitError, (number | null)?];
  const failures: Case[] = [
    ["409 (no longer PENDING)", rejected(409, "Trigger can no longer be cancelled"), "notCancellable"],
    ["400 (not found / someone else's)", rejected(400, "Trigger not found"), "invalid"],
    ["401", rejected(401, "Not logged in"), "unauthorized"],
    ["429 with Retry-After", rejected(429, "Too many requests, please retry later", { "Retry-After": "4" }), "rateLimited", 4],
    ["500", rejected(500, "Internal server error"), "uncertain"],
    ["503 busy", rejected(503, "Busy", { "Retry-After": "1" }), "uncertain"],
    ["404", rejected(404, "Not found"), "invalid"],
    ["offline", offline, "network"],
  ];
  it.each(failures)("%s → %s, the store is untouched", async (_name, respond, code, retryAfter = null) => {
    applyAccountEvent({ t: "trigger", topic: "account", seq: 1, trigger: row("t-1") });
    const before = useAccountStore.getState();
    const { impl } = fakeFetch([respond]);
    expect(await cancelTrigger("t-1", impl)).toEqual({ ok: false, code, retryAfter });
    expect(useAccountStore.getState()).toBe(before);
  });

  it("a 409 on creation is not 'notCancellable' (it means the key was reused with other parameters)", async () => {
    const { impl } = fakeFetch([rejected(409, "clientKey already used with a different trigger")]);
    expect(await submitOrderTrigger(marketSell, impl)).toMatchObject({ code: "invalid" });
  });

  it("verifies the answer: another id, a row that is not CANCELLED, or garbage is uncertain", async () => {
    for (const data of [{ trigger: cancelled("t-other") }, { trigger: row("t-1") }, { trigger: row("t-1", { status: "TRIGGERED" }) }, {}, null]) {
      applyAccountEvent({ t: "trigger", topic: "account", seq: 1, trigger: row("t-1") });
      const before = useAccountStore.getState();
      const { impl } = fakeFetch([ok(data)]);
      expect(await cancelTrigger("t-1", impl)).toEqual({ ok: false, code: "uncertain", retryAfter: null });
      expect(useAccountStore.getState()).toBe(before);
    }
  });
});

describe("readTrigger / verify helpers", () => {
  it("rebuilds a clean Trigger: extra properties are dropped, every field is kept", () => {
    const full = row("t-1", { status: "TRIGGERED", reason: null, orderId: "o-5", firedPrice: 7200, firedAt: 2_000, updatedAt: 2_000, ocoGroupId: "g-1" });
    const parsed = readTrigger({ ...full, extra: "x" });
    expect(parsed).toEqual(full);
    expect(parsed).not.toHaveProperty("extra");
  });

  it("accepts every status and every reason the server can send", () => {
    for (const status of ["PENDING", "TRIGGERING", "TRIGGERED", "REJECTED", "CANCELLED"] as const) expect(readTrigger(row("t", { status }))?.status).toBe(status);
    for (const reason of ["USER", "OCO", "INSUFFICIENT_CASH", "INSUFFICIENT_QTY", "NO_FILL", "INVALID"] as const) expect(readTrigger(row("t", { status: "REJECTED", reason }))?.reason).toBe(reason);
  });

  const malformed: [string, unknown][] = [
    ["not an object", "t-1"],
    ["null", null],
    ["unknown kind", { ...row("t-1"), kind: "STOP" }],
    ["unknown direction", { ...row("t-1"), direction: "UP" }],
    ["unknown reason", { ...row("t-1"), reason: "BECAUSE" }],
    ["unknown side", { ...row("t-1"), side: "HOLD" }],
    ["unknown order type", { ...row("t-1"), orderType: "STOP" }],
    ["zero trigger price", row("t-1", { triggerPrice: 0 })],
    ["negative quantity", row("t-1", { quantity: -1 })],
    ["fractional limit price", row("t-1", { orderType: "LIMIT", limitPrice: 70.5 })],
    ["string timestamp", { ...row("t-1"), createdAt: "1000" }],
    ["undefined where null belongs", { ...row("t-1"), orderId: undefined }],
    ["an ORDER without a side", row("t-1", { side: null })],
    ["an ORDER without a quantity", row("t-1", { quantity: null })],
    ["an ALERT with a side", alertRow("t-1", { side: "BUY" })],
    ["an ALERT with a quantity", alertRow("t-1", { quantity: 3 })],
    ["an ALERT with a limit price", alertRow("t-1", { limitPrice: 100 })],
    ["empty symbol", row("t-1", { symbol: "" })],
  ];
  it.each(malformed)("rejects %s", (_name, value) => {
    expect(readTrigger(value)).toBeNull();
  });

  it("verifyTriggerResponse / verifyOcoResponse / verifyCancelResponse are pure", () => {
    expect(verifyTriggerResponse({ trigger: row("t-1") }, (t) => t.id === "t-1")?.id).toBe("t-1");
    expect(verifyTriggerResponse({ trigger: row("t-1") }, () => false)).toBeNull();
    expect(verifyOcoResponse({ triggers: [takeProfitRow("a"), stopLossRow("b")] }, ocoFields)?.map((t) => t.id)).toEqual(["a", "b"]);
    expect(verifyOcoResponse({ triggers: [takeProfitRow("a")] }, { ...ocoFields, stopLoss: null })?.map((t) => t.id)).toEqual(["a"]);
    expect(verifyOcoResponse({ triggers: [takeProfitRow("a")] }, { ...ocoFields, takeProfit: null, stopLoss: null })).toBeNull();
    expect(verifyCancelResponse({ trigger: row("t-1", { status: "CANCELLED", reason: "USER" }) }, "t-1")?.status).toBe("CANCELLED");
    expect(verifyCancelResponse({ trigger: row("t-1") }, "t-1")).toBeNull();
  });
});
