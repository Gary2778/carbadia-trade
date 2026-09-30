import { afterEach, describe, expect, it } from "vitest";
import type { Fill, Order, PlaceOrderResponse } from "@/shared";
import { DEFAULT_FEE_SCHEDULE } from "@/shared";
import { initialDraft, toReview, type Draft, type DraftCtx, type OrderReview } from "./order-draft";
import {
  ORDERS_URL,
  UNSETTLED_TTL_MS,
  accountEventsOf,
  clearUnsettledReviews,
  failureAfterClose,
  failureSurface,
  markUnsettled,
  openReview,
  placedNotice,
  placedState,
  postEnvelope,
  rejectionReason,
  settleReview,
  submitOrder,
  submitReview,
  unsettledReviews,
  verifyOrderResponse,
} from "./order-submit";

// 下单提交(计划 §3.1):信封请求、响应形状校验、成功后写进账户 store 的事件、结果未确认登记簿。node 环境,注入的 fetch。

const SYMBOL = "VCS-FOR-2021";
const CID = "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab";
const limitReview: OrderReview = {
  request: { assetId: "asset-1", side: "BUY", type: "LIMIT", price: 10_000, quantity: 50, clientOrderId: CID },
  estNotional: 500_000,
  estFee: 0,
  estAvgPrice: 10_000,
  warnings: [],
};
const marketReview: OrderReview = { ...limitReview, request: { ...limitReview.request, type: "MARKET", price: null } };

function response(review: OrderReview, over: { filledQty?: number; filledCost?: number; status?: string; replayed?: boolean; order?: Record<string, unknown> } = {}): PlaceOrderResponse {
  const { request } = review;
  const filledQty = over.filledQty ?? 0;
  return {
    order: {
      id: "order-1",
      clientOrderId: request.clientOrderId,
      assetId: request.assetId,
      symbol: SYMBOL,
      side: request.side,
      type: request.type,
      price: request.price ?? null,
      quantity: request.quantity,
      filledQuantity: filledQty,
      status: (over.status ?? "OPEN") as PlaceOrderResponse["order"]["status"],
      avgFillPrice: null,
      cancelReason: null,
      createdAt: 1,
      updatedAt: 1,
      ...over.order,
    },
    filledQty,
    filledCost: over.filledCost ?? 0,
    fills: [],
    replayed: over.replayed ?? false,
  };
}

const fillOf = (id: string, over: Partial<Fill> = {}): Fill => ({
  id,
  orderId: "order-1",
  symbol: SYMBOL,
  side: "BUY",
  role: "TAKER",
  price: 10_000,
  quantity: 10,
  notional: 100_000,
  feeCents: 0,
  ts: 1,
  auditRef: `SIM-TRD-${id}`,
  ledgerRefs: [],
  ...over,
});

describe("verifyOrderResponse", () => {
  it("接受一致的结果:限价挂单 / 部分成交 / 全部成交,市价全成或余量撤销,重放后被撤的限价单", () => {
    expect(verifyOrderResponse(limitReview, response(limitReview))).not.toBeNull();
    expect(verifyOrderResponse(limitReview, response(limitReview, { filledQty: 20, filledCost: 200_000, status: "PARTIAL" }))).not.toBeNull();
    expect(verifyOrderResponse(limitReview, response(limitReview, { filledQty: 50, filledCost: 499_000, status: "FILLED" }))).not.toBeNull();
    expect(verifyOrderResponse(marketReview, response(marketReview, { filledQty: 50, filledCost: 500_250, status: "FILLED" }))).not.toBeNull();
    expect(verifyOrderResponse(marketReview, response(marketReview, { filledQty: 30, filledCost: 300_150, status: "CANCELLED" }))).not.toBeNull();
    expect(verifyOrderResponse(limitReview, response(limitReview, { status: "CANCELLED", replayed: true }))).not.toBeNull();
  });

  it("拒绝对不上的结果", () => {
    const bad: [OrderReview, unknown][] = [
      [limitReview, null],
      [limitReview, { ...response(limitReview), fills: undefined }],
      [limitReview, response(limitReview, { order: { clientOrderId: "another" } })],
      [limitReview, response(limitReview, { order: { id: "" } })],
      [limitReview, response(limitReview, { order: { quantity: 49 } })],
      [limitReview, response(limitReview, { order: { price: 10_005 } })],
      [limitReview, response(limitReview, { order: { side: "SELL" } })],
      [limitReview, response(limitReview, { filledQty: 10, filledCost: 0, status: "PARTIAL" })],
      [limitReview, response(limitReview, { filledQty: 0, filledCost: 5, status: "OPEN" })],
      [limitReview, response(limitReview, { filledQty: 60, filledCost: 600_000, status: "FILLED" })],
      [limitReview, response(limitReview, { filledQty: 50, filledCost: 500_000, status: "PARTIAL" })],
      [limitReview, response(limitReview, { status: "CANCELLED" })],
      [limitReview, response(limitReview, { status: "WEIRD" })],
      [limitReview, { ...response(limitReview, { filledQty: 20, filledCost: 200_000, status: "PARTIAL" }), filledQty: 10 }],
      [marketReview, response(marketReview, { filledQty: 30, filledCost: 300_150, status: "PARTIAL" })],
      [marketReview, response(marketReview, { filledQty: 0, filledCost: 0, status: "OPEN" })],
      [marketReview, response(limitReview)],
    ];
    for (const [review, data] of bad) expect(verifyOrderResponse(review, data)).toBeNull();
  });
});

type FakeCall = { url: string; body: unknown };
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: FakeCall[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
  return { impl, calls };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const offline = () => {
  throw new TypeError("Failed to fetch");
};

describe("submitOrder / postEnvelope", () => {
  it("断网 → uncertain(status 0);用同一张确认单重试 → 请求带同一个 clientOrderId,成功", async () => {
    const { impl, calls } = fakeFetch([offline, json(200, { ok: true, data: response(limitReview, { replayed: true }) })]);
    expect(await submitOrder(limitReview, impl)).toEqual({ kind: "uncertain", status: 0 });
    const retry = await submitOrder(limitReview, impl);
    expect(retry.kind).toBe("ok");
    expect(calls.map((c) => c.url)).toEqual([ORDERS_URL, ORDERS_URL]);
    expect(calls[0].body).toEqual(limitReview.request);
    expect((calls[1].body as { clientOrderId: string }).clientOrderId).toBe(CID);
  });

  it("5xx、2xx 但信封不对 / 形状对不上 / 响应体读不出 → uncertain", async () => {
    const cases = [
      json(503, { ok: false, error: "Busy" }),
      json(200, { ok: false, error: "?" }),
      json(200, { ok: true, data: response(limitReview, { order: { clientOrderId: "x" } }) }),
      () => new Response("<html>", { status: 200 }),
    ];
    for (const res of cases) {
      const { impl } = fakeFetch([res]);
      expect((await submitOrder(limitReview, impl)).kind).toBe("uncertain");
    }
  });

  it("4xx → rejected:信封 error 原文只留作排查(没有就是 null,不再拼英文);429 读 Retry-After 秒数", async () => {
    const limited = fakeFetch([json(429, { ok: false, error: "Too many requests, please retry later" }, { "Retry-After": "12" })]);
    expect(await submitOrder(limitReview, limited.impl)).toEqual({ kind: "rejected", status: 429, message: "Too many requests, please retry later", retryAfter: 12 });
    const invalid = fakeFetch([json(400, { ok: false, error: "Insufficient available cash" })]);
    expect(await submitOrder(limitReview, invalid.impl)).toEqual({ kind: "rejected", status: 400, message: "Insufficient available cash", retryAfter: null });
    const unauth = fakeFetch([() => new Response("", { status: 401 })]);
    expect(await submitOrder(limitReview, unauth.impl)).toEqual({ kind: "rejected", status: 401, message: null, retryAfter: null });
  });

  it("postEnvelope:无请求体的 POST(演示账户入口),ok 带 data 与状态码", async () => {
    const { impl, calls } = fakeFetch([json(200, { ok: true, data: { id: "u1" } })]);
    expect(await postEnvelope("/api/auth/demo", undefined, impl)).toEqual({ kind: "ok", status: 200, data: { id: "u1" } });
    expect(calls).toEqual([{ url: "/api/auth/demo", body: undefined }]);
  });
});

describe("rejectionReason / placedState(界面文案的选择)", () => {
  it("429(有 Retry-After)→ rateLimited;401 → loginRequired;400 → invalid(重新校验);其余 → other(ui.error)", () => {
    expect(rejectionReason({ status: 429, retryAfter: 30 })).toEqual({ kind: "rateLimited", retryAfter: 30 });
    expect(rejectionReason({ status: 429, retryAfter: null })).toEqual({ kind: "other" });
    expect(rejectionReason({ status: 401, retryAfter: null })).toEqual({ kind: "loginRequired" });
    expect(rejectionReason({ status: 400, retryAfter: null })).toEqual({ kind: "invalid" });
    expect(rejectionReason({ status: 404, retryAfter: null })).toEqual({ kind: "other" });
  });

  it("限价部分成交挂着 → partialResting(toast.orderPartial);市价部分成交余量撤销 → partialCancelled(order.partial)", () => {
    expect(placedState(response(limitReview, { filledQty: 50, filledCost: 500_000, status: "FILLED" }))).toBe("filled");
    expect(placedState(response(limitReview, { filledQty: 20, filledCost: 200_000, status: "PARTIAL" }))).toBe("partialResting");
    expect(placedState(response(marketReview, { filledQty: 30, filledCost: 300_150, status: "CANCELLED" }))).toBe("partialCancelled");
    expect(placedState(response(marketReview, { status: "CANCELLED" }))).toBe("cancelled");
    expect(placedState(response(limitReview))).toBe("resting");
  });

  it("placedNotice:新单 → ok 并清空草稿(零成交撤销用 warning);有意再下同样的单被重放 → warning、不清空草稿、给去委托记录的动作", () => {
    expect(placedNotice(response(limitReview, { filledQty: 50, filledCost: 500_000, status: "FILLED" }))).toEqual({
      replayed: false,
      state: "filled",
      tone: "ok",
      resetDraft: true,
      showOrdersAction: false,
      selfTradeCancelled: 0,
    });
    expect(placedNotice(response(marketReview, { status: "CANCELLED" }))).toMatchObject({ replayed: false, state: "cancelled", tone: "warning", resetDraft: true });
    // 重放(不是对话框里的重试 —— 关掉对话框后重新核对、登记簿沿用了旧 id):之前那张单已在(这里是它现在的状态 FILLED),这次没有下新单
    expect(placedNotice(response(marketReview, { filledQty: 50, filledCost: 500_250, status: "FILLED", replayed: true }))).toEqual({
      replayed: true,
      state: "filled",
      tone: "warning",
      resetDraft: false,
      showOrdersAction: true,
      selfTradeCancelled: 0,
    });
    expect(placedNotice(response(limitReview, { status: "CANCELLED", replayed: true }), { retryOfUncertain: false })).toMatchObject({
      replayed: true,
      state: "cancelled",
      tone: "warning",
      resetDraft: false,
    });
  });

  it("placedNotice:对话框里对「结果未确认」的重试被重放 = 预期的完成:ok、清空草稿、不给动作(文案仍是「此前已下过」)", () => {
    expect(placedNotice(response(marketReview, { filledQty: 50, filledCost: 500_250, status: "FILLED", replayed: true }), { retryOfUncertain: true })).toEqual({
      replayed: true,
      state: "filled",
      tone: "ok",
      resetDraft: true,
      showOrdersAction: false,
      selfTradeCancelled: 0,
    });
    expect(placedNotice(response(limitReview, { replayed: true }), { retryOfUncertain: true })).toMatchObject({ replayed: true, state: "resting", tone: "ok", resetDraft: true });
    // 重放到一张之后被撤、一吨没成交的单:照新单的口径用 warning,但草稿照样清空
    expect(placedNotice(response(limitReview, { status: "CANCELLED", replayed: true }), { retryOfUncertain: true })).toMatchObject({ tone: "warning", resetDraft: true });
    // 重试但服务端这次是新单(第一次其实没到):就是新单
    expect(placedNotice(response(limitReview), { retryOfUncertain: true })).toMatchObject({ replayed: false, tone: "ok", resetDraft: true });
  });

  it("placedNotice.selfTradeCancelled:响应带 > 0 的条数才提示;缺省(P1-07b 之前的服务端)、0、非法值都按 0", () => {
    const base = response(limitReview, { filledQty: 50, filledCost: 500_000, status: "FILLED" });
    expect(placedNotice({ ...base, selfTradeCancelled: 2 }).selfTradeCancelled).toBe(2);
    expect(placedNotice({ ...base, selfTradeCancelled: 1 }, { retryOfUncertain: true }).selfTradeCancelled).toBe(1);
    expect(placedNotice(base).selfTradeCancelled).toBe(0);
    expect(placedNotice({ ...base, selfTradeCancelled: 0 }).selfTradeCancelled).toBe(0);
    for (const bad of [-1, 1.5, Number.NaN, "2"]) expect(placedNotice({ ...base, selfTradeCancelled: bad as number }).selfTradeCancelled).toBe(0);
    // 形状校验不因这个可选字段拒收(有没有都是 ok)
    expect(verifyOrderResponse(limitReview, { ...base, selfTradeCancelled: 3 })).not.toBeNull();
    expect(verifyOrderResponse(limitReview, base)).not.toBeNull();
  });

  it("failureSurface:表单已卸载 → toast;提交在途时要关 → 面板;否则留在对话框", () => {
    expect(failureSurface({ mounted: false, dismissed: false })).toBe("toast");
    expect(failureSurface({ mounted: false, dismissed: true })).toBe("toast");
    expect(failureSurface({ mounted: true, dismissed: true })).toBe("panel");
    expect(failureSurface({ mounted: true, dismissed: false })).toBe("dialog");
  });

  it("failureAfterClose:关掉确认框后结果未确认的提示留在面板里,被拒的说明清掉", () => {
    const uncertain = { message: "u", uncertain: true, loginHref: null };
    expect(failureAfterClose(uncertain)).toBe(uncertain);
    expect(failureAfterClose({ message: "r", uncertain: false, loginHref: "/login" })).toBeNull();
    expect(failureAfterClose(null)).toBeNull();
  });
});

describe("accountEventsOf", () => {
  const known = (orders: Order[] = [], fills: Fill[] = []) => ({ openOrders: new Map(orders.map((o) => [o.id, o])), recentFills: fills });

  it("订单 + 本次成交,账户 topic、seq 0", () => {
    const data = response(limitReview, { filledQty: 50, filledCost: 500_000, status: "FILLED" });
    const fill = fillOf("t1", { quantity: 50, notional: 500_000 });
    expect(accountEventsOf({ ...data, fills: [fill] })).toEqual([
      { t: "order", topic: "account", seq: 0, order: data.order },
      { t: "fill", topic: "account", seq: 0, fill },
    ]);
    // 账户 store 里还没有它的任何消息:照常写订单
    expect(accountEventsOf({ ...data, fills: [fill] }, known()).map((e) => e.t)).toEqual(["order", "fill"]);
  });

  it("推送已先把它作为 FILLED 移出挂单(recentFills 里有不属于本次响应的后续成交)→ 不写回旧的 OPEN / PARTIAL 订单,只写成交", () => {
    const own = fillOf("t1", { quantity: 20, notional: 200_000 });
    const data = { ...response(limitReview, { filledQty: 20, filledCost: 200_000, status: "PARTIAL" }), fills: [own] };
    const later = fillOf("t2", { quantity: 30, notional: 300_000, role: "MAKER", ts: 5 });
    const events = accountEventsOf(data, known([], [later, own]));
    expect(events.map((e) => e.t)).toEqual(["fill"]);
    // 只有本次响应自己的成交:不算被超过
    expect(accountEventsOf(data, known([], [own])).map((e) => e.t)).toEqual(["order", "fill"]);
    // 别的订单的成交不相干
    expect(accountEventsOf(data, known([], [fillOf("t9", { orderId: "order-9" })])).map((e) => e.t)).toEqual(["order", "fill"]);
  });

  it("挂单里已有推送来的更新版本(成交更多或更晚)→ 不覆盖;同一版本或更旧的照常写", () => {
    const data = response(limitReview);
    const pushed: Order = { ...data.order, status: "PARTIAL", filledQuantity: 10, updatedAt: 5 };
    expect(accountEventsOf(data, known([pushed])).map((e) => e.t)).toEqual([]);
    expect(accountEventsOf(data, known([{ ...data.order, updatedAt: 9 }])).map((e) => e.t)).toEqual([]);
    expect(accountEventsOf(data, known([data.order])).map((e) => e.t)).toEqual(["order"]);
  });

  it("终态订单(FILLED / CANCELLED)照常写:账户 store 自己把它移出挂单", () => {
    const data = response(marketReview, { filledQty: 30, filledCost: 300_150, status: "CANCELLED" });
    expect(accountEventsOf(data, known([], [fillOf("t7")])).map((e) => e.t)).toEqual(["order"]);
  });
});

describe("结果未确认登记簿(模块级,跨表单重挂载)", () => {
  afterEach(() => clearUnsettledReviews());

  const ctx: DraftCtx = {
    instrument: { id: "asset-1", symbol: SYMBOL, tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1 },
    avail: { cashCents: 10_000_000, qty: 0 },
    bookTop: { bestBid: 9_990, bestAsk: 10_010 },
    asks: [],
    bids: [],
  };
  const draft = (over: Partial<Draft>): Draft => ({ ...initialDraft(), ...over });

  it("表单重挂载(本地 state 清空)之后,同样参数再核对(openReview)仍沿用未确认那张的 clientOrderId;成功后移除,下一单换新 id", async () => {
    const d = draft({ priceText: "100", qtyText: "50" });
    // 第一次挂载:核对 → 提交(提交前登记)→ 断网,结果未确认
    const first = openReview(d, ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    const lost = fakeFetch([offline]);
    expect(await submitReview(first, lost.impl)).toEqual({ kind: "uncertain", status: 0 });
    expect(unsettledReviews()).toEqual([first]);
    // 换标的 / 手机切页签 / 离开 /trade 再回来:OrderForm 重挂载,组件里什么都没留下;登记簿还在
    const afterRemount = openReview(draft({ priceText: "100.00", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect(afterRemount.request.clientOrderId).toBe(first.request.clientOrderId);
    // 重试成功 → 移除;同样参数的下一单是新单
    const ok = fakeFetch([json(200, { ok: true, data: response(afterRemount) })]);
    expect((await submitReview(afterRemount, ok.impl)).kind).toBe("ok");
    expect(ok.calls[0].body).toEqual(first.request);
    expect(unsettledReviews()).toEqual([]);
    const next = openReview(d, ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect(next.request.clientOrderId).not.toBe(first.request.clientOrderId);
  });

  it("明确被拒(4xx)也留在登记簿(之前若有过结果未确认,重试仍要同一个 id)", async () => {
    const review = openReview(draft({ priceText: "100", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    const limited = fakeFetch([json(429, { ok: false, error: "slow down" }, { "Retry-After": "3" })]);
    expect((await submitReview(review, limited.impl)).kind).toBe("rejected");
    expect(unsettledReviews()).toEqual([review]);
  });

  it("结果未确认其实已成交,用户关掉对话框后有意再下同样的单:沿用旧 id 被服务端重放 → 通知「没有下新单」、不清草稿;登记移除,再核对换新 id", async () => {
    const d = draft({ type: "MARKET", qtyText: "10" });
    const book: DraftCtx = { ...ctx, asks: [{ price: 10_010, quantity: 100, orders: 1 }] };
    const first = openReview(d, book, DEFAULT_FEE_SCHEDULE) as OrderReview;
    // 请求到了服务端、成交了,响应丢了
    expect((await submitReview(first, fakeFetch([offline]).impl)).kind).toBe("uncertain");
    // 用户关掉对话框;稍后有意再下一张 BUY MARKET 10 t —— 参数完全相同,登记簿沿用了旧 id
    const again = openReview(d, book, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect(again.request.clientOrderId).toBe(first.request.clientOrderId);
    const replay = response(again, { filledQty: 10, filledCost: 100_100, status: "FILLED", replayed: true });
    const outcome = await submitReview(again, fakeFetch([json(200, { ok: true, data: replay })]).impl);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    // 面板不能报「已提交」:单独的 warning 通知,草稿留着(这不是对话框里对未确认那一次的重试,retryOfUncertain 为 false)
    expect(placedNotice(outcome.data, { retryOfUncertain: false })).toMatchObject({ replayed: true, tone: "warning", resetDraft: false, showOrdersAction: true });
    // 服务端确认过这个 id 的结果 → 登记移除;用户确实要再下一张时,再核对就是新 id 的新单
    expect(unsettledReviews()).toEqual([]);
    expect((openReview(d, book, DEFAULT_FEE_SCHEDULE) as OrderReview).request.clientOrderId).not.toBe(first.request.clientOrderId);
  });

  it("对话框里断网后按「重试」,服务端重放(第一次其实已生效)= 预期的完成:ok、清空草稿;登记移除,再核对换新 id", async () => {
    const d = draft({ priceText: "100", qtyText: "50" });
    const review = openReview(d, ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect((await submitReview(review, fakeFetch([offline]).impl)).kind).toBe("uncertain");
    // 同一张确认单重试(对话框没关):同一个 clientOrderId,服务端找到了第一次下的单
    const replay = response(review, { replayed: true });
    const outcome = await submitReview(review, fakeFetch([json(200, { ok: true, data: replay })]).impl);
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);
    expect(placedNotice(outcome.data, { retryOfUncertain: true })).toMatchObject({ replayed: true, tone: "ok", resetDraft: true, showOrdersAction: false });
    expect(unsettledReviews()).toEqual([]);
    expect((openReview(d, ctx, DEFAULT_FEE_SCHEDULE) as OrderReview).request.clientOrderId).not.toBe(review.request.clientOrderId);
  });

  it("登记有效期 UNSETTLED_TTL_MS(从最近一次提交算):过期后同样参数再核对换新 id;再次提交会刷新时刻", () => {
    const t0 = 1_000_000;
    const d = draft({ priceText: "100", qtyText: "50" });
    const first = openReview(d, ctx, DEFAULT_FEE_SCHEDULE, t0) as OrderReview;
    markUnsettled(first, t0);
    // 有效期内:沿用
    expect((openReview(d, ctx, DEFAULT_FEE_SCHEDULE, t0 + UNSETTLED_TTL_MS) as OrderReview).request.clientOrderId).toBe(first.request.clientOrderId);
    // 在有效期末尾重试(对话框里的「重试」同样经 submitReview 登记)→ 时刻刷新
    markUnsettled(first, t0 + UNSETTLED_TTL_MS);
    expect(unsettledReviews(t0 + 2 * UNSETTLED_TTL_MS)).toEqual([first]);
    // 离最近一次提交超过有效期:移除,换新 id
    expect(unsettledReviews(t0 + 2 * UNSETTLED_TTL_MS + 1)).toEqual([]);
    expect((openReview(d, ctx, DEFAULT_FEE_SCHEDULE, t0 + 2 * UNSETTLED_TTL_MS + 1) as OrderReview).request.clientOrderId).not.toBe(first.request.clientOrderId);
  });

  it("另一张单成功不会冲掉别的未确认确认单;同一张重复登记不重复;有上限", () => {
    const a = toReview(draft({ priceText: "100", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    const b = toReview(draft({ priceText: "100", qtyText: "60" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    markUnsettled(a);
    markUnsettled(b);
    markUnsettled(a);
    settleReview(b);
    expect(unsettledReviews()).toEqual([a]);
    for (let i = 0; i < 40; i++) markUnsettled({ ...a, request: { ...a.request, quantity: 100 + i, clientOrderId: `id-${i}` } });
    expect(unsettledReviews().length).toBe(32);
    expect(unsettledReviews().at(-1)?.request.clientOrderId).toBe("id-39");
  });
});
