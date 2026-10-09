// 经真实路由(临时 SQLite + migrate deploy + 模拟 cookie)验证三个 CSV 导出接口(计划 §6.2.2 C5):
// 未登录 401、响应头(含文件名)、BOM 与表头、**行与同筛选下 JSON 接口翻到底的行逐格一致**(≥ 250 行、跨多页、同一毫秒多行)、
// 筛选生效、非法筛选 400、别人的行不出现、公式防护与转义经路由生效、限流 429 + Retry-After(三个接口共用一个桶)、
// 行数上限(注入小值)、中途出错流以错误结束、客户端断开后不再读库。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountOrdersResponse, FillsResponse, LedgerActivity, LedgerActivityResponse } from "@/shared/api-shapes";
import type { Fill, Order } from "@/shared/types";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "", enforceRateLimit: false }));

// 显式钉在临时库上, 绝不触碰 dev.db
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (testState.cookie ? { value: testState.cookie } : undefined),
    set: (_name: string, value: string) => { testState.cookie = value; },
    delete: () => { testState.cookie = ""; },
  }),
}));
// 限流桶是进程内的、没有清空的入口:除了专测限流的那一组,其余用例放行(同一个用户一分钟里要导出几十次);
// 限流那一组打开开关,走的是真的 rateLimit / retryAfterSeconds
vi.mock("@/lib/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/rate-limit")>();
  return { ...actual, rateLimit: (key: string, limit: number, windowMs: number) => (testState.enforceRateLimit ? actual.rateLimit(key, limit, windowMs) : true) };
});

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let ordersJson: typeof import("./account/orders/route");
let fillsJson: typeof import("./account/fills/route");
let ledgerJson: typeof import("./transactions/route");
let ordersCsv: typeof import("./account/orders.csv/route");
let fillsCsv: typeof import("./account/fills.csv/route");
let ledgerCsv: typeof import("./transactions.csv/route");
let csvExport: typeof import("@/lib/server/csv-export");
let accountPages: typeof import("@/lib/server/account-pages");
let createSession: (typeof import("@/lib/server/auth"))["createSession"];

const SYMBOL_A = "VCS-TEST-2021";
const SYMBOL_B = "GS-TEST-2022";
/** 情景标的:流水的 unit 列写 scenario unit */
const SYMBOL_S = "CEA-SCEN-TEST";
/** 以 = 开头、含逗号的标的代码:公式防护与转义要经路由生效 */
const SYMBOL_X = "=SUM(1,2)";
const T0 = Date.UTC(2026, 0, 1);
/** dave 的合成数据:每类 300 行;按时间倒序,前 100 行各占一毫秒,中间 160 行挤在同一毫秒(跨过 JSON 的 100 行页与 CSV 的 200 行页),最后 40 行各占一毫秒 */
const BIG = 300;
const createdAtOf = (i: number) => new Date(i < 40 ? T0 + i : i < 200 ? T0 + 500 : T0 + 1_000 + i);

const ids = { assetA: "", assetB: "", assetS: "", assetX: "", alice: "", bob: "", carol: "", dave: "", rita: "", sam: "" };

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-csv-routes-")));
  writeFileSync(join(testState.directory, "csv.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "csv.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  ordersJson = await import("./account/orders/route");
  fillsJson = await import("./account/fills/route");
  ledgerJson = await import("./transactions/route");
  ordersCsv = await import("./account/orders.csv/route");
  fillsCsv = await import("./account/fills.csv/route");
  ledgerCsv = await import("./transactions.csv/route");
  csvExport = await import("@/lib/server/csv-export");
  accountPages = await import("@/lib/server/account-pages");
  ({ createSession } = await import("@/lib/server/auth"));
  const matching = await import("@/lib/exchange/matching");
  const otc = await import("@/lib/exchange/otc");
  const { retireCredits } = await import("@/lib/exchange/retirement");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");

  const asset = (symbol: string, isScenario = false) =>
    prisma.asset.create({ data: { symbol, name: `Test ${symbol}`, standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry", isScenario } });
  const [assetA, assetB, assetS, assetX] = [await asset(SYMBOL_A), await asset(SYMBOL_B), await asset(SYMBOL_S, true), await asset(SYMBOL_X)];
  const cash = { passwordHash: "test", cashBalance: BigInt(100_000_000) };
  const user = (name: string) => prisma.user.create({ data: { email: `${name}@csv.test`, name, ...cash } });
  const [alice, bob, carol, dave, rita, sam] = [await user("alice"), await user("bob"), await user("carol"), await user("dave"), await user("rita"), await user("sam")];
  Object.assign(ids, { assetA: assetA.id, assetB: assetB.id, assetS: assetS.id, assetX: assetX.id, alice: alice.id, bob: bob.id, carol: carol.id, dave: dave.id, rita: rita.id, sam: sam.id });
  await prisma.holding.createMany({ data: [
    { userId: bob.id, assetId: assetA.id, quantity: 1_000 },
    { userId: bob.id, assetId: assetB.id, quantity: 100 },
  ] });

  // ---- alice / bob:经真实撮合、OTC、注销写出来的订单、成交与账本 ----
  await prisma.ledgerEntry.create({ data: { userId: alice.id, account: "CASH", delta: BigInt(100_000_000), reason: "GRANT", createdAt: new Date(T0) } });
  const place = (userId: string, assetId: string, side: "BUY" | "SELL", type: "LIMIT" | "MARKET", price: number | null, quantity: number) =>
    matching.placeOrder({ userId, assetId, side, type, price, quantity });
  // bob 挂卖 A 3 @ 9500,alice 市价买 5 → 成交 3,余量撤销(MARKET_REMAINDER;bob 的挂单方均价要按成交重算)
  await place(bob.id, assetA.id, "SELL", "LIMIT", 9_500, 3);
  await place(alice.id, assetA.id, "BUY", "MARKET", null, 5);
  // alice 限价买 B 后撤单(USER;ORDER_LOCK / ORDER_UNLOCK 的现金行没有 assetId,标的由订单补出)
  const cancelled = await place(alice.id, assetB.id, "BUY", "LIMIT", 4_000, 1);
  await matching.cancelOrder(alice.id, cancelled.order.id);
  // 价格改善:bob 挂卖 B 2 @ 5000,alice 限价买 2 @ 5100 → 退 200(PRICE_IMPROVE_REFUND)
  await place(bob.id, assetB.id, "SELL", "LIMIT", 5_000, 2);
  await place(alice.id, assetB.id, "BUY", "LIMIT", 5_100, 2);
  // 各留一张挂单
  await place(alice.id, assetA.id, "BUY", "LIMIT", 8_000, 1);
  await place(bob.id, assetA.id, "SELL", "LIMIT", 20_000, 1);
  // OTC 与注销(账本的 DEAL / RETIREMENT 引用)
  const listing = await otc.createListing({ sellerId: bob.id, assetId: assetA.id, quantity: 5, pricePerUnit: 11_000 });
  await otc.buyListing(alice.id, listing.id, 2);
  await retireCredits(alice.id, { assetId: assetA.id, quantity: 1, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey: "csv-retire-0001" });

  // ---- dave:合成的 300 张订单、300 笔成交、300 多行账本(见 BIG / createdAtOf) ----
  const assets = [assetA.id, assetB.id, assetX.id];
  const STATUSES = ["OPEN", "PARTIAL", "FILLED", "CANCELLED"];
  await prisma.order.createMany({ data: Array.from({ length: BIG }, (_, i) => {
    const status = STATUSES[i % 4];
    const type = i % 8 === 3 ? "MARKET" : "LIMIT"; // 一部分 CANCELLED 是市价单余量
    return {
      id: `dave-order-${String(i).padStart(4, "0")}`, userId: dave.id, assetId: assets[i % 3], side: i % 2 ? "SELL" : "BUY", type,
      price: type === "MARKET" ? null : 9_000 + i, quantity: 10, filledQuantity: status === "OPEN" ? 0 : status === "FILLED" ? 10 : 4,
      status, avgFillPrice: null, createdAt: createdAtOf(i), updatedAt: i % 5 === 0 ? null : new Date(createdAtOf(i).getTime() + 60_000),
      // 以 - 开头的幂等键:文本单元格要加单引号
      clientOrderId: i % 10 === 0 ? `-key-${i}` : null,
    };
  }) });
  const bobStub = await prisma.order.create({ data: { userId: bob.id, assetId: assetA.id, side: "SELL", type: "LIMIT", price: 9_000, quantity: 1_000_000, status: "OPEN", createdAt: new Date(T0 - 1_000) } });
  await prisma.trade.createMany({ data: Array.from({ length: BIG }, (_, i) => {
    const daveOrder = `dave-order-${String(i).padStart(4, "0")}`;
    const daveBuys = i % 2 === 0;
    return {
      id: `dave-trade-${String(i).padStart(4, "0")}`, assetId: assets[i % 3],
      buyOrderId: daveBuys ? daveOrder : bobStub.id, sellOrderId: daveBuys ? bobStub.id : daveOrder,
      buyerId: daveBuys ? dave.id : bob.id, sellerId: daveBuys ? bob.id : dave.id,
      price: 9_000 + (i % 7), quantity: 1 + (i % 3), createdAt: createdAtOf(i),
    };
  }) });
  const ACCOUNTS = ["CASH", "CASH_LOCKED", "HOLDING", "HOLDING_LOCKED"];
  const REASONS = ["TRADE_SETTLE", "ORDER_LOCK", "ORDER_UNLOCK", "GRANT", "OTC_SETTLE", "SIMULATED_RETIREMENT", "SOMETHING_NEW"];
  const holdingAssets = [assetA.id, assetS.id, assetX.id];
  await prisma.ledgerEntry.createMany({ data: Array.from({ length: BIG }, (_, i) => {
    const account = ACCOUNTS[i % 4];
    return {
      id: `dave-ledger-${String(i).padStart(4, "0")}`, userId: dave.id, account, reason: REASONS[i % REASONS.length],
      delta: BigInt(i % 5 === 0 ? -(i * 37 + 1) : i * 37 + 1), assetId: account.startsWith("HOLDING") ? holdingAssets[i % 3] : null,
      refType: i % 6 === 0 ? "TRADE" : null, refId: i % 6 === 0 ? `dave-trade-${String(i).padStart(4, "0")}` : null, createdAt: createdAtOf(i),
    };
  }) });
  // 难缠的文本:引用里有引号、逗号、换行;reason 以 + 和 @ 开头
  await prisma.ledgerEntry.createMany({ data: [
    { id: "dave-ledger-tricky-1", userId: dave.id, account: "CASH", reason: "+PLUS", delta: BigInt(-5), refType: "ODD,TYPE", refId: 'a"b,c\nd', createdAt: new Date(T0 + 5_000) },
    { id: "dave-ledger-tricky-2", userId: dave.id, account: "HOLDING", reason: "@AT", delta: BigInt(0), assetId: assetS.id, createdAt: new Date(T0 + 5_001) },
  ] });
}, 120_000);

afterAll(async () => {
  await (await import("@/lib/server/order-hooks")).drainOrderHooks(); // 真人成交的通知由提交后钩子写:等它写完再关库
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
  testState.enforceRateLimit = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Kind = "orders" | "fills" | "ledger";
const PATHS: Record<Kind, string> = { orders: "/api/account/orders.csv", fills: "/api/account/fills.csv", ledger: "/api/transactions.csv" };
const request = (kind: Kind, query = "", init?: RequestInit) => new Request(`http://localhost${PATHS[kind]}${query}`, init);
const getCsv = (kind: Kind, query = ""): Promise<Response> =>
  kind === "orders" ? ordersCsv.GET(request(kind, query)) : kind === "fills" ? fillsCsv.GET(request(kind, query)) : ledgerCsv.GET(request(kind, query));

/** RFC 4180 解析(测试自己的实现):引号内的逗号、换行、成对引号;行尾 CRLF。返回各行的单元格 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r" && text[i + 1] === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += ch;
  }
  if (cell !== "" || row.length > 0) throw new Error("CSV does not end with CRLF");
  return rows;
}

/** 读完响应体,核对 BOM,返回 { header, rows } */
async function readCsv(res: Response): Promise<{ header: string[]; rows: string[][] }> {
  expect(res.status).toBe(200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const [header, ...rows] = parseCsv(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).slice(1));
  return { header, rows };
}

/** JSON 接口带着同样的筛选翻到底(query 以 ? 开头或为空) */
async function pageAll<T>(get: (query: string) => Promise<Response>, query: string, pick: (data: never) => { items: T[]; next: string | null }, limit = 100): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = null;
  do {
    const res = await get(`${query}${query ? "&" : "?"}limit=${limit}${next ? `&cursor=${next}` : ""}`);
    expect(res.status).toBe(200);
    const page = pick((await res.json()).data as never);
    items.push(...page.items);
    next = page.next;
  } while (next);
  return items;
}
const allOrders = (query = "") => pageAll<Order>((q) => ordersJson.GET(new Request(`http://localhost/api/account/orders${q}`)), query, (d: AccountOrdersResponse) => ({ items: d.orders, next: d.nextCursor }));
const allFills = (query = "") => pageAll<Fill>((q) => fillsJson.GET(new Request(`http://localhost/api/account/fills${q}`)), query, (d: FillsResponse) => ({ items: d.fills, next: d.nextCursor }));
const allLedger = (query = "") => pageAll<LedgerActivity>((q) => ledgerJson.GET(new Request(`http://localhost/api/transactions${q}`)), query, (d: LedgerActivityResponse) => ({ items: d.items, next: d.nextCursor }));

// ---- 期望值:从 JSON 行独立算出每一格(不调用被测的列定义) ----
const iso = (ms: number) => new Date(ms).toISOString();
const money = (cents: number | null) => (cents === null ? "" : `${cents < 0 ? "-" : ""}${(Math.abs(cents) / 100).toFixed(2)}`);
/** 文本单元格的公式防护 */
const text = (value: string | null) => (value === null ? "" : /^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

const ORDER_HEADER = ["createdAt", "updatedAt", "orderId", "clientOrderId", "symbol", "side", "type", "price", "quantity", "filledQuantity", "avgFillPrice", "status", "cancelReason", "environment"];
const FILL_HEADER = ["time", "fillId", "orderId", "symbol", "side", "role", "price", "quantity", "notional", "fee", "auditRef", "environment"];
const LEDGER_HEADER = ["time", "id", "type", "account", "symbol", "delta", "unit", "reason", "refType", "refId", "environment"];
const HEADERS: Record<Kind, string[]> = { orders: ORDER_HEADER, fills: FILL_HEADER, ledger: LEDGER_HEADER };

const orderCells = (o: Order) => [
  iso(o.createdAt), iso(o.updatedAt), text(o.id), text(o.clientOrderId), text(o.symbol), o.side, o.type, money(o.price),
  String(o.quantity), String(o.filledQuantity), money(o.avgFillPrice), o.status, o.cancelReason ?? "", "SIMULATED",
];
const fillCells = (f: Fill) => [
  iso(f.ts), text(f.id), text(f.orderId), text(f.symbol), f.side, f.role, money(f.price), String(f.quantity), money(f.notional), money(f.feeCents), f.auditRef, "SIMULATED",
];
const ledgerCells = (e: LedgerActivity) => {
  const cash = e.account === "CASH" || e.account === "CASH_LOCKED";
  return [
    iso(e.ts), text(e.id), e.type, e.account, text(e.symbol), cash ? money(e.delta) : String(e.delta),
    cash ? "USD" : e.isScenario ? "scenario unit" : "tCO2e", text(e.reason), text(e.refType), text(e.refId), "SIMULATED",
  ];
};

/** 同一筛选下 CSV 与 JSON 翻到底逐行逐格一致;返回行数 */
async function expectSameAsJson(kind: Kind, query = ""): Promise<number> {
  const expected = kind === "orders" ? (await allOrders(query)).map(orderCells) : kind === "fills" ? (await allFills(query)).map(fillCells) : (await allLedger(query)).map(ledgerCells);
  const csv = await readCsv(await getCsv(kind, query));
  expect(csv.header, `${kind}${query} header`).toEqual(HEADERS[kind]);
  expect(csv.rows.length, `${kind}${query} row count`).toBe(expected.length);
  expect(csv.rows, `${kind}${query} rows`).toEqual(expected);
  return expected.length;
}

const KINDS: Kind[] = ["orders", "fills", "ledger"];

describe("未登录与响应头", () => {
  it.each(KINDS)("%s:未登录 → 401 的 JSON 信封 + private, no-store,不是 CSV", async (kind) => {
    const res = await getCsv(kind);
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Not logged in" });
  });

  it.each(KINDS)("%s:200 的响应头 —— text/csv、private, no-store、attachment 与文件名", async (kind) => {
    await createSession(ids.carol);
    const before = iso(Date.now()).slice(0, 10).replace(/-/g, "");
    const res = await getCsv(kind);
    const after = iso(Date.now()).slice(0, 10).replace(/-/g, "");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const name = kind === "ledger" ? "ledger" : kind;
    expect(disposition).toMatch(new RegExp(`^attachment; filename="carbadia-trade-simulated-${name}-\\d{8}\\.csv"$`));
    // 日期是今天(UTC);跨午夜的那一瞬两边都算对
    expect([before, after]).toContain(/-(\d{8})\.csv"$/.exec(disposition)?.[1]);
    await res.body?.cancel();
  });

  it("文件名:carbadia-trade-simulated-<orders|fills|ledger>-<YYYYMMDD>.csv,日期取 UTC", () => {
    expect(csvExport.csvFilename("orders", Date.UTC(2026, 9, 1, 23, 59, 59))).toBe("carbadia-trade-simulated-orders-20261001.csv");
    expect(csvExport.csvFilename("fills", Date.UTC(2026, 0, 5))).toBe("carbadia-trade-simulated-fills-20260105.csv");
    expect(csvExport.csvFilename("ledger", Date.UTC(2027, 11, 31, 0, 0, 0))).toBe("carbadia-trade-simulated-ledger-20271231.csv");
  });

  it.each(KINDS)("%s:没有数据的用户 → BOM + 表头一行,第一行就是表头(没有说明行)", async (kind) => {
    await createSession(ids.sam);
    const res = await getCsv(kind);
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(body).toBe(`\uFEFF${HEADERS[kind].join(",")}\r\n`);
  });
});

describe("行与 JSON 接口翻到底一致", () => {
  it("订单:300 行跨多页(含同一毫秒 160 行),不筛、按状态、按标的、组合", async () => {
    await createSession(ids.dave);
    expect(await expectSameAsJson("orders")).toBe(BIG);
    expect(await expectSameAsJson("orders", "?status=open")).toBe(BIG / 2);
    expect(await expectSameAsJson("orders", "?status=history")).toBe(BIG / 2);
    expect(await expectSameAsJson("orders", `?symbol=${SYMBOL_A}`)).toBe(BIG / 3);
    expect(await expectSameAsJson("orders", `?status=history&symbol=${SYMBOL_B}`)).toBe(BIG / 6);
    expect(await expectSameAsJson("orders", "?symbol=NO-SUCH-SYMBOL")).toBe(0);
    // 空的 status 视为未传(与 JSON 接口一致)
    expect(await expectSameAsJson("orders", "?status=")).toBe(BIG);
  });

  it("成交:300 行跨多页,不筛与按标的", async () => {
    await createSession(ids.dave);
    expect(await expectSameAsJson("fills")).toBe(BIG);
    expect(await expectSameAsJson("fills", `?symbol=${SYMBOL_B}`)).toBe(BIG / 3);
    expect(await expectSameAsJson("fills", `?symbol=${encodeURIComponent(SYMBOL_X)}`)).toBe(BIG / 3);
    expect(await expectSameAsJson("fills", "?symbol=NO-SUCH-SYMBOL")).toBe(0);
  });

  it("流水:302 行跨多页,不筛、按账户、按类型、按标的、按时间段、组合", async () => {
    await createSession(ids.dave);
    expect(await expectSameAsJson("ledger")).toBe(BIG + 2);
    expect(await expectSameAsJson("ledger", "?account=HOLDING")).toBeGreaterThan(50);
    expect(await expectSameAsJson("ledger", "?account=CASH_LOCKED")).toBe(BIG / 4);
    expect(await expectSameAsJson("ledger", "?type=GRANT")).toBeGreaterThan(10);
    expect(await expectSameAsJson("ledger", "?type=ADJUSTMENT")).toBeGreaterThan(10);
    expect(await expectSameAsJson("ledger", `?symbol=${SYMBOL_S}`)).toBeGreaterThan(10);
    // from ≤ ts < to:同一毫秒的那 160 行
    expect(await expectSameAsJson("ledger", `?from=${T0 + 500}&to=${T0 + 501}`)).toBe(160);
    expect(await expectSameAsJson("ledger", `?account=HOLDING&type=SELL&from=${T0}&to=${T0 + 2_000}`)).toBeGreaterThan(0);
    expect(await expectSameAsJson("ledger", "?symbol=NO-SUCH-SYMBOL")).toBe(0);
  });

  it("经真实撮合、撤单、OTC、注销写出来的行(alice 与 bob):三类各自一致", async () => {
    for (const userId of [ids.alice, ids.bob]) {
      testState.cookie = "";
      await createSession(userId);
      expect(await expectSameAsJson("orders")).toBeGreaterThan(2);
      expect(await expectSameAsJson("fills")).toBeGreaterThan(1);
      expect(await expectSameAsJson("ledger")).toBeGreaterThan(5);
      await expectSameAsJson("orders", "?status=open");
      await expectSameAsJson("ledger", "?type=RETIREMENT");
    }
  });

  it("小页(每次读 7 行)翻完 300 行:页边界落在同一毫秒的行中间也不重不漏", async () => {
    await createSession(ids.dave);
    const expected: Record<Kind, string[][]> = { orders: (await allOrders()).map(orderCells), fills: (await allFills()).map(fillCells), ledger: (await allLedger()).map(ledgerCells) };
    const responses: Record<Kind, Response> = {
      orders: await csvExport.ordersCsvResponse(request("orders"), { pageRows: 7 }),
      fills: await csvExport.fillsCsvResponse(request("fills"), { pageRows: 7 }),
      ledger: await csvExport.ledgerCsvResponse(request("ledger"), { pageRows: 7 }),
    };
    for (const kind of KINDS) {
      const csv = await readCsv(responses[kind]);
      expect(csv.rows, kind).toEqual(expected[kind]);
      expect(new Set(csv.rows.map((row) => row[kind === "orders" ? 2 : 1])).size, `${kind} distinct ids`).toBe(expected[kind].length);
    }
  });

  it("查询参数里的 cursor / limit 不读:导出总是从头到尾", async () => {
    await createSession(ids.dave);
    const csv = await readCsv(await getCsv("orders", "?limit=1&cursor=not-a-cursor"));
    expect(csv.rows.length).toBe(BIG);
    const ledger = await readCsv(await getCsv("ledger", "?limit=0&cursor=not-a-cursor"));
    expect(ledger.rows.length).toBe(BIG + 2);
  });
});

// P2-13(终审 P2-SRV-3 / P2-OPS-4):成交一页 = 买方、卖方各一条键集查询(各走自己的 (buyerId | sellerId, createdAt) 索引),
// 在 JS 里归并。这里用独立的 Prisma 查询核对顺序与完整性(CSV = JSON 那一组两边读的是同一个函数,核对不到它本身)
describe("成交分页:买卖两边各一条键集查询再归并", () => {
  const fillIds = (limit: number, query = "") =>
    pageAll<Fill>((q) => fillsJson.GET(new Request(`http://localhost/api/account/fills${q}`)), query, (d: FillsResponse) => ({ items: d.fills, next: d.nextCursor }), limit).then((fills) => fills.map((f) => f.id));
  const expectedIds = async (userId: string, assetId?: string) =>
    (await prisma.trade.findMany({
      where: { OR: [{ buyerId: userId }, { sellerId: userId }], ...(assetId ? { assetId } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    })).map((t) => t.id);

  it("翻到底 = (createdAt desc, id desc) 的全部成交,不重不漏;页大小 3 / 7 / 100 与按标的筛选都一样(含同一毫秒 160 行)", async () => {
    await createSession(ids.dave);
    const all = await expectedIds(ids.dave);
    expect(all).toHaveLength(BIG);
    for (const limit of [3, 7, 100]) expect(await fillIds(limit), String(limit)).toEqual(all);
    const onlyA = await expectedIds(ids.dave, ids.assetA);
    expect(onlyA.length).toBeGreaterThan(0);
    expect(await fillIds(7, `?symbol=${encodeURIComponent(SYMBOL_A)}`)).toEqual(onlyA);
  });

  // 订单导出一页 2,000 张:均价要按这一页订单的成交重算,查询是 buyOrderId IN (…) OR sellOrderId IN (…)。列表超过 999 个时 Prisma
  // 自动拆批,这个 OR 形状拆批后同一笔成交会重复返回(均价对不上 → 空);avgFillPricesByOrder 自己按 400 张分批、按成交 id 去重
  it("订单一页超过 1,000 张(默认 2,000):每张已成交订单的均价照样按成交算出,与 JSON 翻页逐格一致", async () => {
    const olga = await prisma.user.create({ data: { email: "olga@csv.test", name: "olga", passwordHash: "test" } });
    const stub = await prisma.order.create({ data: { userId: ids.bob, assetId: ids.assetB, side: "SELL", type: "LIMIT", price: 5_000, quantity: 1_000_000, status: "OPEN", createdAt: new Date(T0 - 2_000) } });
    const N = 1_100;
    const orderId = (i: number) => `olga-order-${String(i).padStart(5, "0")}`;
    await prisma.order.createMany({ data: Array.from({ length: N }, (_, i) => ({
      id: orderId(i), userId: olga.id, assetId: ids.assetB, side: "BUY", type: "LIMIT", price: 5_000 + (i % 50), quantity: 2, filledQuantity: 2,
      status: "FILLED", avgFillPrice: null, createdAt: new Date(T0 + 10_000 + i),
    })) });
    // 每张单两笔成交:价格不同,均价 = 两笔的量价加权(行上的 avgFillPrice 是 null,只能从成交算)
    await prisma.trade.createMany({ data: Array.from({ length: N * 2 }, (_, k) => {
      const i = Math.floor(k / 2);
      return { id: `olga-trade-${String(k).padStart(5, "0")}`, assetId: ids.assetB, buyOrderId: orderId(i), sellOrderId: stub.id, buyerId: olga.id, sellerId: ids.bob, price: 5_000 + (i % 50) - (k % 2) * 2, quantity: 1, createdAt: new Date(T0 + 10_000 + i) };
    }) });
    await createSession(olga.id);
    const csv = await readCsv(await csvExport.ordersCsvResponse(request("orders")));
    expect(csv.rows).toHaveLength(N);
    const expected = new Map(Array.from({ length: N }, (_, i) => [orderId(i), money(5_000 + (i % 50) - 1)]));
    for (const row of csv.rows) expect(row[10], row[2]).toBe(expected.get(row[2]));
    expect(await expectSameAsJson("orders")).toBe(N);
    // 直接调:1,100 张一次传进去
    const rows = await prisma.order.findMany({ where: { userId: olga.id }, select: { id: true, filledQuantity: true } });
    const avg = await (await import("@/lib/server/account-mappers")).avgFillPricesByOrder(prisma, rows);
    expect(avg.size).toBe(N);
    expect([...avg.values()].every((value) => value !== null)).toBe(true);
  });

  it("mergeFillKeys:两边的行按 (createdAt desc, id desc) 归并、同一 id 只留一次、截到 take", () => {
    const merged = accountPages.mergeFillKeys(
      [{ id: "b", ts: BigInt(5) }, { id: "self", ts: 4 }, { id: "a", ts: 4 }],
      [{ id: "self", ts: 4 }, { id: "c", ts: 5 }, { id: "d", ts: 1 }],
      4,
    );
    expect(merged).toEqual([{ id: "c", ts: 5 }, { id: "b", ts: 5 }, { id: "self", ts: 4 }, { id: "a", ts: 4 }]);
    expect(accountPages.mergeFillKeys([], [], 3)).toEqual([]);
  });

  it("买卖双方都是本人的成交(两条查询都会取到)只出现一次,JSON 与 CSV 都是", async () => {
    const selfie = await prisma.user.create({ data: { email: "selfie@csv.test", name: "selfie", passwordHash: "test" } });
    const order = (side: "BUY" | "SELL") =>
      prisma.order.create({ data: { userId: selfie.id, assetId: ids.assetA, side, type: "LIMIT", price: 9_000, quantity: 1, filledQuantity: 1, status: "FILLED", createdAt: new Date(T0 + 7_000) } });
    const [buy, sell] = [await order("BUY"), await order("SELL")];
    const trade = await prisma.trade.create({
      data: { assetId: ids.assetA, buyOrderId: buy.id, sellOrderId: sell.id, buyerId: selfie.id, sellerId: selfie.id, price: 9_000, quantity: 1, createdAt: new Date(T0 + 7_001) },
    });
    await createSession(selfie.id);
    expect(await fillIds(100)).toEqual([trade.id]);
    expect((await readCsv(await getCsv("fills"))).rows.map((row) => row[1])).toEqual([trade.id]);
  });
});

describe("内容", () => {
  it("订单:金额是两位小数、市价单价格留空、时间是 ISO 8601 UTC、末列恒为 SIMULATED、cancelReason 照 JSON", async () => {
    await createSession(ids.alice);
    const { rows } = await readCsv(await getCsv("orders"));
    const col = (name: string) => ORDER_HEADER.indexOf(name);
    expect(rows.every((row) => row[col("environment")] === "SIMULATED")).toBe(true);
    expect(rows.every((row) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row[col("createdAt")]) && /Z$/.test(row[col("updatedAt")]))).toBe(true);
    const market = rows.find((row) => row[col("type")] === "MARKET")!;
    expect(market[col("price")]).toBe("");
    expect(market[col("avgFillPrice")]).toBe("95.00");
    expect(market[col("filledQuantity")]).toBe("3");
    expect(market[col("status")]).toBe("CANCELLED");
    expect(market[col("cancelReason")]).toBe("MARKET_REMAINDER");
    expect(rows.some((row) => row[col("cancelReason")] === "USER" && row[col("price")] === "40.00")).toBe(true);
    expect(rows.some((row) => row[col("status")] === "OPEN" && row[col("price")] === "80.00" && row[col("cancelReason")] === "")).toBe(true);
  });

  it("成交:含 auditRef(SIM-TRD-<id>)、role、notional 与 fee 两位小数、末列 SIMULATED;不外露对手方", async () => {
    await createSession(ids.alice);
    const res = await getCsv("fills");
    const raw = new TextDecoder().decode(await res.clone().arrayBuffer());
    const { rows } = await readCsv(res);
    const col = (name: string) => FILL_HEADER.indexOf(name);
    expect(rows.every((row) => row[col("auditRef")] === `SIM-TRD-${row[col("fillId")]}`)).toBe(true);
    expect(rows.every((row) => row[col("fee")] === "0.00" && row[col("environment")] === "SIMULATED")).toBe(true);
    expect(rows.some((row) => row[col("side")] === "BUY" && row[col("role")] === "TAKER" && row[col("price")] === "95.00" && row[col("quantity")] === "3" && row[col("notional")] === "285.00")).toBe(true);
    expect(raw).not.toContain(ids.bob);
    expect(raw).not.toContain(ids.alice);
  });

  it("流水:现金是带符号的两位小数(负数不加单引号)、持仓是整数、unit 三种、引用照 JSON", async () => {
    await createSession(ids.dave);
    const res = await getCsv("ledger");
    const raw = new TextDecoder().decode(await res.clone().arrayBuffer());
    const { rows } = await readCsv(res);
    const col = (name: string) => LEDGER_HEADER.indexOf(name);
    const byId = new Map(rows.map((row) => [row[col("id")], row]));
    // i = 0:CASH,delta −1 分
    expect(byId.get("dave-ledger-0000")![col("delta")]).toBe("-0.01");
    expect(byId.get("dave-ledger-0000")![col("unit")]).toBe("USD");
    // i = 5:CASH_LOCKED,delta −186 分
    expect(byId.get("dave-ledger-0005")![col("delta")]).toBe("-1.86");
    // i = 2:HOLDING(情景标的除外的普通标的 X:i % 3 = 2),整数;i = 10:HOLDING 情景标的(10 % 3 = 1),负的整数
    expect(byId.get("dave-ledger-0002")![col("delta")]).toBe("75");
    expect(byId.get("dave-ledger-0002")![col("unit")]).toBe("tCO2e");
    expect(byId.get("dave-ledger-0010")![col("delta")]).toBe("-371");
    expect(byId.get("dave-ledger-0010")![col("unit")]).toBe("scenario unit");
    expect(byId.get("dave-ledger-0010")![col("symbol")]).toBe(SYMBOL_S);
    // 原始字节里负数前面没有单引号
    expect(raw).toContain(",-0.01,USD,");
    expect(raw).toContain(",-371,scenario unit,");
    expect(raw).not.toMatch(/,'-\d/);
    expect(new Set(rows.map((row) => row[col("unit")]))).toEqual(new Set(["USD", "tCO2e", "scenario unit"]));
    expect(rows.every((row) => row[col("environment")] === "SIMULATED")).toBe(true);
  });

  it("公式防护与转义经路由生效:= + - @ 开头的文本前置单引号,含逗号、引号、换行的单元格加引号", async () => {
    await createSession(ids.dave);
    const ledgerRes = await getCsv("ledger");
    const raw = new TextDecoder().decode(await ledgerRes.clone().arrayBuffer());
    const { rows } = await readCsv(ledgerRes);
    const col = (name: string) => LEDGER_HEADER.indexOf(name);
    const tricky = rows.find((row) => row[col("id")] === "dave-ledger-tricky-1")!;
    expect(tricky[col("reason")]).toBe("'+PLUS");
    expect(tricky[col("refType")]).toBe("ODD,TYPE");
    expect(tricky[col("refId")]).toBe('a"b,c\nd');
    expect(raw).toContain(`,'+PLUS,"ODD,TYPE","a""b,c\nd",SIMULATED\r\n`);
    expect(rows.find((row) => row[col("id")] === "dave-ledger-tricky-2")![col("reason")]).toBe("'@AT");
    // 标的代码以 = 开头且含逗号:前置单引号后整格加引号
    expect(rows.some((row) => row[col("symbol")] === `'${SYMBOL_X}`)).toBe(true);
    expect(raw).toContain(`,"'=SUM(1,2)",`);
    expect(raw).not.toMatch(/,=SUM/);

    const orders = await readCsv(await getCsv("orders"));
    const clientIds = orders.rows.map((row) => row[ORDER_HEADER.indexOf("clientOrderId")]).filter(Boolean);
    expect(clientIds.length).toBe(BIG / 10);
    expect(clientIds.every((id) => id.startsWith("'-key-"))).toBe(true);
  });
});

describe("只有本人的行", () => {
  it("别人的订单、成交、账本行不出现;与此事无关的用户只拿到表头", async () => {
    const idsIn = async (userId: string) => {
      testState.cookie = "";
      await createSession(userId);
      const [orders, fills, ledger] = [await readCsv(await getCsv("orders")), await readCsv(await getCsv("fills")), await readCsv(await getCsv("ledger"))];
      return { orders: orders.rows.map((row) => row[2]), fills: fills.rows.map((row) => row[1]), fillOrders: fills.rows.map((row) => row[2]), ledger: ledger.rows.map((row) => row[1]) };
    };
    const [alice, bob, dave, sam] = [await idsIn(ids.alice), await idsIn(ids.bob), await idsIn(ids.dave), await idsIn(ids.sam)];
    const owners = async (table: "order" | "ledgerEntry", rowIds: string[]) => {
      const rows = table === "order"
        ? await prisma.order.findMany({ where: { id: { in: rowIds } }, select: { userId: true } })
        : await prisma.ledgerEntry.findMany({ where: { id: { in: rowIds } }, select: { userId: true } });
      return new Set(rows.map((row) => row.userId));
    };
    for (const [userId, got] of [[ids.alice, alice], [ids.bob, bob], [ids.dave, dave]] as const) {
      expect(await owners("order", got.orders), "orders").toEqual(new Set([userId]));
      expect(await owners("ledgerEntry", got.ledger), "ledger").toEqual(new Set([userId]));
      // 成交行上的 orderId 是本人那一侧的订单,不是对手方的
      expect(await owners("order", got.fillOrders), "fill orders").toEqual(new Set([userId]));
      const trades = await prisma.trade.findMany({ where: { id: { in: got.fills } }, select: { buyerId: true, sellerId: true } });
      expect(trades.length).toBe(got.fills.length);
      expect(trades.every((trade) => trade.buyerId === userId || trade.sellerId === userId)).toBe(true);
    }
    expect(alice.orders.some((id) => dave.orders.includes(id))).toBe(false);
    expect(dave.fills.some((id) => alice.fills.includes(id))).toBe(false);
    expect(sam).toEqual({ orders: [], fills: [], fillOrders: [], ledger: [] });
  });
});

describe("非法筛选", () => {
  it("与 JSON 接口同样的 400(JSON 信封、private, no-store),不开始下载", async () => {
    await createSession(ids.dave);
    const cases: Array<[Kind, string, (q: string) => Promise<Response>]> = [
      ["orders", "?status=bogus", (q) => ordersJson.GET(new Request(`http://localhost/api/account/orders${q}`))],
      ["orders", "?status=toString", (q) => ordersJson.GET(new Request(`http://localhost/api/account/orders${q}`))],
      ["ledger", "?account=BANK", (q) => ledgerJson.GET(new Request(`http://localhost/api/transactions${q}`))],
      ["ledger", "?type=NOPE", (q) => ledgerJson.GET(new Request(`http://localhost/api/transactions${q}`))],
      ["ledger", "?from=yesterday", (q) => ledgerJson.GET(new Request(`http://localhost/api/transactions${q}`))],
      ["ledger", "?from=200&to=100", (q) => ledgerJson.GET(new Request(`http://localhost/api/transactions${q}`))],
    ];
    for (const [kind, query, json] of cases) {
      const res = await getCsv(kind, query);
      expect(res.status, query).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Content-Disposition")).toBeNull();
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body, query).toEqual(await (await json(query)).json());
    }
  });
});

describe("限流", () => {
  it("每个用户每分钟 10 次、三个接口共用一个桶:第 11 次 429 + Retry-After;别的用户不受影响;未登录的请求不占名额", async () => {
    testState.enforceRateLimit = true;
    // 未登录的 401 不进任何人的桶
    for (let i = 0; i < 12; i++) expect((await getCsv("orders")).status).toBe(401);
    await createSession(ids.rita);
    const kinds: Kind[] = ["orders", "fills", "ledger", "orders", "fills", "ledger", "orders", "fills", "ledger", "orders"];
    for (const kind of kinds) {
      const res = await getCsv(kind);
      expect(res.status, kind).toBe(200);
      await res.body?.cancel();
    }
    for (const kind of KINDS) {
      const res = await getCsv(kind);
      expect(res.status, kind).toBe(429);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Content-Disposition")).toBeNull();
      const retryAfter = Number(res.headers.get("Retry-After"));
      expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After ${res.headers.get("Retry-After")}`).toBe(true);
      await expect(res.json()).resolves.toEqual({ ok: false, error: "Too many requests, please retry later" });
    }
    // 非法筛选的请求也占名额:限流先于参数校验
    expect((await getCsv("orders", "?status=bogus")).status).toBe(429);
    testState.cookie = "";
    await createSession(ids.carol);
    const other = await getCsv("orders");
    expect(other.status).toBe(200);
    await other.body?.cancel();
  });
});

describe("行数上限", () => {
  const respond = (kind: Kind, options: { maxRows: number; pageRows: number }): Promise<Response> =>
    kind === "orders" ? csvExport.ordersCsvResponse(request(kind), options) : kind === "fills" ? csvExport.fillsCsvResponse(request(kind), options) : csvExport.ledgerCsvResponse(request(kind), options);

  it("默认上限是 100,000 行、每次读 200 行(订单每次读 2,000 行)", () => {
    expect(csvExport.CSV_MAX_ROWS).toBe(100_000);
    expect(csvExport.CSV_PAGE_ROWS).toBe(200);
    expect(csvExport.CSV_ORDER_PAGE_ROWS).toBe(2_000);
    expect(csvExport.CSV_RATE_LIMIT).toBe(10);
    expect(csvExport.CSV_RATE_WINDOW_MS).toBe(60_000);
  });

  // P2-13(终审 P2-SRV-3):Order 没有 (userId, createdAt) 索引,每页都要把该用户的订单全读一遍,所以订单导出用大页;
  // 成交与流水每页只读游标附近的行,页大小不变
  it("不传 pageRows 时:订单每页 2,000 行,成交 200 行", async () => {
    await createSession(ids.dave);
    const orders = vi.spyOn(accountPages, "readOrdersPage");
    const fills = vi.spyOn(accountPages, "readFillsPage");
    expect((await readCsv(await csvExport.ordersCsvResponse(request("orders")))).rows).toHaveLength(BIG);
    expect((await readCsv(await csvExport.fillsCsvResponse(request("fills")))).rows).toHaveLength(BIG);
    expect(orders.mock.calls.map((call) => call[2].limit)).toEqual([2_000]);
    expect(fills.mock.calls.map((call) => call[2].limit)).toEqual([200, 200]);
  });

  it.each(KINDS)("%s:到上限即停(最新的那些行),记一行日志;上限落在页中间或页边界都一样", async (kind) => {
    await createSession(ids.dave);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expected = kind === "orders" ? (await allOrders()).map(orderCells) : kind === "fills" ? (await allFills()).map(fillCells) : (await allLedger()).map(ledgerCells);
    for (const [maxRows, pageRows] of [[7, 3], [6, 3], [5, 50], [1, 1]]) {
      warn.mockClear();
      const csv = await readCsv(await respond(kind, { maxRows, pageRows }));
      expect(csv.rows, `${maxRows}/${pageRows}`).toEqual(expected.slice(0, maxRows));
      expect(warn, `${maxRows}/${pageRows}`).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(new RegExp(`^\\[csv\\] ${kind} export for user ${ids.dave} stopped at the row limit \\(${maxRows} rows\\)`));
    }
  });

  it.each(KINDS)("%s:行数没超过上限(包括正好等于上限)时完整导出,不记日志", async (kind) => {
    await createSession(ids.dave);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const total = kind === "ledger" ? BIG + 2 : BIG;
    for (const maxRows of [total, total + 1]) {
      const csv = await readCsv(await respond(kind, { maxRows, pageRows: 64 }));
      expect(csv.rows.length, String(maxRows)).toBe(total);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("中途出错与客户端断开", () => {
  /** 等几轮宏任务:让已经排上的 pull / setImmediate 跑完 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  it("第一页就失败 → 正常的 500(JSON 信封),不是只有表头的文件", async () => {
    await createSession(ids.dave);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(accountPages, "readOrdersPage").mockRejectedValue(new Error("db down"));
    const res = await ordersCsv.GET(request("orders"));
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Internal server error" });
    expect(error).toHaveBeenCalled();
  });

  it("流开始之后出错 → 已发出的部分照常到达,随后流以错误结束(不是正常收尾),记一行日志,之后不再读库", async () => {
    await createSession(ids.dave);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = accountPages.readOrdersPage;
    let calls = 0;
    const spy = vi.spyOn(accountPages, "readOrdersPage").mockImplementation((...args) => (++calls === 3 ? Promise.reject(new Error("db went away")) : real(...args)));
    const res = await csvExport.ordersCsvResponse(request("orders"), { pageRows: 10 });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let received = "";
    let failure: unknown = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("db went away");
    // 表头 + 前两页(20 行)已经发出;文件在行边界处截断
    expect(parseCsv(received.slice(1)).length).toBe(1 + 20);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toMatch(new RegExp(`^\\[csv\\] orders export for user ${ids.dave} failed after 20 rows`));
    await settle();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("客户端取消下载(流的 cancel)→ 不再读下一页", async () => {
    await createSession(ids.dave);
    const spy = vi.spyOn(accountPages, "readFillsPage");
    const res = await csvExport.fillsCsvResponse(request("fills"), { pageRows: 5 });
    const reader = res.body!.getReader();
    await reader.read(); // BOM + 表头
    await reader.read(); // 第一页
    const before = spy.mock.calls.length;
    await reader.cancel();
    await settle();
    // 取消发生在两页之间的让出里:下一页不再读(300 行 / 每页 5 行,不取消的话是 60 次)
    expect(before).toBe(1);
    expect(spy.mock.calls.length).toBe(before);
  });

  it("请求被中止(signal)→ 不再读下一页,流收掉", async () => {
    await createSession(ids.dave);
    const spy = vi.spyOn(accountPages, "readOrdersPage");
    const abort = new AbortController();
    const res = await csvExport.ordersCsvResponse(request("orders", "", { signal: abort.signal }), { pageRows: 5 });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    abort.abort();
    // 中止发生在两页之间的让出里:之后一页都不再读,流直接结束
    let chunks = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      chunks++;
    }
    expect(chunks).toBe(0);
    await settle();
    expect(spy.mock.calls.length).toBe(1);
  });
});
