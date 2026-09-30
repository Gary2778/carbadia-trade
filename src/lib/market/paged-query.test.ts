import { describe, expect, it, vi } from "vitest";
import { createPagedQuery, createUserQueryCache, EMPTY_PAGED_SNAPSHOT, MAX_STALE_ROWS, mergeNewest, sameRow, type Page } from "./paged-query";

// createPagedQuery(计划 §3.6、P1-21):游标分页的小 store,ticket(代号)计数丢弃过期响应,追加 / 前插按 getKey 去重。
// 纯模块测试(node 环境):fetchPage 用可手动 resolve / reject 的假实现,断言请求的游标与状态迁移。

type Row = { id: string; ts: number; status?: string };
const row = (id: string, ts = 0): Row => ({ id, ts });
const newestFirst = (a: Row, b: Row) => b.ts - a.ts || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0);

/** 每次调用 fetchPage 登记一个待决请求:按顺序手动 resolve / reject */
function deferredPages() {
  const calls: { cursor: string | null; resolve: (p: Page<Row>) => void; reject: (e: unknown) => void }[] = [];
  const fetchPage = vi.fn(
    (cursor: string | null) =>
      new Promise<Page<Row>>((resolve, reject) => {
        calls.push({ cursor, resolve, reject });
      }),
  );
  return { calls, fetchPage };
}

const ids = (items: readonly Row[]) => items.map((r) => r.id);

describe("createPagedQuery", () => {
  it("starts idle and empty, and exposes its key", () => {
    const { fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "history:u1", fetchPage, getKey: (r: Row) => r.id });
    expect(q.key).toBe("history:u1");
    expect(q.items).toEqual([]);
    expect(q.status).toBe("idle");
    expect(q.error).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("loadMore fetches the first page with a null cursor, then follows nextCursor and appends", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });

    const first = q.loadMore();
    expect(q.status).toBe("loading");
    expect(calls[0].cursor).toBeNull();
    calls[0].resolve({ items: [row("a"), row("b")], nextCursor: "c1" });
    await first;
    expect(ids(q.items)).toEqual(["a", "b"]);
    expect(q.status).toBe("idle");

    const second = q.loadMore();
    expect(calls[1].cursor).toBe("c1");
    calls[1].resolve({ items: [row("c")], nextCursor: null });
    await second;
    expect(ids(q.items)).toEqual(["a", "b", "c"]);
    expect(q.status).toBe("done");
  });

  it("de-duplicates appended items by getKey (keeps the first copy and its position)", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("a", 3), row("b", 2)], nextCursor: "c1" });
    await p1;
    const p2 = q.loadMore();
    // 同一毫秒的两行跨页边界时服务端可能再给一次 b
    calls[1].resolve({ items: [row("b", 99), row("c", 1)], nextCursor: null });
    await p2;
    expect(ids(q.items)).toEqual(["a", "b", "c"]);
    expect(q.items[1].ts).toBe(2);
  });

  it("a second loadMore while one is in flight shares it instead of fetching the same cursor twice", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const a = q.loadMore();
    const b = q.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    calls[0].resolve({ items: [row("a")], nextCursor: "c1" });
    await Promise.all([a, b]);
    expect(ids(q.items)).toEqual(["a"]);
  });

  it("loadMore after the last page is a no-op", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p = q.loadMore();
    calls[0].resolve({ items: [row("a")], nextCursor: null });
    await p;
    await q.loadMore();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(q.status).toBe("done");
  });

  it("drops a response that arrives after reset (stale ticket)", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const stale = q.loadMore();
    q.reset();
    expect(q.status).toBe("idle");
    calls[0].resolve({ items: [row("old")], nextCursor: "c-old" });
    await stale;
    expect(q.items).toEqual([]);
    expect(q.status).toBe("idle");

    // 重置之后的新请求从第一页开始,晚到的旧响应不影响它的游标
    const fresh = q.loadMore();
    expect(calls[1].cursor).toBeNull();
    calls[1].resolve({ items: [row("new")], nextCursor: null });
    await fresh;
    expect(ids(q.items)).toEqual(["new"]);
    expect(q.status).toBe("done");
  });

  it("drops a stale response even when it lands after the fresh one", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const stale = q.loadMore();
    q.reset();
    const fresh = q.loadMore();
    calls[1].resolve({ items: [row("new")], nextCursor: "c2" });
    await fresh;
    calls[0].reject(new Error("late failure"));
    await stale;
    expect(ids(q.items)).toEqual(["new"]);
    expect(q.status).toBe("idle");
    expect(q.error).toBeNull();
  });

  it("reset clears loaded pages and the next loadMore re-fetches from the first page", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("a")], nextCursor: "c1" });
    await p1;
    const p2 = q.loadMore();
    calls[1].resolve({ items: [row("b")], nextCursor: null });
    await p2;
    expect(q.status).toBe("done");

    q.reset();
    expect(q.items).toEqual([]);
    expect(q.status).toBe("idle");
    const p3 = q.loadMore();
    expect(calls[2].cursor).toBeNull();
    calls[2].resolve({ items: [row("z")], nextCursor: null });
    await p3;
    expect(ids(q.items)).toEqual(["z"]);
  });

  it("goes to error with the message, keeps loaded rows, and retries the same cursor", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("a")], nextCursor: "c1" });
    await p1;

    const p2 = q.loadMore();
    calls[1].reject(new Error("Request failed (500)"));
    await expect(p2).resolves.toBeUndefined(); // loadMore 自己不抛:错误落在 status / error
    expect(q.status).toBe("error");
    expect(q.error).toBe("Request failed (500)");
    expect(ids(q.items)).toEqual(["a"]);

    const p3 = q.loadMore();
    expect(calls[2].cursor).toBe("c1");
    expect(q.status).toBe("loading");
    calls[2].resolve({ items: [row("b")], nextCursor: null });
    await p3;
    expect(q.status).toBe("done");
    expect(q.error).toBeNull();
    expect(ids(q.items)).toEqual(["a", "b"]);
  });

  it("a non-Error rejection still yields a string error", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p = q.loadMore();
    calls[0].reject("boom");
    await p;
    expect(q.status).toBe("error");
    expect(q.error).toBe("boom");
  });

  it("notifies subscribers on every state change and publishes a new immutable snapshot", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const listener = vi.fn();
    const unsubscribe = q.subscribe(listener);
    const before = q.getSnapshot();
    expect(q.getSnapshot()).toBe(before); // 无变化时同一引用(useSyncExternalStore 的要求)

    const p = q.loadMore();
    expect(listener).toHaveBeenCalledTimes(1);
    calls[0].resolve({ items: [row("a")], nextCursor: null });
    await p;
    expect(listener).toHaveBeenCalledTimes(2);
    const after = q.getSnapshot();
    expect(after).not.toBe(before);
    expect(before.items).toEqual([]);
    expect(after).toMatchObject({ status: "done", error: null });

    unsubscribe();
    q.reset();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("prepend puts new rows on top, replaces rows it already has in place, and notifies once", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p = q.loadMore();
    calls[0].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: "c1" });
    await p;
    const listener = vi.fn();
    q.subscribe(listener);

    q.prepend([row("d", 4), row("c", 3), row("b", 20)]);
    expect(ids(q.items)).toEqual(["d", "c", "b", "a"]);
    expect(q.items[2].ts).toBe(20);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(q.status).toBe("idle"); // 前插不动游标与状态

    const same = q.getSnapshot();
    q.prepend([]);
    expect(q.getSnapshot()).toBe(same);
  });

  it("with compare, prepend keeps the list sorted (a completed old order lands at its own place)", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const p = q.loadMore();
    calls[0].resolve({ items: [row("e", 50), row("c", 30), row("a", 10)], nextCursor: "c1" });
    await p;
    q.prepend([row("f", 60), row("b", 20)]);
    expect(ids(q.items)).toEqual(["f", "e", "c", "b", "a"]);
  });

  it("refresh re-reads the first page and merges it on top without touching the cursor", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: "c1" });
    await p1;

    const r = q.refresh();
    expect(calls[1].cursor).toBeNull();
    expect(q.status).toBe("idle"); // 头部刷新不闪 loading
    calls[1].resolve({ items: [row("c", 3), row("b", 2)], nextCursor: "other" });
    await r;
    expect(ids(q.items)).toEqual(["c", "b", "a"]);

    const p2 = q.loadMore();
    expect(calls[2].cursor).toBe("c1");
    calls[2].resolve({ items: [], nextCursor: null });
    await p2;
    expect(q.status).toBe("done");
  });

  it("refresh after reset is dropped, and a failed refresh leaves state untouched", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("a")], nextCursor: null });
    await p1;

    const failed = q.refresh();
    calls[1].reject(new Error("offline"));
    await failed;
    expect(q.status).toBe("done");
    expect(q.error).toBeNull();
    expect(ids(q.items)).toEqual(["a"]);

    const stale = q.refresh();
    q.reset();
    calls[2].resolve({ items: [row("x")], nextCursor: null });
    await stale;
    expect(q.items).toEqual([]);
  });

  it("refresh before the first page behaves like loadMore", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id });
    const r = q.refresh();
    expect(q.status).toBe("loading");
    calls[0].resolve({ items: [row("a")], nextCursor: "c1" });
    await r;
    expect(q.status).toBe("idle");
    expect(ids(q.items)).toEqual(["a"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

// 服务端的一张「活」表:按 newestFirst 排好,cursor = 上一页最后一行的 id(与键集分页同一语义:取严格排在它之后的行)
function serverList(pageSize: number) {
  const rows: Row[] = [];
  const fetchPage = vi.fn(async (cursor: string | null): Promise<Page<Row>> => {
    const sorted = rows.slice().sort(newestFirst);
    const start = cursor === null ? 0 : sorted.findIndex((r) => r.id === cursor) + 1;
    const items = sorted.slice(start, start + pageSize);
    const more = start + pageSize < sorted.length;
    return { items, nextCursor: more ? items[items.length - 1].id : null };
  });
  return { rows, fetchPage };
}
const oid = (n: number) => `o${String(n).padStart(3, "0")}`;
const seed = (rows: Row[], from: number, to: number) => {
  for (let n = from; n <= to; n++) rows.push(row(oid(n), n));
};
async function loadAll(q: { loadMore(): Promise<void>; status: string }) {
  for (let guard = 0; q.status !== "done" && guard < 50; guard++) await q.loadMore();
}

describe("createPagedQuery refresh across a gap", () => {
  it("more than one page of new rows since the last load: reads on until it joins the loaded rows, nothing is skipped", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 3); // o000..o003
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await loadAll(q);
    expect(ids(q.items)).toEqual([oid(3), oid(2), oid(1), oid(0)]);
    expect(q.status).toBe("done");

    // 离开期间又完成了 5 张(多于一页)
    seed(server.rows, 4, 8);
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage.mock.calls.map((c) => c[0])).toEqual([null, oid(6)]); // 第一页接不上,再读一页
    expect(ids(q.items)).toEqual([8, 7, 6, 5, 4, 3, 2, 1, 0].map(oid));
    expect(q.status).toBe("done");
    await q.loadMore(); // 已翻完:不再请求
    expect(server.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("keeps the cursor of the loaded tail when the refresh joins, so paging on continues where it left off", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 9); // o000..o009
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    await q.loadMore(); // o009..o004,游标在 o004
    seed(server.rows, 10, 14); // 5 张新的
    await q.refresh();
    expect(ids(q.items)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4].map(oid));
    expect(q.status).toBe("idle");
    await loadAll(q);
    expect(ids(q.items)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map(oid));
  });

  it("gives up joining after maxRefreshPages and replaces the list with the pages it read (no gap, paging continues from there)", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 3);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst, maxRefreshPages: 2 });
    await loadAll(q);
    seed(server.rows, 4, 20); // 17 张新的,两页(6 行)接不上
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(q.items)).toEqual([20, 19, 18, 17, 16, 15].map(oid));
    expect(q.status).toBe("idle"); // 原来是 done:列表换了,后面还有
    await loadAll(q);
    expect(ids(q.items)).toEqual(Array.from({ length: 21 }, (_, i) => oid(20 - i)));
  });

  it("a replacing refresh drops a loadMore that was in flight on the old cursor", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst, maxRefreshPages: 1 });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: "c-old" });
    await p1;
    const more = q.loadMore(); // calls[1]:旧游标
    const r = q.refresh(); // calls[2]
    calls[2].resolve({ items: [row("z", 26), row("y", 25)], nextCursor: "c-new" });
    await r;
    expect(ids(q.items)).toEqual(["z", "y"]);
    calls[1].resolve({ items: [row("old", 0)], nextCursor: null });
    await more;
    expect(ids(q.items)).toEqual(["z", "y"]); // 旧游标那页落不进来(否则 y 与 old 之间是个洞)
    expect(q.status).toBe("idle");
    const next = q.loadMore();
    expect(calls[3].cursor).toBe("c-new");
    calls[3].resolve({ items: [], nextCursor: null });
    await next;
  });

  it("a refresh that reads to the end replaces the list with what the server has", async () => {
    const server = serverList(50);
    seed(server.rows, 0, 2);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    seed(server.rows, 3, 4);
    await q.refresh();
    expect(ids(q.items)).toEqual([4, 3, 2, 1, 0].map(oid));
    expect(q.status).toBe("done");
  });

  it("a failure halfway through a multi-page refresh changes nothing (no half-merged page with a hole under it)", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const p = q.loadMore();
    calls[0].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: null });
    await p;
    const r = q.refresh();
    calls[1].resolve({ items: [row("f", 6), row("e", 5)], nextCursor: "c-e" });
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2].reject(new Error("offline"));
    await r;
    expect(ids(q.items)).toEqual(["b", "a"]);
    expect(q.status).toBe("done");
  });

  it("coalesces a refresh requested while one is running into one follow-up run", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const p = q.loadMore();
    calls[0].resolve({ items: [row("a", 1)], nextCursor: null });
    await p;
    const first = q.refresh(); // calls[1]
    const second = q.refresh();
    const third = q.refresh();
    expect(fetchPage).toHaveBeenCalledTimes(2);
    calls[1].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: null });
    await vi.waitFor(() => expect(calls).toHaveLength(3)); // 在途期间有人又要:跑完再补一次(只补一次)
    calls[2].resolve({ items: [row("c", 3), row("b", 2), row("a", 1)], nextCursor: null });
    await Promise.all([first, second, third]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(ids(q.items)).toEqual(["c", "b", "a"]);
  });
});

describe("createPagedQuery markStale (a row that entered the list at its own place, below page 1)", () => {
  it("the next refresh reads down to a stale row inside the loaded range and merges it at its place", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 9);
    server.rows.splice(server.rows.findIndex((r) => r.id === oid(5)), 1); // o005 还挂着,不在历史里
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    await q.loadMore(); // o009 o008 o007 | o006 o004 o003,游标在 o003
    expect(ids(q.items)).toEqual([9, 8, 7, 6, 4, 3].map(oid));

    // o005 离开挂单(成交完 / 撤销)进了历史:位置在第一页之后、已加载范围之内
    server.rows.push(row(oid(5), 5));
    q.markStale([row(oid(5), 5)]);
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage.mock.calls.map((c) => c[0])).toEqual([null, oid(7)]); // 第一页接上了,但还没读到 o005 的位置
    expect(ids(q.items)).toEqual([9, 8, 7, 6, 5, 4, 3].map(oid));
    expect(q.status).toBe("idle");

    // 已处理:下一次 refresh 只读第一页
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("ignores stale rows below the loaded tail (loadMore will read them in their final state) and before the first page", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 9);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    q.markStale([row(oid(8), 8)]); // 还没加载:第一页自然会读到
    await q.loadMore(); // o009 o008 o007
    q.markStale([row(oid(1), 1)]); // 在已加载的末行之后
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
    expect(ids(q.items)).toEqual([9, 8, 7].map(oid));
  });

  it("covers a stale row anywhere once the list is complete, and forgets stale rows on reset", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 5);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await loadAll(q);
    q.markStale([row(oid(0), 0)]);
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(2); // 读到底
    expect(q.status).toBe("done");

    q.markStale([row(oid(0), 0)]);
    q.reset();
    await q.loadMore();
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("keeps stale rows for the next refresh when this one fails", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("e", 5), row("d", 4)], nextCursor: "c-d" });
    await p1;
    const p2 = q.loadMore();
    calls[1].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: "c-a" });
    await p2;
    q.markStale([row("c", 3)]);

    const failed = q.refresh();
    calls[2].reject(new Error("offline"));
    await failed;

    const retry = q.refresh();
    calls[3].resolve({ items: [row("e", 5), row("d", 4)], nextCursor: "c-d" }); // 接上了,但还没到 c 的位置
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(calls[4].cursor).toBe("c-d");
    calls[4].resolve({ items: [row("c", 3), row("b", 2)], nextCursor: "c-b" });
    await retry;
    expect(ids(q.items)).toEqual(["e", "d", "c", "b", "a"]);
  });
});

describe("createPagedQuery reference stability (every WS order result triggers a refresh)", () => {
  it("a refresh that joins on page 1 and reads back the same rows publishes nothing: same snapshot, no listener call", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 9);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    await q.loadMore();
    const before = q.getSnapshot();
    const listener = vi.fn();
    q.subscribe(listener);
    await q.refresh();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(4);
    expect(listener).not.toHaveBeenCalled();
    expect(q.getSnapshot()).toBe(before);
  });

  it("a refresh that reads to the end (replace) with unchanged rows and status publishes nothing", async () => {
    const server = serverList(50);
    seed(server.rows, 0, 2);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    const before = q.getSnapshot();
    const listener = vi.fn();
    q.subscribe(listener);
    await q.refresh();
    expect(listener).not.toHaveBeenCalled();
    expect(q.getSnapshot()).toBe(before);
  });

  it("still publishes when a row changed in place, a row was added, or the status changed", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 9);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    const listener = vi.fn();
    q.subscribe(listener);
    // 同一位置的行内容变了(例如状态)
    server.rows[server.rows.findIndex((r) => r.id === oid(8))] = { id: oid(8), ts: 8, status: "CANCELLED" };
    await q.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(q.items[1]).toEqual({ id: oid(8), ts: 8, status: "CANCELLED" });
    // 新行
    seed(server.rows, 10, 10);
    await q.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(ids(q.items)).toEqual([10, 9, 8, 7].map(oid));

    // 整体替换:行相同但状态从 idle 变成 done(列表其实已到底)→ 发布,items 保留原引用
    const { calls, fetchPage } = deferredPages();
    const idle = createPagedQuery({ key: "i", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const first = idle.loadMore();
    calls[0].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: "c-a" });
    await first;
    const itemsBefore = idle.items;
    const r = idle.refresh();
    calls[1].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: null });
    await r;
    expect(idle.status).toBe("done");
    expect(idle.items).toBe(itemsBefore);
  });

  it("sameRow compares own fields (arrays element-wise, e.g. Fill.ledgerRefs), not references", () => {
    expect(sameRow({ id: "f1", refs: ["l1", "l2"], n: 1 }, { id: "f1", refs: ["l1", "l2"], n: 1 })).toBe(true);
    expect(sameRow({ id: "f1", refs: ["l1"] }, { id: "f1", refs: ["l2"] })).toBe(false);
    expect(sameRow({ id: "o1", status: "OPEN" }, { id: "o1", status: "FILLED" })).toBe(false);
    expect(sameRow({ id: "o1" }, { id: "o1", price: null })).toBe(false);
    expect(sameRow({ id: "o1", price: undefined }, { id: "o1", other: undefined })).toBe(false);
    expect(sameRow({ v: Number.NaN }, { v: Number.NaN })).toBe(true);
    expect(sameRow(null, null)).toBe(true);
    expect(sameRow({ id: "o1" }, null)).toBe(false);
  });
});

describe("createPagedQuery markStale bookkeeping (keyed, bounded)", () => {
  // 服务端 3 行一页、o000..o009;已加载两页(o009..o004),游标在 o004
  async function loadedTwoPages() {
    const server = serverList(3);
    seed(server.rows, 0, 9);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await q.loadMore();
    await q.loadMore();
    server.fetchPage.mockClear();
    return { server, q };
  }

  it("marking the same row again and again collapses to one entry (no overflow, the next refresh reads only what that row needs)", async () => {
    const { server, q } = await loadedTwoPages();
    for (let i = 0; i < MAX_STALE_ROWS * 4; i++) q.markStale([row(oid(9), 9)]);
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(1); // o009 在第一页:读一页就覆盖了
  });

  it(`past MAX_STALE_ROWS distinct rows it stops tracking them one by one: the next refresh covers the whole loaded range, then the mark is cleared`, async () => {
    const { server, q } = await loadedTwoPages();
    // 每一条单独看都在第一页之上(第一页就能覆盖);逐条记的话只读一页
    q.markStale(Array.from({ length: MAX_STALE_ROWS }, (_, i) => row(`n${i}`, 100)));
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
    // 超过上限:改为覆盖整段已加载范围 —— 读到已加载的末行 o004 为止(第二页)
    q.markStale(Array.from({ length: MAX_STALE_ROWS + 1 }, (_, i) => row(`m${i}`, 100)));
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage.mock.calls.map((c) => c[0])).toEqual([null, oid(7)]);
    expect(ids(q.items)).toEqual([9, 8, 7, 6, 5, 4].map(oid));
    // 已消化:下一次只读第一页
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage).toHaveBeenCalledTimes(1);
  });

  it("overflow is conservative: with more than maxRefreshPages pages loaded it trades loaded depth for correctness (per-row marks keep the depth)", async () => {
    // 3 行一页、o000..o014,已加载 4 页(12 行),refresh 最多连读 2 页
    const setup = async () => {
      const server = serverList(3);
      seed(server.rows, 0, 14);
      const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst, maxRefreshPages: 2 });
      for (let i = 0; i < 4; i++) await q.loadMore();
      expect(q.items).toHaveLength(12);
      server.fetchPage.mockClear();
      return { server, q };
    };
    // 逐条记:被标记的行都在第一页 → 第一页接上,已加载的 12 行全保留
    const perRow = await setup();
    perRow.q.markStale([row(oid(14), 14), row(oid(13), 13)]);
    await perRow.q.refresh();
    expect(perRow.server.fetchPage).toHaveBeenCalledTimes(1);
    expect(perRow.q.items).toHaveLength(12);
    // 溢出:要读到已加载的末行 o003,读满 2 页仍够不着 → 以这 2 页替换:列表截到 6 行,但连续、无洞,游标接在后面
    const overflow = await setup();
    overflow.q.markStale(Array.from({ length: MAX_STALE_ROWS + 1 }, (_, i) => row(`m${i}`, 100)));
    await overflow.q.refresh();
    expect(overflow.server.fetchPage).toHaveBeenCalledTimes(2);
    expect(ids(overflow.q.items)).toEqual([14, 13, 12, 11, 10, 9].map(oid));
    expect(overflow.q.status).toBe("idle");
    await overflow.q.loadMore();
    expect(ids(overflow.q.items)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6].map(oid));
  });

  it("an overflow on a list that is complete makes the next refresh read to the end", async () => {
    const server = serverList(3);
    seed(server.rows, 0, 5);
    const q = createPagedQuery({ key: "k", fetchPage: server.fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    await loadAll(q);
    q.markStale(Array.from({ length: MAX_STALE_ROWS + 1 }, (_, i) => row(`m${i}`, 100)));
    server.fetchPage.mockClear();
    await q.refresh();
    expect(server.fetchPage.mock.calls.map((c) => c[0])).toEqual([null, oid(3)]);
    expect(q.status).toBe("done");
  });

  it("rows marked while a refresh is running are kept for the next one", async () => {
    const { calls, fetchPage } = deferredPages();
    const q = createPagedQuery({ key: "k", fetchPage, getKey: (r: Row) => r.id, compare: newestFirst });
    const p1 = q.loadMore();
    calls[0].resolve({ items: [row("e", 5), row("d", 4)], nextCursor: "c-d" });
    await p1;
    const p2 = q.loadMore();
    calls[1].resolve({ items: [row("b", 2), row("a", 1)], nextCursor: "c-a" });
    await p2;

    const running = q.refresh(); // calls[2]
    q.markStale([row("c", 3)]); // 在途期间记下:这次 refresh 开始时还不知道它
    calls[2].resolve({ items: [row("e", 5), row("d", 4)], nextCursor: "c-d" });
    await running;
    expect(calls).toHaveLength(3);

    const next = q.refresh(); // calls[3]:第一页接上了但还没到 c 的位置 → 再读一页
    calls[3].resolve({ items: [row("e", 5), row("d", 4)], nextCursor: "c-d" });
    await vi.waitFor(() => expect(calls).toHaveLength(5));
    expect(calls[4].cursor).toBe("c-d");
    calls[4].resolve({ items: [row("c", 3), row("b", 2)], nextCursor: "c-b" });
    await next;
    expect(ids(q.items)).toEqual(["e", "d", "c", "b", "a"]);
  });
});

describe("createUserQueryCache", () => {
  it("returns one query per user (same instance on repeated calls, a new one for another user) and null without a user", () => {
    const { fetchPage } = deferredPages();
    const cache = createUserQueryCache("history", { fetchPage, getKey: (r: Row) => r.id });
    expect(cache.forUser(null)).toBeNull();
    const a = cache.forUser("u1");
    expect(a?.key).toBe("history:u1");
    expect(cache.forUser("u1")).toBe(a); // 幂等:渲染期重复调用拿到同一份
    const b = cache.forUser("u2");
    expect(b?.key).toBe("history:u2");
    expect(b).not.toBe(a);
    expect(cache.forUser(null)).toBeNull(); // null 不动缓存
    expect(cache.forUser("u2")).toBe(b);
    expect(fetchPage).not.toHaveBeenCalled(); // 取实例不发请求
  });

  it("peek returns the current user's query only if it already exists, without creating one", () => {
    const { fetchPage } = deferredPages();
    const cache = createUserQueryCache("history", { fetchPage, getKey: (r: Row) => r.id });
    expect(cache.peek("u1")).toBeNull();
    expect(cache.peek(null)).toBeNull();
    const a = cache.forUser("u1");
    expect(cache.peek("u1")).toBe(a);
    expect(cache.peek("u2")).toBeNull(); // 别的用户:不给、也不换掉当前实例
    expect(cache.forUser("u1")).toBe(a);
    cache.clear();
    expect(cache.peek("u1")).toBeNull();
  });

  it("clear resets the current query (an in-flight page is dropped) and the next call starts a fresh one", async () => {
    const { calls, fetchPage } = deferredPages();
    const cache = createUserQueryCache("fills", { fetchPage, getKey: (r: Row) => r.id });
    const q = cache.forUser("u1")!;
    const first = q.loadMore();
    calls[0].resolve({ items: [row("a")], nextCursor: "c1" });
    await first;
    const pending = q.loadMore();
    const listener = vi.fn();
    q.subscribe(listener);

    cache.clear();
    expect(q.items).toEqual([]);
    expect(listener).toHaveBeenCalled();
    calls[1].resolve({ items: [row("b")], nextCursor: null });
    await pending;
    expect(q.items).toEqual([]); // 上一位用户的在途页落不进来

    const fresh = cache.forUser("u1");
    expect(fresh).not.toBe(q);
    expect(fresh?.items).toEqual([]);
    cache.clear();
    cache.clear(); // 没有实例时也安全
  });
});

describe("mergeNewest", () => {
  const getKey = (r: Row) => r.id;

  it("returns the paged list itself when there is nothing live", () => {
    const paged = [row("a", 1)];
    expect(mergeNewest([], paged, getKey, newestFirst)).toBe(paged);
  });

  it("puts live rows on top, drops duplicates, and keeps newest-first order", () => {
    const merged = mergeNewest([row("c", 3), row("b", 2)], [row("b", 2), row("a", 1)], getKey, newestFirst);
    expect(ids(merged)).toEqual(["c", "b", "a"]);
  });
});

describe("EMPTY_PAGED_SNAPSHOT", () => {
  it("is idle, empty and frozen", () => {
    expect(EMPTY_PAGED_SNAPSHOT).toEqual({ items: [], status: "idle", error: null });
    expect(Object.isFrozen(EMPTY_PAGED_SNAPSHOT)).toBe(true);
  });
});
