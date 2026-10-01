// 经真实路由(临时 SQLite + migrate deploy + 模拟 cookie)验证 GET /api/transactions(计划 §6.2.2 C4):
// 形状与响应头、每个筛选单独与组合、type 筛选与 activityOf 的分类逐行一致(覆盖全部 reason)、非法参数 400、
// 键集游标翻页不重不漏(含同一毫秒多行、跨账户、几千行翻到底)、旧的裸 id 游标 400、别人的行不可见、未登录 401、
// 查询计划走 (userId, account, createdAt) 索引且 createdAt 只有一个上界、isScenario 随行给出。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_TYPES, LEDGER_ACCOUNTS, activityOf } from "@/lib/exchange/ledger-activity";
import type { ActivityType, LedgerActivity, LedgerActivityResponse } from "@/shared/api-shapes";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上, 绝不触碰 dev.db;带查询事件,用来核对实际发出的 SQL 与它的查询计划
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl, log: [{ emit: "event", level: "query" }] }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (testState.cookie ? { value: testState.cookie } : undefined),
    set: (_name: string, value: string) => { testState.cookie = value; },
    delete: () => { testState.cookie = ""; },
  }),
}));

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let route: typeof import("./route");
let cursor: typeof import("@/lib/server/cursor");
let createSession: (typeof import("@/lib/server/auth"))["createSession"];

const SYMBOL_A = "VCS-TEST-2021";
const SYMBOL_B = "GS-TEST-2022";
/** 情景标的(Asset.isScenario = true):行上的 isScenario 由它而来 */
const SYMBOL_S = "CEA-SCEN-TEST";
/** 合成行用的固定时刻(真实流程的行落在「现在」,两者相隔很远) */
const T0 = Date.UTC(2026, 0, 1);
/** 合成数据覆盖的 reason:代码里会写的 13 种 + 只读不写的 MIGRATION_BASELINE + 一个没登记的 */
const REASONS = [
  "ORDER_LOCK", "ORDER_UNLOCK", "SELF_TRADE_UNLOCK", "TRADE_SETTLE", "PRICE_IMPROVE_REFUND", "OTC_LOCK", "OTC_UNLOCK", "OTC_SETTLE",
  "GRANT", "SEED", "BOT_MINT_CASH", "BOT_MINT_QTY", "SIMULATED_RETIREMENT", "MIGRATION_BASELINE", "SOMETHING_NEW",
];

/** gina 的大账本行数,以及挤在同一毫秒(T0)里的行数(超过两页 limit=100) */
const BIG_ROWS = 3_000;
const BIG_SAME_MS = 250;

/** erin 另有两行 delta = 0 的 HOLDING 成交行(撮合与 OTC 各一) */
const ZERO_DELTA_REASONS = ["TRADE_SETTLE", "OTC_SETTLE"];

const ids = { assetA: "", assetB: "", assetS: "", alice: "", bob: "", carol: "", dave: "", erin: "", frank: "", gina: "", t1: "", lockedOrder: "", retirement: "" };
const sql: string[] = [];

type Row = { id: string; userId: string; account: string; reason: string; delta: bigint; assetId: string | null; refType: string | null; refId: string | null; createdAt: Date };
/** 某个用户的全部账本行,按接口的顺序(createdAt desc, id desc)——期望值一律从库里现算 */
const rowsOf = (userId: string): Promise<Row[]> => prisma.ledgerEntry.findMany({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-transactions-route-")));
  writeFileSync(join(testState.directory, "ledger.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "ledger.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  route = await import("./route");
  cursor = await import("@/lib/server/cursor");
  ({ createSession } = await import("@/lib/server/auth"));
  const matching = await import("@/lib/exchange/matching");
  const otc = await import("@/lib/exchange/otc");
  const { retireCredits } = await import("@/lib/exchange/retirement");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
  // db.ts 的类型是按无事件日志构造的 client;这里的实例在 mock 里带了 emit: "event",运行时可用
  (prisma as unknown as { $on(event: "query", cb: (e: { query: string }) => void): void }).$on("query", (e) => { sql.push(e.query); });

  const assetA = await prisma.asset.create({ data: { symbol: SYMBOL_A, name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" } });
  const assetB = await prisma.asset.create({ data: { symbol: SYMBOL_B, name: "Test wind", standard: "GS", projectType: "Wind", vintage: 2022, country: "Example", registry: "Demo registry" } });
  const assetS = await prisma.asset.create({ data: { symbol: SYMBOL_S, name: "Test scenario", standard: "CEA", projectType: "Scenario", vintage: 2026, country: "Example", registry: "Demo registry", isScenario: true } });
  const cash = { passwordHash: "test", cashBalance: BigInt(100_000_000) };
  const user = (name: string) => prisma.user.create({ data: { email: `${name}@ledger.test`, name, ...cash } });
  const [alice, bob, carol, dave, erin, frank, gina] = [await user("alice"), await user("bob"), await user("carol"), await user("dave"), await user("erin"), await user("frank"), await user("gina")];
  Object.assign(ids, { assetA: assetA.id, assetB: assetB.id, assetS: assetS.id, alice: alice.id, bob: bob.id, carol: carol.id, dave: dave.id, erin: erin.id, frank: frank.id, gina: gina.id });
  await prisma.holding.createMany({ data: [
    { userId: bob.id, assetId: assetA.id, quantity: 1_000 },
    { userId: bob.id, assetId: assetB.id, quantity: 100 },
  ] });

  // ---- alice / bob:经真实撮合、OTC、注销写出来的账本 ----
  // 赠金行(注册 / 演示账号路由写的就是这个形状):放在 T0,是 alice 最早的一行
  await prisma.ledgerEntry.create({ data: { userId: alice.id, account: "CASH", delta: BigInt(100_000_000), reason: "GRANT", createdAt: new Date(T0) } });
  const place = (userId: string, assetId: string, side: "BUY" | "SELL", type: "LIMIT" | "MARKET", price: number | null, quantity: number) =>
    matching.placeOrder({ userId, assetId, side, type, price, quantity });
  // T1:bob 挂卖 A 3 @ 9500,alice 市价买 3 → alice: CASH −28500 + HOLDING +3(refType TRADE)
  await place(bob.id, assetA.id, "SELL", "LIMIT", 9_500, 3);
  ids.t1 = (await place(alice.id, assetA.id, "BUY", "MARKET", null, 3)).trades[0].id;
  // alice 限价买 B 1 @ 4000(没有对手)后撤单 → ORDER_LOCK / ORDER_UNLOCK 各两行现金(refType ORDER,行上没有 assetId)
  const locked = await place(alice.id, assetB.id, "BUY", "LIMIT", 4_000, 1);
  await matching.cancelOrder(alice.id, locked.order.id);
  ids.lockedOrder = locked.order.id;
  // OTC:bob 挂 A 5 @ 11000,alice 买 2 → alice: CASH −22000 + HOLDING +2(refType DEAL)
  const listing = await otc.createListing({ sellerId: bob.id, assetId: assetA.id, quantity: 5, pricePerUnit: 11_000 });
  await otc.buyListing(alice.id, listing.id, 2);
  // alice 注销 1 吨 A → HOLDING −1(refType RETIREMENT)
  const retired = await retireCredits(alice.id, { assetId: assetA.id, quantity: 1, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey: "ledger-retire-0001" });
  ids.retirement = retired.retirement.id;
  // 价格改善:bob 挂卖 B 2 @ 5000,alice 限价买 2 @ 5100 → 锁 10200、成交 10000、退 200(PRICE_IMPROVE_REFUND)
  await place(bob.id, assetB.id, "SELL", "LIMIT", 5_000, 2);
  await place(alice.id, assetB.id, "BUY", "LIMIT", 5_100, 2);

  // ---- erin:每个 reason × 账户 × 正负各一行(合成),每行隔 1 秒,给 type / account / from / to 的筛选用 ----
  let k = 0;
  await prisma.ledgerEntry.createMany({ data: REASONS.flatMap((reason) => LEDGER_ACCOUNTS.flatMap((account) => [-5, 5].map((delta) => ({
    userId: erin.id, account, reason, delta: BigInt(delta), assetId: account.startsWith("HOLDING") ? assetA.id : null, createdAt: new Date(T0 + k++ * 1_000),
  })))) });
  // delta = 0 的边界:HOLDING 上的成交行,activityOf 归到卖出一侧(delta > 0 才是买入);SQL 里的符号条件必须给出同样的结果
  await prisma.ledgerEntry.createMany({ data: ZERO_DELTA_REASONS.map((reason) => ({
    userId: erin.id, account: "HOLDING", reason, delta: BigInt(0), assetId: assetA.id, createdAt: new Date(T0 + k++ * 1_000),
  })) });

  // ---- dave:30 行挤在 5 个毫秒里(每毫秒 6 行、四个账户轮着来),给翻页用 ----
  await prisma.ledgerEntry.createMany({ data: Array.from({ length: 30 }, (_, i) => ({
    userId: dave.id, account: LEDGER_ACCOUNTS[i % 4], reason: "GRANT", delta: BigInt(i + 1), assetId: LEDGER_ACCOUNTS[i % 4].startsWith("HOLDING") ? assetB.id : null,
    createdAt: new Date(T0 + Math.floor(i / 6)),
  })) });

  // ---- frank:情景标的与普通标的的持仓行、没有标的的现金行、情景标的成交的现金腿(经引用补出标的),给 isScenario 用 ----
  await prisma.ledgerEntry.createMany({ data: [
    { userId: frank.id, account: "CASH", reason: "GRANT", delta: BigInt(10_000_000), createdAt: new Date(T0) },
    { userId: frank.id, account: "HOLDING", reason: "GRANT", delta: BigInt(7), assetId: assetA.id, createdAt: new Date(T0 + 1) },
    { userId: frank.id, account: "HOLDING", reason: "TRADE_SETTLE", delta: BigInt(4), assetId: assetS.id, refType: "TRADE", refId: "scenario-trade-1", createdAt: new Date(T0 + 2) },
    { userId: frank.id, account: "CASH", reason: "TRADE_SETTLE", delta: BigInt(-26_000), refType: "TRADE", refId: "scenario-trade-1", createdAt: new Date(T0 + 2) },
  ] });

  // ---- gina:几千行的账本,给「翻到很深也不重不漏」用。前 BIG_SAME_MS 行全在 T0 这一毫秒(一毫秒跨好几页),其余每毫秒 9 行;四个账户轮着来 ----
  await prisma.ledgerEntry.createMany({ data: Array.from({ length: BIG_ROWS }, (_, i) => ({
    userId: gina.id, account: LEDGER_ACCOUNTS[i % 4], reason: i % 3 === 0 ? "TRADE_SETTLE" : "GRANT", delta: BigInt(i % 5 === 0 ? -(i + 1) : i + 1),
    assetId: LEDGER_ACCOUNTS[i % 4].startsWith("HOLDING") ? assetA.id : null,
    createdAt: new Date(i < BIG_SAME_MS ? T0 : T0 + 1 + Math.floor((i - BIG_SAME_MS) / 9)),
  })) });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
});

const get = (query = "") => route.GET(new Request(`http://localhost/api/transactions${query}`));

async function expectPrivateOk(res: Response): Promise<LedgerActivityResponse> {
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.data;
}

async function expectBadRequest(query: string, error: string | RegExp) {
  const res = await get(query);
  expect(res.status, query).toBe(400);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const json = await res.json();
  expect(json.ok).toBe(false);
  if (typeof error === "string") expect(json.error, query).toBe(error);
  else expect(json.error, query).toMatch(error);
}

/** 带着筛选条件一页页翻到底(query 以 ? 开头或为空) */
async function all(query = "", limit = 100): Promise<LedgerActivity[]> {
  const items: LedgerActivity[] = [];
  let next: string | null = null;
  do {
    const sep = query ? "&" : "?";
    const page: LedgerActivityResponse = await expectPrivateOk(await get(`${query}${sep}limit=${limit}${next ? `&cursor=${next}` : ""}`));
    items.push(...page.items);
    next = page.nextCursor;
  } while (next);
  return items;
}

const idsOf = (items: { id: string }[]) => items.map((item) => item.id);

describe("未登录与响应头", () => {
  it("未登录 → 401 + { ok: false } + private, no-store", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Not logged in" });
  });

  it("没有流水的用户 → { items: [], nextCursor: null },不带 total / pagination", async () => {
    await createSession(ids.carol);
    expect(await expectPrivateOk(await get())).toEqual({ items: [], nextCursor: null });
  });
});

describe("形状(C4 的 LedgerActivity)", () => {
  it("字段恰好是约定的 12 个;ts 是毫秒、delta 是 number、isScenario 是 boolean;按 createdAt desc, id desc;与库里的行一一对应", async () => {
    await createSession(ids.alice);
    const data = await expectPrivateOk(await get());
    expect(Object.keys(data).sort()).toEqual(["items", "nextCursor"]);
    expect(data.nextCursor).toBeNull();
    const rows = await rowsOf(ids.alice);
    expect(rows.length).toBeGreaterThan(10);
    expect(idsOf(data.items)).toEqual(idsOf(rows));
    for (const [i, item] of data.items.entries()) {
      expect(Object.keys(item).sort()).toEqual(["account", "assetId", "delta", "id", "isScenario", "label", "reason", "refId", "refType", "symbol", "ts", "type"]);
      const row = rows[i];
      expect(item).toMatchObject({ id: row.id, ts: row.createdAt.getTime(), account: row.account, reason: row.reason, delta: Number(row.delta), refType: row.refType, refId: row.refId, ...activityOf(row) });
      expect(typeof item.ts).toBe("number");
      expect(typeof item.delta).toBe("number");
      // alice 只碰过两个普通标的
      expect(item.isScenario).toBe(false);
    }
  });

  it("赠金行:GRANT / Demo funds granted / 没有标的;是最早的一行", async () => {
    await createSession(ids.alice);
    const { items } = await expectPrivateOk(await get());
    expect(items.at(-1)).toEqual({
      id: expect.any(String), ts: T0, account: "CASH", type: "GRANT", label: "Demo funds granted", reason: "GRANT",
      assetId: null, symbol: null, isScenario: false, delta: 100_000_000, refType: null, refId: null,
    });
  });

  it("isScenario:情景标的的持仓行 true,普通标的的持仓行 false,没有标的的现金行 false;情景标的成交的现金腿跟着补出的标的走", async () => {
    await createSession(ids.frank);
    const { items } = await expectPrivateOk(await get());
    expect(items).toHaveLength(4);
    const pick = (account: string, reason: string) => items.find((item) => item.account === account && item.reason === reason)!;
    expect(pick("HOLDING", "TRADE_SETTLE")).toMatchObject({ symbol: SYMBOL_S, assetId: ids.assetS, isScenario: true, delta: 4 });
    expect(pick("HOLDING", "GRANT")).toMatchObject({ symbol: SYMBOL_A, assetId: ids.assetA, isScenario: false, delta: 7 });
    expect(pick("CASH", "GRANT")).toMatchObject({ symbol: null, assetId: null, isScenario: false });
    expect(pick("CASH", "TRADE_SETTLE")).toMatchObject({ symbol: SYMBOL_S, assetId: ids.assetS, isScenario: true, delta: -26_000 });
    // 带 symbol 筛选时(标的不再逐行去查)同样给对
    const scenario = await all(`?symbol=${SYMBOL_S}`);
    expect(scenario.map((item) => [item.account, item.isScenario]).sort()).toEqual([["CASH", true], ["HOLDING", true]]);
    const plain = await all(`?symbol=${SYMBOL_A}`);
    expect(plain.map((item) => [item.account, item.isScenario])).toEqual([["HOLDING", false]]);
  });

  it("现金行本身不带标的:成交与 OTC 的现金腿由同一引用下本人的持仓行补出,挂单冻结 / 解冻由订单补出", async () => {
    await createSession(ids.alice);
    const { items } = await expectPrivateOk(await get());
    const tradeCash = items.find((item) => item.refType === "TRADE" && item.refId === ids.t1 && item.account === "CASH");
    expect(tradeCash).toMatchObject({ type: "SETTLEMENT", label: "Trade payment", delta: -28_500, assetId: ids.assetA, symbol: SYMBOL_A });
    const tradeCredits = items.find((item) => item.refType === "TRADE" && item.refId === ids.t1 && item.account === "HOLDING");
    expect(tradeCredits).toMatchObject({ type: "BUY", label: "Credits purchased", delta: 3, assetId: ids.assetA, symbol: SYMBOL_A });
    const otcCash = items.find((item) => item.refType === "DEAL" && item.account === "CASH");
    expect(otcCash).toMatchObject({ type: "OTC_SETTLEMENT", label: "OTC payment", delta: -22_000, assetId: ids.assetA, symbol: SYMBOL_A });
    const locks = items.filter((item) => item.refType === "ORDER" && item.refId === ids.lockedOrder);
    expect(locks.map((item) => [item.account, item.type, item.delta]).sort()).toEqual([
      ["CASH", "RELEASE", 4_000], ["CASH", "RESERVE", -4_000], ["CASH_LOCKED", "RELEASE", -4_000], ["CASH_LOCKED", "RESERVE", 4_000],
    ]);
    for (const lock of locks) expect(lock).toMatchObject({ assetId: ids.assetB, symbol: SYMBOL_B });
    const refund = items.find((item) => item.reason === "PRICE_IMPROVE_REFUND");
    expect(refund).toMatchObject({ type: "REFUND", label: "Price improvement refund", delta: 200, symbol: SYMBOL_B });
  });

  it("注销行:RETIREMENT,引用指向注销记录(旧页面据此给出证书链接)", async () => {
    await createSession(ids.alice);
    const { items } = await expectPrivateOk(await get("?type=RETIREMENT"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "RETIREMENT", label: "Simulated credit retirement", account: "HOLDING", delta: -1, symbol: SYMBOL_A, refType: "RETIREMENT", refId: ids.retirement });
  });
});

describe("别人的行不可见", () => {
  it("各人只看到自己的行;拿别人某一行的位置当游标,也只是一个时间位置,翻出来的仍然全是自己的行", async () => {
    const aliceRows = await rowsOf(ids.alice);
    const bobRows = await rowsOf(ids.bob);
    expect(bobRows.length).toBeGreaterThan(5);
    await createSession(ids.bob);
    const mine = await all();
    expect(idsOf(mine)).toEqual(idsOf(bobRows));
    expect(mine.some((item) => idsOf(aliceRows).includes(item.id))).toBe(false);

    // alice 最新的一行作游标:bob 拿到的是自己在那个位置之前的行
    const foreign = cursor.encodeCursor({ createdAt: aliceRows[0].createdAt.getTime(), id: aliceRows[0].id });
    const paged = await expectPrivateOk(await get(`?cursor=${foreign}&limit=100`));
    const bobIds = new Set(idsOf(bobRows));
    expect(paged.items.every((item) => bobIds.has(item.id))).toBe(true);
    // 带 symbol 筛选时(现金行经引用补标的)同样只看本人的行
    const bySymbol = await all(`?symbol=${SYMBOL_A}`);
    expect(bySymbol.length).toBeGreaterThan(0);
    expect(bySymbol.every((item) => bobIds.has(item.id))).toBe(true);
  });
});

describe("筛选:type(与 activityOf 逐行一致,覆盖全部 reason)", () => {
  it("合成数据确实覆盖了每个 reason × 账户 × 正负,外加两行 delta = 0 的 HOLDING 成交行,且每个 type 都有行", async () => {
    const rows = await rowsOf(ids.erin);
    expect(rows).toHaveLength(REASONS.length * LEDGER_ACCOUNTS.length * 2 + ZERO_DELTA_REASONS.length);
    expect(rows.filter((row) => row.delta === BigInt(0)).map((row) => [row.account, row.reason]).sort()).toEqual([["HOLDING", "OTC_SETTLE"], ["HOLDING", "TRADE_SETTLE"]]);
    expect(new Set(rows.map((row) => row.reason))).toEqual(new Set(REASONS));
    expect(new Set(rows.map((row) => activityOf(row).type))).toEqual(new Set(ACTIVITY_TYPES));
  });

  it.each(ACTIVITY_TYPES.map((type) => [type]))("type=%s → 恰好是 activityOf 归到这一类的行", async (type) => {
    await createSession(ids.erin);
    const rows = await rowsOf(ids.erin);
    const expected = rows.filter((row) => activityOf(row).type === type);
    expect(expected.length).toBeGreaterThan(0);
    const items = await all(`?type=${type}`);
    expect(idsOf(items)).toEqual(idsOf(expected));
    expect(items.every((item) => item.type === type)).toBe(true);
  });

  it("delta = 0 的 HOLDING 成交行:SQL 的符号条件与 activityOf 一致——归卖出(SELL / OTC_SELL),不归买入,也不是结算腿", async () => {
    await createSession(ids.erin);
    const zero = (await rowsOf(ids.erin)).filter((row) => row.delta === BigInt(0));
    expect(zero).toHaveLength(2);
    const byReason = new Map(zero.map((row) => [row.reason, row]));
    for (const [reason, sell, buy, leg] of [["TRADE_SETTLE", "SELL", "BUY", "SETTLEMENT"], ["OTC_SETTLE", "OTC_SELL", "OTC_BUY", "OTC_SETTLEMENT"]] as const) {
      const row = byReason.get(reason)!;
      expect(activityOf(row).type).toBe(sell);
      const sold = await all(`?type=${sell}`);
      expect(sold.find((item) => item.id === row.id)).toMatchObject({ type: sell, delta: 0, account: "HOLDING" });
      expect(idsOf(await all(`?type=${buy}`))).not.toContain(row.id);
      expect(idsOf(await all(`?type=${leg}`))).not.toContain(row.id);
    }
  });

  it("各 type 的结果互不重叠,合起来就是全部行", async () => {
    await createSession(ids.erin);
    const seen: string[] = [];
    for (const type of ACTIVITY_TYPES) seen.push(...idsOf(await all(`?type=${type}`)));
    const everything = idsOf(await rowsOf(ids.erin));
    expect(seen).toHaveLength(everything.length);
    expect(new Set(seen)).toEqual(new Set(everything));
  });

  it("真实流程写出的行:alice 的 BUY 是两笔撮合买入,OTC_BUY 是一笔 OTC 买入", async () => {
    await createSession(ids.alice);
    const buys = await all("?type=BUY");
    expect(buys.map((item) => [item.symbol, item.delta]).sort()).toEqual([[SYMBOL_B, 2], [SYMBOL_A, 3]]);
    const otcBuys = await all("?type=OTC_BUY");
    expect(otcBuys.map((item) => [item.symbol, item.delta])).toEqual([[SYMBOL_A, 2]]);
  });
});

describe("筛选:account / symbol / from / to 与组合", () => {
  it.each(LEDGER_ACCOUNTS.map((account) => [account]))("account=%s → 只有这个账户的行", async (account) => {
    await createSession(ids.erin);
    const expected = (await rowsOf(ids.erin)).filter((row) => row.account === account);
    expect(idsOf(await all(`?account=${account}`))).toEqual(idsOf(expected));
  });

  it("symbol:持仓行按行上的标的,现金行按补出来的标的——筛选结果与不筛时显示的标的一致", async () => {
    await createSession(ids.alice);
    const everything = await all();
    for (const symbol of [SYMBOL_A, SYMBOL_B]) {
      const expected = everything.filter((item) => item.symbol === symbol);
      const items = await all(`?symbol=${symbol}`);
      expect(idsOf(items)).toEqual(idsOf(expected));
      // 不只是持仓行:同一标的下的现金腿也在里面
      expect(items.some((item) => item.account === "CASH")).toBe(true);
      expect(items.some((item) => item.account === "HOLDING")).toBe(true);
    }
    // 两个标的加上没有标的的赠金行 = 全部
    const withSymbol = everything.filter((item) => item.symbol !== null);
    expect(withSymbol).toHaveLength(everything.length - 1);
  });

  it("未知 symbol → 空结果(不是 400),与 /api/account/orders、fills 一致", async () => {
    await createSession(ids.alice);
    expect(await expectPrivateOk(await get("?symbol=NOPE-2099"))).toEqual({ items: [], nextCursor: null });
  });

  it("from / to:from ≤ ts < to(毫秒),可以只给一边", async () => {
    await createSession(ids.erin);
    const rows = await rowsOf(ids.erin);
    const between = (from: number, to: number) => rows.filter((row) => row.createdAt.getTime() >= from && row.createdAt.getTime() < to);
    // 第 10 行(含)到第 20 行(不含):恰好 10 行
    const window = await all(`?from=${T0 + 10_000}&to=${T0 + 20_000}`);
    expect(window).toHaveLength(10);
    expect(idsOf(window)).toEqual(idsOf(between(T0 + 10_000, T0 + 20_000)));
    expect(window.at(-1)!.ts).toBe(T0 + 10_000);
    expect(window[0].ts).toBe(T0 + 19_000);
    expect(idsOf(await all(`?from=${T0 + 115_000}`))).toEqual(idsOf(between(T0 + 115_000, Infinity)));
    // 第 115..119 行,加上排在最后的两行 delta = 0
    expect(await all(`?from=${T0 + 115_000}`)).toHaveLength(5 + ZERO_DELTA_REASONS.length);
    expect(idsOf(await all(`?to=${T0 + 3_000}`))).toEqual(idsOf(between(0, T0 + 3_000)));
    expect(await all(`?to=${T0 + 3_000}`)).toHaveLength(3);
    expect(await all(`?to=${T0}`)).toEqual([]);
  });

  it("组合:account + type + from / to 取交集;互相矛盾的组合是空结果", async () => {
    await createSession(ids.erin);
    const rows = await rowsOf(ids.erin);
    const combos: { account: string; type: ActivityType; from: number; to: number }[] = [
      { account: "CASH", type: "RELEASE", from: T0, to: T0 + 120_000 },
      { account: "HOLDING_LOCKED", type: "SETTLEMENT", from: T0 + 20_000, to: T0 + 40_000 },
      { account: "HOLDING", type: "OTC_SELL", from: T0, to: T0 + 120_000 },
      { account: "CASH_LOCKED", type: "ADJUSTMENT", from: T0 + 80_000, to: T0 + 120_000 },
    ];
    for (const { account, type, from, to } of combos) {
      const expected = rows.filter((row) => row.account === account && activityOf(row).type === type && row.createdAt.getTime() >= from && row.createdAt.getTime() < to);
      expect(expected.length, `${account} ${type}`).toBeGreaterThan(0);
      expect(idsOf(await all(`?account=${account}&type=${type}&from=${from}&to=${to}`))).toEqual(idsOf(expected));
    }
    // BUY 只出现在 HOLDING 账户上
    expect(await all("?account=CASH&type=BUY")).toEqual([]);
    expect(await all("?account=HOLDING&type=SETTLEMENT")).toEqual([]);
  });

  it("组合:symbol + type + account(真实流程的行)", async () => {
    await createSession(ids.alice);
    const items = await all(`?symbol=${SYMBOL_A}&type=SETTLEMENT&account=CASH`);
    expect(items.map((item) => [item.refId, item.delta])).toEqual([[ids.t1, -28_500]]);
    expect(await all(`?symbol=${SYMBOL_B}&type=RETIREMENT`)).toEqual([]);
    // 空串参数视为没传(与其它账户接口一致)
    const everything = await all();
    expect(idsOf(await all("?account=&type=&symbol=&from=&to=&cursor="))).toEqual(idsOf(everything));
  });
});

describe("非法参数 → 400,信息点名是哪个参数", () => {
  it("limit:非整数、越界", async () => {
    await createSession(ids.alice);
    for (const limit of ["0", "101", "abc", "1.5", "-1", "1e9"]) await expectBadRequest(`?limit=${limit}`, "Invalid limit: must be an integer between 1 and 100");
    expect((await expectPrivateOk(await get("?limit=1"))).items).toHaveLength(1);
    // 空串视为没传(缺省 50),与其它参数一致
    expect((await expectPrivateOk(await get("?limit="))).items.length).toBeGreaterThan(1);
    expect((await expectPrivateOk(await get("?limit=100"))).items.length).toBeGreaterThan(1);
  });

  it("account / type:不在枚举里(含原型链上的名字)", async () => {
    await createSession(ids.alice);
    for (const account of ["FOO", "cash", "toString", "__proto__"]) await expectBadRequest(`?account=${account}`, /^Invalid account: /);
    for (const type of ["FOO", "buy", "constructor", "TRADE_SETTLE"]) await expectBadRequest(`?type=${type}`, /^Invalid type: /);
  });

  it("from / to:不是 0..8.64e15 的整数毫秒,或 from 不早于 to", async () => {
    await createSession(ids.alice);
    for (const from of ["abc", "-1", "1.5", "9000000000000000", "2026-01-01"]) await expectBadRequest(`?from=${from}`, /^Invalid from: /);
    for (const to of ["abc", "-1", "1.5", "9000000000000000"]) await expectBadRequest(`?to=${to}`, /^Invalid to: /);
    await expectBadRequest(`?from=${T0 + 1}&to=${T0}`, "Invalid from / to: from must be earlier than to");
    await expectBadRequest(`?from=${T0}&to=${T0}`, "Invalid from / to: from must be earlier than to");
  });

  it("symbol:超长", async () => {
    await createSession(ids.alice);
    await expectBadRequest(`?symbol=${"X".repeat(65)}`, /^Invalid symbol: /);
  });

  it("cursor:不是 base64url 键集游标;旧的裸 id 游标不再接受", async () => {
    await createSession(ids.alice);
    await expectBadRequest("?cursor=garbage", "Invalid cursor");
    await expectBadRequest("?cursor=%%%", "Invalid cursor");
    const farFuture = Buffer.from(JSON.stringify({ createdAt: 9_000_000_000_000_000, id: "x" })).toString("base64url");
    await expectBadRequest(`?cursor=${farFuture}`, "Invalid cursor");
    const [newest] = await rowsOf(ids.alice);
    await expectBadRequest(`?cursor=${newest.id}`, "Invalid cursor");
  });

  it("未登录时参数再离谱也是 401,不先回 400", async () => {
    const res = await get("?limit=0&type=FOO");
    expect(res.status).toBe(401);
  });
});

describe("键集游标翻页", () => {
  it("30 行挤在 5 个毫秒、跨四个账户:limit=4 翻 8 页,不重不漏,顺序与库里一致;nextCursor 指向每页最后一行", async () => {
    await createSession(ids.dave);
    const rows = await rowsOf(ids.dave);
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(5);
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: LedgerActivityResponse = await expectPrivateOk(await get(`?limit=4${next ? `&cursor=${next}` : ""}`));
      expect(page.items.length).toBeLessThanOrEqual(4);
      seen.push(...idsOf(page.items));
      if (page.nextCursor) {
        const last = page.items.at(-1)!;
        expect(cursor.decodeCursor(page.nextCursor)).toEqual({ createdAt: last.ts, id: last.id });
      }
      next = page.nextCursor;
      pages++;
    } while (next);
    expect(pages).toBe(8);
    expect(seen).toEqual(idsOf(rows));
  });

  it("行数恰好是 limit 的整数倍:最后一页满页且 nextCursor 为 null(不多给一个空页)", async () => {
    await createSession(ids.dave);
    const rows = await rowsOf(ids.dave);
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: LedgerActivityResponse = await expectPrivateOk(await get(`?limit=5${next ? `&cursor=${next}` : ""}`));
      expect(page.items).toHaveLength(5);
      seen.push(...idsOf(page.items));
      next = page.nextCursor;
      pages++;
    } while (next);
    expect(pages).toBe(6);
    expect(seen).toEqual(idsOf(rows));
  });

  it("带筛选翻页:游标与 account / type 同时生效;limit=1 逐行翻完", async () => {
    await createSession(ids.dave);
    const rows = await rowsOf(ids.dave);
    for (const account of ["CASH", "HOLDING_LOCKED"]) {
      const expected = rows.filter((row) => row.account === account);
      expect(idsOf(await all(`?account=${account}`, 3))).toEqual(idsOf(expected));
    }
    expect(idsOf(await all("?type=GRANT", 7))).toEqual(idsOf(rows));
    expect(idsOf(await all(`?symbol=${SYMBOL_B}`, 1))).toEqual(idsOf(rows.filter((row) => row.assetId === ids.assetB)));
    await createSession(ids.erin);
    const erinRows = await rowsOf(ids.erin);
    expect(idsOf(await all("", 7))).toEqual(idsOf(erinRows));
  });
});

describe("深翻页:几千行的账本翻到底", () => {
  it(`${BIG_ROWS} 行(其中 ${BIG_SAME_MS} 行在同一毫秒)、四个账户归并:limit=100 翻到底,不重不漏,顺序与库里一致`, async () => {
    await createSession(ids.gina);
    const rows = await rowsOf(ids.gina);
    expect(rows).toHaveLength(BIG_ROWS);
    expect(rows.filter((row) => row.createdAt.getTime() === T0)).toHaveLength(BIG_SAME_MS);
    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page: LedgerActivityResponse = await expectPrivateOk(await get(`?limit=100${next ? `&cursor=${next}` : ""}`));
      expect(page.items).toHaveLength(100);
      seen.push(...idsOf(page.items));
      next = page.nextCursor;
      pages++;
    } while (next);
    expect(pages).toBe(BIG_ROWS / 100);
    expect(new Set(seen).size).toBe(BIG_ROWS);
    expect(seen).toEqual(idsOf(rows));
  });

  it("单个账户、带 type 筛选:小页翻到底(页边界落在同一毫秒中间),不重不漏", async () => {
    await createSession(ids.gina);
    const rows = await rowsOf(ids.gina);
    const cashRows = rows.filter((row) => row.account === "CASH");
    expect(cashRows).toHaveLength(BIG_ROWS / 4);
    expect(idsOf(await all("?account=CASH", 7))).toEqual(idsOf(cashRows));
    const sells = rows.filter((row) => activityOf(row).type === "SELL");
    expect(sells).toHaveLength(BIG_ROWS / 60); // HOLDING(每 4 行)× TRADE_SETTLE(每 3 行)× 负数(每 5 行)
    expect(idsOf(await all("?type=SELL", 13))).toEqual(idsOf(sells));
  });

  it("to 与游标合成一个上界:to 在游标之后、之前、正好落在游标那一毫秒,结果都等于「先按 to 截、再从游标往后」", async () => {
    await createSession(ids.gina);
    const rows = await rowsOf(ids.gina);
    const times = [...new Set(rows.map((row) => row.createdAt.getTime()))].sort((a, b) => a - b);
    const mid = times[Math.floor(times.length / 2)];
    // 带 to 从头翻到底:第一页的上界是 to,之后每页的上界是游标
    const capped = rows.filter((row) => row.createdAt.getTime() < mid);
    expect(capped.length).toBeGreaterThan(1_000);
    expect(idsOf(await all(`?to=${mid}`, 100))).toEqual(idsOf(capped));
    expect(idsOf(await all(`?from=${T0 + 1}&to=${mid}`, 100))).toEqual(idsOf(capped.filter((row) => row.createdAt.getTime() >= T0 + 1)));

    // 拿不带筛选时第 5 页末尾的位置当游标
    const at = rows[499];
    const position = cursor.encodeCursor({ createdAt: at.createdAt.getTime(), id: at.id });
    const after = rows.slice(500);
    const expectPage = async (to: number) => {
      const expected = after.filter((row) => row.createdAt.getTime() < to).slice(0, 50);
      const page = await expectPrivateOk(await get(`?limit=50&cursor=${position}&to=${to}`));
      expect(idsOf(page.items), `to=${to - T0}`).toEqual(idsOf(expected));
      return expected.length;
    };
    const cursorTs = at.createdAt.getTime();
    // to 远在游标之后:上界是游标,紧接着第 500 行往后
    expect(await expectPage(Date.now())).toBe(50);
    expect(idsOf((await expectPrivateOk(await get(`?limit=50&cursor=${position}&to=${Date.now()}`))).items)).toEqual(idsOf(rows.slice(500, 550)));
    // to = 游标那一毫秒 + 1:游标所在的毫秒还在范围里,同一毫秒里排在游标之后的行照给
    expect(await expectPage(cursorTs + 1)).toBe(50);
    // to = 游标那一毫秒:那一毫秒整个被 to 截掉
    expect(await expectPage(cursorTs)).toBe(50);
    // to 在游标之前:上界是 to
    expect(await expectPage(mid)).toBe(50);
    // to 落在最早那一毫秒之后一点:只剩 T0 那一毫秒里的行
    expect(await expectPage(T0 + 1)).toBe(50);
    expect(await expectPage(T0)).toBe(0);
  });

  it("游标落在挤了 250 行的那一毫秒里:同一个上界下连翻三页,靠 id 去掉已经给过的行", async () => {
    await createSession(ids.gina);
    const rows = await rowsOf(ids.gina);
    const first = rows.findIndex((row) => row.createdAt.getTime() === T0);
    expect(rows.length - first).toBe(BIG_SAME_MS);
    const at = rows[first + 9];
    let next: string | null = cursor.encodeCursor({ createdAt: T0, id: at.id });
    const seen: string[] = [];
    let pages = 0;
    while (next) {
      const page: LedgerActivityResponse = await expectPrivateOk(await get(`?limit=100&cursor=${next}`));
      seen.push(...idsOf(page.items));
      next = page.nextCursor;
      pages++;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(idsOf(rows.slice(first + 10)));
  });
});

describe("查询", () => {
  it("不再数总数;翻页查询在没有 sqlite_stat1 的库上走 (userId, account, createdAt) 索引,不扫表;createdAt 只有一个上界", async () => {
    // 迁移出来的临时库从没 ANALYZE 过,与丢了 sqlite_stat1 的生产库同一处境
    const stat1 = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`);
    expect(Number(stat1[0]?.n)).toBe(0);
    await createSession(ids.alice);
    const [newest] = await rowsOf(ids.alice);
    const position = cursor.encodeCursor({ createdAt: newest.createdAt.getTime(), id: newest.id });
    sql.length = 0;
    await expectPrivateOk(await get(`?account=CASH&type=SETTLEMENT&symbol=${SYMBOL_A}&from=${T0}&to=${Date.now() + 60_000}&cursor=${position}`));
    expect(sql.some((q) => /count\(/i.test(q))).toBe(false);
    const pageQueries = sql.filter((q) => /FROM "LedgerEntry" l\b/.test(q));
    expect(pageQueries).toHaveLength(1); // 给了 account:只查这一个账户
    const placeholders = (pageQueries[0].match(/\?/g) ?? []).length;
    const plan = await prisma.$queryRawUnsafe<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${pageQueries[0]}`, ...Array.from({ length: placeholders }, () => null));
    const details = plan.map((row) => row.detail);
    expect(details[0]).toMatch(/^SEARCH l USING INDEX LedgerEntry_userId_account_createdAt_idx \(userId=\? AND account=\? AND createdAt>\? AND createdAt<\?\)$/);
    expect(details.some((detail) => /^SCAN (l|c|o)\b/.test(detail))).toBe(false);
    // createdAt 上只有一个上界(to 与游标在 JS 里合成 upper)。SQLite 的范围查找只用一个上界定位,第二个只会逐行过滤,
    // 翻得越深读得越多;查询计划的文字看不出这个差别(两种写法都是 createdAt>? AND createdAt<?),所以直接数查询文本:
    // 一个下界、一个上界、游标平局条件里的一个 <,没有 <=
    expect(pageQueries[0].match(/l\."createdAt" >= \?/g)).toHaveLength(1);
    expect(pageQueries[0].match(/l\."createdAt" < \?/g)).toHaveLength(2);
    expect(pageQueries[0]).toMatch(/AND \(l\."createdAt" < \? OR l\."id" < \?\)/);
    expect(pageQueries[0]).not.toMatch(/"createdAt" <=/);

    // 不给 account:四个账户各查一次(每次都是同一条索引查找),在内存里归并
    sql.length = 0;
    await expectPrivateOk(await get());
    expect(sql.filter((q) => /FROM "LedgerEntry" l\b/.test(q))).toHaveLength(4);
    // type 把账户收窄时只查需要的账户:BUY 只在 HOLDING 上
    sql.length = 0;
    await expectPrivateOk(await get("?type=BUY"));
    expect(sql.filter((q) => /FROM "LedgerEntry" l\b/.test(q))).toHaveLength(1);
    expect(sql.some((q) => /count\(/i.test(q))).toBe(false);
  });

  // P2-13:现金行(ORDER_LOCK / ORDER_UNLOCK)的标的从本人的订单补。where 里同时写 userId 时,IN 列表一长 SQLite 就改走
  // (userId, …) 索引、把该用户的订单全读一遍(一个 5 万张订单的用户,流水导出 0.6 s → 3.6 s);现在只按主键取,属主在 JS 里筛
  it("补标的的订单查询只按主键取(不带 userId,IN 再长也走主键),别人的订单补不出标的", async () => {
    await createSession(ids.alice);
    sql.length = 0;
    const page: LedgerActivityResponse = await expectPrivateOk(await get("?account=CASH&type=RESERVE"));
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.symbol === SYMBOL_B)).toBe(true); // alice 挂过又撤的那张 B 买单
    // Prisma 的查询文本用反引号:SELECT … FROM `main`.`Order` WHERE `main`.`Order`.`id` IN (?,?) …
    const orderQueries = sql.filter((q) => q.includes("FROM `main`.`Order`"));
    expect(orderQueries).toHaveLength(1);
    const where = orderQueries[0].slice(orderQueries[0].indexOf(" WHERE "));
    expect(where).toMatch(/^ WHERE `main`\.`Order`\.`id` IN \(/);
    expect(where).not.toContain("userId");
    // 主键上的 IN 与列表多长无关;带着 userId 时 60 个 id 就改走 userId 索引(没有 sqlite_stat1 的库上)
    const ids60 = Array.from({ length: 60 }, (_, i) => `x${i}`);
    const planOf = async (withUser: boolean) =>
      (await prisma.$queryRawUnsafe<{ detail: string }[]>(
        `EXPLAIN QUERY PLAN SELECT "id", "assetId" FROM "Order" WHERE ${withUser ? `"userId" = ? AND ` : ""}"id" IN (${ids60.map(() => "?").join(",")})`,
        ...(withUser ? [ids.alice] : []), ...ids60,
      )).map((row) => row.detail).join(" / ");
    expect(await planOf(false)).toMatch(/USING INDEX sqlite_autoindex_Order_1 \(id=\?\)/);
    expect(await planOf(true)).toMatch(/USING INDEX Order_userId_/);

    // 属主在 JS 里筛:一行引用了别人订单的现金流水(不该有,这里人为造一行)补不出标的
    const ivy = await prisma.user.create({ data: { email: "ivy@ledger.test", name: "ivy", passwordHash: "test" } });
    const bobOrder = await prisma.order.findFirstOrThrow({ where: { userId: ids.bob } });
    await prisma.ledgerEntry.create({ data: { userId: ivy.id, account: "CASH", delta: BigInt(-1), reason: "ORDER_LOCK", refType: "ORDER", refId: bobOrder.id } });
    await createSession(ivy.id);
    const foreign: LedgerActivityResponse = await expectPrivateOk(await get());
    expect(foreign.items.map((item) => [item.refId, item.symbol, item.assetId])).toEqual([[bobOrder.id, null, null]]);
  });
});
