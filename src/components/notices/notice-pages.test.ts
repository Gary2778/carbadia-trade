import { describe, expect, it } from "vitest";
import type { Notice, NoticesResponse } from "@/shared";
import { INITIAL_NOTICE_PAGES, MARK_READ_MAX_IDS, reduceNoticePages, unreadIdsToMark, type NoticePagesAction, type NoticePagesState } from "./notice-pages";

// 通知面板的翻页状态机(纯 reducer):首页 loading → ready / error(可重试),「加载更多」只在 ready 且还有下一页、没在取时才开始,
// 到达 / 失败的结果只落在对应的在途请求上 —— 迟到的、重复的动作一律无变化(返回同一个对象)。

const notice = (id: string, readAt: number | null = null): Notice => ({ id, createdAt: 1_000, readAt, kind: "price_alert", triggerId: `t-${id}`, symbol: "VCS-FOR-2021", direction: "ABOVE", triggerPrice: 7000, firedPrice: 7010 });
const page = (ids: string[], nextCursor: string | null, unread = 0): NoticesResponse => ({ items: ids.map((id) => notice(id)), nextCursor, unread });
const run = (actions: NoticePagesAction[], from: NoticePagesState = INITIAL_NOTICE_PAGES) => actions.reduce(reduceNoticePages, from);

describe("reduceNoticePages", () => {
  it("starts loading and becomes ready with the first page and its cursor", () => {
    expect(INITIAL_NOTICE_PAGES).toEqual({ phase: "loading" });
    expect(run([{ kind: "loaded", page: page(["a", "b"], "c1", 3) }])).toEqual({ phase: "ready", items: [notice("a"), notice("b")], nextCursor: "c1", more: "idle", moreCursor: null });
  });

  it("an empty first page is ready with no items (the panel shows its empty state)", () => {
    expect(run([{ kind: "loaded", page: page([], null) }])).toMatchObject({ phase: "ready", items: [], nextCursor: null });
  });

  it("a failed first page is an error, and a retry goes back to loading (and only from an error)", () => {
    const failed = run([{ kind: "failed" }]);
    expect(failed).toEqual({ phase: "error" });
    expect(run([{ kind: "retry" }], failed)).toEqual({ phase: "loading" });
    const ready = run([{ kind: "loaded", page: page(["a"], null) }]);
    expect(reduceNoticePages(ready, { kind: "retry" })).toBe(ready);
    expect(reduceNoticePages(INITIAL_NOTICE_PAGES, { kind: "retry" })).toBe(INITIAL_NOTICE_PAGES);
  });

  it("load more appends the next page after the ones shown, takes the new cursor and ends at the last page", () => {
    const state = run([
      { kind: "loaded", page: page(["a", "b"], "c1", 2) },
      { kind: "moreStart", cursor: "c1" },
      { kind: "moreLoaded", cursor: "c1", page: page(["c"], "c2") },
      { kind: "moreStart", cursor: "c2" },
      { kind: "moreLoaded", cursor: "c2", page: page(["d"], null) },
    ]);
    expect(state).toMatchObject({ phase: "ready", nextCursor: null, more: "idle", moreCursor: null });
    expect(state.phase === "ready" && state.items.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("load more only starts for the current next cursor, when no request is already running", () => {
    const last = run([{ kind: "loaded", page: page(["a"], null) }]);
    expect(reduceNoticePages(last, { kind: "moreStart", cursor: "c1" })).toBe(last);
    const ready = run([{ kind: "loaded", page: page(["a"], "c1") }]);
    // 游标不是当前的下一页:不开始
    expect(reduceNoticePages(ready, { kind: "moreStart", cursor: "c0" })).toBe(ready);
    const loading = run([{ kind: "moreStart", cursor: "c1" }], ready);
    expect(loading).toMatchObject({ more: "loading", moreCursor: "c1" });
    // 在途时再点一次:同一个游标的第二个请求不开始
    expect(reduceNoticePages(loading, { kind: "moreStart", cursor: "c1" })).toBe(loading);
    expect(reduceNoticePages(INITIAL_NOTICE_PAGES, { kind: "moreStart", cursor: "c1" })).toBe(INITIAL_NOTICE_PAGES);
  });

  it("a failed load more keeps the notices shown, keeps the cursor, and can be tried again", () => {
    const state = run([{ kind: "loaded", page: page(["a"], "c1") }, { kind: "moreStart", cursor: "c1" }, { kind: "moreFailed", cursor: "c1" }]);
    expect(state).toMatchObject({ phase: "ready", more: "error", nextCursor: "c1" });
    expect(state.phase === "ready" && state.items).toHaveLength(1);
    expect(run([{ kind: "moreStart", cursor: "c1" }, { kind: "moreLoaded", cursor: "c1", page: page(["b"], null) }], state)).toMatchObject({ more: "idle", nextCursor: null });
  });

  it("a stale or duplicate answer is dropped: the same page is never appended twice and the cursor never goes back", () => {
    const ready = run([{ kind: "loaded", page: page(["a"], "c1") }]);
    const loading = run([{ kind: "moreStart", cursor: "c1" }], ready);
    const done = run([{ kind: "moreLoaded", cursor: "c1", page: page(["b"], "c2") }], loading);
    expect(done.phase === "ready" && done.items.map((n) => n.id)).toEqual(["a", "b"]);
    // 第二次(重复发出的)同一页的应答晚到:请求已经结束,丢弃 —— 不重复追加、不把游标改回 c2 之外的值
    expect(reduceNoticePages(done, { kind: "moreLoaded", cursor: "c1", page: page(["b"], "c2") })).toBe(done);
    expect(reduceNoticePages(done, { kind: "moreFailed", cursor: "c1" })).toBe(done);
    // 下一页在途时,上一页的迟到应答(游标对不上)同样丢弃
    const next = run([{ kind: "moreStart", cursor: "c2" }], done);
    expect(reduceNoticePages(next, { kind: "moreLoaded", cursor: "c1", page: page(["b"], "c2") })).toBe(next);
    expect(reduceNoticePages(next, { kind: "moreFailed", cursor: "c1" })).toBe(next);
    expect(next).toMatchObject({ more: "loading", moreCursor: "c2" });
    // 它自己的应答照常落下
    expect(run([{ kind: "moreLoaded", cursor: "c2", page: page(["c"], null) }], next)).toMatchObject({ more: "idle", nextCursor: null });
  });

  it("results that no request is waiting for change nothing (a late page, a duplicate, an answer after an error)", () => {
    const ready = run([{ kind: "loaded", page: page(["a"], "c1") }]);
    expect(reduceNoticePages(ready, { kind: "moreLoaded", cursor: "c1", page: page(["x"], null) })).toBe(ready);
    expect(reduceNoticePages(ready, { kind: "moreFailed", cursor: "c1" })).toBe(ready);
    expect(reduceNoticePages(ready, { kind: "loaded", page: page(["y"], null) })).toBe(ready);
    expect(reduceNoticePages(ready, { kind: "failed" })).toBe(ready);
    const errored = run([{ kind: "failed" }]);
    expect(reduceNoticePages(errored, { kind: "loaded", page: page(["a"], null) })).toBe(errored);
    // 失败之后(more: error)到达的成功应答也不认:重试要重新 moreStart
    const failed = run([{ kind: "moreStart", cursor: "c1" }, { kind: "moreFailed", cursor: "c1" }], ready);
    expect(reduceNoticePages(failed, { kind: "moreLoaded", cursor: "c1", page: page(["x"], null) })).toBe(failed);
  });
});

describe("unreadIdsToMark (only what is on screen, only once)", () => {
  it("lists the unread items shown, newest first, and leaves read ones alone", () => {
    const items = [notice("a"), notice("b", 5), notice("c"), notice("d", 9)];
    expect(unreadIdsToMark(items, new Set())).toEqual(["a", "c"]);
    expect(unreadIdsToMark([], new Set())).toEqual([]);
  });

  it("skips ids already sent, so a later page only adds its own unread rows", () => {
    const first = [notice("a"), notice("b")];
    const marked = new Set(unreadIdsToMark(first, new Set()));
    expect(unreadIdsToMark([...first, notice("c"), notice("d", 3), notice("e")], marked)).toEqual(["c", "e"]);
    expect(unreadIdsToMark(first, marked)).toEqual([]);
  });

  it(`never lists more than the server takes in one request (${MARK_READ_MAX_IDS})`, () => {
    const many = Array.from({ length: MARK_READ_MAX_IDS + 30 }, (_, i) => notice(`n-${i}`));
    const ids = unreadIdsToMark(many, new Set());
    expect(ids).toHaveLength(MARK_READ_MAX_IDS);
    expect(ids[0]).toBe("n-0");
  });
});
