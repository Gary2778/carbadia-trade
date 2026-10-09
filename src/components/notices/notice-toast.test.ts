import { describe, expect, it, vi } from "vitest";
import type { PushToast } from "@/components/anim/Toast";
import type { Notice } from "@/shared";
import { NOTICE_TOAST_MS, toastNotice } from "./notice-toast";

// 一条实时通知 → push 什么(类型、文字、dedupeKey、存活时间),按界面语言;弹不弹由 notice-text.test.ts 的判定表管,这里钉接线。
const base = { id: "n-1", createdAt: 1_790_000_000_000, readAt: null } as const;
const takerFill: Notice = { ...base, kind: "fill", orderId: "o-1", symbol: "VCS-FOR-2021", side: "BUY", role: "TAKER", quantity: 3, price: 6850, orderStatus: "FILLED" };
const rejected: Notice = { ...base, id: "n-2", kind: "trigger", triggerId: "t-1", symbol: "VCS-FOR-2021", outcome: "REJECTED", reason: "NO_FILL", side: "SELL", quantity: 5, triggerPrice: 7200, orderId: "o-2" };

describe("toastNotice", () => {
  it("pushes the sentence with the notice id as dedupe key and a longer lifetime than the default toast", () => {
    const push = vi.fn<PushToast>();
    toastNotice(takerFill, "en", push, () => false);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("info", "Bought 3 tonnes of VCS-FOR-2021 at $68.50", { dedupeKey: "n-1", ttlMs: NOTICE_TOAST_MS });
    expect(NOTICE_TOAST_MS).toBeGreaterThan(3200);
  });

  it("speaks the current language and warns about a rejected trigger, reason included", () => {
    const push = vi.fn<PushToast>();
    toastNotice(rejected, "zh-CN", push);
    expect(push).toHaveBeenCalledWith("warning", "已触发，但没有成交：卖出 5 吨 VCS-FOR-2021（触发价 $72.00） · 没有人在买", { dedupeKey: "n-2", ttlMs: NOTICE_TOAST_MS });
  });

  it("pushes nothing for the taker fill of an order this tab submitted", () => {
    const push = vi.fn<PushToast>();
    toastNotice(takerFill, "en", push, (id) => id === "o-1");
    expect(push).not.toHaveBeenCalled();
  });

  it("a notice kind this tab does not know becomes a generic info toast instead of throwing", () => {
    const push = vi.fn<PushToast>();
    const future = { ...base, id: "n-9", kind: "margin_call", symbol: "VCS-FOR-2021" } as unknown as Notice;
    expect(() => toastNotice(future, "en", push)).not.toThrow();
    expect(push).toHaveBeenCalledWith("info", "New notification", { dedupeKey: "n-9", ttlMs: NOTICE_TOAST_MS });
  });
});
