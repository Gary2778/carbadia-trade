import { describe, expect, it } from "vitest";
import type { Notice } from "@/shared";
import copyEn from "@/i18n/messages/notices/en";
import copyZhCN from "@/i18n/messages/notices/zh-CN";
import { formatNoticeTime, noticeHref, noticeLines, noticeSentence, noticeToastType } from "./notice-text";

// 通知的文字与 Toast 判定(纯函数)。措辞的原文在 src/i18n/messages/notices/(messages.test.ts 钉键与字面);这里钉的是「哪个字段进哪句话」「价格与数量怎么写」「弹不弹 Toast」。

const base = { id: "n-1", createdAt: 1_790_000_000_000, readAt: null } as const;
const fill = (partial: Partial<Extract<Notice, { kind: "fill" }>> = {}): Notice => ({
  ...base,
  kind: "fill",
  orderId: "o-1",
  symbol: "VCS-FOR-2021",
  side: "BUY",
  role: "MAKER",
  quantity: 10,
  price: 6850,
  orderStatus: "FILLED",
  ...partial,
});
const trig = (partial: Partial<Extract<Notice, { kind: "trigger" }>> = {}): Notice => ({
  ...base,
  kind: "trigger",
  triggerId: "t-1",
  symbol: "VCS-FOR-2021",
  outcome: "TRIGGERED",
  reason: null,
  side: "SELL",
  quantity: 5,
  triggerPrice: 7200,
  orderId: "o-2",
  ...partial,
});
const alert = (partial: Partial<Extract<Notice, { kind: "price_alert" }>> = {}): Notice => ({
  ...base,
  kind: "price_alert",
  triggerId: "t-3",
  symbol: "CCER-SOL-2023",
  direction: "ABOVE",
  triggerPrice: 4500,
  firedPrice: 4520,
  ...partial,
});

const en = (n: Notice) => noticeLines(copyEn, n, "en");
const zh = (n: Notice) => noticeLines(copyZhCN, n, "zh-CN");

describe("noticeLines: one plain sentence per notice (project, side, tonnes, price)", () => {
  it("fill: bought / sold, tonnes, project, price; no second line", () => {
    expect(en(fill())).toEqual({ headline: "Bought 10 tonnes of VCS-FOR-2021 at $68.50", detail: null });
    expect(en(fill({ side: "SELL", quantity: 3, price: 9010 }))).toEqual({ headline: "Sold 3 tonnes of VCS-FOR-2021 at $90.10", detail: null });
    expect(zh(fill())).toEqual({ headline: "已买入 10 吨 VCS-FOR-2021，成交价 $68.50", detail: null });
    expect(zh(fill({ side: "SELL" }))).toEqual({ headline: "已卖出 10 吨 VCS-FOR-2021，成交价 $68.50", detail: null });
  });

  it("fill reads the same for a resting order that got matched and for the user's own order (role only decides the toast)", () => {
    expect(en(fill({ role: "TAKER" }))).toEqual(en(fill({ role: "MAKER" })));
    expect(en(fill({ orderStatus: "PARTIAL" }))).toEqual(en(fill({ orderStatus: "FILLED" })));
  });

  it("triggered: says the order was submitted, never filled or bought / sold on its own", () => {
    expect(en(trig())).toEqual({ headline: "Triggered · order submitted: sell 5 tonnes of VCS-FOR-2021 (trigger price $72.00)", detail: null });
    expect(zh(trig())).toEqual({ headline: "已触发 · 委托已提交：卖出 5 吨 VCS-FOR-2021（触发价 $72.00）", detail: null });
    for (const lines of [en(trig({ side: "BUY" })), zh(trig({ side: "BUY" }))]) expect(lines.headline).not.toMatch(/fill|成交|Bought|已买入/);
  });

  it("rejected: the sentence says the order failed and the reason is the second line, one reason per code", () => {
    const reasons = { INSUFFICIENT_CASH: "Not enough cash when it triggered", INSUFFICIENT_QTY: "Not enough holdings when it triggered", INVALID: "The order could not be placed" } as const;
    for (const [reason, text] of Object.entries(reasons)) {
      const code = reason as keyof typeof reasons;
      expect(en(trig({ outcome: "REJECTED", reason: code, side: "BUY", quantity: 1250, triggerPrice: 512_345 }))).toEqual({
        headline: "Order failed: buy 1,250 tonnes of VCS-FOR-2021 (trigger price $5,123.45)",
        detail: text,
      });
    }
    expect(zh(trig({ outcome: "REJECTED", reason: "INSUFFICIENT_CASH", side: "BUY", quantity: 1250 }))).toEqual({
      headline: "下单失败：买入 1,250 吨 VCS-FOR-2021（触发价 $72.00）",
      detail: "触发时资金不足",
    });
  });

  it("rejected for NO_FILL (a market order went in but nothing filled): not 'Order failed' and the reason follows the side", () => {
    expect(en(trig({ outcome: "REJECTED", reason: "NO_FILL", side: "BUY", quantity: 20, triggerPrice: 3000 }))).toEqual({
      headline: "Triggered, but nothing filled: buy 20 tonnes of VCS-FOR-2021 (trigger price $30.00)",
      detail: "Not enough cash, or no one was selling",
    });
    expect(en(trig({ outcome: "REJECTED", reason: "NO_FILL", side: "SELL" }))).toEqual({
      headline: "Triggered, but nothing filled: sell 5 tonnes of VCS-FOR-2021 (trigger price $72.00)",
      detail: "No one was buying",
    });
    expect(zh(trig({ outcome: "REJECTED", reason: "NO_FILL", side: "BUY", quantity: 20, triggerPrice: 3000 }))).toEqual({
      headline: "已触发，但没有成交：买入 20 吨 VCS-FOR-2021（触发价 $30.00）",
      detail: "资金不足，或者没有人在卖",
    });
    expect(zh(trig({ outcome: "REJECTED", reason: "NO_FILL", side: "SELL" }))).toEqual({
      headline: "已触发，但没有成交：卖出 5 吨 VCS-FOR-2021（触发价 $72.00）",
      detail: "没有人在买",
    });
    // 没有方向(只可能是手工改库)就不编原因,标题只写标的
    expect(en(trig({ outcome: "REJECTED", reason: "NO_FILL", side: null }))).toEqual({
      headline: "Triggered, but nothing filled: VCS-FOR-2021 (trigger price $72.00)",
      detail: null,
    });
    // NO_FILL 只属于被拒;别的结果带着它(脏数据)不改说法
    expect(en(trig({ outcome: "TRIGGERED", reason: "NO_FILL" })).headline).toMatch(/^Triggered · order submitted/);
    expect(en(trig({ outcome: "CANCELLED", reason: "NO_FILL" })).detail).toBeNull();
  });

  it("cancelled (the other order of a take-profit / stop-loss pair triggered): cancelled + the OCO reason", () => {
    expect(en(trig({ outcome: "CANCELLED", reason: "OCO", triggerPrice: 6500 }))).toEqual({
      headline: "Cancelled: sell 5 tonnes of VCS-FOR-2021 (trigger price $65.00)",
      detail: "The other order of the pair triggered first",
    });
    expect(zh(trig({ outcome: "CANCELLED", reason: "OCO" })).detail).toBe("同组的另一单先触发了");
  });

  it("a reason that cannot belong to the outcome never leaks: none for triggered, none for USER (a user's own cancel has no notice), none for null", () => {
    expect(en(trig({ outcome: "TRIGGERED", reason: "INSUFFICIENT_CASH" })).detail).toBeNull();
    expect(en(trig({ outcome: "CANCELLED", reason: "USER" })).detail).toBeNull();
    expect(en(trig({ outcome: "REJECTED", reason: null })).detail).toBeNull();
  });

  it("a trigger notice without a side or a quantity (only a hand-edited row) names the project only and invents no direction", () => {
    expect(en(trig({ side: null })).headline).toBe("Triggered · order submitted: VCS-FOR-2021 (trigger price $72.00)");
    expect(zh(trig({ quantity: null })).headline).toBe("已触发 · 委托已提交：VCS-FOR-2021（触发价 $72.00）");
  });

  it("price alert: which way it moved, the price it reached and the alert price", () => {
    expect(en(alert())).toEqual({ headline: "Price alert: CCER-SOL-2023 rose to $45.20 (your alert price $45.00)", detail: null });
    expect(en(alert({ direction: "BELOW", triggerPrice: 2000, firedPrice: 1990 })).headline).toBe("Price alert: CCER-SOL-2023 fell to $19.90 (your alert price $20.00)");
    expect(zh(alert()).headline).toBe("价格提醒：CCER-SOL-2023 涨到 $45.20（你设的提醒价 $45.00）");
    expect(zh(alert({ direction: "BELOW" })).headline).toContain("跌到");
  });

  it("writes prices with two decimals and the language's separators, whatever the symbol's own precision", () => {
    expect(en(fill({ price: 100 })).headline).toBe("Bought 10 tonnes of VCS-FOR-2021 at $1.00");
    expect(en(fill({ price: 123_456_789 })).headline).toBe("Bought 10 tonnes of VCS-FOR-2021 at $1,234,567.89");
    expect(noticeLines(copyEn, fill({ quantity: 12_345 }), "de-DE").headline).toBe("Bought 12.345 tonnes of VCS-FOR-2021 at $68,50");
  });
});

describe("noticeLines: a notice kind this tab does not know", () => {
  it("returns a generic line (an older tab meeting a kind added later must not crash the panel or the toast)", () => {
    const future = { ...base, kind: "margin_call", symbol: "VCS-FOR-2021" } as unknown as Notice;
    expect(en(future)).toEqual({ headline: "New notification", detail: null });
    expect(zh(future)).toEqual({ headline: "新通知", detail: null });
    expect(noticeSentence(en(future))).toBe("New notification");
  });
});

describe("noticeSentence (the toast text)", () => {
  it("is the headline, followed by the reason when there is one", () => {
    expect(noticeSentence(en(fill()))).toBe("Bought 10 tonnes of VCS-FOR-2021 at $68.50");
    expect(noticeSentence(en(trig({ outcome: "REJECTED", reason: "INVALID" })))).toBe(
      "Order failed: sell 5 tonnes of VCS-FOR-2021 (trigger price $72.00) · The order could not be placed",
    );
    expect(noticeSentence(zh(trig({ outcome: "CANCELLED", reason: "OCO" })))).toBe("已撤销：卖出 5 吨 VCS-FOR-2021（触发价 $72.00） · 同组的另一单先触发了");
  });
});

describe("noticeToastType (which live notices pop a toast)", () => {
  const mine = new Set(["o-mine"]);
  const isOwn = (id: string) => mine.has(id);
  const takerOf = (orderId: string, partial: Partial<Extract<Notice, { kind: "fill" }>> = {}) => fill({ role: "TAKER", orderId, ...partial });

  it("skips the taker fill of an order this tab itself just submitted (its order toast already said it)", () => {
    expect(noticeToastType(takerOf("o-mine"), isOwn)).toBeNull();
    expect(noticeToastType(takerOf("o-mine", { side: "SELL", orderStatus: "PARTIAL" }), isOwn)).toBeNull();
  });

  it("toasts the taker fill of an order that is not one of this tab's (a fired conditional order's market order: the user heard only 'order submitted' so far)", () => {
    expect(noticeToastType(takerOf("o-from-trigger"), isOwn)).toBe("info");
    expect(noticeToastType(takerOf("o-mine"), () => false)).toBe("info");
  });

  it("toasts every maker fill as info, whether or not the order id is this tab's", () => {
    expect(noticeToastType(fill({ role: "MAKER", orderId: "o-mine" }), isOwn)).toBe("info");
    expect(noticeToastType(fill({ role: "MAKER" }), isOwn)).toBe("info");
  });

  it("a rejected trigger is a warning (NO_FILL included); triggered, cancelled and price alerts are info", () => {
    expect(noticeToastType(trig({ outcome: "REJECTED", reason: "INSUFFICIENT_CASH" }), isOwn)).toBe("warning");
    expect(noticeToastType(trig({ outcome: "REJECTED", reason: "NO_FILL" }), isOwn)).toBe("warning");
    expect(noticeToastType(trig({ outcome: "TRIGGERED" }), isOwn)).toBe("info");
    expect(noticeToastType(trig({ outcome: "CANCELLED", reason: "OCO" }), isOwn)).toBe("info");
    expect(noticeToastType(alert(), isOwn)).toBe("info");
  });

  it("only asks about orders for taker fills", () => {
    const asked: string[] = [];
    const spy = (id: string) => (asked.push(id), false);
    noticeToastType(fill({ role: "MAKER", orderId: "o-1" }), spy);
    noticeToastType(trig(), spy);
    noticeToastType(alert(), spy);
    expect(asked).toEqual([]);
    noticeToastType(takerOf("o-2"), spy);
    expect(asked).toEqual(["o-2"]);
  });
});

describe("noticeHref / formatNoticeTime", () => {
  it("links to the symbol's terminal page, encoded", () => {
    expect(noticeHref(fill())).toBe("/trade/VCS-FOR-2021");
    expect(noticeHref(fill({ symbol: "A B/C" }))).toBe("/trade/A%20B%2FC");
  });

  it("writes MM/DD HH:mm:ss, 24 hour, in the browser's time zone; a broken timestamp is a dash", () => {
    const ms = new Date(2026, 9, 2, 13, 4, 22).getTime(); // 本地时间:不依赖运行机器的时区
    expect(formatNoticeTime(ms, "zh-CN", "local")).toBe("10/02 13:04:22");
    expect(formatNoticeTime(ms, "en", "local")).toBe("10/02, 13:04:22");
    expect(formatNoticeTime(new Date(2026, 9, 2, 0, 5, 0).getTime(), "zh-CN", "local")).toBe("10/02 00:05:00");
    expect(formatNoticeTime(Number.NaN, "en", "local")).toBe("—");
  });

  it("follows the time-zone preference: the same instant reads as the Beijing or the UTC wall clock", () => {
    const ms = Date.UTC(2026, 9, 2, 5, 4, 22);
    expect(formatNoticeTime(ms, "zh-CN", "UTC")).toBe("10/02 05:04:22");
    expect(formatNoticeTime(ms, "zh-CN", "Asia/Shanghai")).toBe("10/02 13:04:22");
    expect(formatNoticeTime(ms, "en", "Asia/Shanghai")).toBe("10/02, 13:04:22");
  });
});
