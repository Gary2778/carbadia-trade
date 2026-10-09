import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Me, Notice } from "@/shared";
import { ApiError } from "@/lib/http/client";
import { requestNoticeRefresh } from "./account-bridge";
import { accountActions, applyAccountEvents, createInitialAccountState, setMe, useAccountStore, type AccountEvent, type FetchJson } from "./account-store";
import { NOTICE_POLL_MIN_MS, NOTICE_REFRESH_TIMEOUT_MS, noticeRefreshDue, refreshUnreadNotices, watchNoticeRefresh } from "./notice-refresh";

// 未读通知数的重读(WS 订阅快照到了 / 标签页回到前台 / 轮询的一轮):调度(纯判定 + 在途 / 限流)、带戳写回、失败静默、桥接与前台监听。node 环境,注入 fetch。
const NOTICES_ONE_URL = "/api/account/notices?limit=1";
const pageOf = (unread: number) => ({ items: [], nextCursor: null, unread });
const alice: NonNullable<Me> = { id: "u-alice", email: "alice@example.com", name: "Alice", cashBalance: 100_000_00, lockedCash: 0, unreadNotices: 0 };
const bob: NonNullable<Me> = { id: "u-bob", email: "bob@example.com", name: "Bob", cashBalance: 50_000_00, lockedCash: 0, unreadNotices: 0 };
const notice = (id: string): Notice => ({ id, createdAt: 1_000, readAt: null, kind: "price_alert", triggerId: `t-${id}`, symbol: "VCS-FOR-2021", direction: "ABOVE", triggerPrice: 7000, firedPrice: 7010 });
const noticeEvent = (n: Notice, unread: number): AccountEvent => ({ t: "notice", topic: "account", seq: 1, notice: n, unread });

/** 按 URL 应答的假 fetchJson:值可以是数据、Error(抛出)或返回 Promise 的函数(测试自己决定何时回) */
function fakeFetch(routes: Record<string, unknown | Error | (() => Promise<unknown>)>) {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fetchJson: FetchJson = async <T,>(url: string, init?: RequestInit) => {
    calls.push(url);
    signals.push(init?.signal ?? undefined);
    const r = routes[url];
    if (r instanceof Error) throw r;
    if (typeof r === "function") return (await (r as () => Promise<unknown>)()) as T;
    return r as T;
  };
  return { fetchJson, calls, signals };
}
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function seedAlice() {
  useAccountStore.setState({ ...createInitialAccountState(), me: { ...alice }, balance: { cashBalance: alice.cashBalance, lockedCash: 0 }, status: "ready" }, true);
}

describe("noticeRefreshDue (the schedule of re-reading the unread count)", () => {
  it("a subscribed snapshot and a tab coming back are always due, a poll round only every 30 s", () => {
    expect(NOTICE_POLL_MIN_MS).toBe(30_000);
    for (const reason of ["subscribed", "visible"] as const) expect(noticeRefreshDue(reason, 1_000, 999, false), reason).toBe(true);
    expect(noticeRefreshDue("poll", 31_000, 1_000, false)).toBe(true);
    expect(noticeRefreshDue("poll", 30_999, 1_000, false)).toBe(false);
    expect(noticeRefreshDue("poll", 6_000, 1_000, false)).toBe(false);
    expect(noticeRefreshDue("poll", 1_000, Number.NEGATIVE_INFINITY, false)).toBe(true);
  });

  it("a stale write-back's re-read is due like a snapshot or a tab coming back (not throttled)", () => {
    expect(noticeRefreshDue("stale", 1_000, 999, false)).toBe(true);
  });

  it("never while a read is in flight, whatever the reason", () => {
    for (const reason of ["subscribed", "visible", "poll", "stale"] as const) expect(noticeRefreshDue(reason, 1_000_000, 0, true), reason).toBe(false);
  });

  it("a clock that went backwards does not block polling for good", () => {
    expect(noticeRefreshDue("poll", 1_000, 500_000, false)).toBe(true);
  });
});

describe("refreshUnreadNotices", () => {
  // 模块级的节流状态在用例之间留着:每个用例把时间拨到很远的新起点,轮询的 30 s 窗口互不影响
  let epoch = 1_800_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    epoch += 3_600_000;
    vi.setSystemTime(epoch);
    seedAlice();
  });
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(NOTICE_REFRESH_TIMEOUT_MS); // 让还挂着的请求到期,单飞不带进下一个用例
    vi.useRealTimers();
  });

  it("reads GET /api/account/notices?limit=1 and writes its unread count into the badge", async () => {
    const { fetchJson, calls } = fakeFetch({ [NOTICES_ONE_URL]: pageOf(8) });
    await refreshUnreadNotices("subscribed", fetchJson);
    expect(calls).toEqual([NOTICES_ONE_URL]);
    expect(useAccountStore.getState().unreadNotices).toBe(8);
  });

  it("does nothing while nobody is logged in or the state is not ready", () => {
    const { fetchJson, calls } = fakeFetch({ [NOTICES_ONE_URL]: pageOf(1) });
    useAccountStore.setState({ ...createInitialAccountState(), status: "anon", me: null }, true);
    expect(refreshUnreadNotices("visible", fetchJson)).toBeNull();
    useAccountStore.setState({ ...createInitialAccountState(), status: "loading" }, true);
    expect(refreshUnreadNotices("subscribed", fetchJson)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does not send a second read while one is in flight, and sends again once it finished", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetchJson, calls } = fakeFetch({ [NOTICES_ONE_URL]: () => gate.then(() => pageOf(2)) });
    const first = refreshUnreadNotices("subscribed", fetchJson);
    expect(first).not.toBeNull();
    expect(refreshUnreadNotices("visible", fetchJson)).toBeNull();
    expect(refreshUnreadNotices("poll", fetchJson)).toBeNull();
    release();
    await first;
    expect(calls).toHaveLength(1);
    await refreshUnreadNotices("visible", fakeFetch({ [NOTICES_ONE_URL]: pageOf(3) }).fetchJson);
    expect(useAccountStore.getState().unreadNotices).toBe(3);
  });

  it("in polling mode reads at most once every 30 s however often the poll round asks", async () => {
    const { fetchJson, calls } = fakeFetch({ [NOTICES_ONE_URL]: pageOf(4) });
    await refreshUnreadNotices("poll", fetchJson);
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(epoch + (i + 1) * 5_000); // pollAccount 每 5 s 一轮
      expect(refreshUnreadNotices("poll", fetchJson)).toBeNull();
    }
    expect(calls).toHaveLength(1);
    vi.setSystemTime(epoch + NOTICE_POLL_MIN_MS);
    await refreshUnreadNotices("poll", fetchJson);
    expect(calls).toHaveLength(2);
  });

  it("a snapshot or a tab coming back still reads inside the poll window", async () => {
    const { fetchJson, calls } = fakeFetch({ [NOTICES_ONE_URL]: pageOf(1) });
    await refreshUnreadNotices("poll", fetchJson);
    await refreshUnreadNotices("subscribed", fetchJson);
    await refreshUnreadNotices("visible", fetchJson);
    expect(calls).toHaveLength(3);
  });

  it("drops an answer that is older than a notice event that arrived while it was in flight, or when the user changed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = refreshUnreadNotices("subscribed", fakeFetch({ [NOTICES_ONE_URL]: () => gate.then(() => pageOf(0)) }).fetchJson);
    applyAccountEvents([noticeEvent(notice("n-1"), 5)]);
    release();
    await slow;
    expect(useAccountStore.getState().unreadNotices).toBe(5);

    let release2!: () => void;
    const gate2 = new Promise<void>((resolve) => (release2 = resolve));
    const other = refreshUnreadNotices("visible", fakeFetch({ [NOTICES_ONE_URL]: () => gate2.then(() => pageOf(0)) }).fetchJson);
    setMe({ ...bob, unreadNotices: 9 });
    release2();
    await other;
    expect(useAccountStore.getState().unreadNotices).toBe(9);
  });

  it("a failed read is silent, keeps the badge as it was, and does not block the next one", async () => {
    applyAccountEvents([noticeEvent(notice("n-1"), 3)]);
    await refreshUnreadNotices("subscribed", fakeFetch({ [NOTICES_ONE_URL]: new ApiError("Failed to fetch", 0) }).fetchJson);
    expect(useAccountStore.getState().unreadNotices).toBe(3);
    await refreshUnreadNotices("visible", fakeFetch({ [NOTICES_ONE_URL]: pageOf(2) }).fetchJson);
    expect(useAccountStore.getState().unreadNotices).toBe(2);
  });

  it("a write-back that throws still releases the single flight (the next read goes out)", async () => {
    // 应答对象的 unread 一读就抛:模拟写回里的任何异常
    const broken = { items: [], nextCursor: null, get unread(): number { throw new Error("write-back failed"); } };
    const first = refreshUnreadNotices("subscribed", fakeFetch({ [NOTICES_ONE_URL]: broken }).fetchJson);
    expect(first).not.toBeNull();
    await expect(first).rejects.toThrow("write-back failed");
    const next = fakeFetch({ [NOTICES_ONE_URL]: pageOf(6) });
    await refreshUnreadNotices("visible", next.fetchJson);
    expect(next.calls).toEqual([NOTICES_ONE_URL]);
    expect(useAccountStore.getState().unreadNotices).toBe(6);
  });

  it(`gives every read a deadline (${NOTICE_REFRESH_TIMEOUT_MS} ms): a hung request is aborted and releases the single flight, so later reads still go out`, async () => {
    expect(NOTICE_REFRESH_TIMEOUT_MS).toBe(10_000);
    let answerLate!: () => void;
    const late = new Promise<void>((resolve) => (answerLate = resolve));
    const hung = fakeFetch({ [NOTICES_ONE_URL]: () => late.then(() => pageOf(9)) });
    const first = refreshUnreadNotices("subscribed", hung.fetchJson);
    expect(first).not.toBeNull();
    expect(hung.signals[0]).toBeInstanceOf(AbortSignal);
    // 挂着的时候:别的时机的重读被单飞挡掉(期限之内)
    expect(refreshUnreadNotices("visible", hung.fetchJson)).toBeNull();
    await vi.advanceTimersByTimeAsync(NOTICE_REFRESH_TIMEOUT_MS - 1);
    expect(hung.signals[0]?.aborted).toBe(false);
    expect(refreshUnreadNotices("visible", hung.fetchJson)).toBeNull();
    // 到点:abort、放弃这一次、释放单飞
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(hung.signals[0]?.aborted).toBe(true);
    // 之后的重读照常发(订阅快照、回到前台、轮询都不再被它挡住)
    const ok = fakeFetch({ [NOTICES_ONE_URL]: pageOf(4) });
    await refreshUnreadNotices("visible", ok.fetchJson);
    expect(ok.calls).toEqual([NOTICES_ONE_URL]);
    expect(useAccountStore.getState().unreadNotices).toBe(4);
    // 迟到的旧应答不再写角标、也不动后来的单飞
    answerLate();
    await settle();
    expect(useAccountStore.getState().unreadNotices).toBe(4);
    await refreshUnreadNotices("subscribed", fakeFetch({ [NOTICES_ONE_URL]: pageOf(1) }).fetchJson);
    expect(useAccountStore.getState().unreadNotices).toBe(1);
  });

  it("a read that answers in time clears its deadline (no abort afterwards) and in polling mode the 30 s window still counts from the one that hung", async () => {
    const quick = fakeFetch({ [NOTICES_ONE_URL]: pageOf(2) });
    await refreshUnreadNotices("subscribed", quick.fetchJson);
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MIN_MS + 1_000);
    expect(quick.signals[0]?.aborted).toBe(false);
    const hung = fakeFetch({ [NOTICES_ONE_URL]: () => new Promise<never>(() => {}) });
    const started = refreshUnreadNotices("poll", hung.fetchJson);
    await vi.advanceTimersByTimeAsync(NOTICE_REFRESH_TIMEOUT_MS);
    await started;
    expect(refreshUnreadNotices("poll", hung.fetchJson)).toBeNull(); // 距上一次发出不足 30 s:轮询照旧限流
    await vi.advanceTimersByTimeAsync(NOTICE_POLL_MIN_MS);
    expect(refreshUnreadNotices("poll", fakeFetch({ [NOTICES_ONE_URL]: pageOf(3) }).fetchJson)).not.toBeNull();
    await settle();
  });

  it("a stale re-read goes out at once when idle; when one is in flight it is queued and runs once after it (that read was sent before the newer event)", async () => {
    // 空闲:马上发
    const idle = fakeFetch({ [NOTICES_ONE_URL]: pageOf(7) });
    await refreshUnreadNotices("stale", idle.fetchJson);
    expect(idle.calls).toHaveLength(1);
    expect(useAccountStore.getState().unreadNotices).toBe(7);
    // 在途:不另发,排队;在途的结束(成功或失败)之后补读一次,只一次
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let n = 0;
    const calls: string[] = [];
    const fetchJson: FetchJson = async <T,>(url: string) => {
      calls.push(url);
      n++;
      if (n === 1) await gate;
      return pageOf(n === 1 ? 10 : 2) as T;
    };
    const first = refreshUnreadNotices("subscribed", fetchJson);
    expect(refreshUnreadNotices("stale", fetchJson)).toBeNull();
    expect(refreshUnreadNotices("stale", fetchJson)).toBeNull();
    expect(calls).toHaveLength(1);
    release();
    await first;
    await settle();
    expect(calls).toHaveLength(2);
    expect(useAccountStore.getState().unreadNotices).toBe(2);
    await settle();
    expect(calls).toHaveLength(2);
    // 没有 stale 排队时,在途的结束之后什么都不补
    const plain = fakeFetch({ [NOTICES_ONE_URL]: pageOf(5) });
    await refreshUnreadNotices("subscribed", plain.fetchJson);
    await settle();
    expect(plain.calls).toHaveLength(1);
  });

  it("is what the account bridge calls: the snapshot and the poll round ask for it through requestNoticeRefresh", async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() => Promise.resolve(new Response(JSON.stringify({ ok: true, data: pageOf(6) }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetchMock);
    onTestFinished(() => void vi.unstubAllGlobals());
    requestNoticeRefresh("subscribed");
    await vi.waitFor(() => expect(useAccountStore.getState().unreadNotices).toBe(6));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(NOTICES_ONE_URL);
    // 写回走 accountActions.setUnreadNotices(带戳),不另开写入路径
    expect(accountActions.setUnreadNotices).toBeTypeOf("function");
  });
});

describe("watchNoticeRefresh (the tab comes back to the foreground)", () => {
  let epoch = 1_900_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    epoch += 3_600_000;
    vi.setSystemTime(epoch);
    seedAlice();
  });
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(NOTICE_REFRESH_TIMEOUT_MS); // 让还挂着的请求到期,单飞不带进下一个用例
    vi.useRealTimers();
  });

  const fakeDocument = () => Object.assign(new EventTarget(), { visibilityState: "hidden" as DocumentVisibilityState });

  it("reads when the page becomes visible, not when it becomes hidden, and stops after the returned cleanup", async () => {
    const doc = fakeDocument();
    const { fetchJson, calls } = fakeFetch({ [NOTICES_ONE_URL]: pageOf(5) });
    const stop = watchNoticeRefresh({ document: doc, fetchJson });
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls).toEqual([]);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls).toEqual([NOTICES_ONE_URL]);
    expect(useAccountStore.getState().unreadNotices).toBe(5);
    stop();
    doc.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("is a no-op without a document (server side)", () => {
    expect(typeof globalThis.document).toBe("undefined");
    expect(watchNoticeRefresh()).toBeTypeOf("function");
  });
});
