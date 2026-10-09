import { describe, expect, it } from "vitest";
import { MAX_PRICE_CENTS, type DraftInstrument, type TriggerDraftField } from "./order-math";
import { validateAlertDraft, validateOcoDraft, type OcoDraft } from "./trigger-drafts";
import type { TriggerDraftError } from "./types";

// 止盈止损与价格提醒的草稿校验(P3-07 复审时从 order-math.ts 挪到 trigger-drafts.ts,用例原样搬来;十四个错误码的覆盖仍在 order-math.test.ts)
const instrument: DraftInstrument = { id: "asset-1", tickSize: 5, qtyStep: 10, minQty: 10 };

describe("validateAlertDraft", () => {
  const LAST = 10_000;
  const cases: [string, TriggerDraftError, TriggerDraftField, Parameters<typeof validateAlertDraft>[0], (number | null)?][] = [
    ["价格空", "invalidTrigger", "triggerPrice", { triggerPrice: null }],
    ["价格超上限", "overMaxPrice", "triggerPrice", { triggerPrice: MAX_PRICE_CENTS + 5 }],
    ["价格不在 tick 上", "offTick", "triggerPrice", { triggerPrice: 10_502 }],
    ["等于最新价", "wouldTriggerNow", "triggerPrice", { triggerPrice: LAST }],
    ["最新价未知又没选方向", "directionNeeded", "direction", { triggerPrice: 10_500 }, null],
  ];
  it.each(cases)("%s → %s", (_name, reason, field, draft, last = LAST) => {
    expect(validateAlertDraft(draft, instrument, last)).toEqual({ ok: false, reason, field });
  });

  it("合法:方向由价格与最新价定;最新价未知时用选的方向", () => {
    expect(validateAlertDraft({ triggerPrice: 9_000 }, instrument, LAST)).toEqual({ ok: true, alert: { assetId: "asset-1", direction: "BELOW", triggerPrice: 9_000 } });
    expect(validateAlertDraft({ triggerPrice: 11_000 }, instrument, LAST)).toEqual({ ok: true, alert: { assetId: "asset-1", direction: "ABOVE", triggerPrice: 11_000 } });
    expect(validateAlertDraft({ triggerPrice: 11_000, direction: "ABOVE" }, instrument, null)).toEqual({ ok: true, alert: { assetId: "asset-1", direction: "ABOVE", triggerPrice: 11_000 } });
  });
});

describe("validateOcoDraft", () => {
  const LAST = 10_000;
  const POSITION = 100;
  const both: OcoDraft = { takeProfit: 11_000, stopLoss: 9_000, quantity: 50 };

  const cases: [string, TriggerDraftError, TriggerDraftField, OcoDraft, (number | null)?, number?][] = [
    ["两个价都没填", "ocoNeedsOne", "form", { takeProfit: null, stopLoss: null, quantity: 50 }],
    ["止盈价垃圾输入(填了但无效,不当作没填)", "invalidPrice", "takeProfit", { takeProfit: NaN, stopLoss: null, quantity: 50 }],
    ["止盈价 0", "invalidPrice", "takeProfit", { ...both, takeProfit: 0 }],
    ["止盈价超上限", "overMaxPrice", "takeProfit", { ...both, takeProfit: MAX_PRICE_CENTS + 5 }],
    ["止盈价不在 tick 上", "offTick", "takeProfit", { ...both, takeProfit: 11_002 }],
    ["止损价非整数", "invalidPrice", "stopLoss", { ...both, stopLoss: 9_000.5 }],
    ["止损价超上限(止盈没填)", "overMaxPrice", "stopLoss", { takeProfit: null, stopLoss: MAX_PRICE_CENTS + 5, quantity: 50 }],
    ["止损价不在 tick 上", "offTick", "stopLoss", { ...both, stopLoss: 9_002 }],
    ["止盈价等于最新价", "takeProfitTooLow", "takeProfit", { ...both, takeProfit: LAST }],
    ["止盈价低于最新价", "takeProfitTooLow", "takeProfit", { ...both, takeProfit: 9_500 }],
    ["止损价等于最新价", "stopLossTooHigh", "stopLoss", { ...both, stopLoss: LAST }],
    ["止损价高于最新价(只填止损)", "stopLossTooHigh", "stopLoss", { takeProfit: null, stopLoss: 10_500, quantity: 50 }],
    ["最新价未知,止盈不高于止损", "takeProfitTooLow", "takeProfit", { ...both, takeProfit: 9_000 }, null],
    ["数量空", "invalidQty", "quantity", { ...both, quantity: null }],
    ["数量 0", "invalidQty", "quantity", { ...both, quantity: 0 }],
    ["数量非整数", "invalidQty", "quantity", { ...both, quantity: 10.5 }],
    ["数量不是 step 倍数", "offStep", "quantity", { ...both, quantity: 15 }],
    ["数量超过持仓", "overPosition", "quantity", { ...both, quantity: 110 }],
    ["没有持仓", "overPosition", "quantity", both, LAST, 0],
  ];
  it.each(cases)("%s → %s(归到 %s)", (_name, reason, field, draft, last = LAST, position = POSITION) => {
    expect(validateOcoDraft(draft, instrument, last, position)).toEqual({ ok: false, reason, field });
  });

  it("两个价都给:止盈 > 最新价 > 止损,数量是 step 的倍数且 ≤ 持仓,给出 submitOco 的输入", () => {
    expect(validateOcoDraft(both, instrument, LAST, POSITION)).toEqual({ ok: true, oco: { assetId: "asset-1", quantity: 50, takeProfit: 11_000, stopLoss: 9_000 } });
  });

  it("只给一个价也行,另一个保持 null", () => {
    expect(validateOcoDraft({ ...both, stopLoss: null }, instrument, LAST, POSITION)).toEqual({ ok: true, oco: { assetId: "asset-1", quantity: 50, takeProfit: 11_000, stopLoss: null } });
    expect(validateOcoDraft({ ...both, takeProfit: null }, instrument, LAST, POSITION)).toEqual({ ok: true, oco: { assetId: "asset-1", quantity: 50, takeProfit: null, stopLoss: 9_000 } });
  });

  it("数量恰好等于持仓合法(持仓总数量,含被挂卖单锁着的部分,与服务端同一口径)", () => {
    expect(validateOcoDraft({ ...both, quantity: POSITION }, instrument, LAST, POSITION).ok).toBe(true);
  });

  it("最新价未知:不拿最新价比,止盈 > 止损即可;只填一个价时没有可比的", () => {
    expect(validateOcoDraft(both, instrument, null, POSITION).ok).toBe(true);
    expect(validateOcoDraft({ ...both, stopLoss: null, takeProfit: 5 }, instrument, null, POSITION).ok).toBe(true);
  });

  it("不查 minQty(服务端创建 OCO 不要求,与简报一致);持仓不是有限数时按超出处理", () => {
    expect(validateOcoDraft({ ...both, quantity: 20 }, { ...instrument, minQty: 30 }, LAST, POSITION).ok).toBe(true);
    expect(validateOcoDraft(both, instrument, LAST, NaN)).toEqual({ ok: false, reason: "overPosition", field: "quantity" });
  });
});
