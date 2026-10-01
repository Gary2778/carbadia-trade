import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAppearance } from "@/providers/appearance-storage";
import { THEME_KEY, UPDOWN_KEY } from "@/providers/themeState";

// layout.tsx 的 THEME_INIT 内联脚本(首帧绘制前写 <html> 的外观属性)按真实代码跑一遍:node 环境,不引 jsdom,
// 给它一个只记属性的 documentElement、一个假 localStorage 与 location。外观只剩浅色与 dark(P1-27 下线了第三种外观):
// 脚本不再写第三种外观的属性,并删掉它留下的旧存储键;它算出的外观与 ThemeProvider 挂载后(readAppearance)算出的一致,
// 所以开过旧外观的访客回来也不闪、不水合失配。

const LAYOUT = readFileSync(fileURLToPath(new URL("./layout.tsx", import.meta.url)), "utf8");
const THEME_INIT = LAYOUT.match(/const THEME_INIT = `([\s\S]*?)`;/)?.[1] ?? "";
/** 下线外观的旧存储键(P1-27 迁移:首屏脚本删除它,别处不再读写) */
const LEGACY_KEY = "carbadia-kids";

type Stored = Record<string, string>;

/** 最小 localStorage 假件,记下每次调用;可让读或删抛错(禁用站点数据) */
function fakeStorage(stored: Stored, opts: { throwOnGet?: boolean; throwOnRemove?: boolean } = {}) {
  const map = new Map(Object.entries(stored));
  const calls: string[] = [];
  const storage = {
    getItem: (k: string) => {
      calls.push(`get ${k}`);
      if (opts.throwOnGet) throw new Error("SecurityError");
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      calls.push(`set ${k}`);
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      calls.push(`remove ${k}`);
      if (opts.throwOnRemove) throw new Error("SecurityError");
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  return { storage, map, calls };
}

/** 在假 DOM 上跑 THEME_INIT:返回写到 <html> 上的属性(setAttribute 与 dataset 都记)、colorScheme、存储与调用记录 */
function runThemeInit(pathname: string, stored: Stored, opts?: { throwOnGet?: boolean; throwOnRemove?: boolean }) {
  const attrs: Record<string, string> = {};
  const style: Record<string, string> = {};
  const dataset = new Proxy({} as Record<string, string>, {
    set: (_, key, value) => {
      attrs[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = String(value);
      return true;
    },
  });
  const documentElement = { setAttribute: (name: string, value: string) => void (attrs[name] = String(value)), style, dataset };
  const { storage, map, calls } = fakeStorage(stored, opts);
  new Function("document", "localStorage", "location", THEME_INIT)({ documentElement }, storage, { pathname });
  return { attrs, colorScheme: style.colorScheme, storage: Object.fromEntries(map), calls };
}

const g = globalThis as unknown as { localStorage?: Storage };
let saved: Storage | undefined;
beforeEach(() => {
  saved = g.localStorage;
});
afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

describe("THEME_INIT (inline script in layout.tsx) with two looks", () => {
  it("is found in layout.tsx and never writes storage", () => {
    expect(THEME_INIT).toMatch(/^\(function\(\)\{/);
    expect(THEME_INIT).not.toContain("setItem");
  });

  it("a returning visitor who had the removed look on lands on the light / dark they stored, and the legacy key is removed", () => {
    for (const theme of ["light", "dark"] as const) {
      const run = runThemeInit("/", { [THEME_KEY]: theme, [LEGACY_KEY]: "1", [UPDOWN_KEY]: "red-up" });
      expect(run.attrs).toEqual({ "data-theme": theme, "data-updown": "red-up" });
      expect(run.colorScheme).toBe(theme);
      expect(run.storage).toEqual({ [THEME_KEY]: theme, [UPDOWN_KEY]: "red-up" });
    }
  });

  it("with only the legacy key stored, the first-visit rule applies (dark on /trade, light elsewhere) and nothing is written in its place", () => {
    const trade = runThemeInit("/trade/VCS-FOR-2021", { [LEGACY_KEY]: "1" });
    expect(trade.attrs).toEqual({ "data-theme": "dark", "data-updown": "green-up" });
    expect(trade.storage).toEqual({});
    expect(trade.calls.filter((c) => !c.startsWith("get "))).toEqual([`remove ${LEGACY_KEY}`]);
    const home = runThemeInit("/", { [LEGACY_KEY]: "1" });
    expect(home.attrs).toEqual({ "data-theme": "light", "data-updown": "green-up" });
    expect(home.storage).toEqual({});
  });

  it("paints exactly what ThemeProvider derives after mounting (readAppearance), so there is no flash and no hydration mismatch, and never a third-look attribute", () => {
    for (const pathname of ["/", "/trade", "/trade/VCS-FOR-2021", "/trade/account", "/market/VCS-FOR-2021", "/orders"]) {
      for (const theme of [null, "light", "dark", "sepia"]) {
        for (const legacy of [null, "1"]) {
          for (const upDown of [null, "green-up", "red-up", "RED-UP"]) {
            const stored: Stored = {};
            if (theme !== null) stored[THEME_KEY] = theme;
            if (legacy !== null) stored[LEGACY_KEY] = legacy;
            if (upDown !== null) stored[UPDOWN_KEY] = upDown;
            const run = runThemeInit(pathname, stored);
            // ThemeProvider 的 layout effect 读同一份存储(内联脚本已删掉旧键)
            g.localStorage = fakeStorage(run.storage).storage;
            const provider = readAppearance(pathname);
            const where = `${pathname} ${JSON.stringify(stored)}`;
            expect(run.attrs, where).toEqual({ "data-theme": provider.theme, "data-updown": provider.upDown });
            expect(run.colorScheme, where).toBe(provider.theme);
            expect(LEGACY_KEY in run.storage, where).toBe(false);
            expect(run.calls.some((c) => c.startsWith("set ")), where).toBe(false);
          }
        }
      }
    }
  });

  it("survives blocked storage: nothing is painted (the SSR light default stays), no error escapes; a failing remove does not undo the paint", () => {
    // 存储读写都抛错时 ThemeProvider 也读到 null(appearance-storage 的 try/catch),两边都是默认规则
    expect(() => runThemeInit("/", { [THEME_KEY]: "dark" }, { throwOnGet: true, throwOnRemove: true })).not.toThrow();
    expect(runThemeInit("/", { [THEME_KEY]: "dark" }, { throwOnGet: true, throwOnRemove: true }).attrs).toEqual({});
    const removeFails = runThemeInit("/", { [THEME_KEY]: "dark", [LEGACY_KEY]: "1" }, { throwOnRemove: true });
    expect(removeFails.attrs).toEqual({ "data-theme": "dark", "data-updown": "green-up" });
  });
});

describe("the removed look leaves no trace in src (P1-27)", () => {
  const SRC = fileURLToPath(new URL("../", import.meta.url));
  /** src/ 下的 .ts / .tsx / .css 源文件(不含测试) */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    });
  }
  const files = sourceFiles(SRC).map((file) => ({ name: relative(SRC, file), src: readFileSync(file, "utf8") }));

  it("scans the whole source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map((f) => f.name)).toContain("app/layout.tsx");
  });

  it("has no attribute, selector, toggle component, provider flag or night-sky component for it", () => {
    // 模式用字符类写([s]),免得本文件和仓库级 grep 自己命中这些名字
    const TRACE = /data-kid[s]|dataset\.kid[s]|Kid[s]ModeToggle|toggleKid[s]|pressKid[s]Button|KID[S]_KEY|kid[s](?:Name|On|Off)\b|StarrySky|\bkid[s]\s*[:?]/;
    const hits = files.flatMap(({ name, src }) => src.split("\n").flatMap((line, i) => (TRACE.test(line) ? [`${name}:${i + 1}`] : [])));
    expect(hits).toEqual([]);
  });

  it("mentions the legacy storage key only in layout.tsx, where THEME_INIT removes it (and never reads it)", () => {
    expect(files.filter(({ src }) => src.includes(LEGACY_KEY)).map((f) => f.name)).toEqual(["app/layout.tsx"]);
    expect(THEME_INIT).toContain(`localStorage.removeItem("${LEGACY_KEY}")`);
    expect(THEME_INIT).not.toContain(`getItem("${LEGACY_KEY}")`);
  });
});
