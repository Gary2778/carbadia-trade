// 经真实路由(临时 SQLite + migrate deploy + 模拟 cookie)验证四个私有账户接口(计划 §3.4 路由表、§3.5 形状):
// 未登录 401、Cache-Control private no-store、成交按本人视角映射(买方 TAKER/BUY、卖方 MAKER/SELL)、成交详情只回本人账本行、
// 非买卖双方 404、disclosure 常量、counterpartyIsBot、订单键集分页 60 条 limit 25 无重复无遗漏、cancelReason 派生、
// 持仓 retired = Retirement 汇总、游标往返与非法值 400。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FILL_DISCLOSURE } from "@/shared/constants";
import type { Fill, Order, Position } from "@/shared/types";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上, 绝不触碰 dev.db
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

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let ordersRoute: typeof import("./orders/route");
let fillsRoute: typeof import("./fills/route");
let fillByIdRoute: typeof import("./fills/[id]/route");
let positionsRoute: typeof import("./positions/route");
let matching: typeof import("@/lib/exchange/matching");
let cursor: typeof import("@/lib/server/cursor");
let createSession: (typeof import("@/lib/server/auth"))["createSession"];

const ids = { assetA: "", assetB: "", alice: "", bob: "", bot: "", carol: "", dave: "", t1: "", t2: "", t3: "", aliceMarket: "", aliceCancelled: "", aliceOpen: "", bobMakerFilled: "", bobOpen: "", erin: "", erinStpBid: "", erinAsk: "" };

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-account-routes-")));
  writeFileSync(join(testState.directory, "account.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "account.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  ordersRoute = await import("./orders/route");
  fillsRoute = await import("./fills/route");
  fillByIdRoute = await import("./fills/[id]/route");
  positionsRoute = await import("./positions/route");
  matching = await import("@/lib/exchange/matching");
  cursor = await import("@/lib/server/cursor");
  ({ createSession } = await import("@/lib/server/auth"));
  const { retireCredits } = await import("@/lib/exchange/retirement");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");

  const assetA = await prisma.asset.create({ data: { symbol: "VCS-TEST-2021", name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" } });
  const assetB = await prisma.asset.create({ data: { symbol: "GS-TEST-2022", name: "Test wind", standard: "GS", projectType: "Wind", vintage: 2022, country: "Example", registry: "Demo registry" } });
  const cash = { passwordHash: "test", cashBalance: BigInt(100_000_000) };
  const alice = await prisma.user.create({ data: { email: "alice@account.test", name: "Alice", ...cash } });
  const bob = await prisma.user.create({ data: { email: "bob@account.test", name: "Bob", ...cash } });
  const bot = await prisma.user.create({ data: { email: "bot@account.test", name: "Bot", isBot: true, ...cash } });
  const carol = await prisma.user.create({ data: { email: "carol@account.test", name: "Carol", ...cash } });
  const dave = await prisma.user.create({ data: { email: "dave@account.test", name: "Dave", ...cash } });
  await prisma.holding.createMany({ data: [
    { userId: bob.id, assetId: assetA.id, quantity: 1_000 },
    { userId: bob.id, assetId: assetB.id, quantity: 100 },
    { userId: bot.id, assetId: assetA.id, quantity: 1_000 },
  ] });
  Object.assign(ids, { assetA: assetA.id, assetB: assetB.id, alice: alice.id, bob: bob.id, bot: bot.id, carol: carol.id, dave: dave.id });

  const place = (userId: string, assetId: string, side: "BUY" | "SELL", type: "LIMIT" | "MARKET", price: number | null, quantity: number) =>
    matching.placeOrder({ userId, assetId, side, type, price, quantity });

  // T1: bob 挂卖 3 @ 9500(maker), alice 市价买 5 → 成交 3, 余量撤销(MARKET_REMAINDER)
  const bobAsk = await place(bob.id, assetA.id, "SELL", "LIMIT", 9_500, 3);
  const aliceMarket = await place(alice.id, assetA.id, "BUY", "MARKET", null, 5);
  ids.t1 = aliceMarket.trades[0].id;
  ids.aliceMarket = aliceMarket.order.id;
  ids.bobMakerFilled = bobAsk.order.id;
  // alice 限价买后主动撤单(USER)
  const cancelled = await place(alice.id, assetA.id, "BUY", "LIMIT", 9_000, 1);
  await matching.cancelOrder(alice.id, cancelled.order.id);
  ids.aliceCancelled = cancelled.order.id;
  // T2: 对手是机器人
  await place(bot.id, assetA.id, "SELL", "LIMIT", 9_600, 2);
  const aliceVsBot = await place(alice.id, assetA.id, "BUY", "LIMIT", 9_600, 2);
  ids.t2 = aliceVsBot.trades[0].id;
  // T3: 另一标的(symbol 筛选)
  await place(bob.id, assetB.id, "SELL", "LIMIT", 5_000, 1);
  const aliceB = await place(alice.id, assetB.id, "BUY", "LIMIT", 5_000, 1);
  ids.t3 = aliceB.trades[0].id;
  // 各留一张挂单: alice 买 1 @ 8000(锁现金 8000), bob 卖 1 @ 20000(锁 1 吨)
  ids.aliceOpen = (await place(alice.id, assetA.id, "BUY", "LIMIT", 8_000, 1)).order.id;
  ids.bobOpen = (await place(bob.id, assetA.id, "SELL", "LIMIT", 20_000, 1)).order.id;
  // bob 注销 4 + 6 吨 A
  const retire = (quantity: number, idempotencyKey: string) => retireCredits(bob.id, { assetId: assetA.id, quantity, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey });
  await retire(4, "account-retire-0001");
  await retire(6, "account-retire-0002");
  // erin: 自成交防护(计划 §9.1 第 41 条)—— 挂买 1 @ 4000,再挂卖 1 @ 3900 会与自己的买单成交 → 买单被撤(SELF_TRADE_UNLOCK),
  // 卖单挂出后她自己撤掉(USER);标的 B 上没有别人的买单,卖单不会成交
  const erin = await prisma.user.create({ data: { email: "erin@account.test", name: "Erin", ...cash } });
  await prisma.holding.create({ data: { userId: erin.id, assetId: assetB.id, quantity: 10 } });
  const erinBid = await place(erin.id, assetB.id, "BUY", "LIMIT", 4_000, 1);
  const erinAsk = await place(erin.id, assetB.id, "SELL", "LIMIT", 3_900, 1);
  await matching.cancelOrder(erin.id, erinAsk.order.id);
  Object.assign(ids, { erin: erin.id, erinStpBid: erinBid.order.id, erinAsk: erinAsk.order.id });
  // dave: 60 张挂单给分页用
  for (let i = 0; i < 60; i++) await place(dave.id, assetA.id, "BUY", "LIMIT", 100 + i, 1);
}, 120_000);

afterAll(async () => {
  await (await import("@/lib/server/order-hooks")).drainOrderHooks(); // 真人成交的通知由提交后钩子写:等它写完再关库
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
});

const url = (path: string) => `http://localhost${path}`;
const getOrders = (query = "") => ordersRoute.GET(new Request(url(`/api/account/orders${query}`)));
const getFills = (query = "") => fillsRoute.GET(new Request(url(`/api/account/fills${query}`)));
const getFill = (id: string) => fillByIdRoute.GET(new Request(url(`/api/account/fills/${id}`)), { params: Promise.resolve({ id }) });
const getPositions = () => positionsRoute.GET();

async function expectPrivateOk(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const json = await res.json();
  expect(json.ok).toBe(true);
  return json.data;
}

async function expectUnauthorised(res: Response) {
  expect(res.status).toBe(401);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  await expect(res.json()).resolves.toEqual({ ok: false, error: "Not logged in" });
}

async function ownLedgerIds(userId: string, tradeId: string) {
  const rows = await prisma.ledgerEntry.findMany({ where: { userId, refType: "TRADE", refId: tradeId }, select: { id: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((row) => row.id);
}

describe("未登录", () => {
  it("四个端点都是 401 + { ok: false } + private, no-store", async () => {
    await expectUnauthorised(await getOrders("?status=open"));
    await expectUnauthorised(await getFills());
    await expectUnauthorised(await getFill(ids.t1));
    await expectUnauthorised(await getPositions());
  });
});

describe("GET /api/account/fills", () => {
  it("买方视角: 全部 side BUY / role TAKER, 倒序, auditRef SIM-TRD-<id>, feeCents 0, ledgerRefs = 本人账本行, 不外露 userId", async () => {
    await createSession(ids.alice);
    const data = await expectPrivateOk(await getFills());
    expect(data.nextCursor).toBeNull();
    const fills: Fill[] = data.fills;
    expect(fills.map((f) => f.id)).toEqual([ids.t3, ids.t2, ids.t1]);
    for (const fill of fills) {
      expect(fill).toMatchObject({ side: "BUY", role: "TAKER", feeCents: 0, auditRef: `SIM-TRD-${fill.id}` });
      expect(typeof fill.ts).toBe("number");
      expect("userId" in fill).toBe(false);
      expect("buyerId" in fill).toBe(false);
    }
    expect(fills[2]).toMatchObject({ orderId: ids.aliceMarket, symbol: "VCS-TEST-2021", price: 9_500, quantity: 3, notional: 28_500 });
    expect(fills[2].ledgerRefs).toEqual(await ownLedgerIds(ids.alice, ids.t1));
    expect(fills[2].ledgerRefs).toHaveLength(2); // 市价买 = CASH 付款 + HOLDING 收货
    expect(fills[0]).toMatchObject({ symbol: "GS-TEST-2022", price: 5_000, quantity: 1 });
  });

  it("卖方视角同一笔成交: side SELL / role MAKER, orderId 取卖单, ledgerRefs 是卖方自己的三行", async () => {
    await createSession(ids.bob);
    const { fills } = await expectPrivateOk(await getFills());
    expect((fills as Fill[]).map((f) => f.id)).toEqual([ids.t3, ids.t1]);
    const t1 = (fills as Fill[])[1];
    expect(t1).toMatchObject({ orderId: ids.bobMakerFilled, side: "SELL", role: "MAKER", price: 9_500, quantity: 3, notional: 28_500 });
    expect(t1.ledgerRefs).toEqual(await ownLedgerIds(ids.bob, ids.t1));
    expect(t1.ledgerRefs).toHaveLength(3); // CASH 收款 + HOLDING 交付 + HOLDING_LOCKED 解锁
    // 对手方的行不在里面
    const aliceRows = await ownLedgerIds(ids.alice, ids.t1);
    expect(t1.ledgerRefs.some((id) => aliceRows.includes(id))).toBe(false);
  });

  it("symbol 筛选; 未知 symbol → 空; limit=1 逐页翻完不重不漏; 非法 cursor / limit → 400", async () => {
    await createSession(ids.alice);
    const filtered = await expectPrivateOk(await getFills("?symbol=GS-TEST-2022"));
    expect((filtered.fills as Fill[]).map((f) => f.id)).toEqual([ids.t3]);
    expect((await expectPrivateOk(await getFills("?symbol=NOPE"))).fills).toEqual([]);

    const seen: string[] = [];
    let next: string | null = null;
    let pages = 0;
    do {
      const page = await expectPrivateOk(await getFills(`?limit=1${next ? `&cursor=${next}` : ""}`));
      expect(page.fills).toHaveLength(1);
      seen.push(page.fills[0].id);
      next = page.nextCursor;
      pages++;
    } while (next);
    expect(pages).toBe(3);
    expect(seen).toEqual([ids.t3, ids.t2, ids.t1]);

    const badCursor = await getFills("?cursor=garbage");
    expect(badCursor.status).toBe(400);
    await expect(badCursor.json()).resolves.toEqual({ ok: false, error: "Invalid cursor" });
    // createdAt 是安全整数但超出 Date 范围:400 而不是 Prisma 校验错 → 500(P1-25b)
    const farFuture = Buffer.from(JSON.stringify({ createdAt: 9_000_000_000_000_000, id: "x" })).toString("base64url");
    for (const res of [await getFills(`?cursor=${farFuture}`), await getOrders(`?status=history&cursor=${farFuture}`)]) {
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ ok: false, error: "Invalid cursor" });
    }
    expect((await getFills("?limit=abc")).status).toBe(400);
  });

  it("没有成交的用户 → 空列表", async () => {
    await createSession(ids.carol);
    expect(await expectPrivateOk(await getFills())).toEqual({ fills: [], nextCursor: null });
  });
});

describe("GET /api/account/fills/[id]", () => {
  it("买方: fill + 本人账本行(CASH −28500, HOLDING +3)+ counterpartyIsBot false + disclosure 常量; ledgerRefs 与 ledger 一致", async () => {
    await createSession(ids.alice);
    const data = await expectPrivateOk(await getFill(ids.t1));
    expect(Object.keys(data).sort()).toEqual(["counterpartyIsBot", "disclosure", "fill", "ledger"]);
    expect(data.disclosure).toBe(FILL_DISCLOSURE);
    expect(data.disclosure).toBe("SIMULATED_TRADE_NOT_REGISTRY_RECORD");
    expect(data.counterpartyIsBot).toBe(false);
    expect(data.fill).toMatchObject({ id: ids.t1, side: "BUY", role: "TAKER", price: 9_500, quantity: 3, auditRef: `SIM-TRD-${ids.t1}` });
    const ledger = data.ledger as { id: string; account: string; delta: number; reason: string; createdAt: number }[];
    expect(ledger.map((l) => [l.account, l.delta, l.reason]).sort()).toEqual([["CASH", -28_500, "TRADE_SETTLE"], ["HOLDING", 3, "TRADE_SETTLE"]]);
    for (const line of ledger) {
      expect(typeof line.createdAt).toBe("number");
      expect(Object.keys(line).sort()).toEqual(["account", "createdAt", "delta", "id", "reason"]);
    }
    expect(data.fill.ledgerRefs).toEqual(ledger.map((l) => l.id));
    expect(ledger.map((l) => l.id)).toEqual(await ownLedgerIds(ids.alice, ids.t1));
  });

  it("卖方看同一笔: side SELL / role MAKER, 账本行是自己的三行(CASH +28500, HOLDING −3, HOLDING_LOCKED −3)", async () => {
    await createSession(ids.bob);
    const data = await expectPrivateOk(await getFill(ids.t1));
    expect(data.fill).toMatchObject({ id: ids.t1, orderId: ids.bobMakerFilled, side: "SELL", role: "MAKER" });
    expect((data.ledger as { account: string; delta: number }[]).map((l) => [l.account, l.delta]).sort()).toEqual([["CASH", 28_500], ["HOLDING", -3], ["HOLDING_LOCKED", -3]]);
    expect(data.counterpartyIsBot).toBe(false);
  });

  it("对手是做市机器人 → counterpartyIsBot true", async () => {
    await createSession(ids.alice);
    const data = await expectPrivateOk(await getFill(ids.t2));
    expect(data.counterpartyIsBot).toBe(true);
    expect(data.fill).toMatchObject({ side: "BUY", role: "TAKER", price: 9_600, quantity: 2 });
  });

  it("非买卖双方 → 404 { ok: false }; 不存在的 id → 404", async () => {
    await createSession(ids.carol);
    const res = await getFill(ids.t1);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Fill not found" });
    expect((await getFill("does-not-exist")).status).toBe(404);
  });
});

describe("GET /api/account/orders", () => {
  it("history: MARKET 余量撤销 → MARKET_REMAINDER, LIMIT 撤单 → USER, 成交单 FILLED 带均价; open 只有挂单; 缺省不筛状态", async () => {
    await createSession(ids.alice);
    const history = await expectPrivateOk(await getOrders("?status=history"));
    const byId = new Map((history.orders as Order[]).map((o) => [o.id, o]));
    expect(byId.get(ids.aliceMarket)).toMatchObject({ type: "MARKET", status: "CANCELLED", cancelReason: "MARKET_REMAINDER", filledQuantity: 3, quantity: 5, avgFillPrice: 9_500, symbol: "VCS-TEST-2021" });
    expect(byId.get(ids.aliceCancelled)).toMatchObject({ type: "LIMIT", status: "CANCELLED", cancelReason: "USER", filledQuantity: 0, avgFillPrice: null });
    expect(byId.has(ids.aliceOpen)).toBe(false);
    for (const order of history.orders as Order[]) {
      expect(["FILLED", "CANCELLED"]).toContain(order.status);
      expect("userId" in order).toBe(false);
      expect(typeof order.createdAt).toBe("number");
      expect(typeof order.updatedAt).toBe("number");
    }
    const filled = (history.orders as Order[]).filter((o) => o.status === "FILLED");
    expect(filled).toHaveLength(2);
    for (const order of filled) expect(order).toMatchObject({ cancelReason: null, avgFillPrice: order.price });

    const open = await expectPrivateOk(await getOrders("?status=open"));
    expect((open.orders as Order[]).map((o) => o.id)).toEqual([ids.aliceOpen]);
    expect(open.orders[0]).toMatchObject({ status: "OPEN", price: 8_000, quantity: 1, cancelReason: null });

    const all = await expectPrivateOk(await getOrders());
    expect(all.orders).toHaveLength(history.orders.length + 1);
  });

  it("history: 自成交防护撤掉的限价单 → SELF_TRADE(从 SELF_TRADE_UNLOCK 流水派生),本人撤的 → USER", async () => {
    await createSession(ids.erin);
    const history = await expectPrivateOk(await getOrders("?status=history"));
    const byId = new Map((history.orders as Order[]).map((o) => [o.id, o]));
    expect(byId.get(ids.erinStpBid)).toMatchObject({ type: "LIMIT", side: "BUY", status: "CANCELLED", cancelReason: "SELF_TRADE", filledQuantity: 0 });
    expect(byId.get(ids.erinAsk)).toMatchObject({ type: "LIMIT", side: "SELL", status: "CANCELLED", cancelReason: "USER", filledQuantity: 0 });
    expect(history.orders).toHaveLength(2);
  });

  it("挂单方成交的均价按实际成交重算(行上是 null): bob 的 maker 卖单 FILLED avgFillPrice 9500; open 里是他的卖单", async () => {
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ids.bobMakerFilled } })).avgFillPrice).toBeNull();
    await createSession(ids.bob);
    const history = await expectPrivateOk(await getOrders("?status=history&symbol=VCS-TEST-2021"));
    expect((history.orders as Order[]).map((o) => o.id)).toEqual([ids.bobMakerFilled]);
    expect(history.orders[0]).toMatchObject({ side: "SELL", status: "FILLED", filledQuantity: 3, avgFillPrice: 9_500 });
    const open = await expectPrivateOk(await getOrders("?status=open"));
    expect((open.orders as Order[]).map((o) => o.id)).toEqual([ids.bobOpen]);
  });

  it("status 非法 → 400(含原型链上的名字); status 空串 = 未传; cursor 非法 → 400; limit 非数字 → 400", async () => {
    await createSession(ids.alice);
    const status = await getOrders("?status=bogus");
    expect(status.status).toBe(400);
    await expect(status.json()).resolves.toEqual({ ok: false, error: "Invalid status" });
    for (const name of ["toString", "constructor", "__proto__", "OPEN"]) expect((await getOrders(`?status=${name}`)).status).toBe(400);
    const blank = await expectPrivateOk(await getOrders("?status="));
    expect(blank.orders.length).toBe((await expectPrivateOk(await getOrders())).orders.length);
    const badCursor = await getOrders("?status=open&cursor=%%%");
    expect(badCursor.status).toBe(400);
    await expect(badCursor.json()).resolves.toEqual({ ok: false, error: "Invalid cursor" });
    expect((await getOrders("?limit=ten")).status).toBe(400);
  });

  it("游标翻页: 60 条 limit 25 → 25 / 25 / 10, 无重复无遗漏, 页内与跨页都严格按 createdAt desc, id desc; 游标往返", async () => {
    await createSession(ids.dave);
    const pages: Order[][] = [];
    let next: string | null = null;
    do {
      const page = await expectPrivateOk(await getOrders(`?status=open&limit=25${next ? `&cursor=${next}` : ""}`));
      pages.push(page.orders);
      if (page.nextCursor) {
        const last = page.orders[page.orders.length - 1];
        expect(cursor.decodeCursor(page.nextCursor)).toEqual({ createdAt: last.createdAt, id: last.id });
      }
      next = page.nextCursor;
    } while (next);
    expect(pages.map((p) => p.length)).toEqual([25, 25, 10]);
    const flat = pages.flat();
    expect(new Set(flat.map((o) => o.id)).size).toBe(60);
    const expected = await prisma.order.findMany({ where: { userId: ids.dave }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    expect(flat.map((o) => o.id)).toEqual(expected.map((o) => o.id));
    for (let i = 1; i < flat.length; i++) {
      const prev = flat[i - 1];
      const curr = flat[i];
      expect(prev.createdAt > curr.createdAt || (prev.createdAt === curr.createdAt && prev.id > curr.id)).toBe(true);
    }

    // limit 夹到 100: 一页拿完, 没有下一页
    const one = await expectPrivateOk(await getOrders("?limit=1000"));
    expect(one.orders).toHaveLength(60);
    expect(one.nextCursor).toBeNull();
  });
});

describe("GET /api/account/positions", () => {
  it("bob: retired = Retirement 汇总(4 + 6), locked 来自挂单(lockedBy.orders), 无账本来源的持仓 costBasisStatus incomplete_ledger, 按 symbol 升序", async () => {
    await createSession(ids.bob);
    const data = await expectPrivateOk(await getPositions());
    expect(Object.keys(data).sort()).toEqual(["balance", "positions"]);
    const positions = data.positions as Position[];
    expect(positions.map((p) => p.symbol)).toEqual(["GS-TEST-2022", "VCS-TEST-2021"]);
    const a = positions[1];
    const retiredSum = await prisma.retirement.aggregate({ where: { userId: ids.bob, assetId: ids.assetA }, _sum: { quantity: true } });
    expect(retiredSum._sum.quantity).toBe(10);
    expect(a).toEqual({
      assetId: ids.assetA, symbol: "VCS-TEST-2021", quantity: 987, locked: 1, lockedBy: { orders: 1, otc: 0 }, available: 986, retired: 10, lastPrice: 9_600, marketValue: 987 * 9_600,
      averagePurchasePrice: null, unrealisedPnl: null, costBasisStatus: "incomplete_ledger", isScenario: false,
    });
    expect(positions[0]).toMatchObject({ assetId: ids.assetB, quantity: 99, locked: 0, available: 99, retired: 0, lastPrice: 5_000 });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.bob } });
    expect(data.balance).toEqual({ cashBalance: Number(user.cashBalance), lockedCash: Number(user.lockedCash) });
    expect(data.balance.cashBalance).toBe(100_000_000 + 28_500 + 5_000);
  });

  it("alice: 买入成本可从账本重建 → complete + 均价 + 浮盈; 情景标的也返回并带 isScenario; 现金 / 冻结与 User 行一致", async () => {
    const scenario = await prisma.asset.create({ data: { symbol: "CEA-SCENARIO", name: "Scenario", standard: "Scenario", projectType: "Index", vintage: 2024, country: "Example", registry: "", isScenario: true, lastPrice: 7_000 } });
    await prisma.holding.create({ data: { userId: ids.alice, assetId: scenario.id, quantity: 7 } });
    await prisma.ledgerEntry.create({ data: { userId: ids.alice, account: "HOLDING", assetId: scenario.id, delta: BigInt(7), reason: "SEED" } });

    await createSession(ids.alice);
    const data = await expectPrivateOk(await getPositions());
    const positions = data.positions as Position[];
    expect(positions.map((p) => p.symbol)).toEqual(["CEA-SCENARIO", "GS-TEST-2022", "VCS-TEST-2021"]);
    expect(positions[2]).toEqual({
      assetId: ids.assetA, symbol: "VCS-TEST-2021", quantity: 5, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 5, retired: 0, lastPrice: 9_600, marketValue: 48_000,
      averagePurchasePrice: 9_540, unrealisedPnl: 300, costBasisStatus: "complete", isScenario: false, // (28500 + 19200) / 5
    });
    expect(positions[1]).toMatchObject({ quantity: 1, averagePurchasePrice: 5_000, unrealisedPnl: 0, costBasisStatus: "complete" });
    expect(positions[0]).toMatchObject({ symbol: "CEA-SCENARIO", isScenario: true, quantity: 7, retired: 0, costBasisStatus: "unknown_acquisition_cost", averagePurchasePrice: null, unrealisedPnl: null, marketValue: 49_000 });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.alice } });
    expect(data.balance).toEqual({ cashBalance: 100_000_000 - 28_500 - 19_200 - 5_000 - 8_000, lockedCash: 8_000 });
    expect(data.balance).toEqual({ cashBalance: Number(user.cashBalance), lockedCash: Number(user.lockedCash) });
  });

  it("没有持仓的用户 → positions [] + 余额", async () => {
    await createSession(ids.carol);
    expect(await expectPrivateOk(await getPositions())).toEqual({ positions: [], balance: { cashBalance: 100_000_000, lockedCash: 0 } });
  });
});

describe("GET /api/account/positions:整仓注销(P1-25b)", () => {
  it("全部注销的持仓仍然返回(quantity 0、retired > 0),卖光且没注销过的不返回", async () => {
    const { retireCredits } = await import("@/lib/exchange/retirement");
    const cash = { passwordHash: "test", cashBalance: BigInt(100_000_000) };
    const fay = await prisma.user.create({ data: { email: "fay@account.test", name: "Fay", ...cash } });
    await prisma.holding.createMany({ data: [
      { userId: fay.id, assetId: ids.assetB, quantity: 5 }, // 全部注销
      { userId: fay.id, assetId: ids.assetA, quantity: 0 }, // 卖光的旧行
    ] });
    await retireCredits(fay.id, { assetId: ids.assetB, quantity: 5, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey: "account-retire-fay-01" });
    expect((await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: fay.id, assetId: ids.assetB } } })).quantity).toBe(0);

    await createSession(fay.id);
    const data = await expectPrivateOk(await getPositions());
    const positions = data.positions as Position[];
    expect(positions.map((p) => p.symbol)).toEqual(["GS-TEST-2022"]);
    expect(positions[0]).toMatchObject({ assetId: ids.assetB, quantity: 0, locked: 0, available: 0, retired: 5, marketValue: 0, averagePurchasePrice: null });
  });
});
