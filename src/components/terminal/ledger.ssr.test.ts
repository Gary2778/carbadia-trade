import { createElement } from "react";
import { renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server 的同名函数 + /trade 布局登记终端文案的那层 Provider(P2-01)
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LedgerActivity } from "@/shared/api-shapes";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import { ACTIVITY_TYPES, LEDGER_ACCOUNTS } from "@/lib/exchange/ledger-activity";
import {
  certificateHref,
  DEFAULT_LEDGER_FILTERS,
  isDefaultLedgerFilters,
  LEDGER_CACHE_MAX,
  LEDGER_PAGE_LIMIT,
  LEDGER_RANGES,
  ledgerCsvHref,
  ledgerPageUrl,
  ledgerQueries,
  ledgerQueryParams,
  ledgerRefKind,
  ledgerRequest,
  ledgerRequestKey,
  LedgerRow,
  LedgerTab,
  ledgerUnit,
  LedgerView,
  newestLedgerFirst,
  rangeFrom,
  refTail,
  type LedgerFilterState,
  type LedgerRequest,
  type LedgerRowProps,
  type LedgerViewProps,
} from "./LedgerTab";
import { fmtLedgerDelta, isCashAccount, ledgerTone } from "./TabTable";

// 终端「流水」页签(P2-07)的服务端标记与纯函数测试(node 环境,不引 jsdom;交互在内置浏览器里验收)。
// 放在单独的文件里而不是 tabs.ssr.test.ts:同一波的 P2-09 在改那份文件的持仓部分,分开放两边不会撞行。
// 页签数量、标题顺序、键盘移动仍在 tabs.ssr.test.ts 的 BottomTabs 一节。

const T = en.terminal;
const count = (html: string, needle: string) => html.split(needle).length - 1;

const DAY = 86_400_000;
// 本地时间 2026-10-01 15:30:00.250(用本地时间构造:rangeFrom 按用户的时区取「今天」,断言不写死某个时区)
const NOW = new Date(2026, 9, 1, 15, 30, 0, 250).getTime();

function activity(id: string, ts: number, patch: Partial<LedgerActivity> = {}): LedgerActivity {
  return {
    id,
    ts,
    account: "CASH",
    type: "RESERVE",
    label: "Demo funds reserved",
    reason: "ORDER_LOCK",
    assetId: "asset-VCS-FOR-2021",
    symbol: "VCS-FOR-2021",
    isScenario: false,
    delta: -68_500,
    refType: "ORDER",
    refId: "cmg4x1a2b0001abcd9f8e7d6c",
    ...patch,
  };
}

const rowProps = (patch: Partial<LedgerRowProps> = {}): LedgerRowProps => ({
  id: "le-1",
  ts: NOW,
  type: "RESERVE",
  symbol: "VCS-FOR-2021",
  account: "CASH",
  delta: -68_500,
  isScenario: false,
  refType: "ORDER",
  refId: "cmg4x1a2b0001abcd9f8e7d6c",
  onOpenFill: () => {},
  ...patch,
});
const row = (patch: Partial<LedgerRowProps> = {}) => renderToStaticMarkup(createElement(LedgerRow, rowProps(patch)));

const viewProps = (patch: Partial<LedgerViewProps> = {}): LedgerViewProps => ({
  symbol: "VCS-FOR-2021",
  filters: DEFAULT_LEDGER_FILTERS,
  onFilters: () => {},
  items: [],
  onOpenFill: () => {},
  ...patch,
});
const view = (patch: Partial<LedgerViewProps> = {}) => renderToStaticMarkup(createElement(LedgerView, viewProps(patch)));

const ALL: LedgerRequest = { account: null, type: null, symbol: null, range: "all", tz: "local" };

describe("ledger filters → query (pure)", () => {
  it("starts with no filter: all accounts, all types, all instruments, all time", () => {
    expect(DEFAULT_LEDGER_FILTERS).toEqual({ account: null, type: null, scope: "all", range: "all" });
    expect(isDefaultLedgerFilters(DEFAULT_LEDGER_FILTERS)).toBe(true);
    expect(isDefaultLedgerFilters({ ...DEFAULT_LEDGER_FILTERS, range: "7d" })).toBe(false);
    expect(ledgerRequest(DEFAULT_LEDGER_FILTERS, "VCS-FOR-2021", "local")).toEqual(ALL);
    expect(ledgerQueryParams(ALL, NOW).toString()).toBe("");
    expect(ledgerPageUrl(ALL, null, NOW)).toBe(`/api/transactions?limit=${LEDGER_PAGE_LIMIT}`);
    expect(LEDGER_PAGE_LIMIT).toBe(50);
  });

  it("the symbol filter follows the terminal's current symbol only in the 'current' scope", () => {
    const current: LedgerFilterState = { ...DEFAULT_LEDGER_FILTERS, scope: "current" };
    expect(ledgerRequest(current, "VCS-FOR-2021", "local").symbol).toBe("VCS-FOR-2021");
    expect(ledgerRequest(current, "GS-WIND-2022", "local").symbol).toBe("GS-WIND-2022");
    expect(ledgerRequest({ ...current, scope: "all" }, "GS-WIND-2022", "local").symbol).toBeNull();
  });

  it("maps each filter to the C4 parameter names (account, type, symbol, from), one at a time and combined", () => {
    expect(ledgerQueryParams({ ...ALL, account: "CASH_LOCKED" }, NOW).toString()).toBe("account=CASH_LOCKED");
    expect(ledgerQueryParams({ ...ALL, type: "RELEASE" }, NOW).toString()).toBe("type=RELEASE");
    expect(ledgerQueryParams({ ...ALL, symbol: "VCS-FOR-2021" }, NOW).toString()).toBe("symbol=VCS-FOR-2021");
    expect(ledgerQueryParams({ ...ALL, range: "today" }, NOW).toString()).toBe(`from=${rangeFrom("today", NOW, "local")}`);
    const combined: LedgerRequest = { account: "HOLDING", type: "BUY", symbol: "GS-WIND-2022", range: "7d", tz: "local" };
    const params = ledgerQueryParams(combined, NOW);
    expect([...params.keys()]).toEqual(["account", "type", "symbol", "from"]);
    expect(Object.fromEntries(params)).toEqual({ account: "HOLDING", type: "BUY", symbol: "GS-WIND-2022", from: String(rangeFrom("7d", NOW, "local")) });
    // 不传 to(到此刻为止),也不带 limit / cursor:CSV 导出(P2-06)用同一组筛选参数
    expect(params.has("to")).toBe(false);
    expect(params.has("limit")).toBe(false);
  });

  it("builds the page URL with limit first and the keyset cursor last; a symbol is URL-encoded", () => {
    expect(ledgerPageUrl({ ...ALL, account: "CASH" }, "eyJ4Ijox", NOW)).toBe("/api/transactions?limit=50&account=CASH&cursor=eyJ4Ijox");
    expect(ledgerPageUrl({ ...ALL, symbol: "A&B C" }, null, NOW)).toBe("/api/transactions?limit=50&symbol=A%26B+C");
  });

  it("time ranges start at local midnight: today, today and the 6 / 29 days before it; 'all' has no lower bound", () => {
    expect(LEDGER_RANGES).toEqual(["today", "7d", "30d", "all"]);
    expect(rangeFrom("all", NOW, "local")).toBeNull();
    const today = rangeFrom("today", NOW, "local")!;
    expect(today).toBe(new Date(2026, 9, 1).getTime());
    expect(rangeFrom("7d", NOW, "local")).toBe(new Date(2026, 8, 25).getTime());
    expect(rangeFrom("30d", NOW, "local")).toBe(new Date(2026, 8, 2).getTime());
    // 一天之内边界不动:同一份查询翻页、刷新用的是同一个 from
    expect(rangeFrom("today", NOW + 3 * 3_600_000, "local")).toBe(today);
    expect(rangeFrom("today", today, "local")).toBe(today);
    expect(rangeFrom("today", today - 1, "local")).toBe(today - DAY);
    // 服务端要求 from 是 0..8.64e15 的整数毫秒
    for (const range of LEDGER_RANGES) {
      const from = rangeFrom(range, NOW, "local");
      if (from !== null) expect(Number.isSafeInteger(from) && from >= 0 && from <= NOW, range).toBe(true);
    }
  });

  it("time ranges follow the chosen zone's midnight (P3-09): Beijing and UTC give different lower bounds for the same instant, and the key, the page URL and the CSV link carry them", () => {
    // 2026-10-01 20:00 UTC = 2026-10-02 04:00 北京时间:UTC 的「今天」是 10-01,北京的「今天」已经是 10-02
    const at = Date.UTC(2026, 9, 1, 20, 0);
    expect(rangeFrom("today", at, "UTC")).toBe(Date.UTC(2026, 9, 1));
    expect(rangeFrom("7d", at, "UTC")).toBe(Date.UTC(2026, 8, 25));
    expect(rangeFrom("30d", at, "UTC")).toBe(Date.UTC(2026, 8, 2));
    expect(rangeFrom("today", at, "Asia/Shanghai")).toBe(Date.UTC(2026, 9, 1, 16)); // 10-02 00:00 +08:00
    expect(rangeFrom("7d", at, "Asia/Shanghai")).toBe(Date.UTC(2026, 8, 25, 16)); // 09-26 00:00 +08:00
    expect(rangeFrom("30d", at, "Asia/Shanghai")).toBe(Date.UTC(2026, 8, 2, 16)); // 09-03 00:00 +08:00
    expect(rangeFrom("all", at, "Asia/Shanghai")).toBeNull();
    const beijing: LedgerRequest = { ...ALL, range: "today", tz: "Asia/Shanghai" };
    const utc: LedgerRequest = { ...ALL, range: "today", tz: "UTC" };
    expect(ledgerRequestKey(beijing, at)).toBe(`*|*|*|today@${Date.UTC(2026, 9, 1, 16)}`);
    expect(ledgerRequestKey(utc, at)).toBe(`*|*|*|today@${Date.UTC(2026, 9, 1)}`);
    expect(ledgerPageUrl(beijing, null, at)).toBe(`/api/transactions?limit=50&from=${Date.UTC(2026, 9, 1, 16)}`);
    // CSV 链接的 from 随时区(内容仍是 UTC,见 shared/csv.ts),其余参数不变
    expect(ledgerCsvHref(beijing, at)).toBe(`/api/transactions.csv?from=${Date.UTC(2026, 9, 1, 16)}`);
    expect(ledgerCsvHref(utc, at)).toBe(`/api/transactions.csv?from=${Date.UTC(2026, 9, 1)}`);
    expect(ledgerCsvHref({ ...beijing, range: "all" }, at)).toBe("/api/transactions.csv");
    // 一天之内(按所选时区)边界不动,过了那个时区的午夜才换:北京 10-02 00:00 = UTC 10-01 16:00
    expect(ledgerRequestKey(beijing, Date.UTC(2026, 9, 1, 16))).toBe(ledgerRequestKey(beijing, at));
    expect(ledgerRequestKey(beijing, Date.UTC(2026, 9, 1, 15, 59, 59, 999))).not.toBe(ledgerRequestKey(beijing, at));
  });

  it("counting back 6 / 29 days lands on that day's midnight even when a daylight-saving change makes a day 23 or 25 hours (zone passed explicitly, not the machine's)", () => {
    // 洛杉矶 2026-03-08 凌晨 2 点进入夏令时(当天 23 小时),11-01 退出(25 小时)
    const afterSpring = Date.UTC(2026, 2, 11, 1, 0); // 03-10 18:00 PDT
    expect(rangeFrom("today", afterSpring, "America/Los_Angeles")).toBe(Date.UTC(2026, 2, 10, 7)); // 03-10 00:00 PDT
    expect(rangeFrom("7d", afterSpring, "America/Los_Angeles")).toBe(Date.UTC(2026, 2, 4, 8)); // 03-04 00:00 PST,不是「往前 6 × 24 小时」的 03-03 23:00
    const afterFall = Date.UTC(2026, 10, 3, 18, 0); // 11-03 10:00 PST
    expect(rangeFrom("7d", afterFall, "America/Los_Angeles")).toBe(Date.UTC(2026, 9, 28, 7)); // 10-28 00:00 PDT
    expect(rangeFrom("30d", afterFall, "America/Los_Angeles")).toBe(Date.UTC(2026, 9, 5, 7)); // 10-05 00:00 PDT
  });

  it("the cache key identifies the filter combination plus the day's lower bound: stable within a local day, new on the next", () => {
    const keys = new Set<string>();
    for (const account of [null, ...LEDGER_ACCOUNTS]) {
      for (const type of [null, "BUY", "RELEASE"] as const) {
        for (const symbol of [null, "VCS-FOR-2021"]) {
          for (const range of LEDGER_RANGES) keys.add(ledgerRequestKey({ account, type, symbol, range, tz: "local" }, NOW));
        }
      }
    }
    expect(keys.size).toBe(5 * 3 * 2 * 4);
    // 有下界的时间段带上当天算出的 from;「全部」没有下界,键里也就没有时间
    expect(ledgerRequestKey({ account: "CASH", type: "RESERVE", symbol: "VCS-FOR-2021", range: "7d", tz: "local" }, NOW)).toBe(`CASH|RESERVE|VCS-FOR-2021|7d@${new Date(2026, 8, 25).getTime()}`);
    expect(ledgerRequestKey({ ...ALL, range: "today" }, NOW)).toBe(`*|*|*|today@${new Date(2026, 9, 1).getTime()}`);
    expect(ledgerRequestKey(ALL, NOW)).toBe("*|*|*|all");
    const midnight = new Date(2026, 9, 2).getTime();
    for (const range of LEDGER_RANGES) {
      const request: LedgerRequest = { ...ALL, range };
      // 同一个本地日历日里(0 点整到 23:59:59.999)键不变:翻页、刷新、切回页签拿到的是同一份查询
      expect(ledgerRequestKey(request, new Date(2026, 9, 1).getTime()), range).toBe(ledgerRequestKey(request, NOW));
      expect(ledgerRequestKey(request, midnight - 1), range).toBe(ledgerRequestKey(request, NOW));
      // 过了本地午夜:有下界的时间段是一个新键(新查询),「全部」还是原来那个
      if (range === "all") expect(ledgerRequestKey(request, midnight)).toBe(ledgerRequestKey(request, NOW));
      else expect(ledgerRequestKey(request, midnight), range).not.toBe(ledgerRequestKey(request, NOW));
    }
  });

  it("sorts like the server: ts desc, then id desc (several rows share a millisecond)", () => {
    const rows = [activity("a", 1), activity("c", 2), activity("b", 2), activity("d", 2)];
    expect(rows.sort(newestLedgerFirst).map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
  });
});

describe("ledger change formatting", () => {
  it("picks the unit from the account first, then from isScenario (a scenario trade's cash leg is still cash)", () => {
    expect(ledgerUnit("CASH", false)).toBe("cash");
    expect(ledgerUnit("CASH_LOCKED", true)).toBe("cash");
    expect(ledgerUnit("HOLDING", false)).toBe("tonnes");
    expect(ledgerUnit("HOLDING_LOCKED", false)).toBe("tonnes");
    expect(ledgerUnit("HOLDING", true)).toBe("scenario");
    expect(ledgerUnit("HOLDING_LOCKED", true)).toBe("scenario");
  });

  it("formats cash as signed cents with two decimals and holdings as signed whole tonnes (one formatter, shared with the fill detail)", () => {
    expect(fmtLedgerDelta("CASH", 123_456, "en-US")).toBe("+1,234.56");
    expect(fmtLedgerDelta("CASH_LOCKED", -68_500, "en-US")).toBe("-685.00");
    expect(fmtLedgerDelta("CASH_LOCKED", -123_456, "en-US")).toBe("-1,234.56");
    expect(fmtLedgerDelta("HOLDING", 1_200, "en-US")).toBe("+1,200");
    expect(fmtLedgerDelta("HOLDING_LOCKED", -10, "en-US")).toBe("-10");
    expect(fmtLedgerDelta("CASH", 0, "en-US")).toBe("0.00");
    expect(fmtLedgerDelta("HOLDING", 0, "en-US")).toBe("0");
    expect(fmtLedgerDelta("CASH", 123_456, "zh-CN")).toBe("+1,234.56");
    // 「是不是现金账户」直接问:四个账本账户里只有两个现金账户
    expect(LEDGER_ACCOUNTS.filter(isCashAccount)).toEqual(["CASH", "CASH_LOCKED"]);
    expect(isCashAccount("CASHIER")).toBe(false);
  });

  it("tones a ledger change neutrally: foreground for any movement, muted for zero — never a direction colour", () => {
    expect([ledgerTone(68_500), ledgerTone(-10), ledgerTone(0)]).toEqual(["text-foreground", "text-foreground", "text-muted"]);
  });
});

describe("ledger references", () => {
  it("a trade opens the fill detail, a retirement links its certificate, everything else is text", () => {
    expect(ledgerRefKind("TRADE", "t1")).toBe("fill");
    expect(ledgerRefKind("RETIREMENT", "r1")).toBe("certificate");
    for (const refType of ["ORDER", "LISTING", "DEAL", "SOMETHING_NEW"]) expect(ledgerRefKind(refType, "x1"), refType).toBe("text");
    // 没有引用(赠金、期初余额):不显示任何引用,也不编一个
    expect(ledgerRefKind(null, null)).toBeNull();
    expect(ledgerRefKind("ORDER", null)).toBeNull();
    expect(ledgerRefKind(null, "x1")).toBeNull();
  });

  it("links the private certificate route and shows only the tail of an id", () => {
    expect(certificateHref("ret_1")).toBe("/api/retirements/ret_1/certificate");
    expect(certificateHref("a/b")).toBe("/api/retirements/a%2Fb/certificate");
    expect(refTail("cmg4x1a2b0001abcd9f8e7d6c")).toBe("…9f8e7d6c");
    expect(refTail("short")).toBe("short");
  });
});

describe("LedgerRow", () => {
  it("shows time, type, symbol, account, signed change with its unit, and the reference", () => {
    const html = row();
    expect(html).toContain('data-ledger-id="le-1"');
    expect(html).toContain(`>${T.ledger.types.RESERVE}<`);
    expect(html).toContain(">VCS-FOR-2021<");
    expect(html).toContain(`>${T.ledger.accounts.CASH}<`);
    // 数字与单位之间是一个真的空格(读屏、复制出来都是 "-685.00 USD")
    expect(html.replace(/<[^>]+>/g, "")).toContain("-685.00 USD");
    expect(html).toContain(`> ${T.ledger.units.cash}</span>`);
    // 订单引用:类别 + 订单号尾段,完整 id 在 title 里;不是链接也不是按钮
    expect(html).toContain(`${T.ledger.refs.ORDER} …9f8e7d6c`);
    expect(html).toContain('title="cmg4x1a2b0001abcd9f8e7d6c"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
  });

  it("has a label for every activity type and every ledger account, in both languages", () => {
    for (const type of ACTIVITY_TYPES) {
      expect(row({ type }), type).toContain(`>${T.ledger.types[type]}<`);
      expect(zhCN.terminal.ledger.types[type], type).toBeTruthy();
    }
    for (const account of LEDGER_ACCOUNTS) {
      expect(row({ account }), account).toContain(`>${T.ledger.accounts[account]}<`);
      expect(zhCN.terminal.ledger.accounts[account], account).toBeTruthy();
    }
    expect(Object.keys(T.ledger.types).sort()).toEqual([...ACTIVITY_TYPES].sort());
    expect(Object.keys(T.ledger.accounts).sort()).toEqual([...LEDGER_ACCOUNTS].sort());
  });

  it("marks increases and decreases with the sign and a screen-reader word, never with the up / down colours", () => {
    const up = row({ account: "CASH", delta: 68_500, type: "RELEASE" });
    expect(up).toContain('data-direction="in"');
    expect(up).toContain("+685.00");
    expect(up).toContain(`<span class="sr-only">${T.ledger.increase} </span>`);
    const down = row({ account: "HOLDING_LOCKED", delta: -10, type: "RELEASE" });
    expect(down).toContain('data-direction="out"');
    expect(down).toContain("-10");
    expect(down).toContain(`<span class="sr-only">${T.ledger.decrease} </span>`);
    expect(down).toContain(`> ${T.ledger.units.tonnes}</span>`);
    const flat = row({ delta: 0 });
    expect(flat).toContain('data-direction="none"');
    expect(flat).not.toContain(T.ledger.increase);
    expect(flat).not.toContain(T.ledger.decrease);
    // 中性色:有变动是前景色,0 是 muted
    expect(up).toContain('data-direction="in" class="tnum truncate text-end text-foreground"');
    expect(down).toContain('data-direction="out" class="tnum truncate text-end text-foreground"');
    expect(flat).toContain('data-direction="none" class="tnum truncate text-end text-muted"');
    // 红涨模式下涨跌色会对调:流水的增减不借用它们
    for (const html of [up, down, flat]) {
      expect(html).not.toContain("--terminal-up");
      expect(html).not.toContain("--terminal-down");
    }
  });

  it("labels scenario holdings as scenario units, but a scenario trade's cash leg as cash", () => {
    expect(row({ account: "HOLDING", delta: 5, isScenario: true, type: "BUY", symbol: "CEA-SCEN-2026" })).toContain(`> ${T.ledger.units.scenario}</span>`);
    const cash = row({ account: "CASH", delta: -500, isScenario: true, type: "SETTLEMENT", symbol: "CEA-SCEN-2026" });
    expect(cash).toContain(`> ${T.ledger.units.cash}</span>`);
    expect(cash).not.toContain(T.ledger.units.scenario);
  });

  it("sets the reference column apart from the end-aligned change column: start padding on text cells, the same start margin on the button and the link", () => {
    expect(row()).toMatch(/<span class="truncate ps-panel tnum text-t-xs text-muted" title="cmg4x1a2b0001abcd9f8e7d6c">/);
    expect(row({ refType: null, refId: null })).toContain('<span class="truncate ps-panel text-muted">—</span>');
    expect(row({ type: "BUY", refType: "TRADE", refId: "t1" })).toMatch(/<button [^>]*class="tnum ms-panel truncate /);
    expect(row({ type: "RETIREMENT", refType: "RETIREMENT", refId: "r1" })).toMatch(/<a [^>]*class="ms-panel truncate /);
  });

  it("a trade reference is a button that opens the fill detail", () => {
    const html = row({ type: "BUY", account: "HOLDING", delta: 10, refType: "TRADE", refId: "cmg4trade00012345abcdef01" });
    expect(html).toContain(`<button type="button" data-fill-ref="cmg4trade00012345abcdef01" title="${T.ledger.refFillHint}"`);
    expect(html).toContain(`>${T.ledger.refs.TRADE} …abcdef01</button>`);
    expect(html).not.toContain("<a ");
  });

  it("a retirement reference links the certificate in a new tab", () => {
    const html = row({ type: "RETIREMENT", account: "HOLDING", delta: -3, refType: "RETIREMENT", refId: "cmg4ret0001" });
    expect(html).toContain(`<a href="/api/retirements/cmg4ret0001/certificate" target="_blank" rel="noopener noreferrer" title="${T.ledger.refCertificateHint}"`);
    expect(html).toContain(`>${T.ledger.refs.RETIREMENT}<span class="sr-only"> ${T.ledger.newTab}</span></a>`);
    expect(html).not.toContain("<button");
  });

  it("names OTC references, shows an unknown reference type as its raw code, and — when there is none", () => {
    expect(row({ refType: "LISTING", refId: "cmg4lst00000000000001234" })).toContain(`${T.ledger.refs.LISTING} …00001234`);
    expect(row({ refType: "DEAL", refId: "cmg4deal0000000000005678" })).toContain(`${T.ledger.refs.DEAL} …00005678`);
    expect(row({ refType: "SOMETHING_NEW", refId: "abc" })).toContain("SOMETHING_NEW abc");
    const none = row({ type: "OPENING_BALANCE", symbol: null, refType: null, refId: null, delta: 10_000_000 });
    expect(none).toContain("+100,000.00");
    // 标的与引用都没有:两格都是「—」,不编造
    expect(count(none, ">—<")).toBe(2);
  });
});

describe("CSV export (P2-06)", () => {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

  it("ledgerCsvHref = /api/transactions.csv + exactly the list's filter params (no limit / cursor), from counted on the same local day", () => {
    expect(ledgerCsvHref(ALL, NOW)).toBe("/api/transactions.csv");
    const combos: LedgerRequest[] = [
      { account: "CASH_LOCKED", type: null, symbol: null, range: "all", tz: "local" },
      { account: null, type: "RESERVE", symbol: "VCS-FOR-2021", range: "today", tz: "local" },
      { account: "HOLDING", type: "BUY", symbol: "=SUM(1,2)", range: "30d", tz: "local" },
    ];
    for (const combo of combos) {
      const href = new URL(ledgerCsvHref(combo, NOW), "http://localhost");
      const page = new URL(ledgerPageUrl(combo, "some-cursor", NOW), "http://localhost").searchParams;
      page.delete("limit");
      page.delete("cursor");
      expect(href.pathname).toBe("/api/transactions.csv");
      expect([...href.searchParams], JSON.stringify(combo)).toEqual([...page]);
      expect(href.searchParams.has("limit")).toBe(false);
      expect(href.searchParams.get("from")).toBe(combo.range === "all" ? null : String(rangeFrom(combo.range, NOW, "local")));
    }
    // 标的代码经 URLSearchParams 编码,不会拼坏查询串
    expect(ledgerCsvHref(combos[2], NOW)).toContain("symbol=%3DSUM%281%2C2%29");
  });

  it("on a narrow screen only the filter group scrolls sideways; the download link is a non-shrinking sibling that stays in view (P2-12)", () => {
    const html = view({ exportHref: ledgerCsvHref(ALL, NOW), pager: { status: "done", onLoadMore: () => {} } });
    const group = /<div role="group" aria-label="[^"]+" class="([^"]+)">/.exec(html)?.[1] ?? "";
    expect(group.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "overflow-x-auto"]));
    // 外层工具行不滚动:它就是筛选组的父节点
    const row = html.slice(0, html.indexOf('<div role="group"'));
    expect(row.slice(row.lastIndexOf("<div"))).toBe('<div class="flex shrink-0 items-center gap-gap">');
    // 导出链接的包装不收缩,紧跟在筛选组之后
    expect(html).toMatch(/<\/select><\/div><div class="flex shrink-0 p-0\.5"><a href="[^"]+" download="" data-export-csv=""/);
  });

  it("LedgerView puts the download link at the end of the filter row, outside the filter group; the hint mentions filters only when one is set", () => {
    const href = ledgerCsvHref(ALL, NOW);
    const plain = view({ exportHref: href, pager: { status: "done", onLoadMore: () => {} } });
    expect(count(plain, "data-export-csv")).toBe(1);
    expect(plain).toContain(`<a href="${href}" download="" data-export-csv="" title="${esc(T.exportCsv.hint)}"`);
    expect(plain).toMatch(new RegExp(`data-export-csv=""[^>]*>${T.exportCsv.label}</a>`));
    // 在四个下拉之后,在筛选组(role=group)之外
    const group = plain.slice(plain.indexOf('role="group"'), plain.indexOf("data-export-csv"));
    expect(count(group, "<select")).toBe(4);
    expect(group).toContain("</select></div>");
    expect(plain.indexOf("data-export-csv")).toBeLessThan(plain.indexOf(`>${T.tabs.colTime}</span>`));

    const filters: LedgerFilterState = { account: "CASH", type: "RESERVE", scope: "current", range: "7d" };
    const filteredHref = ledgerCsvHref(ledgerRequest(filters, "VCS-FOR-2021", "local"), NOW);
    const filtered = view({ filters, exportHref: filteredHref, pager: { status: "done", onLoadMore: () => {} } });
    expect(filtered).toContain(`<a href="${esc(filteredHref)}" download="" data-export-csv="" title="${esc(T.exportCsv.hintFiltered)}"`);
    expect(filteredHref).toMatch(/^\/api\/transactions\.csv\?account=CASH&type=RESERVE&symbol=VCS-FOR-2021&from=\d+$/);
    // 加载中、出错时工具行(连同导出入口)都还在
    expect(view({ exportHref: href, pager: { status: "loading", onLoadMore: () => {} } })).toContain("data-export-csv");
    expect(view({ exportHref: href, pager: { status: "error", onLoadMore: () => {} } })).toContain("data-export-csv");
  });

  it("no exportHref, no link (the view is also used without one)", () => {
    expect(view({ pager: { status: "done", onLoadMore: () => {} } })).not.toContain("data-export-csv");
  });
});

describe("LedgerView", () => {
  it("offers the four filters as labelled native selects, with the current symbol as the only instrument choice besides All", () => {
    const html = view({ pager: { status: "done", onLoadMore: () => {} } });
    expect(html).toContain(`role="group" aria-label="${T.ledger.filtersLabel}"`);
    expect(count(html, "<select")).toBe(4);
    for (const label of [T.ledger.filterAccount, T.ledger.filterType, T.ledger.filterSymbol, T.ledger.filterRange]) expect(html).toContain(`<select aria-label="${label}"`);
    // 账户:全部 + 四个账本账户;类型:全部 + 全部 ActivityType(顺序 = ACTIVITY_TYPES)
    const options = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", T.ledger.allAccounts],
      ...LEDGER_ACCOUNTS.map((a) => [a, T.ledger.accounts[a]]),
      ["", T.ledger.allTypes],
      ...ACTIVITY_TYPES.map((a) => [a, T.ledger.types[a]]),
      ["all", T.ledger.allSymbols],
      ["current", "VCS-FOR-2021"],
      ...LEDGER_RANGES.map((r) => [r, T.ledger.ranges[r]]),
    ]);
  });

  it("reflects the chosen filters in the selects", () => {
    const html = view({ filters: { account: "CASH_LOCKED", type: "RELEASE", scope: "current", range: "7d" }, pager: { status: "done", onLoadMore: () => {} } });
    for (const value of ["CASH_LOCKED", "RELEASE", "current", "7d"]) expect(html, value).toContain(`<option value="${value}" selected="">`);
  });

  it("loading: a Skeleton under the filter bar while the first page is on its way", () => {
    for (const status of ["idle", "loading"] as const) {
      const html = view({ pager: { status, onLoadMore: () => {} } });
      expect(count(html, "<select")).toBe(4);
      expect(html).toContain('role="status" aria-busy="true"');
      expect(html).not.toContain(T.ledger.empty);
      expect(html).not.toContain('role="alert"');
    }
  });

  it("error: an ErrorState with retry, and the filters stay usable", () => {
    const html = view({ pager: { status: "error", onLoadMore: () => {} } });
    expect(count(html, "<select")).toBe(4);
    expect(html).toContain('role="alert"');
    expect(html).toContain(`>${en.ui.retry}</button>`);
    expect(html).not.toContain(T.ledger.empty);
  });

  it("empty: EmptyState; with filters on it says so and offers to clear them", () => {
    const plain = view({ pager: { status: "done", onLoadMore: () => {} } });
    expect(plain).toContain(`>${T.ledger.empty}<`);
    expect(plain).not.toContain(T.ledger.clearFilters);
    const filtered = view({ filters: { ...DEFAULT_LEDGER_FILTERS, type: "RETIREMENT" }, pager: { status: "done", onLoadMore: () => {} } });
    expect(filtered).toContain(`>${T.ledger.emptyFiltered}<`);
    expect(filtered).toContain(`>${T.ledger.clearFilters}</button>`);
    expect(filtered).not.toContain(`>${T.ledger.empty}<`);
  });

  it("rows: the six column titles, one row per entry, a named scroll region, and the load-more sentinel only while there are more pages", () => {
    const items = [
      activity("le-4", NOW, { account: "CASH", type: "RELEASE", delta: 68_500, reason: "ORDER_UNLOCK" }),
      activity("le-3", NOW, { account: "CASH_LOCKED", type: "RELEASE", delta: -68_500, reason: "ORDER_UNLOCK" }),
      activity("le-2", NOW - 1000, { account: "CASH_LOCKED", type: "RESERVE", delta: 68_500 }),
      activity("le-1", NOW - 1000, { account: "CASH", type: "RESERVE", delta: -68_500 }),
    ];
    const html = view({ items, pager: { status: "done", onLoadMore: () => {} } });
    for (const label of [T.tabs.colTime, T.tabs.colType, T.tabs.colSymbol, T.tabs.colAccount, T.tabs.colDelta, T.ledger.colRef]) expect(html).toContain(`>${label}</span>`);
    expect([...html.matchAll(/data-ledger-id="([^"]+)"/g)].map((m) => m[1])).toEqual(["le-4", "le-3", "le-2", "le-1"]);
    // 表头:只有引用列带起始内边距(与右对齐的变动列分开);其余表头的 class 与别的页签一样,没有多出东西
    expect(html).toContain(`<span class="truncate ps-panel">${T.ledger.colRef}</span>`);
    expect(html).toContain(`<span class="truncate text-end">${T.tabs.colDelta}</span>`);
    for (const label of [T.tabs.colTime, T.tabs.colType, T.tabs.colSymbol, T.tabs.colAccount]) expect(html, label).toContain(`<span class="truncate">${label}</span>`);
    expect(html).toContain(`role="region" aria-label="${T.ledger.region}"`);
    // 冻结与解冻各两行(现金与冻结现金两条腿)
    // (类型筛选的 <option> 里也有这两个词,所以按行里的类型格数)
    expect(count(html, `>${T.ledger.types.RESERVE}</span>`)).toBe(2);
    expect(count(html, `>${T.ledger.types.RELEASE}</span>`)).toBe(2);
    expect(html).not.toContain(en.ui.loadMore);
    const more = view({ items, pager: { status: "error", onLoadMore: () => {} } });
    expect(more).toContain('role="alert"'); // 翻页失败:表下 ErrorState,已加载的行还在
    expect(count(more, "data-ledger-id=")).toBe(4);
  });

  it("the container renders on the server with no account yet: filters plus the EmptyState, no request, no dialog", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const html = renderToStaticMarkup(createElement(LedgerTab, { symbol: "VCS-FOR-2021" }));
      expect(count(html, "<select")).toBe(4);
      expect(html).toContain(`>${T.ledger.empty}<`);
      expect(html).not.toContain("<dialog");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders in Chinese from the zh-CN ledger group (same keys)", () => {
    const Z = zhCN.terminal.ledger;
    expect(Z.tab).toBe("流水");
    expect(Object.keys(Z.types).sort()).toEqual(Object.keys(T.ledger.types).sort());
    expect(Object.keys(Z.refs).sort()).toEqual(Object.keys(T.ledger.refs).sort());
    expect(Object.keys(Z.ranges)).toEqual([...LEDGER_RANGES]);
  });
});

describe("ledger query cache (per user, per filter combination)", () => {
  afterEach(() => {
    ledgerQueries.clear();
    vi.unstubAllGlobals();
  });

  const page = (items: LedgerActivity[], nextCursor: string | null) =>
    new Response(JSON.stringify({ ok: true, data: { items, nextCursor } }), { status: 200, headers: { "Content-Type": "application/json" } });

  it("is one instance per user and filter combination; a different filter is a different query; no user, no query", () => {
    const all = ledgerQueries.forUser("u1", ALL);
    expect(all?.key).toBe("ledger:*|*|*|all:u1");
    expect(ledgerQueries.forUser("u1", { ...ALL })).toBe(all);
    const cash = ledgerQueries.forUser("u1", { ...ALL, account: "CASH" });
    expect(cash).not.toBe(all);
    expect(cash?.key).toBe("ledger:CASH|*|*|all:u1");
    // 切回原来的筛选:还是那一份(已翻的页还在)
    expect(ledgerQueries.forUser("u1", ALL)).toBe(all);
    expect(ledgerQueries.forUser(null, ALL)).toBeNull();
    expect(ledgerQueries.forUser("u1", ALL)).toBe(all);
  });

  it("a new local day is a new query for a bounded range, and each query keeps the lower bound it was created with", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return page([], null);
    });
    const week: LedgerRequest = { ...ALL, range: "7d" };
    const tomorrow = NOW + DAY;
    const day1 = ledgerQueries.forUser("u1", week, NOW)!;
    expect(day1.key).toBe(`ledger:*|*|*|7d@${rangeFrom("7d", NOW, "local")}:u1`);
    // 当天稍后再取(切走页签又回来):还是那一份
    expect(ledgerQueries.forUser("u1", week, NOW + 3_600_000)).toBe(day1);
    // 过了午夜:新的一份,窗口往前挪一天 —— 昨天那份里掉出窗口的行不会被带过来
    const day2 = ledgerQueries.forUser("u1", week, tomorrow)!;
    expect(day2).not.toBe(day1);
    expect(day2.key).toBe(`ledger:*|*|*|7d@${rangeFrom("7d", tomorrow, "local")}:u1`);
    await day2.loadMore();
    await day1.refresh();
    // 每份查询的请求都带它建立那天的 from(不是发请求那一刻重新算的)
    expect(calls).toEqual([`/api/transactions?limit=50&from=${rangeFrom("7d", tomorrow, "local")}`, `/api/transactions?limit=50&from=${rangeFrom("7d", NOW, "local")}`]);
    // 「全部」没有下界:跨天还是同一份
    expect(ledgerQueries.forUser("u1", ALL, tomorrow)).toBe(ledgerQueries.forUser("u1", ALL, NOW));
  });

  it("keeps at most LEDGER_CACHE_MAX filter combinations, dropping the least recently used", () => {
    const requests = Array.from({ length: LEDGER_CACHE_MAX + 1 }, (_, i): LedgerRequest => ({ ...ALL, symbol: `SYM-${i}` }));
    const first = ledgerQueries.forUser("u1", requests[0]);
    const second = ledgerQueries.forUser("u1", requests[1]);
    for (const request of requests.slice(2, LEDGER_CACHE_MAX)) ledgerQueries.forUser("u1", request);
    // 再用一次第一份:它成了最近用过的,挤出去的是第二份
    expect(ledgerQueries.forUser("u1", requests[0])).toBe(first);
    ledgerQueries.forUser("u1", requests[LEDGER_CACHE_MAX]);
    expect(ledgerQueries.forUser("u1", requests[0])).toBe(first);
    expect(ledgerQueries.forUser("u1", requests[1])).not.toBe(second);
    expect(LEDGER_CACHE_MAX).toBeGreaterThanOrEqual(2);
  });

  it("requests /api/transactions with the filter's parameters and pages with the keyset cursor, de-duplicating by id", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return calls.length === 1 ? page([activity("b", 2), activity("a", 1)], "CUR1") : page([activity("a", 1), activity("0", 0)], null);
    });
    const request: LedgerRequest = { account: "CASH", type: "RESERVE", symbol: "VCS-FOR-2021", range: "all", tz: "local" };
    const query = ledgerQueries.forUser("u1", request)!;
    await query.loadMore();
    expect(calls).toEqual(["/api/transactions?limit=50&account=CASH&type=RESERVE&symbol=VCS-FOR-2021"]);
    expect(query.status).toBe("idle");
    await query.loadMore();
    expect(calls[1]).toBe("/api/transactions?limit=50&account=CASH&type=RESERVE&symbol=VCS-FOR-2021&cursor=CUR1");
    expect(query.items.map((r) => r.id)).toEqual(["b", "a", "0"]);
    expect(query.status).toBe("done");
  });

  it("a refresh puts new rows on top (account events re-read the first page)", async () => {
    let rows = [activity("b", 2), activity("a", 1)];
    vi.stubGlobal("fetch", async () => page(rows, "CUR"));
    const query = ledgerQueries.forUser("u1", ALL)!;
    await query.loadMore();
    rows = [activity("d", 4), activity("c", 3), activity("b", 2)];
    await query.refresh();
    expect(query.items.map((r) => r.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("a failed request lands in the error state and the next loadMore retries the same page", async () => {
    let fail = true;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (fail) return new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 500 });
      return page([activity("a", 1)], null);
    });
    const query = ledgerQueries.forUser("u1", ALL)!;
    await query.loadMore();
    expect(query.status).toBe("error");
    fail = false;
    await query.loadMore();
    expect(calls).toEqual(["/api/transactions?limit=50", "/api/transactions?limit=50"]);
    expect(query.items.map((r) => r.id)).toEqual(["a"]);
  });

  it("drops every cached combination on sign-out (the tab is not mounted when anon, so the account store does it)", async () => {
    // 模块级订阅只在浏览器里挂(typeof window !== "undefined"):给一个 window,换一套新的模块实例再导入
    vi.resetModules();
    vi.stubGlobal("window", {});
    try {
      const { ledgerQueries: ledger } = await import("./LedgerTab");
      const { useAccountStore: store } = await import("@/lib/market/account-store");
      store.setState({ me: { id: "u1", email: "u1@example.test", name: "U1", cashBalance: 0, lockedCash: 0, unreadNotices: 0 }, status: "ready" });
      const all = ledger.forUser("u1", ALL);
      const cash = ledger.forUser("u1", { ...ALL, account: "CASH" });
      store.setState({ me: null, status: "anon" });
      expect(ledger.forUser("u1", ALL)).not.toBe(all);
      expect(ledger.forUser("u1", { ...ALL, account: "CASH" })).not.toBe(cash);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
