import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMetadata } from "@/app/trade/[symbol]/layout";
import { PREFS_KEY } from "./prefs";
import {
  filtersToSearch,
  readFiltersFromUrl,
  readSideFromUrl,
  switchSymbol,
  symbolFromPath,
  terminalHref,
  terminalMetaTitle,
  terminalTitle,
  writeFiltersToUrl,
} from "./navigation";

// node 环境、不引 jsdom:window / document / localStorage 用最小假对象,replaceState 按真实语义改写 location。
type FakeLocation = { pathname: string; search: string; hash: string };
function installBrowser(initial: string) {
  const location: FakeLocation = { pathname: "/", search: "", hash: "" };
  const setUrl = (url: string) => {
    const u = new URL(url, "https://cbda.trade");
    location.pathname = u.pathname;
    location.search = u.search;
    location.hash = u.hash;
  };
  setUrl(initial);
  const replaceState = vi.fn((_state: unknown, _unused: string, url?: string | URL | null) => {
    if (url != null) setUrl(String(url));
  });
  const pushState = vi.fn();
  const store = new Map<string, string>();
  const doc = { title: "Carbadia Trade" };
  vi.stubGlobal("window", { location, history: { replaceState, pushState }, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return { location, replaceState, pushState, store, doc };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("symbolFromPath", () => {
  it("reads the upper-case symbol out of /trade/<SYMBOL>", () => {
    expect(symbolFromPath("/trade/VCS-FOR-2021")).toBe("VCS-FOR-2021");
    expect(symbolFromPath("/trade/CEA-SCEN-2026")).toBe("CEA-SCEN-2026");
    expect(symbolFromPath("/trade/GS-WIND-2023/")).toBe("GS-WIND-2023");
    // 调用方偶尔会传带 query / hash 的串:只看路径部分
    expect(symbolFromPath("/trade/CCER-SOL-2022?side=BUY")).toBe("CCER-SOL-2022");
    expect(symbolFromPath("/trade/CCER-SOL-2022#book")).toBe("CCER-SOL-2022");
  });

  it("returns null for every other shape", () => {
    for (const path of [
      "/trade",
      "/trade/",
      "/trade/vcs-for-2021", // 小写不是标的代码(page.tsx 对不在标的列表里的 symbol 一律 notFound)
      "/trade/VCS-FOR-2021/extra",
      "/trade//VCS-FOR-2021",
      "/trade/VCS--FOR",
      "/trade/-VCS",
      "/trade/VCS%20FOR",
      "/market/VCS-FOR-2021",
      "/trade-VCS-FOR-2021",
      "",
      null,
      undefined,
    ]) {
      expect(symbolFromPath(path), String(path)).toBeNull();
    }
  });
});

describe("terminalHref / terminalTitle", () => {
  it("builds /trade/<symbol> with an optional query in any common form", () => {
    expect(terminalHref("VCS-FOR-2021")).toBe("/trade/VCS-FOR-2021");
    expect(terminalHref("VCS-FOR-2021", "side=BUY")).toBe("/trade/VCS-FOR-2021?side=BUY");
    expect(terminalHref("VCS-FOR-2021", "?side=BUY&perf=1")).toBe("/trade/VCS-FOR-2021?side=BUY&perf=1");
    expect(terminalHref("VCS-FOR-2021", new URLSearchParams({ q: "forest" }))).toBe("/trade/VCS-FOR-2021?q=forest");
    for (const empty of ["", "?", null, undefined, new URLSearchParams()]) {
      expect(terminalHref("GS-MANG-2023", empty)).toBe("/trade/GS-MANG-2023");
    }
    // 路径段编码:任何输入都不能逃出 /trade/<segment>
    expect(terminalHref("A/B?C")).toBe("/trade/A%2FB%3FC");
  });

  it("writes the same title that generateMetadata renders through the root template", async () => {
    const root = readFileSync(fileURLToPath(new URL("../../app/layout.tsx", import.meta.url)), "utf8");
    const template = root.match(/template:\s*"([^"]+)"/)?.[1];
    expect(template).toBe("%s · Carbadia Trade");
    for (const symbol of ["VCS-FOR-2021", "CCER-SCEN-2026"]) {
      const meta = await generateMetadata({ params: Promise.resolve({ symbol }) });
      expect(meta.title).toBe(terminalMetaTitle(symbol));
      expect(template!.replace("%s", String(meta.title))).toBe(terminalTitle(symbol));
      expect(terminalTitle(symbol)).toBe(`${symbol} · Terminal · Carbadia Trade`);
      // 新路由不丢「模拟」说明
      expect(meta.description).toBe(`Simulated order book, candles and orders for ${symbol} on Carbadia Trade.`);
    }
  });
});

describe("readFiltersFromUrl / writeFiltersToUrl", () => {
  it("parses the filter keys from URLSearchParams or a Next searchParams record", () => {
    const expected = { q: "forest", registry: "Verra", projectType: "Forestry", vintage: 2021, minPrice: 5000, maxPrice: 9000, watchlistOnly: true, sort: "change" };
    const query = "q=forest&registry=Verra&projectType=Forestry&vintage=2021&minPrice=5000&maxPrice=9000&watchlist=1&sort=change&side=BUY";
    expect(readFiltersFromUrl(new URLSearchParams(query))).toEqual(expected);
    // Next 的 searchParams 是普通对象,重复键是数组(取第一个)
    expect(
      readFiltersFromUrl({ q: ["forest", "x"], registry: "Verra", projectType: "Forestry", vintage: "2021", minPrice: "5000", maxPrice: "9000", watchlist: "1", sort: "change", side: "BUY" }),
    ).toEqual(expected);
    expect(readFiltersFromUrl({})).toEqual({});
    expect(readFiltersFromUrl(new URLSearchParams())).toEqual({});
  });

  it("drops empty, malformed and out-of-range values instead of guessing", () => {
    expect(
      readFiltersFromUrl(
        new URLSearchParams("q=%20%20&registry=&vintage=20x1&minPrice=-5&maxPrice=12.5&watchlist=yes&sort=random"),
      ),
    ).toEqual({});
    expect(readFiltersFromUrl({ vintage: "1e3", minPrice: "0", maxPrice: undefined })).toEqual({ minPrice: 0 });
  });

  it("round-trips through the URL with replaceState only, keeping unrelated params and the hash", () => {
    const browser = installBrowser("/trade/VCS-FOR-2021?side=SELL&perf=1#book");
    const filters = { q: "wind", vintage: 2023, maxPrice: 8000, watchlistOnly: true, sort: "volume" as const };
    writeFiltersToUrl(filters);
    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.replaceState).toHaveBeenCalledTimes(1);
    expect(browser.replaceState.mock.calls[0][0]).toBeNull();
    expect(browser.location.pathname).toBe("/trade/VCS-FOR-2021");
    expect(browser.location.hash).toBe("#book");
    const params = new URLSearchParams(browser.location.search);
    expect(params.get("side")).toBe("SELL");
    expect(params.get("perf")).toBe("1");
    // 不传参数时读 window.location.search
    expect(readFiltersFromUrl()).toEqual(filters);

    // 清空筛选:只删筛选键,其余参数原样
    writeFiltersToUrl({});
    expect(browser.location.search).toBe("?side=SELL&perf=1");
    expect(readFiltersFromUrl()).toEqual({});

    // 与当前 URL 相同时不再 replaceState
    browser.replaceState.mockClear();
    writeFiltersToUrl({});
    expect(browser.replaceState).not.toHaveBeenCalled();
  });

  it("serialises filters in a fixed key order so the URL is stable", () => {
    expect(filtersToSearch("", { sort: "price", q: "solar", minPrice: 100 })).toBe("?q=solar&minPrice=100&sort=price");
    expect(filtersToSearch("?side=BUY&q=old", { q: "new" })).toBe("?side=BUY&q=new");
    expect(filtersToSearch("?side=BUY", {})).toBe("?side=BUY");
    expect(filtersToSearch("?q=x", {})).toBe("");
  });

  it("is a no-op on the server", () => {
    expect(() => writeFiltersToUrl({ q: "x" })).not.toThrow();
    expect(() => switchSymbol("VCS-FOR-2021")).not.toThrow();
  });
});

describe("readSideFromUrl", () => {
  it("accepts BUY / SELL in any case and nothing else", () => {
    expect(readSideFromUrl({ side: "BUY" })).toBe("BUY");
    expect(readSideFromUrl({ side: "sell" })).toBe("SELL");
    expect(readSideFromUrl(new URLSearchParams("side=Buy"))).toBe("BUY");
    expect(readSideFromUrl({ side: ["SELL", "BUY"] })).toBe("SELL");
    expect(readSideFromUrl({ side: "short" })).toBeUndefined();
    expect(readSideFromUrl({})).toBeUndefined();
  });
});

describe("switchSymbol", () => {
  let browser: ReturnType<typeof installBrowser>;
  beforeEach(() => {
    browser = installBrowser("/trade/VCS-FOR-2021?side=BUY&q=forest#chart");
  });

  it("replaces the URL keeping the query, writes the templated title and remembers the symbol", () => {
    switchSymbol("GS-WIND-2023");
    expect(browser.pushState).not.toHaveBeenCalled();
    expect(browser.replaceState).toHaveBeenCalledWith(null, "", "/trade/GS-WIND-2023?side=BUY&q=forest#chart");
    expect(browser.location.pathname).toBe("/trade/GS-WIND-2023");
    expect(browser.location.search).toBe("?side=BUY&q=forest");
    expect(symbolFromPath(browser.location.pathname)).toBe("GS-WIND-2023");
    expect(browser.doc.title).toBe("GS-WIND-2023 · Terminal · Carbadia Trade");
    expect(JSON.parse(browser.store.get(PREFS_KEY) ?? "{}").lastSymbol).toBe("GS-WIND-2023");
  });

  it("does nothing to the history when the symbol is already current", () => {
    switchSymbol("VCS-FOR-2021");
    expect(browser.replaceState).not.toHaveBeenCalled();
    expect(browser.doc.title).toBe("VCS-FOR-2021 · Terminal · Carbadia Trade");
  });
});
