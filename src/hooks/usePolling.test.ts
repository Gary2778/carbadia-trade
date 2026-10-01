import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPolling, type VisibilitySource } from "./usePolling";

// usePolling 的调度本体(startPolling):没有 jsdom(§9.1 第 7 条),用假 document 与假定时器直接测。
// P2-12:runFirstWhileHidden —— 页面在后台时第一次照样取(资产页在后台标签页打开不再一直是骨架),之后的定时重取照旧在后台暂停。

const MS = 1_000;

function fakeDocument(hidden: boolean) {
  const listeners = new Set<() => void>();
  const doc = {
    hidden,
    addEventListener: (_type: "visibilitychange", listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) => void listeners.delete(listener),
  };
  const setHidden = (value: boolean) => {
    doc.hidden = value;
    for (const listener of [...listeners]) listener();
  };
  return { doc: doc as VisibilitySource, setHidden, listeners };
}

/** 让在途的 Promise 链走完(不推进时间) */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startPolling: default (the terminal's MarketProvider, the legacy pages)", () => {
  it("visible: runs at once, then every ms", async () => {
    const { doc } = fakeDocument(false);
    const run = vi.fn();
    const stop = startPolling(run, MS, doc);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MS);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MS * 3);
    expect(run).toHaveBeenCalledTimes(5);
    stop();
  });

  it("hidden at start: does not run, not even once, until the page comes to the foreground; then runs at once and resumes", async () => {
    const { doc, setHidden } = fakeDocument(true);
    const run = vi.fn();
    const stop = startPolling(run, MS, doc);
    await vi.advanceTimersByTimeAsync(MS * 5);
    expect(run).not.toHaveBeenCalled();
    setHidden(false);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MS);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("going to the background stops the timer; coming back runs at once", async () => {
    const { doc, setHidden } = fakeDocument(false);
    const run = vi.fn();
    const stop = startPolling(run, MS, doc);
    await settle();
    setHidden(true);
    await vi.advanceTimersByTimeAsync(MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
    setHidden(false);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("backs off on failure (2×, 4×, capped at 4×) and resets after a success", async () => {
    const { doc } = fakeDocument(false);
    let fail = true;
    const run = vi.fn(() => (fail ? Promise.reject(new Error("down")) : Promise.resolve()));
    const stop = startPolling(run, MS, doc);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MS * 2 - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MS * 4);
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(MS * 4);
    expect(run).toHaveBeenCalledTimes(4);
    fail = false;
    await vi.advanceTimersByTimeAsync(MS * 4);
    expect(run).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(MS);
    expect(run).toHaveBeenCalledTimes(6);
    stop();
  });

  it("stop: no more runs, the listener is removed, and a run still in flight does not schedule another", async () => {
    const { doc, setHidden, listeners } = fakeDocument(false);
    let finish: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const stop = startPolling(run, MS, doc);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    stop();
    expect(listeners.size).toBe(0);
    finish();
    await vi.advanceTimersByTimeAsync(MS * 5);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("startPolling: runFirstWhileHidden (the account page's overview and its polling fallback)", () => {
  it("hidden at start: runs once at once, schedules nothing while hidden, runs again at once and resumes when the page comes back", async () => {
    const { doc, setHidden } = fakeDocument(true);
    const run = vi.fn();
    const stop = startPolling(run, MS, doc, { runFirstWhileHidden: true });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MS * 5);
    expect(run).toHaveBeenCalledTimes(1);
    setHidden(false);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(MS);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("visible at start: the same as the default", async () => {
    const { doc, setHidden } = fakeDocument(false);
    const run = vi.fn();
    const stop = startPolling(run, MS, doc, { runFirstWhileHidden: true });
    await settle();
    await vi.advanceTimersByTimeAsync(MS);
    expect(run).toHaveBeenCalledTimes(2);
    setHidden(true);
    await vi.advanceTimersByTimeAsync(MS * 5);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a first run that fails while hidden is not retried until the page comes back", async () => {
    const { doc, setHidden } = fakeDocument(true);
    const run = vi.fn(() => Promise.reject(new Error("down")));
    const stop = startPolling(run, MS, doc, { runFirstWhileHidden: true });
    await vi.advanceTimersByTimeAsync(MS * 10);
    expect(run).toHaveBeenCalledTimes(1);
    setHidden(false);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("usePolling call sites", () => {
  // 组件与 hook 在 node 环境里不跑 effect,这里对着源码钉住谁开了 runFirstWhileHidden:资产页的总览与两条轮询降级开,终端不开
  const code = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
  const calls = (rel: string) => code(rel).match(/usePolling\([^\n]*\);|usePolling\([\s\S]*?\n\s*\);/g) ?? [];

  it("the account page (overview, and AccountFeed's two polls) runs its first fetch while hidden", () => {
    const overview = calls("../components/account/useAccountOverview.ts");
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatch(/FIRST_RUN_WHILE_HIDDEN\)/);
    const feed = calls("../lib/market/AccountFeed.tsx");
    expect(feed).toHaveLength(2);
    for (const call of feed) expect(call).toMatch(/FIRST_RUN_WHILE_HIDDEN,\s*\)/);
  });

  it("the terminal's MarketProvider keeps the default (a background terminal fetches when it comes to the foreground)", () => {
    const provider = calls("../lib/market/MarketProvider.tsx");
    expect(provider).toHaveLength(3);
    for (const call of provider) expect(call).not.toMatch(/FIRST_RUN_WHILE_HIDDEN|runFirstWhileHidden/);
  });
});
