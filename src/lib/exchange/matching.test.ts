import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 独立测试库,绝不触碰 dev.db。ESM 静态 import 会被提升到设置 env 之前执行,
// 因此 matching 必须等测试库就位后再动态加载(见 beforeAll)
const DB_FILE = fileURLToPath(new URL("../../../prisma/test-matching.db", import.meta.url));
const DB_URL = `file:${DB_FILE}`;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// 不能只依赖 DATABASE_URL 环境变量: 生成的 client 可能在生成时把 datasource url
// 内联死(fromEnvVar: null),届时环境变量会被无声忽略、测试直接写进 dev.db。
// 这里整体替换 db 模块,用 datasourceUrl 把连接显式钉在测试库上。
vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  const { fileURLToPath: toPath } = await import("node:url");
  const url = `file:${toPath(new URL("../../../prisma/test-matching.db", import.meta.url))}`;
  return { prisma: new PrismaClient({ datasourceUrl: url, log: ["error"] }) };
});

// 发布器存根换成 spy:断言事务提交后(且只有提交后)结果被交给 publishOrderResult
vi.mock("../server/market-publisher", () => ({ publishOrderResult: vi.fn() }));
// 提交后钩子(成交通知)同理:这里只断言它在发布器之后拿到同一份结果,通知本身见 order-hooks.integration.test.ts
vi.mock("../server/order-hooks", () => ({ afterOrderCommit: vi.fn() }));

type DbModule = typeof import("../server/db");
type MatchingModule = typeof import("./matching");

let prisma: DbModule["prisma"];
let matching: MatchingModule;
let publishOrderResult: ReturnType<typeof vi.fn>;
let afterOrderCommit: ReturnType<typeof vi.fn>;

// SQLite 主文件之外还可能有日志/WAL 附属文件,一并清理才算干净
const wipeDbFiles = () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(DB_FILE + suffix, { force: true });
};

beforeAll(async () => {
  wipeDbFiles();
  process.env.DATABASE_URL = DB_URL;
  // CLI 侧 schema.prisma 用 env("DATABASE_URL"),显式传 env 建出测试库表结构
  execSync("npx prisma migrate deploy", {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "pipe",
  });
  matching = await import("./matching");
  ({ prisma } = await import("../server/db"));
  ({ publishOrderResult } = (await import("../server/market-publisher")) as unknown as { publishOrderResult: ReturnType<typeof vi.fn> });
  ({ afterOrderCommit } = (await import("../server/order-hooks")) as unknown as { afterOrderCommit: ReturnType<typeof vi.fn> });

  // 保险丝: 确认连的是测试库再继续,防止清库语句误伤 dev.db
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.endsWith("test-matching.db")) {
    throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
  }
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  wipeDbFiles();
});

// ---- 初始注资/发放台账: 守恒不变量的对账基准 ----
let initialCashTotal = 0;
const initialQtyByAsset = new Map<string, number>();

beforeEach(async () => {
  // 按外键依赖顺序清空(子表在前),避免约束报错
  await prisma.trade.deleteMany();
  await prisma.otcDeal.deleteMany();
  await prisma.order.deleteMany();
  await prisma.otcListing.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.user.deleteMany();
  await prisma.asset.deleteMany();
  initialCashTotal = 0;
  initialQtyByAsset.clear();
  publishOrderResult.mockClear();
  afterOrderCommit.mockClear();
});

async function fundUser(name: string, cash: number) {
  initialCashTotal += cash;
  return prisma.user.create({
    data: { email: `${name}@invariant.test`, name, passwordHash: "test", cashBalance: BigInt(cash) },
  });
}

async function createAsset(symbol = "VCS-TEST-2021") {
  return prisma.asset.create({
    data: {
      symbol,
      name: "测试林业碳汇项目",
      standard: "VCS",
      projectType: "林业碳汇",
      vintage: 2021,
      country: "中国",
      registry: "Verra",
    },
  });
}

async function grantHolding(userId: string, assetId: string, quantity: number) {
  initialQtyByAsset.set(assetId, (initialQtyByAsset.get(assetId) ?? 0) + quantity);
  await prisma.holding.create({ data: { userId, assetId, quantity } });
}

/**
 * 资金/持仓守恒不变量 —— 撮合只转移、不创造:
 * ① 全体用户 Σ(cashBalance + lockedCash) 恒等于初始注资总额
 * ② 每个标的 Σholding.quantity 恒等于初始发放总量
 * ③ 每个用户 lockedCash ≈ 其 OPEN/PARTIAL 限价买单 Σ(price × 未成交量)
 * ④ 每个用户每标的 holding.locked = 开口卖单余量 + ACTIVE OTC 挂牌余量
 */
async function expectInvariants() {
  const users = await prisma.user.findMany();
  const holdings = await prisma.holding.findMany();
  const openOrders = await prisma.order.findMany({ where: { status: { in: ["OPEN", "PARTIAL"] } } });
  const activeListings = await prisma.otcListing.findMany({ where: { status: "ACTIVE" } });

  const totalCash = users.reduce((sum, u) => sum + Number(u.cashBalance) + Number(u.lockedCash), 0);
  expect(totalCash).toBe(initialCashTotal);

  const qtyByAsset = new Map<string, number>();
  for (const h of holdings) qtyByAsset.set(h.assetId, (qtyByAsset.get(h.assetId) ?? 0) + h.quantity);
  for (const assetId of new Set([...initialQtyByAsset.keys(), ...qtyByAsset.keys()])) {
    expect(qtyByAsset.get(assetId) ?? 0).toBe(initialQtyByAsset.get(assetId) ?? 0);
  }

  for (const u of users) {
    const expectedLocked = openOrders
      .filter((o) => o.userId === u.id && o.side === "BUY" && o.price != null)
      .reduce((sum, o) => sum + (o.price ?? 0) * (o.quantity - o.filledQuantity), 0);
    expect(Number(u.lockedCash)).toBe(expectedLocked);
  }

  for (const h of holdings) {
    const sellRemaining = openOrders
      .filter((o) => o.userId === h.userId && o.assetId === h.assetId && o.side === "SELL")
      .reduce((sum, o) => sum + (o.quantity - o.filledQuantity), 0);
    const otcRemaining = activeListings
      .filter((l) => l.sellerId === h.userId && l.assetId === h.assetId)
      .reduce((sum, l) => sum + l.quantity, 0);
    expect(h.locked).toBe(sellRemaining + otcRemaining);
  }
}

/** 标准盘面: alice 纯现金买家, bob 现金 + 持仓卖家(金额一律整数分) */
async function setupMarket() {
  const asset = await createAsset();
  const alice = await fundUser("alice", 10_000_000);
  const bob = await fundUser("bob", 10_000_000);
  await grantHolding(bob.id, asset.id, 1_000);
  return { asset, alice, bob };
}

describe("撮合引擎 — 资金守恒不变量", () => {
  it("限价单全部成交: 现金与持仓双向清算", async () => {
    const { asset, alice, bob } = await setupMarket();

    const sell = await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 50,
    });
    expect(sell.order.status).toBe("OPEN");
    await expectInvariants();

    const buy = await matching.placeOrder({
      userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 50,
    });
    expect(buy.order.status).toBe("FILLED");
    expect(buy.filledQty).toBe(50);
    await expectInvariants();

    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.cashBalance)).toBe(9_500_000);
    expect(Number(aliceAfter.lockedCash)).toBe(0);
    const bobAfter = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(Number(bobAfter.cashBalance)).toBe(10_500_000);

    const aliceHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: alice.id, assetId: asset.id } },
    });
    expect(aliceHolding.quantity).toBe(50);
    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.quantity).toBe(950);
    expect(bobHolding.locked).toBe(0);

    const maker = await prisma.order.findUniqueOrThrow({ where: { id: sell.order.id } });
    expect(maker.status).toBe("FILLED");
    const trades = await prisma.trade.findMany();
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ price: 10_000, quantity: 50, buyerId: alice.id, sellerId: bob.id });
    const assetAfter = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(assetAfter.lastPrice).toBe(10_000);
  });

  it("限价买部分成交: 余量挂簿且冻结与订单簿一致", async () => {
    const { asset, alice, bob } = await setupMarket();

    await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 30,
    });
    await expectInvariants();

    const buy = await matching.placeOrder({
      userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 50,
    });
    expect(buy.order.status).toBe("PARTIAL");
    expect(buy.filledQty).toBe(30);
    await expectInvariants();

    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.cashBalance)).toBe(9_500_000);
    expect(Number(aliceAfter.lockedCash)).toBe(200_000); // 10_000 分 × 未成交 20

    const book = await matching.getOrderBook(asset.id);
    expect(book.bids).toEqual([{ price: 10_000, quantity: 20, orders: 1 }]);
    expect(book.asks).toEqual([]);
  });

  it("taker 限价买价格改善: 按成交价扣款并退还冻结差价", async () => {
    const { asset, alice, bob } = await setupMarket();

    await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_500, quantity: 40,
    });
    await expectInvariants();

    const buy = await matching.placeOrder({
      userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 40,
    });
    expect(buy.order.status).toBe("FILLED");
    expect(buy.order.avgFillPrice).toBe(9_500);
    await expectInvariants();

    // 冻结 10000×40=400000,按 9500 成交只花 380000,差价 20000 分必须回到可用现金
    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.cashBalance)).toBe(9_620_000);
    expect(Number(aliceAfter.lockedCash)).toBe(0);
    const bobAfter = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(Number(bobAfter.cashBalance)).toBe(10_380_000);
  });

  it("市价买受可用现金约束: 买得起多少成交多少, 余量撤销", async () => {
    const { asset, bob } = await setupMarket();
    const charlie = await fundUser("charlie", 27_500);

    await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 5_000, quantity: 100,
    });
    await expectInvariants();

    const buy = await matching.placeOrder({
      userId: charlie.id, assetId: asset.id, side: "BUY", type: "MARKET", quantity: 10,
    });
    // 27500 分按 5000 分/吨只买得起 5 吨,剩余委托量随市价单一并撤销
    expect(buy.filledQty).toBe(5);
    expect(buy.order.status).toBe("CANCELLED");
    await expectInvariants();

    const charlieAfter = await prisma.user.findUniqueOrThrow({ where: { id: charlie.id } });
    expect(Number(charlieAfter.cashBalance)).toBe(2_500);
    const charlieHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: charlie.id, assetId: asset.id } },
    });
    expect(charlieHolding.quantity).toBe(5);
    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.locked).toBe(95); // 卖单余量仍在簿上冻结
  });

  it("市价卖吃完对手盘: 余量撤销并解冻持仓", async () => {
    const { asset, alice, bob } = await setupMarket();

    await matching.placeOrder({
      userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 10,
    });
    await expectInvariants();

    const sell = await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "MARKET", quantity: 25,
    });
    expect(sell.filledQty).toBe(10);
    expect(sell.order.status).toBe("CANCELLED");
    await expectInvariants();

    const bobAfter = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(Number(bobAfter.cashBalance)).toBe(10_100_000);
    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.quantity).toBe(990);
    expect(bobHolding.locked).toBe(0); // 未成交的 15 吨必须解冻
    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.lockedCash)).toBe(0);
  });

  it("撤销部分成交买单: 只退未成交部分的冻结现金", async () => {
    const { asset, alice, bob } = await setupMarket();

    await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 8_000, quantity: 5,
    });
    const buy = await matching.placeOrder({
      userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 8_000, quantity: 20,
    });
    expect(buy.order.status).toBe("PARTIAL");
    await expectInvariants();

    await matching.cancelOrder(alice.id, buy.order.id);
    await expectInvariants();

    // 已成交 5 吨花 40000 分,未成交 15 吨的 120000 分冻结应全额退回
    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.cashBalance)).toBe(9_960_000);
    expect(Number(aliceAfter.lockedCash)).toBe(0);

    // 已撤销订单不可重复撤销
    await expect(matching.cancelOrder(alice.id, buy.order.id)).rejects.toThrow(matching.TradingError);
    await expectInvariants();
  });

  it("撤销卖单: 解冻持仓, 且不能撤别人的单", async () => {
    const { asset, alice, bob } = await setupMarket();

    const sell = await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 20,
    });
    await expectInvariants();

    await expect(matching.cancelOrder(alice.id, sell.order.id)).rejects.toThrow(matching.TradingError);
    await expectInvariants();

    await matching.cancelOrder(bob.id, sell.order.id);
    await expectInvariants();

    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.quantity).toBe(1_000);
    expect(bobHolding.locked).toBe(0);
  });

  it("防自成交: 同一用户的对手单不撮合, 而是撤掉那张旧挂单(EXPIRE_MAKER), 盘口不交叉", async () => {
    const { asset, bob } = await setupMarket();

    const sell = await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 10,
    });
    const buy = await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 10,
    });
    // 价格交叉且同属 bob: 不成交; bob 的旧卖单被撤、持仓解冻, 新买单挂簿
    expect(buy.filledQty).toBe(0);
    expect(buy.order.status).toBe("OPEN");
    expect(buy.selfTradeCancelled).toBe(1);
    expect(await prisma.trade.count()).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: sell.order.id } })).status).toBe("CANCELLED");
    await expectInvariants();

    const bobAfter = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(Number(bobAfter.lockedCash)).toBe(100_000);
    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.locked).toBe(0);
    expect(await matching.getOrderBook(asset.id)).toEqual({ bids: [{ price: 10_000, quantity: 10, orders: 1 }], asks: [] });
  });

  it("非法输入与资源不足: 抛 TradingError 且状态不变", async () => {
    const { asset, alice, bob } = await setupMarket();
    const base = { userId: alice.id, assetId: asset.id } as const;

    // 数量非法
    await expect(
      matching.placeOrder({ ...base, side: "BUY", type: "LIMIT", price: 10_000, quantity: 0 }),
    ).rejects.toThrow(matching.TradingError);
    await expect(
      matching.placeOrder({ ...base, side: "BUY", type: "LIMIT", price: 10_000, quantity: -3 }),
    ).rejects.toThrow(matching.TradingError);
    // 限价单价格非法
    await expect(
      matching.placeOrder({ ...base, side: "BUY", type: "LIMIT", quantity: 10 }),
    ).rejects.toThrow(matching.TradingError);
    await expect(
      matching.placeOrder({ ...base, side: "BUY", type: "LIMIT", price: 0, quantity: 10 }),
    ).rejects.toThrow(matching.TradingError);
    await expect(
      matching.placeOrder({ ...base, side: "SELL", type: "LIMIT", price: -500, quantity: 10 }),
    ).rejects.toThrow(matching.TradingError);
    // 现金不足 / 持仓不足
    await expect(
      matching.placeOrder({ ...base, side: "BUY", type: "LIMIT", price: 30_000, quantity: 1_000 }),
    ).rejects.toThrow(matching.TradingError);
    await expect(
      matching.placeOrder({ ...base, side: "SELL", type: "LIMIT", price: 10_000, quantity: 1 }),
    ).rejects.toThrow(matching.TradingError);
    await expect(
      matching.placeOrder({
        userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 2_000,
      }),
    ).rejects.toThrow(matching.TradingError);
    // 标的不存在
    await expect(
      matching.placeOrder({ userId: alice.id, assetId: "no-such-asset", side: "BUY", type: "LIMIT", price: 10_000, quantity: 1 }),
    ).rejects.toThrow(matching.TradingError);

    // 全部被拒后,资金与持仓必须原封不动
    await expectInvariants();
    expect(await prisma.order.count()).toBe(0);
  });

  it("价格必须是整数分", async () => {
    const { asset, alice } = await setupMarket();
    await expect(
      matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 100.5, quantity: 1 }),
    ).rejects.toThrow(/integer/i);
  });

  it("超过单笔名义额上限拒单", async () => {
    const { asset, alice } = await setupMarket();
    await expect(
      matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 100_000_000, quantity: 11 }),
    ).rejects.toThrow(/notional/i);
  });
});

// ---- 自成交防护的辅助 ----

/** 某用户某账户的流水合计(beforeEach 不清流水表,但每个用例的用户都是新建的,按 userId 过滤即只含本用例) */
async function ledgerDelta(userId: string, account: string, assetId?: string) {
  const rows = await prisma.ledgerEntry.findMany({ where: { userId, account, ...(assetId ? { assetId } : {}) }, select: { delta: true } });
  return rows.reduce((sum, r) => sum + Number(r.delta), 0);
}

/** 账本与列对账:fundUser / grantHolding 直接写列、不记流水,所以比的是「列 − 初始值」;两个冻结列从 0 起,流水合计必须等于列值 */
async function expectLedgerReconciles(userId: string, initialCash: number, assetId: string, initialQty: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  expect(await ledgerDelta(userId, "CASH")).toBe(Number(user.cashBalance) - initialCash);
  expect(await ledgerDelta(userId, "CASH_LOCKED")).toBe(Number(user.lockedCash));
  const holding = await prisma.holding.findUnique({ where: { userId_assetId: { userId, assetId } } });
  expect(await ledgerDelta(userId, "HOLDING", assetId)).toBe((holding?.quantity ?? 0) - initialQty);
  expect(await ledgerDelta(userId, "HOLDING_LOCKED", assetId)).toBe(holding?.locked ?? 0);
}

/** 盘口不交叉:两侧都有挂单时买一 < 卖一 */
async function expectUncrossed(assetId: string) {
  const { bids, asks } = await matching.getOrderBook(assetId);
  if (bids.length > 0 && asks.length > 0) expect(bids[0].price).toBeLessThan(asks[0].price);
}

/** 挂在某张订单上的流水(冻结 / 解冻都以订单为 ref) */
const orderLedger = (orderId: string) =>
  prisma.ledgerEntry.findMany({ where: { refType: "ORDER", refId: orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { account: true, delta: true, reason: true } });

const selfTrades = (userId: string) => prisma.trade.count({ where: { buyerId: userId, sellerId: userId } });

describe("自成交防护 EXPIRE_MAKER(计划 §9.1 第 41 条)", () => {
  it("A 卖 5@70.83、B 卖 3@71.00, A 买 5@71.40 → A 的卖单被撤(释放持仓), 与 B 成交 3@71.00, 剩 2 挂 71.40, 盘口不交叉", async () => {
    const asset = await createAsset();
    const a = await fundUser("a", 10_000_000);
    const b = await fundUser("b", 10_000_000);
    await grantHolding(a.id, asset.id, 100);
    await grantHolding(b.id, asset.id, 100);

    const own = await matching.placeOrder({ userId: a.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_083, quantity: 5 });
    const other = await matching.placeOrder({ userId: b.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_100, quantity: 3 });
    const input = { userId: a.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 7_140, quantity: 5, clientOrderId: "7a0c3a4e-1b2d-4e5f-8a9b-0c1d2e3f4a5b" };
    const buy = await matching.placeOrder(input);

    expect(buy.selfTradeCancelled).toBe(1);
    expect(buy.order).toMatchObject({ status: "PARTIAL", filledQuantity: 3 });
    expect(buy).toMatchObject({ filledQty: 3, filledCost: 21_300, replayed: false });
    expect(buy.trades.map((t) => [t.price, t.quantity, t.buyerId, t.sellerId])).toEqual([[7_100, 3, a.id, b.id]]);
    // 被撤的本人挂单走 makerOrders 通道(状态 CANCELLED,发布器据此发 account 的 order 事件),排在撮合顺序里它被撤的位置
    expect(buy.makerOrders.map((o) => [o.id, o.status, o.filledQuantity, o.asset.symbol])).toEqual([
      [own.order.id, "CANCELLED", 0, "VCS-TEST-2021"],
      [other.order.id, "FILLED", 3, "VCS-TEST-2021"],
    ]);
    expect(await selfTrades(a.id)).toBe(0);

    expect(await matching.getOrderBook(asset.id)).toEqual({ bids: [{ price: 7_140, quantity: 2, orders: 1 }], asks: [] });
    await expectUncrossed(asset.id);

    // A 的持仓: 卖单 5 吨解冻, 买到 3 吨; 现金: 冻结 5 × 7140, 成交 3 吨按 7100 结算并退差价, 剩 2 × 7140 仍冻结
    const aHolding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: a.id, assetId: asset.id } } });
    expect([aHolding.quantity, aHolding.locked]).toEqual([103, 0]);
    const aAfter = await prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    expect([Number(aAfter.cashBalance), Number(aAfter.lockedCash)]).toEqual([10_000_000 - 7_140 * 5 + 40 * 3, 7_140 * 2]);
    // 被撤挂单的流水: 冻结一行 + 自成交防护解冻一行(reason 与用户撤单的 ORDER_UNLOCK 区分)
    expect(await orderLedger(own.order.id)).toEqual([
      { account: "HOLDING_LOCKED", delta: BigInt(5), reason: "ORDER_LOCK" },
      { account: "HOLDING_LOCKED", delta: BigInt(-5), reason: "SELF_TRADE_UNLOCK" },
    ]);
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } })).lastPrice).toBe(7_100);
    await expectInvariants();
    await expectLedgerReconciles(a.id, 10_000_000, asset.id, 100);
    await expectLedgerReconciles(b.id, 10_000_000, asset.id, 100);

    // 幂等重放: 不再撤任何东西, selfTradeCancelled 为 0
    const ledgerRows = await prisma.ledgerEntry.count();
    const again = await matching.placeOrder(input);
    expect(again).toMatchObject({ replayed: true, selfTradeCancelled: 0, makerOrders: [], order: { id: buy.order.id } });
    expect(await prisma.ledgerEntry.count()).toBe(ledgerRows);
  });

  it("市价买穿过本人卖单: 本人卖单被撤, 不与自己成交, 向下与别人成交", async () => {
    const { asset, alice, bob } = await setupMarket();
    await grantHolding(alice.id, asset.id, 50);
    const own = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_800, quantity: 5 });
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 5 });

    const market = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "MARKET", quantity: 5 });
    expect(market.selfTradeCancelled).toBe(1);
    expect(market.order).toMatchObject({ type: "MARKET", status: "FILLED", filledQuantity: 5 });
    expect(market.trades.map((t) => [t.price, t.quantity, t.sellerId])).toEqual([[10_000, 5, bob.id]]);
    expect(await selfTrades(alice.id)).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: own.order.id } })).status).toBe("CANCELLED");
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: alice.id, assetId: asset.id } } });
    expect([holding.quantity, holding.locked]).toEqual([55, 0]);
    expect(await matching.getOrderBook(asset.id)).toEqual({ bids: [], asks: [] });
    await expectInvariants();
    await expectLedgerReconciles(alice.id, 10_000_000, asset.id, 50);
  });

  it("卖单穿过本人买单: 本人买单被撤并退回冻结现金, 与别人成交后余量以卖价挂出", async () => {
    const { asset, bob } = await setupMarket();
    const carol = await fundUser("carol", 10_000_000);
    const own = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_900, quantity: 10 });
    await matching.placeOrder({ userId: carol.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_800, quantity: 4 });
    const bobLocked = Number((await prisma.user.findUniqueOrThrow({ where: { id: bob.id } })).lockedCash);
    expect(bobLocked).toBe(99_000);

    const sell = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_700, quantity: 6 });
    expect(sell.selfTradeCancelled).toBe(1);
    expect(sell.order).toMatchObject({ status: "PARTIAL", filledQuantity: 4 });
    expect(sell.trades.map((t) => [t.price, t.quantity, t.buyerId])).toEqual([[9_800, 4, carol.id]]);
    expect(await orderLedger(own.order.id)).toEqual([
      { account: "CASH", delta: BigInt(-99_000), reason: "ORDER_LOCK" },
      { account: "CASH_LOCKED", delta: BigInt(99_000), reason: "ORDER_LOCK" },
      { account: "CASH_LOCKED", delta: BigInt(-99_000), reason: "SELF_TRADE_UNLOCK" },
      { account: "CASH", delta: BigInt(99_000), reason: "SELF_TRADE_UNLOCK" },
    ]);
    expect(Number((await prisma.user.findUniqueOrThrow({ where: { id: bob.id } })).lockedCash)).toBe(0);
    expect(await matching.getOrderBook(asset.id)).toEqual({ bids: [], asks: [{ price: 9_700, quantity: 2, orders: 1 }] });
    expect(await selfTrades(bob.id)).toBe(0);
    await expectInvariants();
    await expectLedgerReconciles(bob.id, 10_000_000, asset.id, 1_000);
  });

  it("PARTIAL 的本人挂单被撤: 已成交部分、其成交与账本不变, 只释放剩余部分", async () => {
    const { asset, alice, bob } = await setupMarket();
    const own = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 10 });
    const hit = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 4 });
    expect(hit.makerOrders.map((o) => [o.status, o.filledQuantity])).toEqual([["PARTIAL", 4]]);
    const tradeLedger = await prisma.ledgerEntry.findMany({ where: { refType: "TRADE", refId: hit.trades[0].id }, orderBy: { id: "asc" } });

    const buy = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 6 });
    expect(buy.selfTradeCancelled).toBe(1);
    expect(buy.trades).toEqual([]);
    expect(buy.order).toMatchObject({ status: "OPEN", filledQuantity: 0 });
    expect(buy.makerOrders.map((o) => [o.id, o.status, o.filledQuantity])).toEqual([[own.order.id, "CANCELLED", 4]]);

    expect(await prisma.trade.count()).toBe(1);
    expect(await prisma.ledgerEntry.findMany({ where: { refType: "TRADE", refId: hit.trades[0].id }, orderBy: { id: "asc" } })).toEqual(tradeLedger);
    expect(await orderLedger(own.order.id)).toEqual([
      { account: "HOLDING_LOCKED", delta: BigInt(10), reason: "ORDER_LOCK" },
      { account: "HOLDING_LOCKED", delta: BigInt(-6), reason: "SELF_TRADE_UNLOCK" },
    ]);
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: bob.id, assetId: asset.id } } });
    expect([holding.quantity, holding.locked]).toEqual([996, 0]);
    expect(await matching.getOrderBook(asset.id)).toEqual({ bids: [{ price: 10_000, quantity: 6, orders: 1 }], asks: [] });
    await expectInvariants();
    await expectLedgerReconciles(bob.id, 10_000_000, asset.id, 1_000);

    // 用户撤单与自成交防护共用一套释放逻辑, 但流水 reason 仍是 ORDER_UNLOCK
    await matching.cancelOrder(bob.id, buy.order.id);
    expect((await orderLedger(buy.order.id)).map((l) => l.reason)).toEqual(["ORDER_LOCK", "ORDER_LOCK", "ORDER_UNLOCK", "ORDER_UNLOCK"]);
    await expectInvariants();
    await expectLedgerReconciles(bob.id, 10_000_000, asset.id, 1_000);
  });

  it("只撤新单真正会碰到的本人挂单: 先被别人的挂单吃满时后面的本人挂单不动; 价格不交叉的本人挂单不动", async () => {
    const { asset, alice, bob } = await setupMarket();
    await grantHolding(alice.id, asset.id, 50);
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 5 });
    const sameLevel = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 5 });
    const deeper = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_100, quantity: 5 });

    // 同价时间优先: bob 的卖单在前, 5 吨吃满就停, alice 自己的两张卖单都没碰到
    const buy = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_200, quantity: 5 });
    expect(buy).toMatchObject({ selfTradeCancelled: 0, filledQty: 5, order: { status: "FILLED" } });
    // 不交叉的买单不碰卖单
    const low = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1 });
    expect(low.selfTradeCancelled).toBe(0);
    for (const id of [sameLevel.order.id, deeper.order.id]) {
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
    }
    await expectUncrossed(asset.id);
    await expectInvariants();
  });

  it("连穿多张本人挂单: 逐张撤掉并计数, 新单整笔挂出", async () => {
    const { asset, bob } = await setupMarket();
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 2 });
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_050, quantity: 3 });
    const untouched = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_600, quantity: 1 });

    const buy = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_500, quantity: 10 });
    expect(buy.selfTradeCancelled).toBe(2);
    expect(buy.makerOrders.map((o) => o.status)).toEqual(["CANCELLED", "CANCELLED"]);
    expect(buy.order).toMatchObject({ status: "OPEN", filledQuantity: 0 });
    expect(await matching.getOrderBook(asset.id)).toEqual({
      bids: [{ price: 10_500, quantity: 10, orders: 1 }],
      asks: [{ price: 10_600, quantity: 1, orders: 1 }],
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: untouched.order.id } })).status).toBe("OPEN");
    await expectInvariants();
    await expectLedgerReconciles(bob.id, 10_000_000, asset.id, 1_000);
  });
});

describe("订单簿深度与每档单数(计划 §3.4)", () => {
  it("同价两个用户的挂单合并为一档, orders 计数 2; 不同价各成一档", async () => {
    const { asset, alice, bob } = await setupMarket();
    const carol = await fundUser("carol", 10_000_000);
    await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 5 });
    await matching.placeOrder({ userId: carol.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 7 });
    await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 8_900, quantity: 1 });
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_500, quantity: 3 });

    const book = await matching.getOrderBook(asset.id);
    expect(book.bids).toEqual([
      { price: 9_000, quantity: 12, orders: 2 },
      { price: 8_900, quantity: 1, orders: 1 },
    ]);
    expect(book.asks).toEqual([{ price: 9_500, quantity: 3, orders: 1 }]);
  });

  it("depth=2 每边只返回 2 档(bids 由高到低, asks 由低到高), 上限夹到 50", async () => {
    const { asset, alice, bob } = await setupMarket();
    for (const price of [9_000, 8_800, 8_900]) {
      await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price, quantity: 1 });
    }
    for (const price of [9_600, 9_400, 9_500]) {
      await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price, quantity: 1 });
    }

    const shallow = await matching.getOrderBook(asset.id, 2);
    expect(shallow.bids.map((l) => l.price)).toEqual([9_000, 8_900]);
    expect(shallow.asks.map((l) => l.price)).toEqual([9_400, 9_500]);

    const deep = await matching.getOrderBook(asset.id, 500);
    expect(deep.bids).toHaveLength(3);
    expect(deep.asks).toHaveLength(3);
    expect((await matching.getOrderBook(asset.id, 0)).bids).toHaveLength(1);
  });
});

describe("clientOrderId 幂等与并发兜底(计划 §3.4)", () => {
  const CID = "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab";

  it("重放同一 clientOrderId: 返回同一张单, replayed true, 账本行数与冻结都不变", async () => {
    const { asset, alice } = await setupMarket();
    const input = { userId: alice.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 10_000, quantity: 5, clientOrderId: CID };

    const first = await matching.placeOrder(input);
    expect(first.replayed).toBe(false);
    expect(first.order.clientOrderId).toBe(CID);
    expect(first.order.asset.symbol).toBe("VCS-TEST-2021");
    const ledgerRows = await prisma.ledgerEntry.count();
    await expectInvariants();

    const again = await matching.placeOrder(input);
    expect(again.replayed).toBe(true);
    expect(again.order.id).toBe(first.order.id);
    expect(again.trades).toEqual([]);
    expect(again.makerOrders).toEqual([]);
    expect(again.selfTradeCancelled).toBe(0);
    expect(again.filledQty).toBe(0);
    expect(again.filledCost).toBe(0);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(ledgerRows);
    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.lockedCash)).toBe(50_000); // 只冻结了一次
    await expectInvariants();
  });

  it("重放已成交的单: filledQty / filledCost 取既有单的累计成交", async () => {
    const { asset, alice, bob } = await setupMarket();
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_800, quantity: 3 });
    const input = { userId: alice.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 10_000, quantity: 3, clientOrderId: CID };
    const first = await matching.placeOrder(input);
    expect(first.filledCost).toBe(29_400);

    const again = await matching.placeOrder(input);
    expect(again).toMatchObject({ replayed: true, filledQty: 3, filledCost: 29_400, trades: [], makerOrders: [] });
    expect(again.order.id).toBe(first.order.id);
    expect(await prisma.trade.count()).toBe(1);
  });

  it("幂等键按用户隔离: 另一个用户用同一 clientOrderId 是另一张单", async () => {
    const { asset, alice } = await setupMarket();
    const carol = await fundUser("carol", 10_000_000);
    const a = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1, clientOrderId: CID });
    const c = await matching.placeOrder({ userId: carol.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1, clientOrderId: CID });
    expect(c.replayed).toBe(false);
    expect(c.order.id).not.toBe(a.order.id);
    expect(await prisma.order.count()).toBe(2);
  });

  it("Promise.all 两次同 clientOrderId: 一个 replayed false 一个 true, 只有一张单一份流水, 无 Prisma 错误外泄", async () => {
    const { asset, alice, bob } = await setupMarket();
    await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_900, quantity: 2 });
    const single = await prisma.ledgerEntry.count();
    const input = { userId: alice.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 10_000, quantity: 4, clientOrderId: CID };

    const results = await Promise.all([matching.placeOrder(input), matching.placeOrder(input)]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    expect(await prisma.order.count({ where: { userId: alice.id } })).toBe(1);

    // 流水 = 单独下这一张单应有的行数: 冻结 2 行 + 成交 6 行(卖方 CASH、买方 CASH_LOCKED、退差价 CASH、卖方 HOLDING/HOLDING_LOCKED、买方 HOLDING)
    expect((await prisma.ledgerEntry.count()) - single).toBe(8);
    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.lockedCash)).toBe(20_000); // 剩 2 吨 × 10000
    await expectInvariants();
  });

  it.each(["P2002", "P2034", "P2028", "P1008"])("事务抛 %s 后按幂等键重读: 读到 → replayed true; 读不到 → BusyError", async (code) => {
    const { Prisma } = await import("../../generated/prisma");
    const { asset, alice } = await setupMarket();
    const existing = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 2, clientOrderId: CID });
    const boom = () => Promise.reject(new Prisma.PrismaClientKnownRequestError("simulated contention", { code, clientVersion: "test" }));

    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce(boom as never);
    const replay = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 2, clientOrderId: CID });
    expect(txSpy).toHaveBeenCalledTimes(1); // catch 分支确实走到了: 事务被拒后靠重读给出结果
    expect(replay.replayed).toBe(true);
    expect(replay.order.id).toBe(existing.order.id);

    txSpy.mockImplementationOnce(boom as never);
    await expect(
      matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 2, clientOrderId: "11111111-2222-4333-8444-555555555555" }),
    ).rejects.toBeInstanceOf(matching.BusyError);

    // 没带 clientOrderId(bot 路径)无从重读, 同样是 BusyError, 而且它仍是 TradingError
    txSpy.mockImplementationOnce(boom as never);
    const err = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 2 }).catch((e) => e);
    expect(err).toBeInstanceOf(matching.BusyError);
    expect(err).toBeInstanceOf(matching.TradingError);
    expect(err.message).toBe("The account is busy. Retry this same request.");
    txSpy.mockRestore();
    expect(await prisma.order.count()).toBe(1);
    await expectInvariants();
  });

  it("其它 Prisma 错误原样抛出, 不伪装成 BusyError", async () => {
    const { Prisma } = await import("../../generated/prisma");
    const { asset, alice } = await setupMarket();
    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((() =>
      Promise.reject(new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "test" }))) as never);
    const err = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1, clientOrderId: CID }).catch((e) => e);
    txSpy.mockRestore();
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(err.code).toBe("P2025");
  });

  it("跨 bundle 的争用错误(不是本模块图的 Prisma 类实例)同样走兜底: 只认 code 字段, 不认类", async () => {
    const { Prisma } = await import("../../generated/prisma");
    // 模拟另一份 Prisma 运行时抛出的错误: 同名同 code, 但对本图的类 instanceof 为 false
    //(生产里 instrumentation 与 route handler 各带一份运行时, globalThis.prisma 来自前者)
    class ForeignKnownRequestError extends Error {
      code: string;
      constructor(code: string) {
        super(`foreign ${code}`);
        this.name = "PrismaClientKnownRequestError";
        this.code = code;
      }
    }
    expect(new ForeignKnownRequestError("P2034")).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    const { asset, alice } = await setupMarket();
    const input = { userId: alice.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 9_000, quantity: 2, clientOrderId: CID };
    const existing = await matching.placeOrder(input);

    const txSpy = vi.spyOn(prisma, "$transaction");
    for (const code of ["P2002", "P2034", "P2028", "P1008"]) {
      txSpy.mockImplementationOnce((() => Promise.reject(new ForeignKnownRequestError(code))) as never);
      const replay = await matching.placeOrder(input);
      expect(replay).toMatchObject({ replayed: true, order: { id: existing.order.id } });
    }
    txSpy.mockImplementationOnce((() => Promise.reject(new ForeignKnownRequestError("P2028"))) as never);
    await expect(
      matching.placeOrder({ ...input, clientOrderId: "11111111-2222-4333-8444-555555555555" }),
    ).rejects.toBeInstanceOf(matching.BusyError);
    txSpy.mockRestore();
    expect(await prisma.order.count()).toBe(1);
  });

  it("没有 code 或 code 不是争用码的错误原样抛出, 不伪装成 BusyError", async () => {
    const { asset, alice } = await setupMarket();
    const input = { userId: alice.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 9_000, quantity: 2, clientOrderId: CID };
    const plain = new Error("disk full");
    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((() => Promise.reject(plain)) as never);
    await expect(matching.placeOrder(input)).rejects.toBe(plain);
    const system = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    txSpy.mockImplementationOnce((() => Promise.reject(system)) as never);
    await expect(matching.placeOrder(input)).rejects.toBe(system);
    const numeric = Object.assign(new Error("odd"), { code: 2034 });
    txSpy.mockImplementationOnce((() => Promise.reject(numeric)) as never);
    await expect(matching.placeOrder(input)).rejects.toBe(numeric);
    txSpy.mockRestore();
    expect(await prisma.order.count()).toBe(0);
  });

  it("同 clientOrderId 但载荷不同 → TradingError, 不下新单、不再冻结; 争用兜底的重读同样核对载荷", async () => {
    const { Prisma } = await import("../../generated/prisma");
    const { asset, alice } = await setupMarket();
    const input = { userId: alice.id, assetId: asset.id, side: "BUY" as const, type: "LIMIT" as const, price: 9_000, quantity: 2, clientOrderId: CID };
    await matching.placeOrder(input);
    const ledgerRows = await prisma.ledgerEntry.count();

    await expect(matching.placeOrder({ ...input, quantity: 3 })).rejects.toThrow("clientOrderId already used with a different order");
    await expect(matching.placeOrder({ ...input, price: 9_001 })).rejects.toBeInstanceOf(matching.TradingError);
    await expect(matching.placeOrder({ ...input, type: "MARKET", price: null })).rejects.toBeInstanceOf(matching.TradingError);
    await expect(matching.placeOrder({ ...input, side: "SELL" })).rejects.toBeInstanceOf(matching.TradingError);
    const mismatch = await matching.placeOrder({ ...input, quantity: 1 }).catch((e) => e);
    expect(mismatch).toBeInstanceOf(matching.TradingError);
    expect(mismatch).not.toBeInstanceOf(matching.BusyError); // 400 而不是 503: 客户端重发同一请求也不会成功

    // 争用后按幂等键重读到的既有单载荷不同 → 同样 TradingError, 不把别人的单当重放
    const txSpy = vi.spyOn(prisma, "$transaction").mockImplementationOnce((() =>
      Promise.reject(new Prisma.PrismaClientKnownRequestError("contention", { code: "P2034", clientVersion: "test" }))) as never);
    await expect(matching.placeOrder({ ...input, quantity: 5 })).rejects.toThrow("clientOrderId already used with a different order");
    txSpy.mockRestore();

    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.ledgerEntry.count()).toBe(ledgerRows);
    const aliceAfter = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceAfter.lockedCash)).toBe(18_000); // 只冻结了第一次的 2 × 9000
    await expectInvariants();
    // 载荷一致仍照常重放
    expect((await matching.placeOrder(input)).replayed).toBe(true);
  });
});

describe("PlaceOrderResult / CancelOrderResult 与发布器交接(计划 §3.2)", () => {
  it("trades 与 makerOrders 与成交笔数一致, 各带 symbol 与两张订单的存根", async () => {
    const { asset, alice, bob } = await setupMarket();
    const carol = await fundUser("carol", 10_000_000);
    await grantHolding(carol.id, asset.id, 100);
    const m1 = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_800, quantity: 3 });
    const m2 = await matching.placeOrder({ userId: carol.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_900, quantity: 10 });

    const buy = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 5 });
    expect(buy.order.status).toBe("FILLED");
    expect(buy.trades).toHaveLength(2);
    expect(buy.makerOrders).toHaveLength(2);
    expect(await prisma.trade.count()).toBe(2);
    expect(buy.makerOrders.map((o) => [o.id, o.status, o.filledQuantity])).toEqual([[m1.order.id, "FILLED", 3], [m2.order.id, "PARTIAL", 2]]);
    expect(buy.selfTradeCancelled).toBe(0);
    for (const t of buy.trades) {
      expect(t.asset.symbol).toBe("VCS-TEST-2021");
      expect(t.buyOrder.id).toBe(buy.order.id);
      expect([m1.order.id, m2.order.id]).toContain(t.sellOrder.id);
      expect(t.buyOrder.createdAt).toBeInstanceOf(Date);
    }
    expect(buy.trades.map((t) => [t.price, t.quantity])).toEqual([[9_800, 3], [9_900, 2]]);
    expect(buy.filledCost).toBe(9_800 * 3 + 9_900 * 2);
    await expectInvariants();
  });

  it("市价单余量 CANCELLED, 无对手盘时 trades 为空; cancelOrder 返回 { order }", async () => {
    const { asset, alice, bob } = await setupMarket();
    const market = await matching.placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "MARKET", quantity: 4 });
    expect(market.order).toMatchObject({ type: "MARKET", status: "CANCELLED", filledQuantity: 0 });
    expect(market.trades).toEqual([]);
    expect(market.makerOrders).toEqual([]);

    const limit = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1 });
    const cancelled = await matching.cancelOrder(alice.id, limit.order.id);
    expect(cancelled).toEqual({ order: expect.objectContaining({ id: limit.order.id, type: "LIMIT", status: "CANCELLED", asset: { symbol: "VCS-TEST-2021" } }) });
    await expectInvariants();
  });

  it("下单 / 撤单提交后各把结果交给 publishOrderResult 与 afterOrderCommit 一次(钩子在发布器之后); 被拒的事务两者都不调", async () => {
    const { asset, alice } = await setupMarket();
    const placed = await matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000, quantity: 1 });
    expect(publishOrderResult).toHaveBeenCalledTimes(1);
    expect(publishOrderResult).toHaveBeenLastCalledWith(placed);
    expect(afterOrderCommit).toHaveBeenCalledTimes(1);
    expect(afterOrderCommit).toHaveBeenLastCalledWith(placed);
    expect(afterOrderCommit.mock.invocationCallOrder[0]).toBeGreaterThan(publishOrderResult.mock.invocationCallOrder[0]);

    const cancelled = await matching.cancelOrder(alice.id, placed.order.id);
    expect(publishOrderResult).toHaveBeenCalledTimes(2);
    expect(publishOrderResult).toHaveBeenLastCalledWith(cancelled);
    expect(afterOrderCommit).toHaveBeenCalledTimes(2);
    expect(afterOrderCommit).toHaveBeenLastCalledWith(cancelled);
    expect(afterOrderCommit.mock.invocationCallOrder[1]).toBeGreaterThan(publishOrderResult.mock.invocationCallOrder[1]);

    await expect(matching.placeOrder({ userId: alice.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 9_000, quantity: 1 })).rejects.toThrow(matching.TradingError);
    await expect(matching.cancelOrder(alice.id, placed.order.id)).rejects.toThrow(matching.TradingError);
    expect(publishOrderResult).toHaveBeenCalledTimes(2);
    expect(afterOrderCommit).toHaveBeenCalledTimes(2);
  });
});
