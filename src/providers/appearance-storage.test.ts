import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistTheme, readAppearance, readAppearanceKey, writeAppearanceKey } from "./appearance-storage";
import { THEME_KEY, UPDOWN_KEY } from "./themeState";

// 外观的存储读写与换路径时的派生(appearance-storage.ts,node 环境,不引 jsdom)。ThemeProvider 的接线见 ThemeProvider.test.ts。
/** 最小 localStorage 假件;可切换成写抛错(配额)或读写都抛错(禁用站点数据) */
function fakeStorage(opts: { throwOnSet?: boolean; throwOnGet?: boolean } = {}) {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (opts.throwOnGet) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      if (opts.throwOnSet) throw new Error("SecurityError");
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

const g = globalThis as unknown as { localStorage?: Storage };
let saved: Storage | undefined;
beforeEach(() => {
  saved = g.localStorage;
  // 上一个用例留在内存里的值:一次成功的写入把它们清掉
  g.localStorage = fakeStorage();
  for (const key of [THEME_KEY, UPDOWN_KEY]) writeAppearanceKey(key, null);
});
afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

describe("appearance storage with an in-memory fallback (theme and up/down choices survive soft navigation when localStorage is unavailable)", () => {
  it("storage works: reads and writes go to localStorage", () => {
    writeAppearanceKey(THEME_KEY, "dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(readAppearanceKey(THEME_KEY)).toBe("dark");
    writeAppearanceKey(THEME_KEY, null);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("site data blocked (getItem and setItem throw): the user's choice is kept in memory and read back", () => {
    g.localStorage = fakeStorage({ throwOnSet: true, throwOnGet: true });
    expect(readAppearanceKey(THEME_KEY)).toBeNull();
    writeAppearanceKey(THEME_KEY, "dark");
    writeAppearanceKey(UPDOWN_KEY, "red-up");
    expect(readAppearanceKey(THEME_KEY)).toBe("dark");
    expect(readAppearanceKey(UPDOWN_KEY)).toBe("red-up");
    writeAppearanceKey(UPDOWN_KEY, null); // 删除键:内存里同样记成「没有」
    expect(readAppearanceKey(UPDOWN_KEY)).toBeNull();
  });

  it("quota full (only setItem throws): the failed write wins over the stale stored value; a later successful write goes back to storage", () => {
    const storage = fakeStorage();
    storage.setItem(THEME_KEY, "light");
    g.localStorage = Object.assign(Object.create(storage), {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      getItem: (k: string) => storage.getItem(k),
    }) as Storage;
    writeAppearanceKey(THEME_KEY, "dark");
    expect(readAppearanceKey(THEME_KEY)).toBe("dark");
    g.localStorage = storage;
    writeAppearanceKey(THEME_KEY, "light");
    storage.setItem(THEME_KEY, "dark"); // 之后以存储为准(例如别的标签页写了)
    expect(readAppearanceKey(THEME_KEY)).toBe("dark");
  });

  it("readAppearance (the path-change re-derivation): with storage blocked, the dark / red-up chosen in this session stays on / as on /trade", () => {
    g.localStorage = fakeStorage({ throwOnSet: true, throwOnGet: true });
    // 没选过:按 pathname 派生(终端首访 dark,离开回 light)
    expect(readAppearance("/trade/VCS-FOR-2021").theme).toBe("dark");
    expect(readAppearance("/").theme).toBe("light");
    writeAppearanceKey(THEME_KEY, "dark");
    writeAppearanceKey(UPDOWN_KEY, "red-up");
    expect(readAppearance("/")).toEqual({ theme: "dark", upDown: "red-up" });
    writeAppearanceKey(THEME_KEY, "light");
    expect(readAppearance("/trade").theme).toBe("light");
  });

  it("readAppearance only reads (the terminal's path-derived dark is never written); persistTheme stores the explicit choice", () => {
    expect(readAppearance("/trade").theme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(localStorage.length).toBe(0);
    persistTheme("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    persistTheme("light");
    expect(readAppearance("/trade").theme).toBe("light");
    expect(readAppearance("/").theme).toBe("light");
  });
});

describe("appearance-storage module boundary", () => {
  const src = readFileSync(fileURLToPath(new URL("./appearance-storage.ts", import.meta.url)), "utf8");

  it("is a plain module (no \"use client\"), so importing it never makes a Fast Refresh boundary or a client reference", () => {
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });

  it("every storage read and write goes through readAppearanceKey / writeAppearanceKey (no bare localStorage outside them)", () => {
    const body = src.slice(src.indexOf("export function readAppearanceKey"));
    const helpers = body.slice(0, body.indexOf("/** 读存储并按 pathname 派生"));
    expect(helpers).toMatch(/localStorage\./);
    expect(src.replace(helpers, "")).not.toMatch(/localStorage\./);
  });
});
