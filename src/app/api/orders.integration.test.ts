// 经真实路由(临时 SQLite + migrate deploy + 模拟 cookie)验证下单 / 撤单接口(计划 §3.4 路由表、§9.1 第 26 条):
// 未登录 401、clientOrderId 重放 200 + replayed、PlaceOrderResponse 形状、按用户限流 60/min 且 429 带 Retry-After;
// 自成交防护(计划 §9.1 第 41 条,EXPIRE_MAKER):selfTradeCancelled 条数、公开盘口不交叉、余额与账本守恒、重放为 0。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上, 绝不触碰 dev.db(生成的 client 可能把 datasource url 内联死, 只靠环境变量不保险)
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

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let orders: typeof import("./orders/route");
let orderById: typeof import("./orders/[id]/route");
let bookRoute: typeof import("./market/[symbol]/book/route");
let transactionsRoute: typeof import("./transactions/route");
let createSession: (typeof import("@/lib/server/auth"))["createSession"];
let assetId: string;
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-orders-route-")));
  writeFileSync(join(testState.directory, "orders.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "orders.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  vi.stubEnv("PROXY_SECRET", undefined); // 无反代密钥: x-forwarded-for 末跳就是限流分桶 IP, 每个用例用自己的 IP
  ({ prisma } = await import("@/lib/server/db"));
  orders = await import("./orders/route");
  orderById = await import("./orders/[id]/route");
  bookRoute = await import("./market/[symbol]/book/route");
  transactionsRoute = await import("./transactions/route");
  ({ createSession } = await import("@/lib/server/auth"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");

  const asset = await prisma.asset.create({
    data: { symbol: "VCS-TEST-2021", name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" },
  });
  const alice = await prisma.user.create({ data: { email: "alice@orders.test", name: "Alice", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  const bob = await prisma.user.create({ data: { email: "bob@orders.test", name: "Bob", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  await prisma.holding.create({ data: { userId: bob.id, assetId: asset.id, quantity: 1_000 } });
  assetId = asset.id;
  aliceId = alice.id;
  bobId = bob.id;
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
});

const CID = "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab";

function post(body: Record<string, unknown>, ip: string) {
  return orders.POST(
    new Request("http://localhost/api/orders", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

function del(id: string, ip: string) {
  return orderById.DELETE(new Request(`http://localhost/api/orders/${id}`, { method: "DELETE", headers: { "x-forwarded-for": ip } }), { params: Promise.resolve({ id }) });
}

const limitBuy = (over: Record<string, unknown> = {}) => ({ assetId, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1, ...over });

function expectRetryAfter(res: Response) {
  expect(res.status).toBe(429);
  const retryAfter = res.headers.get("Retry-After");
  expect(retryAfter).toMatch(/^\d+$/);
  expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  expect(Number(retryAfter)).toBeLessThanOrEqual(60);
}

describe("POST /api/orders", () => {
  it("未登录 → 401, 不落单", async () => {
    const res = await post(limitBuy(), "203.0.113.1");
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Not logged in" });
    expect(await prisma.order.count()).toBe(0);
  });

  it("同一 clientOrderId 两次: 第二次 200 且 replayed true, 同一张单, 冻结只发生一次", async () => {
    await createSession(aliceId);
    const first = await post(limitBuy({ clientOrderId: CID, quantity: 2 }), "203.0.113.2");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const a = (await first.json()).data;
    expect(a.replayed).toBe(false);
    expect(a.order).toMatchObject({ clientOrderId: CID, symbol: "VCS-TEST-2021", side: "BUY", type: "LIMIT", price: 9_000, quantity: 2, filledQuantity: 0, status: "OPEN", cancelReason: null });
    expect(typeof a.order.createdAt).toBe("number");
    expect(typeof a.order.updatedAt).toBe("number");
    expect("userId" in a.order).toBe(false);
    expect(a).toMatchObject({ filledQty: 0, filledCost: 0, fills: [], selfTradeCancelled: 0 });

    const second = await post(limitBuy({ clientOrderId: CID, quantity: 2 }), "203.0.113.2");
    expect(second.status).toBe(200);
    const b = (await second.json()).data;
    expect(b.replayed).toBe(true);
    expect(b.selfTradeCancelled).toBe(0);
    expect(b.order.id).toBe(a.order.id);
    expect(await prisma.order.count({ where: { userId: aliceId, clientOrderId: CID } })).toBe(1);
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: aliceId } })).lockedCash)).toBe(18_000);
  });

  it("成交时 fills 从下单方视角映射: role TAKER, auditRef SIM-TRD-<id>, feeCents 0", async () => {
    await createSession(bobId);
    const ask = await post({ assetId, side: "SELL", type: "LIMIT", price: 9_500, quantity: 3 }, "203.0.113.3");
    expect(ask.status).toBe(200);

    await createSession(aliceId);
    const res = await post({ assetId, side: "BUY", type: "MARKET", price: null, quantity: 5, clientOrderId: "11111111-2222-4333-8444-555555555555" }, "203.0.113.3");
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ filledQty: 3, filledCost: 28_500, replayed: false });
    expect(data.order).toMatchObject({ type: "MARKET", status: "CANCELLED", filledQuantity: 3, cancelReason: "MARKET_REMAINDER", avgFillPrice: 9_500 });
    expect(data.fills).toHaveLength(1);
    expect(data.fills[0]).toMatchObject({ orderId: data.order.id, symbol: "VCS-TEST-2021", side: "BUY", role: "TAKER", price: 9_500, quantity: 3, notional: 28_500, feeCents: 0 });
    expect(data.fills[0].auditRef).toBe(`SIM-TRD-${data.fills[0].id}`);
    // ledgerRefs = 本人(买方)在该成交下的账本行 id(计划 §3.5): 市价买 = CASH 付款 + HOLDING 收货两行, 不含卖方的行
    const mine = await prisma.ledgerEntry.findMany({ where: { userId: aliceId, refType: "TRADE", refId: data.fills[0].id }, select: { id: true, account: true } });
    expect(mine.map((row) => row.account).sort()).toEqual(["CASH", "HOLDING"]);
    expect([...data.fills[0].ledgerRefs].sort()).toEqual(mine.map((row) => row.id).sort());
    expect(await prisma.ledgerEntry.count({ where: { refType: "TRADE", refId: data.fills[0].id } })).toBeGreaterThan(mine.length);
  });

  it("同一 clientOrderId 配不同载荷 → 400, 不下新单", async () => {
    await createSession(aliceId);
    const cid = "22222222-3333-4444-8555-666666666666";
    expect((await post(limitBuy({ clientOrderId: cid, quantity: 2 }), "203.0.113.9")).status).toBe(200);
    const res = await post(limitBuy({ clientOrderId: cid, quantity: 3 }), "203.0.113.9");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "clientOrderId already used with a different order" });
    expect(await prisma.order.count({ where: { userId: aliceId, clientOrderId: cid } })).toBe(1);
  });

  it("clientOrderId 不是 uuid → 400; 业务拒单 → 400 信封", async () => {
    await createSession(aliceId);
    const bad = await post(limitBuy({ clientOrderId: "not-a-uuid" }), "203.0.113.4");
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toEqual({ ok: false, error: "clientOrderId must be a UUID" });
    const poor = await post(limitBuy({ price: 100_000_000, quantity: 11 }), "203.0.113.4");
    expect(poor.status).toBe(400);
    await expect(poor.json()).resolves.toEqual({ ok: false, error: "Order notional exceeds maximum" });
  });

  it("按用户 60/min: 第 61 次 → 429 且 Retry-After 为正整数秒; 另一个用户不受影响", async () => {
    const carol = await prisma.user.create({ data: { email: "carol@orders.test", name: "Carol", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
    await createSession(carol.id);
    for (let i = 0; i < 60; i++) expect((await post(limitBuy(), "203.0.113.5")).status).toBe(200);
    const res = await post(limitBuy(), "203.0.113.5");
    expectRetryAfter(res);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Too many requests, please retry later" });
    expect(await prisma.order.count({ where: { userId: carol.id } })).toBe(60);

    await createSession(aliceId);
    expect((await post(limitBuy(), "203.0.113.5")).status).toBe(200);
  });
});

describe("POST /api/orders 自成交防护(EXPIRE_MAKER,计划 §9.1 第 41 条)", () => {
  it("A 卖 5@70.83、B 卖 3@71.00, A 买 5@71.40 → selfTradeCancelled 1, 与 B 成交 3@71.00, 剩 2 挂 71.40; 公开盘口买一 < 卖一; 余额与账本守恒; 重放为 0", async () => {
    const asset = await prisma.asset.create({
      data: { symbol: "VCS-STP-2021", name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" },
    });
    const erin = await prisma.user.create({ data: { email: "erin@orders.test", name: "Erin", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
    const frank = await prisma.user.create({ data: { email: "frank@orders.test", name: "Frank", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
    await prisma.holding.createMany({ data: [{ userId: erin.id, assetId: asset.id, quantity: 100 }, { userId: frank.id, assetId: asset.id, quantity: 100 }] });
    const users = [erin.id, frank.id];
    // 两人的现金总额(可用 + 冻结)与该标的持仓总量:撮合只转移、不创造
    const totals = async () => {
      const rows = await prisma.user.findMany({ where: { id: { in: users } } });
      const holdings = await prisma.holding.findMany({ where: { assetId: asset.id, userId: { in: users } } });
      return { cash: rows.reduce((sum, u) => sum + Number(u.cashBalance) + Number(u.lockedCash), 0), qty: holdings.reduce((sum, h) => sum + h.quantity, 0) };
    };
    const before = await totals();
    const ip = "203.0.113.20";

    await createSession(erin.id);
    const own = (await (await post({ assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_083, quantity: 5 }, ip)).json()).data;
    expect(own.selfTradeCancelled).toBe(0);
    await createSession(frank.id);
    expect((await post({ assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_100, quantity: 3 }, ip)).status).toBe(200);
    expect((await post({ assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_200, quantity: 2 }, ip)).status).toBe(200);

    await createSession(erin.id);
    const body = { assetId: asset.id, side: "BUY", type: "LIMIT", price: 7_140, quantity: 5, clientOrderId: "33333333-4444-4555-8666-777777777777" };
    const res = await post(body, ip);
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data).toMatchObject({ selfTradeCancelled: 1, replayed: false, filledQty: 3, filledCost: 21_300 });
    expect(data.order).toMatchObject({ side: "BUY", price: 7_140, quantity: 5, filledQuantity: 3, status: "PARTIAL" });
    expect(data.fills.map((f: { price: number; quantity: number; role: string }) => [f.price, f.quantity, f.role])).toEqual([[7_100, 3, "TAKER"]]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: own.order.id } })).toMatchObject({ status: "CANCELLED", filledQuantity: 0 });
    expect(await prisma.trade.count({ where: { buyerId: erin.id, sellerId: erin.id } })).toBe(0);

    // 公开盘口(终端的轮询降级与 WS 快照同形):买一 71.40 < 卖一 72.00
    const bookRes = await bookRoute.GET(new Request("http://localhost/api/market/VCS-STP-2021/book"), { params: Promise.resolve({ symbol: "VCS-STP-2021" }) });
    expect(bookRes.status).toBe(200);
    const book = (await bookRes.json()).data;
    expect(book.bids).toEqual([{ price: 7_140, quantity: 2, orders: 1 }]);
    expect(book.asks).toEqual([{ price: 7_200, quantity: 2, orders: 1 }]);
    expect(book.bids[0].price).toBeLessThan(book.asks[0].price);

    // 守恒:现金总额与持仓总量不变;账本对账(建用户时直接写列、不记流水,所以比的是「列 − 初始值」,两个冻结列从 0 起)
    expect(await totals()).toEqual(before);
    const ledgerSum = async (userId: string, account: string) =>
      (await prisma.ledgerEntry.findMany({ where: { userId, account }, select: { delta: true } })).reduce((sum, row) => sum + Number(row.delta), 0);
    for (const userId of users) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId, assetId: asset.id } } });
      expect(await ledgerSum(userId, "CASH")).toBe(Number(user.cashBalance) - 100_000_000);
      expect(await ledgerSum(userId, "CASH_LOCKED")).toBe(Number(user.lockedCash));
      expect(await ledgerSum(userId, "HOLDING")).toBe(holding.quantity - 100);
      expect(await ledgerSum(userId, "HOLDING_LOCKED")).toBe(holding.locked);
    }
    const erinHolding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: erin.id, assetId: asset.id } } });
    expect([erinHolding.quantity, erinHolding.locked]).toEqual([103, 0]); // 被撤卖单的 5 吨解冻
    expect(await prisma.ledgerEntry.count({ where: { refType: "ORDER", refId: own.order.id, reason: "SELF_TRADE_UNLOCK" } })).toBe(1);
    // 资产流水里它是一条 RELEASE,标签点明是自成交防护
    const activity = (await (await transactionsRoute.GET(new Request("http://localhost/api/transactions?limit=100"))).json()).data.entries;
    expect(activity.filter((e: { reason: string }) => e.reason === "SELF_TRADE_UNLOCK").map((e: { type: string; label: string; delta: number; refId: string }) => [e.type, e.label, e.delta, e.refId]))
      .toEqual([["RELEASE", "Credits released (self-trade prevention)", -5, own.order.id]]);

    // 幂等重放:同一张单, replayed true, selfTradeCancelled 0, 不再动账
    const ledgerRows = await prisma.ledgerEntry.count();
    const replay = await post(body, ip);
    expect(replay.status).toBe(200);
    const again = (await replay.json()).data;
    expect(again).toMatchObject({ replayed: true, selfTradeCancelled: 0, order: { id: data.order.id } });
    expect(await prisma.ledgerEntry.count()).toBe(ledgerRows);
  });
});

describe("DELETE /api/orders/[id]", () => {
  it("未登录 → 401", async () => {
    expect((await del("nothing", "203.0.113.6")).status).toBe(401);
  });

  it("撤单返回 { order }, LIMIT 撤单的 cancelReason 为 USER; 撤别人的单 400", async () => {
    await createSession(aliceId);
    const placed = (await (await post(limitBuy({ quantity: 3 }), "203.0.113.7")).json()).data;
    await createSession(bobId);
    expect((await del(placed.order.id, "203.0.113.7")).status).toBe(400);

    await createSession(aliceId);
    const res = await del(placed.order.id, "203.0.113.7");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { data } = await res.json();
    expect(Object.keys(data)).toEqual(["order"]);
    expect(data.order).toMatchObject({ id: placed.order.id, symbol: "VCS-TEST-2021", status: "CANCELLED", cancelReason: "USER", filledQuantity: 0 });
  });

  it("按用户 60/min: 第 61 次撤单 → 429 且带 Retry-After", async () => {
    const dave = await prisma.user.create({ data: { email: "dave@orders.test", name: "Dave", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
    await createSession(dave.id);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push((await (await post(limitBuy(), "203.0.113.8")).json()).data.order.id);
    for (const id of ids) expect((await del(id, "203.0.113.8")).status).toBe(200);
    const res = await del(ids[0], "203.0.113.8");
    expectRetryAfter(res);
    expect(await prisma.order.count({ where: { userId: dave.id, status: "CANCELLED" } })).toBe(60);
  });
});

describe("POST /api/orders 输入边界(P1-25b)", () => {
  let ginaId = "";
  const gina = async () => {
    if (!ginaId) {
      ginaId = (await prisma.user.create({ data: { email: "gina@orders.test", name: "Gina", passwordHash: "test", cashBalance: BigInt(100_000_000) } })).id;
    }
    await createSession(ginaId);
    return ginaId;
  };

  it("数量上限对 MARKET 与 LIMIT 一样(= MAX_ORDER_QUANTITY,即 1 分价格下的名义额上限):超出 → 400 而不是 INT 列溢出的 500", async () => {
    const { MAX_ORDER_QUANTITY } = await import("@/lib/exchange/matching");
    const { MAX_NOTIONAL_CENTS } = await import("@/lib/exchange/limits");
    expect(MAX_ORDER_QUANTITY).toBe(MAX_NOTIONAL_CENTS);
    expect(MAX_ORDER_QUANTITY).toBeLessThanOrEqual(2_147_483_647); // SQLite INT 列 / Prisma Int 是 32 位
    const userId = await gina();
    for (const body of [
      { assetId, side: "BUY", type: "MARKET", quantity: 3_000_000_000 },
      { assetId, side: "SELL", type: "MARKET", quantity: MAX_ORDER_QUANTITY + 1 },
      limitBuy({ price: 1, quantity: MAX_ORDER_QUANTITY + 1 }),
    ]) {
      const res = await post(body, "203.0.113.30");
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ ok: false, error: "Quantity exceeds maximum" });
    }
    // 上限本身过得了校验,落到业务规则(没有持仓)
    const atCap = await post({ assetId, side: "SELL", type: "MARKET", quantity: MAX_ORDER_QUANTITY }, "203.0.113.30");
    expect(atCap.status).toBe(400);
    await expect(atCap.json()).resolves.toEqual({ ok: false, error: "Insufficient available holdings" });
    expect(await prisma.order.count({ where: { userId } })).toBe(0);
  });

  it("撮合入口自己也挡(机器人等不经路由的调用方):MARKET 3e9 → TradingError,不是 P2023", async () => {
    const { placeOrderTx, TradingError } = await import("@/lib/exchange/matching");
    const userId = await gina();
    const err = await placeOrderTx({ userId, assetId, side: "BUY", type: "MARKET", quantity: 3_000_000_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TradingError);
    expect((err as Error).message).toBe("Quantity exceeds maximum");
  });

  it("MARKET 单忽略客户端传来的 price:落库与响应都是 null;同一 clientOrderId 换个 price 重放仍算同一单", async () => {
    const userId = await gina();
    const cid = "33333333-4444-4555-8666-777777777777";
    const res = await post({ assetId, side: "BUY", type: "MARKET", price: 123_456, quantity: 1, clientOrderId: cid }, "203.0.113.31");
    expect(res.status).toBe(200);
    const first = (await res.json()).data;
    expect(first.order).toMatchObject({ type: "MARKET", price: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).price).toBeNull();
    const replay = await post({ assetId, side: "BUY", type: "MARKET", price: 1, quantity: 1, clientOrderId: cid }, "203.0.113.31");
    expect(replay.status).toBe(200);
    const again = (await replay.json()).data;
    expect(again).toMatchObject({ replayed: true });
    expect(again.order.id).toBe(first.order.id);
    expect(await prisma.order.count({ where: { userId, clientOrderId: cid } })).toBe(1);
  });
});
