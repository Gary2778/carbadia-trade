import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FILL_DISCLOSURE, type AccountTotals, type Balance, type EquityChange, type FillDetailResponse, type Notice, type Position } from "@/shared";
import { renderAccountMarkup, renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server + /trade 布局(与资产页布局)登记文案的那层 Provider
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import type { RetirementRecord } from "@/lib/exchange/retirement";
import { INITIAL_RETIRE_FLOW, reduceRetireFlow, type RetireAction, type RetireFlow } from "@/lib/market/retire-flow";
import { chartShiftFor, chartTime, formatChartTime } from "@/lib/market/chart-adapter";
import { zoneOffsetSeconds, formatTime } from "@/lib/time-format";
import { TZ_PREFS, type TimeZonePref } from "@/providers/timeZoneState";
import { AccountSummary } from "@/components/account/Summary";
import { RetireReceiptStep } from "@/components/account/RetireDialog";
import { NoticeList } from "@/components/notices/NoticeList";
import { lastMessageTime } from "./ConnectionBadge";
import { FillDetailView } from "./FillDetailDialog";
import { FillRow } from "./FillsTab";
import { LedgerRow, rangeFrom } from "./LedgerTab";
import { OpenOrderRow } from "./OpenOrdersTab";
import { HistoryRow } from "./OrderHistoryTab";
import { fmtTs } from "./TabTable";
import { TapeRow } from "./TapeRow";
import { TimeZoneSelect } from "./TimeZoneSelect";
import { TriggerRow } from "./TriggersTab";

// 时区偏好在各个显示时间的地方生效(P3-09):useTimeZone 打桩成可切换的值(服务端快照恒为 local 由 useTimeZone.test.ts 守),
// 渲染各处的纯展示件,同一个时刻在北京 / UTC 下读成各自的墙上时间。本文件不动 process.env.TZ;「local」下逐字节不变的证据是各处原有的测试。
const tzState = vi.hoisted(() => ({ tz: "local" as "local" | "Asia/Shanghai" | "UTC" }));
vi.mock("@/providers/useTimeZone", () => ({ useTimeZone: () => tzState.tz, setTimeZone: () => {} }));

beforeEach(() => {
  tzState.tz = "local";
});

// 2026-10-02 05:04:22 UTC = 北京 13:04:22(同一天)
const AT = Date.UTC(2026, 9, 2, 5, 4, 22);
const BEIJING = "13:04:22";
const UTC = "05:04:22";
const T = en.terminal;

function inZone(tz: "Asia/Shanghai" | "UTC", html: () => string): string {
  tzState.tz = tz;
  return html();
}

describe("every display site follows the time-zone preference", () => {
  it("tape row: HH:mm:ss", () => {
    const row = () => renderToStaticMarkup(createElement(TapeRow, { price: 7037, quantity: 12, takerSide: "BUY", ts: AT, auditRef: "SIM-TRD-t1", precision: 2 }));
    expect(inZone("Asia/Shanghai", row)).toContain(`>${BEIJING}<`);
    expect(inZone("UTC", row)).toContain(`>${UTC}<`);
  });

  it("fills / open orders / order history rows: MM/DD HH:mm:ss", () => {
    const fills = () => renderToStaticMarkup(createElement(FillRow, { id: "f1", ts: AT, symbol: "VCS-FOR-2021", side: "BUY", role: "MAKER", price: 6850, quantity: 10, notional: 68_500, feeCents: 0, auditRef: "SIM-TRD-f1", precision: 2, onOpen: () => {} }));
    const open = () =>
      renderToStaticMarkup(createElement(OpenOrderRow, { id: "o1", createdAt: AT, symbol: "VCS-FOR-2021", side: "BUY", type: "LIMIT", price: 6800, quantity: 5, filledQuantity: 0, status: "OPEN", precision: 2, armed: false, busy: false, onCancel: () => {} }));
    const history = () =>
      renderToStaticMarkup(createElement(HistoryRow, { createdAt: AT, symbol: "VCS-FOR-2021", side: "BUY", type: "MARKET", price: null, quantity: 30, filledQuantity: 12, avgFillPrice: 6810, status: "CANCELLED", cancelReason: "MARKET_REMAINDER", precision: 2 }));
    for (const html of [fills, open, history]) {
      expect(inZone("Asia/Shanghai", html)).toContain(`>10/02, ${BEIJING}<`);
      expect(inZone("UTC", html)).toContain(`>10/02, ${UTC}<`);
    }
  });

  it("conditional orders (Conditional tab) row", () => {
    const row = () =>
      renderToStaticMarkup(
        createElement(TriggerRow, { id: "t1", time: AT, symbol: "VCS-FOR-2021", kind: "ORDER", type: "conditional", direction: "ABOVE", triggerPrice: 7000, side: "BUY", orderType: "MARKET", limitPrice: null, quantity: 10, status: "PENDING", reason: null, precision: 2 }),
      );
    expect(inZone("Asia/Shanghai", row)).toContain(`>10/02, ${BEIJING}<`);
    expect(inZone("UTC", row)).toContain(`>10/02, ${UTC}<`);
  });

  it("ledger row", () => {
    const row = () => renderToStaticMarkup(createElement(LedgerRow, { id: "le1", ts: AT, type: "RESERVE", symbol: "VCS-FOR-2021", account: "CASH", delta: -68_500, isScenario: false, refType: null, refId: null, onOpenFill: () => {} }));
    expect(inZone("Asia/Shanghai", row)).toContain(`>10/02, ${BEIJING}<`);
    expect(inZone("UTC", row)).toContain(`>10/02, ${UTC}<`);
  });

  it("fill detail: the fill's time and the ledger lines' times", () => {
    const detail: FillDetailResponse = {
      fill: { id: "clx9", orderId: "ord-clx9", symbol: "VCS-FOR-2021", side: "SELL", role: "TAKER", price: 6850, quantity: 10, notional: 68_500, feeCents: 0, ts: AT, auditRef: "SIM-TRD-clx9", ledgerRefs: [] },
      ledger: [{ id: "l1", account: "CASH", delta: 68_500, reason: "TRADE_SETTLE", createdAt: AT + 1000 }],
      counterpartyIsBot: true,
      disclosure: FILL_DISCLOSURE,
    };
    const html = () => renderToStaticMarkup(createElement(FillDetailView, { detail, precision: 2 }));
    const beijing = inZone("Asia/Shanghai", html);
    expect(beijing).toContain(`10/02, ${BEIJING}`);
    expect(beijing).toContain("10/02, 13:04:23");
    const utc = inZone("UTC", html);
    expect(utc).toContain(`10/02, ${UTC}`);
    expect(utc).toContain("10/02, 05:04:23");
  });

  it("portfolio page: the baseline time of the 24h change", () => {
    const totals: AccountTotals = { holdingsValue: 25_000, totalAssets: 1_045_000, heldCredits: 30, retiredCredits: 7, unrealisedPnl: -1_234, valuationComplete: true, costBasisComplete: true };
    const balance: Balance = { cashBalance: 1_000_000, lockedCash: 20_000 };
    const change: EquityChange = { amount: 12_345, pct: 0.0123, baseline: 1_000_000, since: AT };
    const html = () => renderAccountMarkup(createElement(AccountSummary, { totals, balance, change24h: change, stale: false }));
    expect(inZone("Asia/Shanghai", html)).toContain(en.account.summary.change24hSince("10/02, 13:04"));
    expect(inZone("UTC", html)).toContain(en.account.summary.change24hSince("10/02, 05:04"));
  });

  it("connection badge tooltip time", () => {
    expect(lastMessageTime(AT, "en", "Asia/Shanghai")).toBe(BEIJING);
    expect(lastMessageTime(AT, "zh-CN", "UTC")).toBe(UTC);
    expect(lastMessageTime(null, "en", "UTC")).toBeNull();
  });

  it("retire receipt: medium date + short time", () => {
    const record: RetirementRecord = {
      id: "ret-1",
      reference: "SIM-RET-0F8FAD5B-D9CB-469F-A165-70867728950E",
      status: "SIMULATED",
      assetId: "asset-1",
      symbol: "VCS-FOR-2021",
      projectName: "云南森林经营碳汇",
      registry: "Verra",
      standard: "VCS",
      vintage: 2021,
      quantity: 40,
      tonnesCO2e: 40,
      reason: "Event Offset",
      beneficiary: "Acme",
      purpose: "Annual meeting",
      publicMessage: null,
      // 2026-10-01 20:00 UTC = 北京 10-02 04:00:日期也跟着变
      createdAt: "2026-10-01T20:00:00.000Z",
      certificateUrl: "/api/retirements/ret-1/certificate",
    };
    const position: Position = {
      assetId: "asset-1", symbol: "VCS-FOR-2021", quantity: 120, locked: 20, lockedBy: { orders: 12, otc: 8 }, available: 100, retired: 5,
      lastPrice: 6900, marketValue: 828_000, averagePurchasePrice: 6800, unrealisedPnl: 12_000, costBasisStatus: "complete", isScenario: false,
    };
    const run = (actions: RetireAction[], from: RetireFlow = INITIAL_RETIRE_FLOW): RetireFlow => actions.reduce(reduceRetireFlow, from);
    const flow = run([
      { type: "field", name: "quantity", value: "40" },
      { type: "field", name: "reason", value: "Event Offset" },
      { type: "field", name: "beneficiary", value: "Acme" },
      { type: "field", name: "purpose", value: "Annual meeting" },
      { type: "review", assetId: "asset-1", available: 100, idempotencyKey: "key-0001" },
      { type: "acknowledge", value: true },
      { type: "submit" },
      { type: "succeeded", retirement: record },
    ]);
    const html = () => renderToStaticMarkup(createElement(RetireReceiptStep, { position, instrument: undefined, flow, onAgain: () => {}, onClose: () => {} }));
    const dateRow = (h: string) => h.slice(h.indexOf(`>${T.retire.date}</dt>`)).split("</dd>")[0];
    const created = new Date(record.createdAt);
    expect(dateRow(inZone("Asia/Shanghai", html))).toContain(formatTime(created, "en-US", "Asia/Shanghai", "full"));
    expect(dateRow(inZone("UTC", html))).toContain(formatTime(created, "en-US", "UTC", "full"));
    // 两天:北京已经是 10-02,UTC 还是 10-01
    expect(dateRow(inZone("Asia/Shanghai", html))).toContain("Oct 2, 2026");
    expect(dateRow(inZone("UTC", html))).toContain("Oct 1, 2026");
  });

  it("notification panel list", () => {
    const notice: Notice = { id: "n1", createdAt: AT, readAt: null, kind: "price_alert", triggerId: "t-4", symbol: "CDM-METH-2019", direction: "BELOW", triggerPrice: 2000, firedPrice: 1990 };
    const html = () => renderToStaticMarkup(createElement(NoticeList, { items: [notice] }));
    // notices 目录只读核心命名空间,不需要终端 Provider;这里多包一层无妨
    expect(inZone("Asia/Shanghai", html)).toContain(`10/02, ${BEIJING}`);
    expect(inZone("UTC", html)).toContain(`10/02, ${UTC}`);
  });
});

describe("the selector", () => {
  const select = () => renderToStaticMarkup(createElement(TimeZoneSelect));

  it("is a labelled native select with Local, UTC+8 Beijing and UTC (in the order of the stored values), local selected on the server", () => {
    const html = select();
    expect(html).toContain(`aria-label="${T.tz.label}"`);
    expect(html).toContain('data-tz-select="local"');
    const options = [...html.matchAll(/<option value="([^"]+)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], m[2] === undefined ? "" : "selected"]);
    expect(options).toEqual([
      ["local", "Local", "selected"],
      ["Asia/Shanghai", "UTC+8 Beijing", ""],
      ["UTC", "UTC", ""],
    ]);
    expect(TZ_PREFS).toEqual(options.map(([value]) => value));
    // 服务端没有「此刻的偏移」可说,title 只有名字(挂载后才补上 UTC-5 之类,避免水合对不上)
    expect(html).toContain(`title="${T.tz.label}"`);
  });

  it("selects the stored preference", () => {
    tzState.tz = "Asia/Shanghai";
    expect(select()).toContain('<option value="Asia/Shanghai" selected="">UTC+8 Beijing</option>');
    tzState.tz = "UTC";
    expect(select()).toContain('<option value="UTC" selected="">UTC</option>');
  });

  it("has both languages for its four strings", () => {
    expect(Object.keys(en.terminal.tz)).toEqual(["label", "local", "beijing", "utc"]);
    expect(zhCN.terminal.tz).toEqual({ label: "时区", local: "本地", beijing: "UTC+8 北京", utc: "UTC" });
  });

  it("sits in the display toggles at the end of the terminal header (before the row-density and up/down toggles) and in the portfolio page header", () => {
    const src = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
    expect(src("./TerminalHeader.tsx")).toMatch(/<TimeZoneSelect \/>\s*<DensityToggle \/>\s*<UpDownToggle \/>/);
    expect(src("../account/AccountPage.tsx")).toMatch(/<TimeZoneSelect \/>/);
  });
});

describe("the legacy pages follow the stored preference without a control of their own", () => {
  const src = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

  it.each(["../exchange/OrderWorkspace.tsx", "../exchange/ActivityWorkspace.tsx", "../../app/retirement/page.tsx"])("%s formats times through lib/time-format with useTimeZone()", (name) => {
    const code = src(name);
    expect(code).toMatch(/const tz = useTimeZone\(\);/);
    expect(code).toMatch(/formatTime\(/);
    expect(code).not.toMatch(/TimeZoneSelect/);
    expect(code).not.toMatch(/fmtTime|toLocaleString\(/);
  });

  it("fmtTime is gone from lib/format.ts (the Nav imports that file; the time module must not ride into the floor with it)", () => {
    expect(src("../../lib/format.ts")).not.toMatch(/fmtTime/);
  });
});

describe("one instant, each preference value: tape, tab, the ledger's day boundary and the chart agree on the wall clock", () => {
  // 2026-10-01 20:00 UTC:UTC 与「本地」(这里不钉时区,用它自己的偏移比)与北京 04:00(次日)三者的小时、日期都可能不同
  const at = Date.UTC(2026, 9, 1, 20, 0, 5);
  const localOffset = zoneOffsetSeconds("local", at);
  const OFFSET: Record<TimeZonePref, number> = { local: localOffset, "Asia/Shanghai": 28_800, UTC: 0 };

  it.each(TZ_PREFS)("%s", (pref) => {
    const wall = new Date(at + OFFSET[pref] * 1000); // 用偏移独立算出的墙上时间(按 UTC 读)
    const p2 = (n: number) => String(n).padStart(2, "0");
    const hh = p2(wall.getUTCHours());
    const mm = p2(wall.getUTCMinutes());
    const day = `${p2(wall.getUTCMonth() + 1)}/${p2(wall.getUTCDate())}`;

    // tape
    expect(formatTime(at, "en-US", pref, "tape")).toBe(`${hh}:${mm}:05`);
    // 页签(MM/DD HH:mm:ss)与通知、资产页同一格式
    expect(fmtTs(at, "zh-CN", pref)).toBe(`${day} ${hh}:${mm}:05`);
    // 流水的日界:「今天」的起点在这个时区里是 00:00:00,而且就是 at 所在的那个日期
    const from = rangeFrom("today", at, pref)!;
    expect(fmtTs(from, "zh-CN", pref)).toBe(`${day} 00:00:00`);
    expect(from).toBeLessThanOrEqual(at);
    expect(at - from).toBeLessThan(25 * 3_600_000);
    expect(rangeFrom("today", from - 1, pref)).toBeLessThan(from);
    // 图表:K 线的位置(平移后的秒按 UTC 读)、时间轴刻度、十字线标签
    const shift = chartShiftFor("1m", at, pref);
    expect(shift).toBe(OFFSET[pref]);
    const d = new Date(chartTime(at, shift) * 1000);
    expect(`${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`).toBe(`${hh}:${mm}`);
    expect(formatTime(chartTime(at, shift) * 1000, "en-US", "UTC", "axisTime")).toBe(`${hh}:${mm}`);
    expect(formatChartTime(at, "en-US", false, pref)).toBe(`${day}/2026, ${hh}:${mm}`);
  });

  it("the three values really are different wall clocks for this instant (so the check above bites)", () => {
    expect(new Set(TZ_PREFS.map((pref) => formatTime(at, "en-US", pref, "tape"))).size).toBeGreaterThanOrEqual(2);
    expect(formatTime(at, "en-US", "Asia/Shanghai", "tab")).not.toBe(formatTime(at, "en-US", "UTC", "tab"));
  });
});
