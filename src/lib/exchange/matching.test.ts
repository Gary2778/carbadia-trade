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

type DbModule = typeof import("../server/db");
type MatchingModule = typeof import("./matching");

let prisma: DbModule["prisma"];
let matching: MatchingModule;

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
    expect(book.bids).toEqual([{ price: 10_000, quantity: 20 }]);
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

  it("防自成交: 同一用户的对手单不撮合", async () => {
    const { asset, bob } = await setupMarket();

    await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 10,
    });
    const buy = await matching.placeOrder({
      userId: bob.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 10,
    });
    // 价格交叉但同属 bob,不能成交,双边继续挂簿
    expect(buy.filledQty).toBe(0);
    expect(buy.order.status).toBe("OPEN");
    expect(await prisma.trade.count()).toBe(0);
    await expectInvariants();

    const bobAfter = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(Number(bobAfter.lockedCash)).toBe(100_000);
    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.locked).toBe(10);
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
