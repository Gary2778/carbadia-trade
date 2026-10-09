import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAppearanceKey } from "./appearance-key-storage";
import { TZ_KEY } from "./timeZoneState";
import { readTimeZone, setTimeZone, subscribeTimeZone, useTimeZone } from "./useTimeZone";

// 时区偏好的存储与订阅(node 环境,不引 jsdom):最小的 localStorage 与 window 假件,经 vi.stubGlobal 挂上(不读 Node 自带的 localStorage 访问器)。
/** getItem 被调了几次(含抛错的那些):快照应该是 O(1),不碰存储 */
let reads = 0;
function fakeStorage(opts: { blocked?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      reads++;
      if (opts.blocked) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.blocked) throw new Error("SecurityError");
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (opts.blocked) throw new Error("SecurityError");
      map.delete(k);
    },
  } as Storage;
}

/** 记下 storage 监听器的 window 假件 */
function fakeWindow() {
  const handlers = new Set<(e: StorageEvent) => void>();
  return {
    handlers,
    addEventListener: vi.fn((type: string, fn: (e: StorageEvent) => void) => {
      if (type === "storage") handlers.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (e: StorageEvent) => void) => {
      if (type === "storage") handlers.delete(fn);
    }),
    /** 别的标签页改了存储 */
    fire: (key: string | null) => handlers.forEach((fn) => fn({ key } as StorageEvent)),
  };
}

let win: ReturnType<typeof fakeWindow>;
beforeEach(() => {
  win = fakeWindow();
  vi.stubGlobal("localStorage", fakeStorage());
  vi.stubGlobal("window", win);
  writeAppearanceKey(TZ_KEY, null); // 上一个用例留在内存里的值
  subscribeTimeZone(() => {})(); // 挂一下再摘掉:作废上一个用例留在模块里的缓存
  win.addEventListener.mockClear();
  win.removeEventListener.mockClear();
  reads = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTimeZone store", () => {
  it("the first read (no subscriber yet) goes to storage; nothing stored and illegal stored values read as local", () => {
    expect(readTimeZone()).toBe("local");
    expect(reads).toBe(1);
    const off = subscribeTimeZone(() => {});
    for (const bad of ["Europe/Paris", "", "utc"]) {
      localStorage.setItem(TZ_KEY, bad);
      win.fire(TZ_KEY); // 缓存靠 storage 事件刷新
      expect(readTimeZone(), bad).toBe("local");
    }
    off();
  });

  it("a stored value is read at the first use and when the first subscriber attaches", () => {
    localStorage.setItem(TZ_KEY, "UTC");
    expect(readTimeZone()).toBe("UTC");
    const off = subscribeTimeZone(() => {});
    off();
    // 没有订阅者时缓存是作废的:这段时间里别的标签页改了存储(没人听事件),下次取到的是新值
    localStorage.setItem(TZ_KEY, "Asia/Shanghai");
    expect(readTimeZone()).toBe("Asia/Shanghai");
  });

  it("with a subscriber attached the snapshot is O(1): any number of reads (every table row calls the hook) touches storage zero times", () => {
    localStorage.setItem(TZ_KEY, "UTC");
    const off = subscribeTimeZone(() => {});
    reads = 0;
    for (let i = 0; i < 1000; i++) expect(readTimeZone()).toBe("UTC");
    expect(reads).toBe(0);
    off();
  });

  it("setTimeZone writes carbadia-tz, refreshes the cache with one read and notifies subscribers in the same tab", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTimeZone(listener);
    reads = 0;
    setTimeZone("Asia/Shanghai");
    expect(reads).toBe(1); // setTimeZone 重读一次,之后的快照不再读
    for (let i = 0; i < 100; i++) expect(readTimeZone()).toBe("Asia/Shanghai");
    expect(reads).toBe(1);
    expect(localStorage.getItem(TZ_KEY)).toBe("Asia/Shanghai");
    expect(listener).toHaveBeenCalledTimes(1);
    setTimeZone("UTC");
    expect(readTimeZone()).toBe("UTC");
    setTimeZone("local");
    expect(localStorage.getItem(TZ_KEY)).toBe("local");
    expect(readTimeZone()).toBe("local");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    setTimeZone("UTC");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("reacts to the storage event from another tab: this key or a cleared store re-reads once and notifies, other keys do nothing", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTimeZone(listener);
    localStorage.setItem(TZ_KEY, "UTC"); // 别的标签页写的
    reads = 0;
    win.fire(TZ_KEY);
    expect(reads).toBe(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readTimeZone()).toBe("UTC");
    expect(reads).toBe(1);
    win.fire("carbadia-theme");
    win.fire("carbadia-terminal-prefs");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
    localStorage.removeItem(TZ_KEY);
    win.fire(null); // storage.clear()
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readTimeZone()).toBe("local");
    unsubscribe();
  });

  it("shares one window listener between all subscribers (table rows each subscribe) and removes it with the last one", () => {
    const a = subscribeTimeZone(() => {});
    const b = subscribeTimeZone(() => {});
    const c = subscribeTimeZone(() => {});
    expect(win.addEventListener).toHaveBeenCalledTimes(1);
    expect(win.handlers.size).toBe(1);
    // 只有第一个订阅者读存储(刷新缓存),其余的不读
    expect(reads).toBe(1);
    a();
    b();
    expect(win.removeEventListener).not.toHaveBeenCalled();
    c();
    expect(win.removeEventListener).toHaveBeenCalledTimes(1);
    expect(win.handlers.size).toBe(0);
    // 再订阅又挂上
    const d = subscribeTimeZone(() => {});
    expect(win.handlers.size).toBe(1);
    d();
  });

  it("keeps the choice in memory for this session when site data is blocked (through the appearance accessors), and still reads storage zero times per snapshot", () => {
    vi.stubGlobal("localStorage", fakeStorage({ blocked: true }));
    const listener = vi.fn();
    const unsubscribe = subscribeTimeZone(listener);
    expect(readTimeZone()).toBe("local");
    setTimeZone("UTC");
    expect(readTimeZone()).toBe("UTC");
    expect(listener).toHaveBeenCalledTimes(1);
    reads = 0;
    for (let i = 0; i < 100; i++) expect(readTimeZone()).toBe("UTC");
    expect(reads).toBe(0);
    unsubscribe();
  });

  it("the server snapshot is local whatever is stored (the server renders no times; no inline script, no <html> attribute)", () => {
    localStorage.setItem(TZ_KEY, "UTC");
    function Probe() {
      return createElement("span", null, useTimeZone());
    }
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>local</span>");
  });

  it("goes through the appearance accessors only (no bare localStorage), imported from the small module they live in", () => {
    const src = readFileSync(fileURLToPath(new URL("./useTimeZone.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/localStorage/);
    expect(src).toMatch(/readAppearanceKey\(TZ_KEY\)/);
    expect(src).toMatch(/writeAppearanceKey\(TZ_KEY, pref\)/);
    // 不引 appearance-storage.ts 本身:它从根布局可达(ThemeProvider),被 floor 之外的 chunk 再引一次,
    // 打包器就不再把它并进 ThemeProvider 的作用域,floor 多约 0.15 KB gzip(floor 预算 201 KB,现 200.7)。两个存取函数在 appearance-key-storage.ts
    expect(src).toMatch(/from "\.\/appearance-key-storage"/);
    expect(src).not.toMatch(/from "\.\/appearance-storage"/);
  });
});
