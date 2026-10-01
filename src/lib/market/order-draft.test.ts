import { describe, expect, expectTypeOf, it } from "vitest";
import type { DraftError, FeeSchedule, OrderBookLevel } from "@/shared";
import { DEFAULT_FEE_SCHEDULE } from "@/shared";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import {
  DRAFT_ERRORS,
  PCT_MARKS,
  bookLevels,
  bookTopOf,
  bookTopWatcher,
  draftCtxOf,
  draftError,
  errorSelector,
  estimateOrderFee,
  initialDraft,
  newClientOrderId,
  parseCents,
  parseQty,
  reduceDraft,
  refreshChanges,
  requestError,
  sellQtyForProceeds,
  shouldConsumeSeed,
  toReview,
  type Draft,
  type DraftAction,
  type DraftCtx,
  type OrderReview,
} from "./order-draft";

// 下单草稿 reducer 与确认单(计划 §3.6、§3.5;任务 P1-20 的 ≥12 用例)。node 环境,纯函数;提交与响应校验在 order-submit.test.ts。
// 标的:tick 5 分、qtyStep 10 吨、minQty 10 吨;盘口:卖 100.05 × 30、100.10 × 50;买 99.95 × 40、99.90 × 100。

const SYMBOL = "VCS-FOR-2021";
const instrument = { id: "asset-1", symbol: SYMBOL, tickSize: 5, pricePrecision: 2, qtyStep: 10, minQty: 10 };
const lvl = (price: number, quantity: number, orders = 1): OrderBookLevel => ({ price, quantity, orders });
const asks = [lvl(10_005, 30), lvl(10_010, 50, 2)];
const bids = [lvl(9_995, 40), lvl(9_990, 100, 3)];
const ctx: DraftCtx = { instrument, avail: { cashCents: 1_000_000, qty: 500 }, bookTop: { bestBid: 9_995, bestAsk: 10_005 }, asks, bids };

const run = (actions: DraftAction[], c: DraftCtx = ctx, start: Draft = initialDraft()): Draft => actions.reduce((d, a) => reduceDraft(d, a, c), start);
const draft = (over: Partial<Draft>): Draft => ({ ...initialDraft(), ...over });

describe("DraftError 与文案键", () => {
  it("DRAFT_ERRORS 恰好是 DraftError 的全部字面量,且与 en / zh-CN 的 terminal.order.errors 键集一致", () => {
    expectTypeOf<(typeof DRAFT_ERRORS)[number]>().toEqualTypeOf<DraftError>();
    expect(new Set(DRAFT_ERRORS).size).toBe(DRAFT_ERRORS.length);
    expect(Object.keys(en.terminal.order.errors).sort()).toEqual([...DRAFT_ERRORS].sort());
    expect(Object.keys(zhCN.terminal.order.errors).sort()).toEqual([...DRAFT_ERRORS].sort());
  });
});

describe("输入框文本解析", () => {
  it("parseCents:元 → 整数分;空为 null;非法或超过两位小数为 NaN;千分位与空白忽略", () => {
    expect(parseCents("100")).toBe(10_000);
    expect(parseCents("100.5")).toBe(10_050);
    expect(parseCents("1,234.56")).toBe(123_456);
    expect(parseCents(".5")).toBe(50);
    expect(parseCents("100.500")).toBe(10_050);
    expect(parseCents("  ")).toBeNull();
    expect(parseCents("100.505")).toBeNaN();
    expect(parseCents("-1")).toBeNaN();
    expect(parseCents("abc")).toBeNaN();
    expect(parseCents(".")).toBeNaN();
  });

  it("parseQty:整数吨;小数、负数、非数字为 NaN", () => {
    expect(parseQty("50")).toBe(50);
    expect(parseQty("1,000")).toBe(1_000);
    expect(parseQty("")).toBeNull();
    expect(parseQty("1.5")).toBeNaN();
    expect(parseQty("-3")).toBeNaN();
  });
});

describe("reduceDraft:数量 ↔ 金额 ↔ 仓位", () => {
  it("改数量算金额(限价 = 价 × 量),滑杆随之反推(金额占可用现金)", () => {
    const d = run([{ kind: "setPrice", text: "100.00" }, { kind: "setQty", text: "50" }]);
    expect(d).toMatchObject({ priceText: "100.00", qtyText: "50", amountText: "5000.00", pct: 50, lastEdited: "qty" });
  });

  it("改金额算数量:floor(金额 / 价) 再向下取整到 qtyStep;金额框保持用户输入", () => {
    const d = run([{ kind: "setPrice", text: "100" }, { kind: "setAmount", text: "5555" }]);
    // 555500 / 10000 = 55.55 → 55 → qtyStep 10 → 50
    expect(d).toMatchObject({ qtyText: "50", amountText: "5555", lastEdited: "amount", pct: 55 });
    // 之后改价:上次动的是金额 → 按新价重算数量
    expect(reduceDraft(d, { kind: "setPrice", text: "50" }, ctx).qtyText).toBe("110");
  });

  it("仓位百分比:买按可用现金 × pct% 在限价下能买的吨数", () => {
    const d = run([{ kind: "setPrice", text: "100" }, { kind: "setPct", pct: 50 }]);
    // 1,000,000 分 × 50% = 500,000 分 → 50 吨 → 金额 5000.00
    expect(d).toMatchObject({ qtyText: "50", amountText: "5000.00", pct: 50, lastEdited: "pct" });
    const quarter = run([{ kind: "setPrice", text: "100" }, { kind: "setPct", pct: 25 }]);
    expect(quarter.qtyText).toBe("20"); // 25 吨 → 向下取整到 10 的倍数
  });

  it("仓位百分比:卖按可用持仓,向下取整到 qtyStep;价格框空时先填买一价", () => {
    const d = run([{ kind: "setSide", side: "SELL" }, { kind: "setPct", pct: 25 }]);
    // 500 × 25% = 125 → 120;价格取买一 99.95 → 120 × 9995 = 1,199,400 分
    expect(d).toMatchObject({ side: "SELL", priceText: "99.95", qtyText: "120", amountText: "11994.00", pct: 25 });
    expect(run([{ kind: "setSide", side: "SELL" }, { kind: "setPct", pct: 0 }])).toMatchObject({ qtyText: "", amountText: "", pct: 0 });
  });

  it("切 side:数量保留,仓位百分比按新方向的可用资源重算", () => {
    const buy = run([{ kind: "setPrice", text: "100" }, { kind: "setPct", pct: 50 }]);
    expect(buy.pct).toBe(50);
    const sell = reduceDraft(buy, { kind: "setSide", side: "SELL" }, ctx);
    // 50 吨 / 可用持仓 500 = 10%;价格不动,金额 = 50 × 10000
    expect(sell).toMatchObject({ side: "SELL", qtyText: "50", amountText: "5000.00", pct: 10, lastEdited: "qty" });
    expect(reduceDraft(sell, { kind: "setSide", side: "SELL" }, ctx)).toBe(sell);
  });

  it("市价买按卖盘逐档走:改数量算预估金额,改金额算能买到的吨数;滑杆按现金预算走档", () => {
    const qty = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "40" }]);
    // 30 × 100.05 + 10 × 100.10 = 3001.50 + 1001.00
    expect(qty).toMatchObject({ type: "MARKET", amountText: "4002.50", pct: 40 });
    const amount = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setAmount", text: "4002.50" }]);
    expect(amount.qtyText).toBe("40");
    const pct = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setPct", pct: 50 }]);
    // 预算 500,000 分:30 吨 300,150 + 19 吨 190,190 = 49 吨 → qtyStep 10 → 40 吨,金额按 40 吨走档
    expect(pct).toMatchObject({ qtyText: "40", amountText: "4002.50" });
    // 市价卖走买盘:40 × 99.95 + 10 × 99.90
    const sell = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setSide", side: "SELL" }, { kind: "setQty", text: "50" }]);
    expect(sell.amountText).toBe("4997.00");
    // 空盘口:按金额买不到任何东西
    expect(run([{ kind: "setType", orderType: "MARKET" }, { kind: "setAmount", text: "100" }], { ...ctx, asks: [] }).qtyText).toBe("0");
  });

  it("市价卖按金额:沿买盘(价降序)逐档,吃完的高价档之后剩余金额仍够低一档就继续,不在吃完的档后早停(P1-20 审查第 4 条)", () => {
    const fine = { ...instrument, qtyStep: 1, minQty: 1 };
    const sellCtx = (b: OrderBookLevel[]): DraftCtx => ({ ...ctx, instrument: fine, bookTop: { bestBid: b[0]?.price ?? null, bestAsk: 10_005 }, bids: b });
    const sellByAmount = (b: OrderBookLevel[], text: string) =>
      run([{ kind: "setType", orderType: "MARKET" }, { kind: "setSide", side: "SELL" }, { kind: "setAmount", text }], sellCtx(b));
    // 买盘 [100 × 1, 40 × 5]、金额 150:第一档卖完(100),剩 50 ≥ 40 → 再卖 1 吨;共 2 吨、所得 140(旧实现给 1 吨)
    expect(sellByAmount([lvl(10_000, 1), lvl(4_000, 5)], "150")).toMatchObject({ qtyText: "2", amountText: "150", estNotional: 14_000 });
    // 第一档没卖完就停:下一吨仍按 100 成交,2 吨要 200 > 150
    expect(sellByAmount([lvl(10_000, 5), lvl(4_000, 5)], "150")).toMatchObject({ qtyText: "1", estNotional: 10_000 });
    // 盘口卖穿:全部档位卖完为止
    expect(sellByAmount([lvl(10_000, 1), lvl(4_000, 2)], "100000")).toMatchObject({ qtyText: "3", estNotional: 18_000 });
    // 空买盘
    expect(sellByAmount([], "150").qtyText).toBe("0");
    // 数量仍向下取整到 qtyStep(ctx 的 qtyStep 10):99.95 × 40 + 99.90 × 1 = 4097.90 ≤ 4097.95 → 41 → 40
    const stepped = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setSide", side: "SELL" }, { kind: "setAmount", text: "4097.95" }]);
    expect(stepped).toMatchObject({ qtyText: "40", estNotional: 399_800 });
  });

  it("sellQtyForProceeds:逐档 min(档量, floor(剩余 / 价)),本档没卖完即停;档位非法或金额非法为 null", () => {
    expect(sellQtyForProceeds([lvl(10_000, 1), lvl(4_000, 5)], 15_000)).toBe(2);
    expect(sellQtyForProceeds([lvl(10_000, 1), lvl(4_000, 5)], 14_000)).toBe(2);
    expect(sellQtyForProceeds([lvl(10_000, 1), lvl(4_000, 5)], 13_999)).toBe(1);
    expect(sellQtyForProceeds([lvl(10_000, 2), lvl(9_000, 1), lvl(8_000, 3)], 44_000)).toBe(4);
    expect(sellQtyForProceeds([lvl(10_000, 1)], 0)).toBe(0);
    expect(sellQtyForProceeds([lvl(0, 1)], 100)).toBeNull();
    expect(sellQtyForProceeds([lvl(10_000, 1)], -1)).toBeNull();
    expect(sellQtyForProceeds([lvl(10_000, 1)], 1.5)).toBeNull();
  });

  it("refresh:可用现金到了之后滑杆随之更新(先输了数量、账户还没就绪时是 0%);无变化返回同一引用", () => {
    const noCash: DraftCtx = { ...ctx, avail: { cashCents: 0, qty: 0 } };
    const typed = run([{ kind: "setPrice", text: "100" }, { kind: "setQty", text: "50" }], noCash);
    expect(typed).toMatchObject({ amountText: "5000.00", pct: 0 });
    const refreshed = reduceDraft(typed, { kind: "refresh" }, ctx);
    expect(refreshed).toMatchObject({ qtyText: "50", amountText: "5000.00", pct: 50, lastEdited: "qty" });
    expect(reduceDraft(refreshed, { kind: "refresh" }, ctx)).toBe(refreshed);
    expect(reduceDraft(initialDraft(), { kind: "refresh" }, ctx)).toEqual(initialDraft());
    expect(reduceDraft(initialDraft("SELL"), { kind: "refresh" }, ctx)).toEqual(initialDraft("SELL"));
    // 卖出:可用持仓变了
    const sell = run([{ kind: "setSide", side: "SELL" }, { kind: "setPrice", text: "100" }, { kind: "setQty", text: "50" }]);
    expect(sell.pct).toBe(10);
    expect(reduceDraft(sell, { kind: "refresh" }, { ...ctx, avail: { cashCents: 0, qty: 100 } }).pct).toBe(50);
  });

  it("refresh:市价单的金额与预估合计按新盘口重新走档;限价单价格框空着时不替用户填价", () => {
    const market = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "40" }]);
    expect(market).toMatchObject({ amountText: "4002.50", estNotional: 400_250 });
    const moved: DraftCtx = { ...ctx, bookTop: { bestBid: 9_995, bestAsk: 10_010 }, asks: [lvl(10_010, 100)] };
    expect(reduceDraft(market, { kind: "refresh" }, moved)).toMatchObject({ qtyText: "40", amountText: "4004.00", estNotional: 400_400, lastEdited: "qty" });
    // 按金额(预算)输入:数量按新盘口重算,金额框保持用户输入
    const budget = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setAmount", text: "4500" }]);
    expect(reduceDraft(budget, { kind: "refresh" }, { ...moved, instrument: { ...instrument, qtyStep: 1, minQty: 1 } })).toMatchObject({
      qtyText: "44",
      amountText: "4500",
      estNotional: 440_440,
    });
    // 限价、价格框空:refresh 不填参考价(只有 setQty / setAmount / setPct 会填)
    const noPrice = draft({ qtyText: "10" });
    expect(reduceDraft(noPrice, { kind: "refresh" }, ctx).priceText).toBe("");
  });

  it("限价 ↔ 市价切换按 lastEdited 重算;用户清空价格框不会被立即填回", () => {
    const limit = run([{ kind: "setPrice", text: "200" }, { kind: "setQty", text: "40" }]);
    expect(limit.amountText).toBe("8000.00");
    const market = reduceDraft(limit, { kind: "setType", orderType: "MARKET" }, ctx);
    expect(market.amountText).toBe("4002.50");
    const cleared = reduceDraft(limit, { kind: "setPrice", text: "" }, ctx);
    expect(cleared).toMatchObject({ priceText: "", qtyText: "40", amountText: "", pct: 0 });
    // 价格框空时改数量:买单先填卖一价
    expect(run([{ kind: "setQty", text: "10" }])).toMatchObject({ priceText: "100.05", amountText: "1000.50" });
  });

  it("applySeed 覆盖 price 与 side(有价则切到限价、按精度填价),symbol 不符原样返回", () => {
    const start = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "50" }]);
    const seeded = reduceDraft(start, { kind: "applySeed", seed: { symbol: SYMBOL, side: "SELL", price: 10_050, nonce: 7 } }, ctx);
    expect(seeded).toMatchObject({ side: "SELL", type: "LIMIT", priceText: "100.50", qtyText: "50", amountText: "5025.00", pct: 10 });
    // 只带方向的种子(手机底部买卖条)
    expect(reduceDraft(start, { kind: "applySeed", seed: { symbol: SYMBOL, side: "SELL", nonce: 8 } }, ctx)).toMatchObject({ side: "SELL", type: "MARKET" });
    const other = { kind: "applySeed", seed: { symbol: "GS-WIND-2023", side: "SELL", price: 5_000, nonce: 9 } } as const;
    expect(reduceDraft(start, other, ctx)).toBe(start);
  });

  it("applySeed:种子没有 price(undefined)= 不碰价格与类型 —— 只带方向的种子不会用上一次点价覆盖用户输入的价格", () => {
    const typed = run([{ kind: "setPrice", text: "101" }, { kind: "setQty", text: "50" }]);
    const sideOnly = reduceDraft(typed, { kind: "applySeed", seed: { symbol: SYMBOL, side: "SELL", nonce: 10 } }, ctx);
    expect(sideOnly).toMatchObject({ side: "SELL", type: "LIMIT", priceText: "101", qtyText: "50" });
    // 显式传 price: undefined(P1-22 的 b / s 热键这一波仍这样写)同样处理
    expect(reduceDraft(typed, { kind: "applySeed", seed: { symbol: SYMBOL, side: "SELL", price: undefined, nonce: 11 } }, ctx)).toEqual(sideOnly);
    // 市价单:只带方向的种子不切回限价
    const market = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "10" }]);
    expect(reduceDraft(market, { kind: "applySeed", seed: { symbol: SYMBOL, side: "BUY", nonce: 12 } }, ctx)).toBe(market);
  });

  it("shouldConsumeSeed:只认比已消费更新的 nonce、只认当前标的;初始种子(nonce 0、symbol 空)永不消费", () => {
    expect(shouldConsumeSeed({ symbol: "", nonce: 0 }, SYMBOL, 0)).toBe(false);
    // 新种子、当前标的 → 消费
    expect(shouldConsumeSeed({ symbol: SYMBOL, nonce: 1 }, SYMBOL, 0)).toBe(true);
    // 同一颗种子(面板重挂载、页签来回切)不重放;更旧的也不
    expect(shouldConsumeSeed({ symbol: SYMBOL, nonce: 1 }, SYMBOL, 1)).toBe(false);
    expect(shouldConsumeSeed({ symbol: SYMBOL, nonce: 3 }, SYMBOL, 5)).toBe(false);
    // 别的标的的种子不认(换标的时还留在 store 里的旧种子、其它面板点的价)
    expect(shouldConsumeSeed({ symbol: "GS-WIND-2023", nonce: 6 }, SYMBOL, 5)).toBe(false);

    // 面板照做的消费序列:同价再点(nonce 变了)再次触发;手机上先点底部「卖出」、之后才挂载的面板照样消费一次
    let consumed = 0;
    const consume = (seed: { symbol: string; nonce: number }) => {
      if (!shouldConsumeSeed(seed, SYMBOL, consumed)) return false;
      consumed = seed.nonce;
      return true;
    };
    const click = { symbol: SYMBOL, side: "SELL" as const, price: 10_050, nonce: 7 };
    expect(consume(click)).toBe(true);
    expect(consume(click)).toBe(false);
    expect(consume({ ...click, nonce: 8 })).toBe(true);
  });

  it("reset 清空数量 / 金额 / 滑杆,保留方向、类型与价格", () => {
    const d = run([{ kind: "setSide", side: "SELL" }, { kind: "setPrice", text: "101" }, { kind: "setPct", pct: 50 }]);
    expect(reduceDraft(d, { kind: "reset" }, ctx)).toEqual({ ...initialDraft("SELL"), priceText: "101" });
  });

  it("estNotional(面板的预估合计):限价 = 价 × 量(按金额输入时按取整后的数量算);缺价或数量非法为 null", () => {
    expect(run([{ kind: "setPrice", text: "100" }, { kind: "setQty", text: "30" }]).estNotional).toBe(300_000);
    // 金额 5555 → 数量 50 → 预估合计 5000.00,不是金额框里的 5555
    expect(run([{ kind: "setPrice", text: "100" }, { kind: "setAmount", text: "5555" }]).estNotional).toBe(500_000);
    expect(run([{ kind: "setPrice", text: "100" }, { kind: "setQty", text: "1.5" }]).estNotional).toBeNull();
    expect(run([{ kind: "setPrice", text: "100" }, { kind: "setQty", text: "30" }, { kind: "setPrice", text: "" }]).estNotional).toBeNull();
    expect(initialDraft().estNotional).toBeNull();
  });

  it("estNotional:市价按金额(预算)输入时是取整后数量的走档金额,与确认框的 estNotional 一致", () => {
    // 预算 4500.00:30 × 100.05 + 14 × 100.10 = 44 吨 → qtyStep 10 → 40 吨;40 吨走档 = 4002.50
    const d = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setAmount", text: "4500" }]);
    expect(d).toMatchObject({ qtyText: "40", amountText: "4500", estNotional: 400_250 });
    expect((toReview(d, ctx, DEFAULT_FEE_SCHEDULE) as OrderReview).estNotional).toBe(d.estNotional);
    // 按数量 / 滑杆输入时与金额框一致
    expect(run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "40" }]).estNotional).toBe(400_250);
    expect(run([{ kind: "setType", orderType: "MARKET" }, { kind: "setPct", pct: 50 }]).estNotional).toBe(400_250);
    // 切方向:卖出走买盘重算
    expect(run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "50" }, { kind: "setSide", side: "SELL" }]).estNotional).toBe(499_700);
  });
});

describe("校验:十种 DraftError 各能触发", () => {
  const cases: [DraftError, Draft, DraftCtx?][] = [
    ["invalidPrice", draft({ priceText: "", qtyText: "10" })],
    ["overMaxPrice", draft({ priceText: "1000000.05", qtyText: "10" })],
    ["offTick", draft({ priceText: "100.03", qtyText: "10" })],
    ["invalidQty", draft({ priceText: "100", qtyText: "1.5" })],
    ["belowMinQty", draft({ priceText: "100", qtyText: "5" })],
    ["offStep", draft({ priceText: "100", qtyText: "15" })],
    ["overMaxNotional", draft({ priceText: "999999.95", qtyText: "20" })],
    ["noLiquidity", draft({ type: "MARKET", qtyText: "10" }), { ...ctx, bookTop: { bestBid: 9_995, bestAsk: null }, asks: [] }],
    ["insufficientCash", draft({ priceText: "100", qtyText: "200" })],
    ["insufficientQty", draft({ side: "SELL", priceText: "100", qtyText: "600" })],
  ];

  it.each(cases)("%s", (expected, d, c = ctx) => {
    expect(draftError(d, c)).toBe(expected);
    expect(toReview(d, c, DEFAULT_FEE_SCHEDULE)).toEqual({ error: expected });
  });

  it("用例覆盖 DRAFT_ERRORS 全表,合法草稿无错误", () => {
    expect(cases.map(([e]) => e).sort()).toEqual([...DRAFT_ERRORS].sort());
    expect(draftError(draft({ priceText: "100", qtyText: "50" }), ctx)).toBeNull();
  });
});

describe("toReview:确认单", () => {
  const ids = () => {
    let n = 0;
    return () => `00000000-0000-4000-8000-00000000000${++n}`;
  };

  it("限价:请求与预估全是整数分;手续费按较高费率向上取整", () => {
    const fees: FeeSchedule = { makerBps: 7, takerBps: 10, minFeeCents: 1, demo: true };
    const r = toReview(draft({ priceText: "100.05", qtyText: "30" }), ctx, fees, { newId: ids() }) as OrderReview;
    expect(r.request).toEqual({ assetId: "asset-1", side: "BUY", type: "LIMIT", price: 10_005, quantity: 30, clientOrderId: "00000000-0000-4000-8000-000000000001" });
    expect(r).toMatchObject({ estNotional: 300_150, estFee: 301, estAvgPrice: 10_005, warnings: [] });
    for (const n of [r.request.price, r.request.quantity, r.estNotional, r.estFee, r.estAvgPrice]) expect(Number.isSafeInteger(n)).toBe(true);
    // 演示费率(默认全零):手续费 0
    expect((toReview(draft({ priceText: "100.05", qtyText: "30" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview).estFee).toBe(0);
    expect(estimateOrderFee(300_150, DEFAULT_FEE_SCHEDULE)).toBe(0);
  });

  it("市价:按盘口走档(买单再按可用现金封顶)估名义额与整数均价,吃不满给 partialFill", () => {
    const r = toReview(draft({ type: "MARKET", qtyText: "40" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect(r.request).toMatchObject({ type: "MARKET", price: null, quantity: 40 });
    expect(r).toMatchObject({ estNotional: 400_250, estAvgPrice: 10_006, warnings: [] });
    expect(Number.isSafeInteger(r.estAvgPrice)).toBe(true);
    // 盘口只有 80 吨可卖
    expect((toReview(draft({ type: "MARKET", qtyText: "100" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview).warnings).toEqual(["partialFill"]);
    // 现金只够 1 吨多:封顶后只成交 1 吨
    const poor = { ...ctx, avail: { cashCents: 15_000, qty: 0 } };
    expect(toReview(draft({ type: "MARKET", qtyText: "10" }), poor, DEFAULT_FEE_SCHEDULE)).toMatchObject({ estNotional: 10_005, estAvgPrice: 10_005, warnings: ["partialFill"] });
  });

  it("clientOrderId:打开确认框时生成;结果未确认后同样参数再核对沿用同一个,参数一变换新的", () => {
    const newId = ids();
    const d = draft({ priceText: "100", qtyText: "50" });
    const first = toReview(d, ctx, DEFAULT_FEE_SCHEDULE, { newId }) as OrderReview;
    const again = toReview(d, ctx, DEFAULT_FEE_SCHEDULE, { reuse: first, newId }) as OrderReview;
    expect(again.request.clientOrderId).toBe(first.request.clientOrderId);
    const changed = toReview(draft({ priceText: "100", qtyText: "60" }), ctx, DEFAULT_FEE_SCHEDULE, { reuse: first, newId }) as OrderReview;
    expect(changed.request.clientOrderId).not.toBe(first.request.clientOrderId);
    const fresh = toReview(d, ctx, DEFAULT_FEE_SCHEDULE, { reuse: null, newId }) as OrderReview;
    expect(fresh.request.clientOrderId).not.toBe(first.request.clientOrderId);
  });

  it("clientOrderId:reuse 可以是多张未确认的确认单,挑参数完全相同的那张", () => {
    const newId = ids();
    const a = toReview(draft({ priceText: "100", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE, { newId }) as OrderReview;
    const b = toReview(draft({ side: "SELL", priceText: "101", qtyText: "20" }), ctx, DEFAULT_FEE_SCHEDULE, { newId }) as OrderReview;
    const againB = toReview(draft({ side: "SELL", priceText: "101.00", qtyText: "20" }), ctx, DEFAULT_FEE_SCHEDULE, { reuse: [a, b], newId }) as OrderReview;
    expect(againB.request.clientOrderId).toBe(b.request.clientOrderId);
    const againA = toReview(draft({ priceText: "100", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE, { reuse: [a, b], newId }) as OrderReview;
    expect(againA.request.clientOrderId).toBe(a.request.clientOrderId);
    const other = toReview(draft({ priceText: "100", qtyText: "40" }), ctx, DEFAULT_FEE_SCHEDULE, { reuse: [a, b], newId }) as OrderReview;
    expect([a.request.clientOrderId, b.request.clientOrderId]).not.toContain(other.request.clientOrderId);
  });

  it("requestError:已提交的请求按最新可用资源重新校验(服务端 400 时映射回 DraftError);仍然通过为 null", () => {
    const r = toReview(draft({ priceText: "100", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect(requestError(r.request, ctx)).toBeNull();
    expect(requestError(r.request, { ...ctx, avail: { cashCents: 100_000, qty: 500 } })).toBe("insufficientCash");
    const sell = toReview(draft({ side: "SELL", type: "MARKET", qtyText: "50" }), ctx, DEFAULT_FEE_SCHEDULE) as OrderReview;
    expect(requestError(sell.request, { ...ctx, avail: { cashCents: 0, qty: 40 } })).toBe("insufficientQty");
    expect(requestError(sell.request, { ...ctx, bookTop: { bestBid: null, bestAsk: 10_005 } })).toBe("noLiquidity");
  });

  it("newClientOrderId 生成 v4 uuid;没有 randomUUID(非安全上下文)时用 getRandomValues 拼", () => {
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(newClientOrderId()).toMatch(UUID_V4);
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: real.getRandomValues.bind(real) }, configurable: true });
    try {
      const a = newClientOrderId();
      expect(a).toMatch(UUID_V4);
      expect(newClientOrderId()).not.toBe(a);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });
});

describe("盘口逐档", () => {
  it("bookLevels:卖盘价升序、买盘价降序;没有盘口为空", () => {
    const book = { asks: new Map([[10_010, lvl(10_010, 5)], [10_005, lvl(10_005, 3)]]), bids: new Map([[9_990, lvl(9_990, 1)], [9_995, lvl(9_995, 2)]]) };
    expect(bookLevels(book)).toEqual({ asks: [lvl(10_005, 3), lvl(10_010, 5)], bids: [lvl(9_995, 2), lvl(9_990, 1)] });
    expect(bookLevels(undefined)).toEqual({ asks: [], bids: [] });
    expect(PCT_MARKS).toEqual([0, 25, 50, 75, 100]);
  });

  it("bookTopOf:买盘最高价、卖盘最低价(不看 Map 的插入顺序);一侧没有挂单、没有盘口为 null", () => {
    const book = { asks: new Map([[10_010, lvl(10_010, 5)], [10_005, lvl(10_005, 3)]]), bids: new Map([[9_990, lvl(9_990, 1)], [9_995, lvl(9_995, 2)]]) };
    expect(bookTopOf(book)).toEqual({ bestBid: 9_995, bestAsk: 10_005 });
    expect(bookTopOf({ asks: new Map(), bids: book.bids })).toEqual({ bestBid: 9_995, bestAsk: null });
    expect(bookTopOf(undefined)).toEqual({ bestBid: null, bestAsk: null });
  });

  it("draftCtxOf:顶档与逐档取自同一份盘口", () => {
    const book = { asks: new Map([[10_010, lvl(10_010, 5)], [10_005, lvl(10_005, 3)]]), bids: new Map([[9_995, lvl(9_995, 2)]]) };
    const avail = { cashCents: 1_000, qty: 7 };
    expect(draftCtxOf(instrument, avail, book)).toEqual({ instrument, avail, bookTop: { bestBid: 9_995, bestAsk: 10_005 }, asks: [lvl(10_005, 3), lvl(10_010, 5)], bids: [lvl(9_995, 2)] });
    expect(draftCtxOf(instrument, avail, undefined)).toEqual({ instrument, avail, bookTop: { bestBid: null, bestAsk: null }, asks: [], bids: [] });
  });
});

// 计划 §7.1「盘口更新时 OrderPanel 零提交」、§9.1 第 45 条(P2-08):下单面板不在渲染期订阅顶档。顶档变化经 store.subscribe →
// bookTopWatcher(顶档真的变了才往下走)→ refreshChanges(派生项会变才派发 refresh)。这两道门都不放行时面板没有任何 state 更新,也就没有提交。
describe("盘口顶档变化 → 要不要重算草稿", () => {
  const bookOf = (askLevels: OrderBookLevel[], bidLevels: OrderBookLevel[]) => ({
    asks: new Map(askLevels.map((l) => [l.price, l])),
    bids: new Map(bidLevels.map((l) => [l.price, l])),
  });
  const avail = { cashCents: 1_000_000, qty: 500 };
  const ctxOf = (askLevels: OrderBookLevel[], bidLevels: OrderBookLevel[]): DraftCtx => draftCtxOf(instrument, avail, bookOf(askLevels, bidLevels));
  const movedAsks = [lvl(10_010, 50, 2)]; // 卖一 100.05 被吃掉,顶档移到 100.10
  const movedBids = [lvl(9_990, 100, 3)];

  it("bookTopWatcher:同一个对象、只改深度 / 数量 / 单数的更新不算;最优买价或卖价变了才算,且每次变化只报一次", () => {
    const first = bookOf(asks, bids);
    const moved = bookTopWatcher(first);
    expect(moved(first)).toBe(false);
    // 顶档价位不变:卖一数量变了、深处多了一档、买二被撤
    expect(moved(bookOf([lvl(10_005, 10), lvl(10_010, 50, 2), lvl(10_020, 80)], [lvl(9_995, 40)]))).toBe(false);
    // 卖一移动
    const askMoved = bookOf(movedAsks, bids);
    expect(moved(askMoved)).toBe(true);
    expect(moved(askMoved)).toBe(false);
    expect(moved(bookOf(movedAsks, bids))).toBe(false);
    // 买一移动
    expect(moved(bookOf(movedAsks, movedBids))).toBe(true);
    // 一侧空了、盘口被逐出(换标的后的淘汰)
    expect(moved(bookOf([], movedBids))).toBe(true);
    expect(moved(undefined)).toBe(true);
    expect(moved(undefined)).toBe(false);
  });

  it("bookTopWatcher:一开始没有盘口,快照到了算一次变化;空盘口到空盘口不算", () => {
    const moved = bookTopWatcher(undefined);
    expect(moved(bookOf([], []))).toBe(false);
    expect(moved(bookOf(asks, bids))).toBe(true);
  });

  it("refreshChanges:限价草稿(空的、填了价与量的、按金额的、按滑杆的)不随顶档变 —— 面板不派发", () => {
    const before = ctxOf(asks, bids);
    const after = ctxOf(movedAsks, movedBids);
    const drafts = [
      initialDraft(),
      initialDraft("SELL"),
      run([{ kind: "setPrice", text: "100.00" }, { kind: "setQty", text: "20" }], before),
      run([{ kind: "setPrice", text: "100.00" }, { kind: "setAmount", text: "5000" }], before),
      run([{ kind: "setPrice", text: "100.00" }, { kind: "setPct", pct: 50 }], before),
      // 价格框空着动了数量:参考价已在那次事件里填进价格框,之后顶档再动也不改它
      run([{ kind: "setQty", text: "20" }], before),
    ];
    for (const d of drafts) {
      expect(refreshChanges(d, before)).toBe(false);
      expect(refreshChanges(d, after)).toBe(false);
    }
  });

  it("refreshChanges:市价草稿没填数量时不随顶档变;填了数量 / 金额 / 滑杆,走档结果变了才要重算", () => {
    const before = ctxOf(asks, bids);
    const after = ctxOf(movedAsks, movedBids);
    const empty = run([{ kind: "setType", orderType: "MARKET" }], before);
    expect(refreshChanges(empty, after)).toBe(false);

    const byQty = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "20" }], before);
    expect(byQty.estNotional).toBe(20 * 10_005);
    expect(refreshChanges(byQty, before)).toBe(false);
    expect(refreshChanges(byQty, after)).toBe(true);
    // 重算一次之后就稳定了:同一个上下文不会反复派发
    const refreshed = reduceDraft(byQty, { kind: "refresh" }, after);
    expect(refreshed.estNotional).toBe(20 * 10_010);
    expect(refreshed.amountText).toBe("2002.00");
    expect(refreshChanges(refreshed, after)).toBe(false);

    const byAmount = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setSide", side: "SELL" }, { kind: "setAmount", text: "3000" }], before);
    expect(refreshChanges(byAmount, after)).toBe(true);
    const byPct = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setPct", pct: 100 }], before);
    expect(refreshChanges(byPct, after)).toBe(true);
  });

  it("每个动作的结果对同一个上下文都已稳定(提交后的对账不会多派发一次)", () => {
    const actions: DraftAction[] = [
      { kind: "setType", orderType: "MARKET" },
      { kind: "setQty", text: "30" },
      { kind: "setSide", side: "SELL" },
      { kind: "setAmount", text: "2500" },
      { kind: "setType", orderType: "LIMIT" },
      { kind: "setPrice", text: "99.95" },
      { kind: "setPct", pct: 75 },
      { kind: "applySeed", seed: { symbol: SYMBOL, side: "BUY", price: 10_005, nonce: 1 } },
      { kind: "reset" },
    ];
    let d = initialDraft();
    for (const action of actions) {
      d = reduceDraft(d, action, ctx);
      expect(refreshChanges(d, ctx), action.kind).toBe(false);
    }
  });

  it("校验结果:限价草稿与顶档无关;市价草稿在对手盘空了 / 买不起一吨时才变", () => {
    const before = ctxOf(asks, bids);
    const limit = run([{ kind: "setPrice", text: "100.00" }, { kind: "setQty", text: "20" }], before);
    expect(draftError(limit, before)).toBeNull();
    expect(draftError(limit, ctxOf(movedAsks, movedBids))).toBeNull();
    expect(draftError(limit, ctxOf([], []))).toBeNull();

    const market = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "20" }], before);
    expect(draftError(market, before)).toBeNull();
    expect(draftError(market, ctxOf(movedAsks, movedBids))).toBeNull();
    expect(draftError(market, ctxOf([], bids))).toBe("noLiquidity");
    expect(draftError(market, draftCtxOf(instrument, { cashCents: 10_004, qty: 0 }, bookOf(asks, bids)))).toBe("insufficientCash");
  });

  // 下单表单渲染期唯一读盘口的 selector(OrderPanel:useMarketStore(errorSelector(…)))。useSyncExternalStore 按 Object.is 比较
  // 它先后两次的返回值:相同 ⇒ 顶档变化不让表单重渲染。这里拿「只有盘口不同」的两份 store 状态直接喂它。
  describe("errorSelector:校验结果的 selector", () => {
    const stateOf = (askLevels: OrderBookLevel[], bidLevels: OrderBookLevel[]) => ({ books: { [SYMBOL]: bookOf(askLevels, bidLevels) } });
    const before = stateOf(asks, bids);
    const bothMoved = stateOf(movedAsks, movedBids);
    const same = (select: ReturnType<typeof errorSelector>, a: Parameters<ReturnType<typeof errorSelector>>[0], b: typeof a): boolean => Object.is(select(a), select(b));

    it("还没点过「核对订单」(attempted = false):恒为 null,哪怕草稿不合法、盘口空了", () => {
      const market = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "20" }]);
      for (const d of [initialDraft(), market]) {
        const select = errorSelector(d, instrument, avail, SYMBOL, false);
        for (const state of [before, bothMoved, stateOf([], []), { books: {} }]) expect(select(state)).toBeNull();
      }
    });

    it("限价草稿:顶档怎么动(两侧都移、一侧空、整个盘口没了),结果都是同一个值 —— 合法的恒为 null,不合法的恒为同一条错误", () => {
      const valid = run([{ kind: "setPrice", text: "100.00" }, { kind: "setQty", text: "20" }]);
      const offTick = run([{ kind: "setPrice", text: "100.01" }, { kind: "setQty", text: "20" }]);
      const tooMuch = run([{ kind: "setSide", side: "SELL" }, { kind: "setPrice", text: "100.00" }, { kind: "setQty", text: "510" }]);
      const cases: [Draft, DraftError | null][] = [
        [valid, null],
        [initialDraft(), "invalidPrice"],
        [offTick, "offTick"],
        [tooMuch, "insufficientQty"],
      ];
      for (const [d, expected] of cases) {
        const select = errorSelector(d, instrument, avail, SYMBOL, true);
        expect(select(before), String(expected)).toBe(expected);
        for (const after of [bothMoved, stateOf([], bids), stateOf(asks, []), stateOf([], []), { books: {} }]) expect(same(select, before, after), String(expected)).toBe(true);
      }
    });

    it("市价草稿:走档结果没变的顶档移动(买单只走卖盘,动的是买一)结果相同;走档结果变了但仍然买得起,结果也相同", () => {
      const market = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "20" }]);
      const select = errorSelector(market, instrument, avail, SYMBOL, true);
      expect(select(before)).toBeNull();
      // 只有买一动了:市价买单沿卖盘走档,走档金额不变(refreshChanges 为假 = 面板不派发),校验结果也不变 → 表单零渲染
      expect(refreshChanges(market, ctxOf(asks, movedBids))).toBe(false);
      expect(same(select, before, stateOf(asks, movedBids))).toBe(true);
      // 卖一动了:走档金额变了(那一次渲染是草稿自己的 refresh),校验结果这个 selector 仍是同一个 null
      expect(refreshChanges(market, ctxOf(movedAsks, bids))).toBe(true);
      expect(same(select, before, stateOf(movedAsks, bids))).toBe(true);
      // 不合法的市价草稿(数量没填):错误先于盘口判定,顶档怎么动都是同一条
      const empty = errorSelector(run([{ kind: "setType", orderType: "MARKET" }]), instrument, avail, SYMBOL, true);
      expect(empty(before)).toBe("invalidQty");
      expect(same(empty, before, bothMoved)).toBe(true);
      expect(same(empty, before, stateOf([], []))).toBe(true);
    });

    it("市价草稿:该变的时候变 —— 对手盘空了 / 盘口没了是 noLiquidity,卖一涨到现金买不起一吨是 insufficientCash;对手盘回来就恢复", () => {
      const buy = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "20" }]);
      const select = errorSelector(buy, instrument, avail, SYMBOL, true);
      expect(select(before)).toBeNull();
      expect(select(stateOf([], bids))).toBe("noLiquidity");
      expect(select({ books: {} })).toBe("noLiquidity");
      expect(select(stateOf(asks, []))).toBeNull(); // 买单不看买盘
      expect(select(bothMoved)).toBeNull();

      // 可用现金 100.07:买得起卖一 100.05,卖一移到 100.10 之后买不起
      const tight = errorSelector(buy, instrument, { cashCents: 10_007, qty: 0 }, SYMBOL, true);
      expect(tight(before)).toBeNull();
      expect(tight(stateOf(movedAsks, bids))).toBe("insufficientCash");
      expect(same(tight, before, stateOf(movedAsks, bids))).toBe(false);

      const sell = errorSelector(run([{ kind: "setType", orderType: "MARKET" }, { kind: "setSide", side: "SELL" }, { kind: "setQty", text: "20" }]), instrument, avail, SYMBOL, true);
      expect(sell(before)).toBeNull();
      expect(sell(stateOf(asks, movedBids))).toBeNull();
      expect(sell(stateOf(asks, []))).toBe("noLiquidity");
      expect(sell(stateOf([], bids))).toBeNull(); // 卖单不看卖盘
    });

    it("只认自己的标的:别的标的的盘口怎么变都不影响结果", () => {
      const market = run([{ kind: "setType", orderType: "MARKET" }, { kind: "setQty", text: "20" }]);
      const select = errorSelector(market, instrument, avail, SYMBOL, true);
      const mine = bookOf(asks, bids);
      expect(same(select, { books: { [SYMBOL]: mine, OTHER: bookOf(asks, bids) } }, { books: { [SYMBOL]: mine, OTHER: bookOf([], []) } })).toBe(true);
    });
  });
});
