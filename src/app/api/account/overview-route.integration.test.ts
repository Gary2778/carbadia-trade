// GET /api/account/overview 经真实路由的集成测试(计划 §6.2.2 C6、§6.2.3 P2-05):临时 SQLite + migrate deploy + 模拟 cookie。
// 断言:未登录 401;成功与失败都是 private, no-store;形状;只有本人的持仓与本人 ACTIVE 的场外挂牌(新的在前:createdAt 降序、id 降序);
// 持仓与 GET /api/account/positions 同一份读取;totals 可以由响应里的 balance + positions 用 computeAccountTotals 重算出来;
// change24h 与 loadEquityChange 同一个结果;24 小时变化的计算抛错时总览照常 200,change24h 为 null。
// P2-13:精简模式 ?parts=extras(只有 change24h 与 otcListings,不做成本回放)、每用户限流(总览 30 / 分钟,持仓 120 / 分钟)、
// 同一用户同一模式的并发请求共用一次读取。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeAccountTotals } from "@/shared/account-totals";
import type { AccountOverview, AccountOverviewExtras, OtcListingView } from "@/shared/api-shapes";
import type { Position } from "@/shared/types";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "", enforceRateLimit: false }));

// 显式钉在临时库上,绝不触碰 dev.db
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (testState.cookie ? { value: testState.cookie } : undefined),
    set: (_name: string, value: string) => { testState.cookie = value; },
    delete: () => { testState.cookie = ""; },
  }),
}));

// 限流桶是进程内的、没有清空的入口:除了专测限流的那一组,其余用例放行;限流那一组打开开关,走的是真的 rateLimit / retryAfterSeconds
vi.mock("@/lib/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/rate-limit")>();
  return { ...actual, rateLimit: (key: string, limit: number, windowMs: number) => (testState.enforceRateLimit ? actual.rateLimit(key, limit, windowMs) : true) };
});

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let overviewRoute: typeof import("./overview/route");
let accountOverview: typeof import("@/lib/server/account-overview");
let positionsModule: typeof import("@/lib/server/positions");
let positionsRoute: typeof import("./positions/route");
let equity: typeof import("@/lib/server/equity-change");
let createSession: (typeof import("@/lib/server/auth"))["createSession"];

const ids = {
  assetA: "", assetB: "", assetR: "", assetS: "", assetN: "",
  alice: "", bob: "", carol: "", dave: "",
  aliceActive: "", aliceCancelled: "", aliceSold: "", bobListing: "", bobSecond: "", bobThird: "",
};
/** bob 三条 ACTIVE 挂牌的创建时刻(夹具里写死):bobListing 最早;bobSecond 与 bobThird 晚一分钟、同一毫秒(排序要靠 id 分先后) */
const BOB_LISTED_AT = Date.UTC(2026, 8, 30, 12, 0, 0);

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-overview-")));
  writeFileSync(join(testState.directory, "overview.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "overview.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
  overviewRoute = await import("./overview/route");
  accountOverview = await import("@/lib/server/account-overview");
  positionsModule = await import("@/lib/server/positions");
  positionsRoute = await import("./positions/route");
  equity = await import("@/lib/server/equity-change");
  ({ createSession } = await import("@/lib/server/auth"));
  const matching = await import("@/lib/exchange/matching");
  const otc = await import("@/lib/exchange/otc");
  const { retireCredits } = await import("@/lib/exchange/retirement");

  const asset = (symbol: string, isScenario = false) =>
    prisma.asset.create({ data: { symbol, name: `Test ${symbol}`, standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry", isScenario } });
  const [assetA, assetB, assetR, assetS, assetN] = [await asset("OV-A"), await asset("OV-B"), await asset("OV-R"), await asset("OV-S", true), await asset("OV-N")];
  Object.assign(ids, { assetA: assetA.id, assetB: assetB.id, assetR: assetR.id, assetS: assetS.id, assetN: assetN.id });

  /** 人类用户,赠金连同账本行(与注册 / 演示账号的写法相同) */
  const human = async (name: string, cash = 10_000_000) => {
    const user = await prisma.user.create({ data: { email: `${name}@overview.test`, name, passwordHash: "test", cashBalance: BigInt(cash) } });
    await prisma.ledgerEntry.create({ data: { userId: user.id, account: "CASH", delta: BigInt(cash), reason: "GRANT" } });
    return user.id;
  };
  /** 期初持仓(没有买入成本:成本不完整) */
  const seedHolding = async (userId: string, assetId: string, quantity: number) => {
    await prisma.holding.create({ data: { userId, assetId, quantity } });
    await prisma.ledgerEntry.create({ data: { userId, account: "HOLDING", assetId, delta: BigInt(quantity), reason: "SEED" } });
  };
  const place = (userId: string, assetId: string, side: "BUY" | "SELL", price: number, quantity: number) =>
    matching.placeOrder({ userId, assetId, side, type: "LIMIT", price, quantity });
  /** bob 挂卖、buyer 吃掉 */
  const buyFromBob = async (buyer: string, assetId: string, price: number, quantity: number) => {
    await place(ids.bob, assetId, "SELL", price, quantity);
    await place(buyer, assetId, "BUY", price, quantity);
  };
  const retire = (userId: string, assetId: string, quantity: number, idempotencyKey: string) =>
    retireCredits(userId, { assetId, quantity, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey });

  ids.bob = await human("bob");
  for (const a of [assetA, assetB, assetR, assetS]) await seedHolding(ids.bob, a.id, 1_000);
  ids.alice = await human("alice");
  ids.carol = await human("carol");
  ids.dave = await human("dave");

  // alice:全是买来的(成本完整)。A 分两笔买:1 @1000 + 2 @1001 → 成本 3002、均价四舍五入 1001(均价 × 数量 = 3003,差 1 分)
  await buyFromBob(ids.alice, ids.assetA, 1_000, 1);
  await buyFromBob(ids.alice, ids.assetA, 1_001, 2);
  await buyFromBob(ids.alice, ids.assetB, 2_000, 20);
  await buyFromBob(ids.alice, ids.assetR, 500, 2);
  await buyFromBob(ids.alice, ids.assetS, 300, 4); // 情景标的:估值照算,不算信用吨数
  await retire(ids.alice, ids.assetB, 3, "overview-alice-0001"); // 部分注销
  await retire(ids.alice, ids.assetR, 2, "overview-alice-0002"); // 整仓注销:数量 0、retired 2 的行
  await place(ids.alice, ids.assetA, "BUY", 900, 5); // 留一张买单:冻结现金 4500
  // alice 的场外挂牌:一条 ACTIVE(10 B,被 bob 买走 4 → 剩 6)、一条已撤、一条卖完
  const active = await otc.createListing({ sellerId: ids.alice, assetId: ids.assetB, quantity: 10, pricePerUnit: 2_100, minQuantity: 2 });
  await otc.buyListing(ids.bob, active.id, 4);
  const cancelled = await otc.createListing({ sellerId: ids.alice, assetId: ids.assetB, quantity: 1, pricePerUnit: 2_200 });
  await otc.cancelListing(ids.alice, cancelled.id);
  const sold = await otc.createListing({ sellerId: ids.alice, assetId: ids.assetB, quantity: 1, pricePerUnit: 2_050 });
  await otc.buyListing(ids.bob, sold.id, 1);
  // bob 自己也有一条 ACTIVE 挂牌(不该出现在 alice 的总览里)
  const bobListing = await otc.createListing({ sellerId: ids.bob, assetId: ids.assetA, quantity: 7, pricePerUnit: 1_300 });
  // bob 再挂两条 ACTIVE(总览按 createdAt 降序、id 降序排);创建时刻写死,其中两条同一毫秒
  const bobSecond = await otc.createListing({ sellerId: ids.bob, assetId: ids.assetB, quantity: 3, pricePerUnit: 2_300 });
  const bobThird = await otc.createListing({ sellerId: ids.bob, assetId: ids.assetR, quantity: 2, pricePerUnit: 700 });
  await prisma.otcListing.update({ where: { id: bobListing.id }, data: { createdAt: new Date(BOB_LISTED_AT) } });
  await prisma.otcListing.updateMany({ where: { id: { in: [bobSecond.id, bobThird.id] } }, data: { createdAt: new Date(BOB_LISTED_AT + 60_000) } });
  Object.assign(ids, {
    aliceActive: active.id, aliceCancelled: cancelled.id, aliceSold: sold.id,
    bobListing: bobListing.id, bobSecond: bobSecond.id, bobThird: bobThird.id,
  });

  // carol:买了 5 A;另有期初给的 N(从没成交过,没有价格)
  await buyFromBob(ids.carol, ids.assetA, 1_050, 5);
  await seedHolding(ids.carol, ids.assetN, 8);
  // 收盘:A 最新价 1100(alice 的 3 A 浮盈 298,不是 297)
  await buyFromBob(ids.dave, ids.assetA, 1_100, 1);
  await place(ids.bob, ids.assetA, "BUY", 1_100, 1);
  await place(ids.dave, ids.assetA, "SELL", 1_100, 1); // dave 买 1 卖 1,回到没有持仓(持仓行数量 0、没注销过 → 不在列表里)
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
  testState.enforceRateLimit = false;
});

const overviewRequest = (query = "") => new Request(`http://localhost/api/account/overview${query}`);

async function overviewOf(userId: string): Promise<AccountOverview> {
  await createSession(userId);
  const res = await overviewRoute.GET(overviewRequest());
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.data;
}

describe("GET /api/account/overview", () => {
  it("未登录 → 401 + { ok: false } + private, no-store", async () => {
    const res = await overviewRoute.GET(overviewRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Not logged in" });
  });

  it("形状:balance / positions / totals / change24h / otcListings,没有别的键,也不带用户或内部字段", async () => {
    const data = await overviewOf(ids.alice);
    expect(Object.keys(data).sort()).toEqual(["balance", "change24h", "otcListings", "positions", "totals"]);
    expect(Object.keys(data.totals).sort()).toEqual(["costBasisComplete", "heldCredits", "holdingsValue", "retiredCredits", "totalAssets", "unrealisedPnl", "valuationComplete"]);
    expect(Object.keys(data.change24h!).sort()).toEqual(["amount", "baseline", "pct", "since"]);
    expect(JSON.stringify(data)).not.toMatch(/userId|sellerId|passwordHash|anchorPrice|realClose|email/);
  });

  it("alice:余额、持仓(含整仓注销的行)与合计", async () => {
    const data = await overviewOf(ids.alice);
    // 现金:1000 万 − 3002 − 40000 − 1000 − 1200 − 4500(冻结)+ 8400(场外卖 4 @2100)+ 2050(场外卖 1 @2050)
    expect(data.balance).toEqual({ cashBalance: 9_960_748, lockedCash: 4_500 });
    expect(data.positions.map((p) => [p.symbol, p.quantity, p.retired])).toEqual([["OV-A", 3, 0], ["OV-B", 12, 3], ["OV-R", 0, 2], ["OV-S", 4, 0]]);
    expect(data.positions[1]).toMatchObject({ locked: 6, lockedBy: { orders: 0, otc: 6 }, available: 6 });
    // A 3 × 1100 + B 12 × 2050(最后一次场外成交价)+ S 4 × 300
    expect(data.totals).toEqual({
      holdingsValue: 3_300 + 24_600 + 1_200,
      totalAssets: 9_960_748 + 4_500 + 29_100,
      heldCredits: 15, // 情景标的的 4 个单位不算
      retiredCredits: 5,
      unrealisedPnl: 298 + (24_600 - 24_000) + 0,
      valuationComplete: true,
      costBasisComplete: true,
    });
  });

  it("只有本人 ACTIVE 的场外挂牌:已撤的、卖完的、别人的都不在", async () => {
    const data = await overviewOf(ids.alice);
    expect(data.otcListings).toHaveLength(1);
    const listing: OtcListingView = data.otcListings[0];
    expect(listing).toEqual({ id: ids.aliceActive, assetId: ids.assetB, symbol: "OV-B", quantity: 6, pricePerUnit: 2_100, minQuantity: 2, createdAt: expect.any(Number) });
    expect(Math.abs(Date.now() - listing.createdAt)).toBeLessThan(120_000);

    const bob = await overviewOf(ids.bob);
    expect(bob.otcListings.map((l) => l.id).sort()).toEqual([ids.bobListing, ids.bobSecond, ids.bobThird].sort());
    expect((await overviewOf(ids.dave)).otcListings).toEqual([]);
  });

  it("场外挂牌新的在前:createdAt 降序,同一毫秒的按 id 降序", async () => {
    const bob = await overviewOf(ids.bob);
    const tied = [ids.bobSecond, ids.bobThird].sort().reverse(); // 同一个 createdAt:id 大的在前
    expect(bob.otcListings.map((l) => [l.id, l.createdAt])).toEqual([
      [tied[0], BOB_LISTED_AT + 60_000],
      [tied[1], BOB_LISTED_AT + 60_000],
      [ids.bobListing, BOB_LISTED_AT], // 最早挂的排最后
    ]);
    expect(bob.otcListings.find((l) => l.id === ids.bobSecond)).toMatchObject({ symbol: "OV-B", quantity: 3, pricePerUnit: 2_300, minQuantity: 1 });
  });

  it("别人的数据不可见:每个人的持仓、余额、挂牌都只是自己的", async () => {
    const [alice, carol, dave] = [await overviewOf(ids.alice), await overviewOf(ids.carol), await overviewOf(ids.dave)];
    expect(carol.positions.map((p) => p.symbol)).toEqual(["OV-A", "OV-N"]);
    expect(carol.balance).toEqual({ cashBalance: 10_000_000 - 5_250, lockedCash: 0 });
    expect(dave.positions).toEqual([]);
    expect(dave.balance).toEqual({ cashBalance: 10_000_000, lockedCash: 0 });
    expect(alice.positions.some((p) => p.symbol === "OV-N")).toBe(false);
    // 同一个标的(A)各人是各人的数量
    expect(alice.positions.find((p) => p.symbol === "OV-A")!.quantity).toBe(3);
    expect(carol.positions.find((p) => p.symbol === "OV-A")!.quantity).toBe(5);
  });

  it("没有价格的标的:不计入市值,valuationComplete 为 false,未实现盈亏为 null", async () => {
    const data = await overviewOf(ids.carol);
    expect(data.totals).toEqual({
      holdingsValue: 5 * 1_100, totalAssets: 10_000_000 - 5_250 + 5_500, heldCredits: 13, retiredCredits: 0,
      unrealisedPnl: null, valuationComplete: false, costBasisComplete: false, // N 是期初给的:成本也不完整
    });
    expect(data.change24h).toBeNull(); // 现在持有的标的没有价格 → 算不出
  });

  it("没有持仓的新账户:合计只有现金,24 小时变化是 0 而不是 +10 万美元", async () => {
    const data = await overviewOf(ids.dave);
    expect(data.totals).toEqual({ holdingsValue: 0, totalAssets: 10_000_000, heldCredits: 0, retiredCredits: 0, unrealisedPnl: 0, valuationComplete: true, costBasisComplete: true });
    expect(data.change24h).toMatchObject({ amount: 0, pct: 0, baseline: 10_000_000 });
  });

  it("bob:期初持仓成本不完整 → costBasisComplete 为 false、未实现盈亏为 null;情景标的不算信用吨数", async () => {
    const data = await overviewOf(ids.bob);
    expect(data.totals).toMatchObject({ costBasisComplete: false, unrealisedPnl: null, valuationComplete: true });
    const scenario = data.positions.find((p) => p.symbol === "OV-S")!;
    expect(scenario.isScenario).toBe(true);
    expect(data.totals.heldCredits).toBe(data.positions.filter((p) => !p.isScenario).reduce((sum, p) => sum + p.quantity, 0));
  });

  it("持仓与 GET /api/account/positions 是同一份;totals 可由响应里的 balance + positions 重算", async () => {
    for (const userId of [ids.alice, ids.bob, ids.carol]) {
      const data = await overviewOf(userId);
      const positions = (await (await positionsRoute.GET()).json()).data;
      expect(data.positions).toEqual(positions.positions);
      expect(data.balance).toEqual(positions.balance);
      expect(data.totals).toEqual(computeAccountTotals(data.balance, data.positions as Position[], (p) => p.lastPrice));
    }
  });

  it("change24h 与 loadEquityChange 同一个结果;账户全部历史都在窗口内 → baseline 是赠金,amount 是其余的变化", async () => {
    const data = await overviewOf(ids.alice);
    expect(data.change24h).not.toBeNull();
    const change = data.change24h!;
    expect(change.since % equity.EQUITY_BUCKET_MS).toBe(0);
    expect(Date.now() - change.since).toBeGreaterThanOrEqual(equity.EQUITY_WINDOW_MS);
    expect(Date.now() - change.since).toBeLessThan(equity.EQUITY_WINDOW_MS + equity.EQUITY_BUCKET_MS + 60_000);
    // 同一个基准时刻下重算(since + 24 h 落在同一个 10 分钟桶里)
    expect(await equity.loadEquityChange(prisma, ids.alice, change.since + equity.EQUITY_WINDOW_MS)).toEqual(change);
    // 赠金 1000 万是基准;注销的 3 B 与 2 R 按现价加回(R 最新价 500)
    expect(change.baseline).toBe(10_000_000);
    expect(change.amount).toBe(data.totals.totalAssets + 3 * 2_050 + 2 * 500 - 10_000_000);
    expect(change.pct).toBe(change.amount / 10_000_000);
  });

  it("24 小时变化的计算抛错(T 时刻价格的查询超时 / 忙)不拖垮总览:200,change24h 为 null,其余照常,只记一行不带用户数据的日志", async () => {
    const normal = await overviewOf(ids.alice);
    expect(normal.change24h).not.toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const busy = Object.assign(new Error("Timed out fetching a new connection from the connection pool.\n  (connection limit: 1)"), { name: "PrismaClientKnownRequestError" });
    const replay = vi.spyOn(equity, "equityReplayFrom").mockRejectedValueOnce(busy);
    try {
      const data = await overviewOf(ids.alice); // overviewOf 里断言了 200 与 private, no-store
      expect(replay).toHaveBeenCalledTimes(1);
      expect(data.change24h).toBeNull();
      // 余额、持仓、合计、挂牌与正常那一次逐项相同
      expect({ ...data, change24h: normal.change24h }).toEqual(normal);
      expect(data.positions.length).toBeGreaterThan(0);
      expect(data.otcListings).toHaveLength(1);
      // 一行日志:只有错误的名字与消息(压成一行),没有用户 id,也没走 handle 的 [API ERROR]
      expect(warn.mock.calls).toEqual([
        ["[overview] equity change unavailable", "PrismaClientKnownRequestError: Timed out fetching a new connection from the connection pool. (connection limit: 1)"],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(ids.alice);
      expect(error).not.toHaveBeenCalled();
    } finally {
      replay.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
    // 只是那一次算不出:下一次请求照常给数
    expect((await overviewOf(ids.alice)).change24h).not.toBeNull();
  });
});

async function extrasOf(userId: string): Promise<AccountOverviewExtras> {
  await createSession(userId);
  const res = await overviewRoute.GET(overviewRequest("?parts=extras"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.data;
}

describe("GET /api/account/overview?parts=extras(精简模式,P2-13)", () => {
  it("只有 change24h 与 otcListings,与全量里的同名两项相同(每个人)", async () => {
    for (const userId of [ids.alice, ids.bob, ids.carol, ids.dave]) {
      const [full, extras] = [await overviewOf(userId), await extrasOf(userId)];
      expect(Object.keys(extras).sort()).toEqual(["change24h", "otcListings"]);
      expect(extras).toEqual({ change24h: full.change24h, otcListings: full.otcListings });
    }
    expect((await extrasOf(ids.carol)).change24h).toBeNull(); // 算不出照样是 null
    expect((await extrasOf(ids.alice)).change24h).not.toBeNull();
  });

  it("不做持仓的成本回放:不调 positionReads / positionsFromRows(全量才调)", async () => {
    const reads = vi.spyOn(positionsModule, "positionReads");
    const map = vi.spyOn(positionsModule, "positionsFromRows");
    try {
      await extrasOf(ids.alice);
      expect(reads).not.toHaveBeenCalled();
      expect(map).not.toHaveBeenCalled();
      await overviewOf(ids.alice);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(map).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
      map.mockRestore();
    }
  });

  it("24 小时变化抛错时精简模式同样 200 + change24h null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replay = vi.spyOn(equity, "equityReplayFrom").mockRejectedValueOnce(new Error("busy"));
    try {
      const extras = await extrasOf(ids.alice);
      expect(extras.change24h).toBeNull();
      expect(extras.otcListings).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith("[overview] equity change unavailable", "Error: busy");
    } finally {
      replay.mockRestore();
      warn.mockRestore();
    }
  });

  it("?parts= 空串 = 全量;不认识的值 → 400 + private, no-store;未登录 401", async () => {
    await createSession(ids.alice);
    const empty = await overviewRoute.GET(overviewRequest("?parts="));
    expect(Object.keys((await empty.json()).data).sort()).toEqual(["balance", "change24h", "otcListings", "positions", "totals"]);
    for (const bad of ["?parts=positions", "?parts=EXTRAS", "?parts=extras,totals", "?parts=toString"]) {
      const res = await overviewRoute.GET(overviewRequest(bad));
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await res.json()).toEqual({ ok: false, error: "Invalid parts: must be extras" });
    }
    testState.cookie = "";
    const anon = await overviewRoute.GET(overviewRequest("?parts=extras"));
    expect(anon.status).toBe(401);
    expect(anon.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("同一用户的并发总览请求共用一次读取(single-flight,P2-13)", () => {
  it("同一模式同时到达的请求只读一次、结果相同;结束之后的请求重新读(不缓存)", async () => {
    await createSession(ids.alice);
    const map = vi.spyOn(positionsModule, "positionsFromRows");
    const replay = vi.spyOn(equity, "equityReplayFrom");
    try {
      const full = await Promise.all(Array.from({ length: 5 }, () => overviewRoute.GET(overviewRequest())));
      expect(map).toHaveBeenCalledTimes(1);
      const bodies = await Promise.all(full.map((res) => res.json()));
      expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
      expect(bodies[0].ok).toBe(true);

      replay.mockClear();
      const extras = await Promise.all(Array.from({ length: 4 }, () => overviewRoute.GET(overviewRequest("?parts=extras"))));
      expect(extras.every((res) => res.status === 200)).toBe(true);
      expect(replay).toHaveBeenCalledTimes(1);

      // 全量与精简是两个键:同时到达各读一次
      map.mockClear();
      replay.mockClear();
      await Promise.all([overviewRoute.GET(overviewRequest()), overviewRoute.GET(overviewRequest("?parts=extras"))]);
      expect(map).toHaveBeenCalledTimes(1);
      expect(replay).toHaveBeenCalledTimes(2);

      // 前一次结束之后再来:重新读
      map.mockClear();
      await overviewRoute.GET(overviewRequest());
      await overviewRoute.GET(overviewRequest());
      expect(map).toHaveBeenCalledTimes(2);
      expect(globalThis.__carbadiaSingleFlight?.size ?? 0).toBe(0);
    } finally {
      map.mockRestore();
      replay.mockRestore();
    }
  });

  it("键 = 用户 + 模式:不同用户、不同模式不共用(测试的会话是全局的一个 cookie,并发的两个用户在这里构造不出来,所以核对键)", async () => {
    const singleFlight = await import("@/lib/server/single-flight");
    const spy = vi.spyOn(singleFlight, "singleFlight");
    try {
      for (const userId of [ids.alice, ids.carol]) {
        await createSession(userId);
        await overviewRoute.GET(overviewRequest());
        await overviewRoute.GET(overviewRequest("?parts=extras"));
      }
      expect(spy.mock.calls.map((call) => call[0])).toEqual([
        `overview:${ids.alice}:full`, `overview:${ids.alice}:extras`, `overview:${ids.carol}:full`, `overview:${ids.carol}:extras`,
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("每用户限流(P2-13)", () => {
  /** 一个只在这一组里请求的用户:限流桶是进程内的,别的用例的请求不会算到它头上 */
  const freshUser = async (name: string) =>
    (await prisma.user.create({ data: { email: `${name}@overview.test`, name, passwordHash: "test", cashBalance: BigInt(1_000) } })).id;

  it("总览:每分钟 30 次(全量与精简共用一个桶),第 31 次 429 + Retry-After + private, no-store;别的用户不受影响", async () => {
    testState.enforceRateLimit = true;
    expect(accountOverview.OVERVIEW_RATE_LIMIT).toBe(30);
    const erin = await freshUser("erin-ov");
    await createSession(erin);
    for (let i = 0; i < 30; i++) {
      const res = await overviewRoute.GET(overviewRequest(i % 2 ? "?parts=extras" : ""));
      expect(res.status, String(i)).toBe(200);
    }
    for (const query of ["", "?parts=extras"]) {
      const limited = await overviewRoute.GET(overviewRequest(query));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("Cache-Control")).toBe("private, no-store");
      const retryAfter = Number(limited.headers.get("Retry-After"));
      expect(retryAfter).toBeGreaterThanOrEqual(1);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(await limited.json()).toEqual({ ok: false, error: "Too many requests, please retry later" });
    }
    const frank = await freshUser("frank-ov");
    await createSession(frank);
    expect((await overviewRoute.GET(overviewRequest())).status).toBe(200);
  });

  it("限流在查库之前:超限的请求不调 requireUser(不为注定被拒的请求查用户);没有会话的请求照常 401、不计数", async () => {
    testState.enforceRateLimit = true;
    const auth = await import("@/lib/server/auth");
    const hana = await freshUser("hana-ov");
    await createSession(hana);
    for (let i = 0; i < 30; i++) expect((await overviewRoute.GET(overviewRequest("?parts=extras"))).status).toBe(200);
    const requireUser = vi.spyOn(auth, "requireUser");
    try {
      expect((await overviewRoute.GET(overviewRequest())).status).toBe(429);
      expect(requireUser).not.toHaveBeenCalled();
      testState.cookie = "";
      const anon = await overviewRoute.GET(overviewRequest());
      expect(anon.status).toBe(401);
      expect(requireUser).toHaveBeenCalledTimes(1);
    } finally {
      requireUser.mockRestore();
    }
  });

  it("持仓:每分钟 120 次,第 121 次 429 + Retry-After + private, no-store", async () => {
    testState.enforceRateLimit = true;
    const gina = await freshUser("gina-ov");
    await createSession(gina);
    for (let i = 0; i < 120; i++) expect((await positionsRoute.GET()).status, String(i)).toBe(200);
    const limited = await positionsRoute.GET();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // 与总览不共用桶
    expect((await overviewRoute.GET(overviewRequest())).status).toBe(200);
  });
});
