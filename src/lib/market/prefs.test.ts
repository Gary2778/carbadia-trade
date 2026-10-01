import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPTH_OPTIONS } from "@/shared";
import { DEFAULT_PREFS, PREFS_KEY, readPrefs, readPrefsSnapshot, subscribePrefs, writePrefs, type TerminalPrefs } from "./prefs";

/** 最小 localStorage 假件(node 环境无 window / localStorage);可切换成抛错模式(写抛错,或读写都抛错 —— 禁用站点数据) */
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
    removeItem: (k: string) => void map.delete(k),
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
  // 上一个用例若留下了会话内偏好(存储写失败时的回退),一次成功的写入把它清掉
  g.localStorage = fakeStorage();
  writePrefs({});
});
afterEach(() => {
  if (saved === undefined) delete g.localStorage;
  else g.localStorage = saved;
});

describe("readPrefs", () => {
  it("null / 空串 / 非法 JSON / 非对象 → 默认值(同一引用)", () => {
    expect(readPrefs(null)).toBe(DEFAULT_PREFS);
    expect(readPrefs("")).toBe(DEFAULT_PREFS);
    expect(readPrefs("{oops")).toBe(DEFAULT_PREFS);
    expect(readPrefs("[1,2]")).toBe(DEFAULT_PREFS);
    expect(readPrefs("42")).toBe(DEFAULT_PREFS);
    expect(readPrefs("null")).toBe(DEFAULT_PREFS);
  });

  it("默认值:1m、agg null、深度 15、open、MA + VOL 开、lastSymbol null", () => {
    expect(DEFAULT_PREFS).toEqual({ interval: "1m", agg: null, depth: 15, bottomTab: "open", indicators: { ma: true, ema: false, vol: true }, lastSymbol: null });
    expect(DEFAULT_PREFS.depth).toBe(DEPTH_OPTIONS[0]);
  });

  it("缺键逐键回默认,合法键保留", () => {
    expect(readPrefs(JSON.stringify({ interval: "1h" }))).toEqual({ ...DEFAULT_PREFS, interval: "1h" });
    expect(readPrefs(JSON.stringify({ bottomTab: "fills", lastSymbol: "GS-REN-2020" }))).toEqual({ ...DEFAULT_PREFS, bottomTab: "fills", lastSymbol: "GS-REN-2020" });
  });

  it("非法值逐键回默认:interval / bottomTab 不在枚举、agg 非正整数、indicators 非布尔、lastSymbol 空串或非字符串", () => {
    const raw = JSON.stringify({ interval: "2m", agg: -5, bottomTab: "nope", indicators: { ma: "yes", ema: 1, vol: false }, lastSymbol: "" });
    expect(readPrefs(raw)).toEqual({ ...DEFAULT_PREFS, indicators: { ma: true, ema: false, vol: false } });
    expect(readPrefs(JSON.stringify({ agg: 1.5 })).agg).toBeNull();
    expect(readPrefs(JSON.stringify({ agg: 5 })).agg).toBe(5);
    expect(readPrefs(JSON.stringify({ indicators: "x", lastSymbol: 7 }))).toEqual(DEFAULT_PREFS);
  });

  it("bottomTab:第五个页签 ledger(P2-07)可读;加它之前存下的四个旧值照旧读出;未知值回默认 open,不连累其它键", () => {
    for (const tab of ["open", "history", "fills", "positions", "ledger"]) expect(readPrefs(JSON.stringify({ bottomTab: tab })).bottomTab, tab).toBe(tab);
    // 旧版本(四个页签)写下的整份偏好原样读回
    const legacy: TerminalPrefs = { interval: "15m", agg: 5, depth: 25, bottomTab: "positions", indicators: { ma: true, ema: true, vol: false }, lastSymbol: "VCS-FOR-2021" };
    expect(readPrefs(JSON.stringify(legacy))).toEqual(legacy);
    // 未知值(大小写不符、以后才有的页签、非字符串)→ 默认 open
    for (const tab of ["Ledger", "transactions", "", 4, null, ["ledger"]]) {
      expect(readPrefs(JSON.stringify({ bottomTab: tab, interval: "1h" })), JSON.stringify(tab)).toEqual({ ...DEFAULT_PREFS, interval: "1h" });
    }
  });

  it("depth 只认 DEPTH_OPTIONS(15 / 25 / 50)里的数;其余(不在档位里、字符串、小数、负数)回默认 15", () => {
    for (const depth of DEPTH_OPTIONS) expect(readPrefs(JSON.stringify({ depth })).depth).toBe(depth);
    for (const depth of [20, 0, -15, 25.5, "25", null, 100]) expect(readPrefs(JSON.stringify({ depth })).depth, String(depth)).toBe(15);
    // depth 非法不连累其它键
    expect(readPrefs(JSON.stringify({ depth: 7, agg: 5 }))).toEqual({ ...DEFAULT_PREFS, agg: 5 });
  });

  it("往返:全量写入再读回逐字段相等", () => {
    const prefs: TerminalPrefs = { interval: "4h", agg: 50, depth: 50, bottomTab: "positions", indicators: { ma: false, ema: true, vol: false }, lastSymbol: "VCS-FOR-2021" };
    expect(readPrefs(JSON.stringify(prefs))).toEqual(prefs);
  });
});

describe("writePrefs", () => {
  it("合并写入(部分键、indicators 子键),读回一致", () => {
    g.localStorage = fakeStorage();
    writePrefs({ interval: "1d" });
    expect(readPrefs(localStorage.getItem(PREFS_KEY))).toEqual({ ...DEFAULT_PREFS, interval: "1d" });
    writePrefs({ lastSymbol: "GS-REN-2020", indicators: { ema: true } as TerminalPrefs["indicators"] });
    expect(readPrefs(localStorage.getItem(PREFS_KEY))).toEqual({ ...DEFAULT_PREFS, interval: "1d", lastSymbol: "GS-REN-2020", indicators: { ma: true, ema: true, vol: true } });
  });

  it("depth 与 agg 一样合并写入并持久化,不动其它键", () => {
    g.localStorage = fakeStorage();
    writePrefs({ agg: 10 });
    writePrefs({ depth: 25 });
    expect(readPrefs(localStorage.getItem(PREFS_KEY))).toEqual({ ...DEFAULT_PREFS, agg: 10, depth: 25 });
  });

  it("已有非法内容时以默认为基底合并", () => {
    g.localStorage = fakeStorage();
    localStorage.setItem(PREFS_KEY, "{broken");
    writePrefs({ bottomTab: "history" });
    expect(readPrefs(localStorage.getItem(PREFS_KEY))).toEqual({ ...DEFAULT_PREFS, bottomTab: "history" });
  });

  it("切到流水页签(ledger)会持久化,旧存储里的其它键不动", () => {
    g.localStorage = fakeStorage();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ interval: "1h", bottomTab: "positions", lastSymbol: "VCS-FOR-2021" }));
    writePrefs({ bottomTab: "ledger" });
    expect(readPrefs(localStorage.getItem(PREFS_KEY))).toEqual({ ...DEFAULT_PREFS, interval: "1h", bottomTab: "ledger", lastSymbol: "VCS-FOR-2021" });
  });

  it("setItem 抛错(配额 / 隐私模式)不冒泡;没有 localStorage 也不抛", () => {
    g.localStorage = fakeStorage({ throwOnSet: true });
    expect(() => writePrefs({ interval: "5m" })).not.toThrow();
    delete g.localStorage;
    expect(() => writePrefs({ interval: "5m" })).not.toThrow();
  });
});

describe("storage unavailable: preferences still apply for this session (in-memory fallback)", () => {
  it("setItem throws (quota, cookies blocked): the snapshot reflects the write, later writes merge on top of it, references stay stable", () => {
    g.localStorage = fakeStorage({ throwOnSet: true });
    writePrefs({ interval: "5m", depth: 25, indicators: { ema: true } as TerminalPrefs["indicators"] });
    const snap = readPrefsSnapshot();
    expect(snap).toEqual({ ...DEFAULT_PREFS, interval: "5m", depth: 25, indicators: { ma: true, ema: true, vol: true } });
    expect(readPrefsSnapshot()).toBe(snap); // useSyncExternalStore:同一内容同一引用
    writePrefs({ agg: 10 });
    expect(readPrefsSnapshot()).toEqual({ ...snap, agg: 10 });
  });

  it("getItem and setItem both throw (site data blocked), or there is no localStorage at all: same", () => {
    g.localStorage = fakeStorage({ throwOnSet: true, throwOnGet: true });
    writePrefs({ interval: "1h" });
    expect(readPrefsSnapshot().interval).toBe("1h");
    delete g.localStorage;
    writePrefs({ bottomTab: "fills" });
    expect(readPrefsSnapshot()).toMatchObject({ interval: "1h", bottomTab: "fills" });
  });

  it("subscribers are told about the in-memory write (emit), so usePrefs re-renders with it", () => {
    const w = globalThis as unknown as { window?: EventTarget };
    const hadWindow = "window" in w;
    w.window ??= new EventTarget();
    const listener = vi.fn();
    const unsub = subscribePrefs(listener);
    g.localStorage = fakeStorage({ throwOnSet: true });
    writePrefs({ interval: "15m" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readPrefsSnapshot().interval).toBe("15m");
    unsub();
    if (!hadWindow) delete w.window;
  });

  it("once storage works again, a successful write goes back to storage (the session layer is dropped) and keeps what the session had", () => {
    g.localStorage = fakeStorage({ throwOnSet: true });
    writePrefs({ interval: "4h" });
    const storage = fakeStorage();
    g.localStorage = storage;
    writePrefs({ depth: 50 });
    expect(readPrefs(storage.getItem(PREFS_KEY))).toEqual({ ...DEFAULT_PREFS, interval: "4h", depth: 50 });
    storage.setItem(PREFS_KEY, JSON.stringify({ interval: "1d" }));
    expect(readPrefsSnapshot().interval).toBe("1d"); // 读存储,不再读会话层
  });

  it("another tab writing the key (storage event) drops the session layer: storage wins again", () => {
    const w = globalThis as unknown as { window?: EventTarget };
    const hadWindow = "window" in w;
    w.window ??= new EventTarget();
    const unsub = subscribePrefs(() => {});
    const storage = fakeStorage({ throwOnSet: true });
    g.localStorage = storage;
    writePrefs({ interval: "5m" });
    expect(readPrefsSnapshot().interval).toBe("5m");
    g.localStorage = fakeStorage();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ interval: "1h" }));
    w.window!.dispatchEvent(Object.assign(new Event("storage"), { key: PREFS_KEY }));
    expect(readPrefsSnapshot().interval).toBe("1h");
    unsub();
    if (!hadWindow) delete w.window;
  });
});
