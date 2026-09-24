import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 独立测试库,绝不触碰 dev.db;与 matching.test.ts 分库,两个文件可以并行跑。
// ESM 静态 import 会被提升到设置 env 之前执行,因此 otc 必须动态加载(见 beforeAll)
const DB_FILE = fileURLToPath(new URL("../../../prisma/test-otc.db", import.meta.url));
const DB_URL = `file:${DB_FILE}`;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// 不能只依赖 DATABASE_URL 环境变量: 生成的 client 可能在生成时把 datasource url
// 内联死(fromEnvVar: null),届时环境变量会被无声忽略、测试直接写进 dev.db。
// 这里整体替换 db 模块,用 datasourceUrl 把连接显式钉在测试库上。
vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  const { fileURLToPath: toPath } = await import("node:url");
  const url = `file:${toPath(new URL("../../../prisma/test-otc.db", import.meta.url))}`;
  return { prisma: new PrismaClient({ datasourceUrl: url, log: ["error"] }) };
});

type DbModule = typeof import("../server/db");
type OtcModule = typeof import("./otc");

let prisma: DbModule["prisma"];
let otc: OtcModule;

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
  otc = await import("./otc");
  ({ prisma } = await import("../server/db"));

  // 保险丝: 确认连的是测试库再继续,防止清库语句误伤 dev.db
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.endsWith("test-otc.db")) {
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

async function createAsset(symbol = "GS-WIND-2022") {
  return prisma.asset.create({
    data: {
      symbol,
      name: "测试风电项目",
      standard: "GS",
      projectType: "可再生能源",
      vintage: 2022,
      country: "中国",
      registry: "Gold Standard",
    },
  });
}

async function grantHolding(userId: string, assetId: string, quantity: number) {
  initialQtyByAsset.set(assetId, (initialQtyByAsset.get(assetId) ?? 0) + quantity);
  await prisma.holding.create({ data: { userId, assetId, quantity } });
}

/**
 * 资金/持仓守恒不变量 —— OTC 只转移、不创造:
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

/** 标准盘面: bob 持仓卖家, alice 现金买家(金额一律整数分) */
async function setupOtc() {
  const asset = await createAsset();
  const bob = await fundUser("bob", 1_000_000);
  const alice = await fundUser("alice", 5_000_000);
  await grantHolding(bob.id, asset.id, 100);
  return { asset, alice, bob };
}

describe("OTC 挂牌 — 资金守恒不变量", () => {
  it("挂牌冻结持仓: 冻结量占用后不能超挂", async () => {
    const { asset, bob } = await setupOtc();

    const listing = await otc.createListing({
      sellerId: bob.id, assetId: asset.id, quantity: 60, pricePerUnit: 5_000,
    });
    expect(listing.status).toBe("ACTIVE");
    await expectInvariants();

    const holding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(holding.locked).toBe(60);

    // 可用持仓只剩 40,再挂 50 必须被拒且状态不变
    await expect(
      otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 50, pricePerUnit: 5_000 }),
    ).rejects.toThrow(otc.OtcError);
    await expectInvariants();
  });

  it("分批购买: 扣款/交货/减余量, 买光后流转为 SOLD", async () => {
    const { asset, alice, bob } = await setupOtc();

    const listing = await otc.createListing({
      sellerId: bob.id, assetId: asset.id, quantity: 60, pricePerUnit: 5_000,
    });
    await expectInvariants();

    const deal1 = await otc.buyListing(alice.id, listing.id, 20);
    expect(deal1).toMatchObject({ quantity: 20, price: 5_000 });
    expect(deal1.total).toBe(100_000);
    await expectInvariants();

    const aliceMid = await prisma.user.findUniqueOrThrow({ where: { id: alice.id } });
    expect(Number(aliceMid.cashBalance)).toBe(4_900_000);
    const bobMid = await prisma.user.findUniqueOrThrow({ where: { id: bob.id } });
    expect(Number(bobMid.cashBalance)).toBe(1_100_000);
    const listingMid = await prisma.otcListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(listingMid).toMatchObject({ status: "ACTIVE", quantity: 40 });

    await otc.buyListing(alice.id, listing.id, 40);
    await expectInvariants();

    const listingAfter = await prisma.otcListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(listingAfter).toMatchObject({ status: "SOLD", quantity: 0 });
    const bobHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(bobHolding.quantity).toBe(40);
    expect(bobHolding.locked).toBe(0); // 卖光后不能残留冻结
    const aliceHolding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: alice.id, assetId: asset.id } },
    });
    expect(aliceHolding.quantity).toBe(60);
    const assetAfter = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(assetAfter.lastPrice).toBe(5_000); // OTC 成交也刷新参考价

    // 已 SOLD 的挂牌不可再买
    await expect(otc.buyListing(alice.id, listing.id, 1)).rejects.toThrow(otc.OtcError);
    await expectInvariants();
  });

  it("最小购买量: 低于下限拒绝, 但允许清空尾量", async () => {
    const { asset, alice, bob } = await setupOtc();

    const listing = await otc.createListing({
      sellerId: bob.id, assetId: asset.id, quantity: 15, pricePerUnit: 10_000, minQuantity: 10,
    });

    await expect(otc.buyListing(alice.id, listing.id, 5)).rejects.toThrow(otc.OtcError);
    await expectInvariants();

    await otc.buyListing(alice.id, listing.id, 10);
    await expectInvariants();

    // 剩余 5 吨已不足最小购买量,一次买光应放行,否则尾量永远卖不掉
    await otc.buyListing(alice.id, listing.id, 5);
    await expectInvariants();
    const listingAfter = await prisma.otcListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(listingAfter.status).toBe("SOLD");
  });

  it("撤销挂牌: 解冻剩余持仓, 且只有卖家本人可撤", async () => {
    const { asset, alice, bob } = await setupOtc();

    const listing = await otc.createListing({
      sellerId: bob.id, assetId: asset.id, quantity: 30, pricePerUnit: 5_000,
    });
    await expectInvariants();

    await expect(otc.cancelListing(alice.id, listing.id)).rejects.toThrow(otc.OtcError);
    await expectInvariants();

    await otc.cancelListing(bob.id, listing.id);
    await expectInvariants();

    const holding = await prisma.holding.findUniqueOrThrow({
      where: { userId_assetId: { userId: bob.id, assetId: asset.id } },
    });
    expect(holding.locked).toBe(0);
    const listingAfter = await prisma.otcListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(listingAfter.status).toBe("CANCELLED");

    // 已撤销的挂牌: 不可重复撤销, 也不可购买
    await expect(otc.cancelListing(bob.id, listing.id)).rejects.toThrow(otc.OtcError);
    await expect(otc.buyListing(alice.id, listing.id, 10)).rejects.toThrow(otc.OtcError);
    await expectInvariants();
  });

  it("非法输入与资源不足: 抛 OtcError 且状态不变", async () => {
    const { asset, alice, bob } = await setupOtc();

    // 挂牌参数非法
    await expect(
      otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 0, pricePerUnit: 5_000 }),
    ).rejects.toThrow(otc.OtcError);
    await expect(
      otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 10, pricePerUnit: 0 }),
    ).rejects.toThrow(otc.OtcError);
    await expect(
      otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 10, pricePerUnit: 5_000, minQuantity: 20 }),
    ).rejects.toThrow(otc.OtcError);
    // alice 无持仓不能挂牌
    await expect(
      otc.createListing({ sellerId: alice.id, assetId: asset.id, quantity: 1, pricePerUnit: 5_000 }),
    ).rejects.toThrow(otc.OtcError);

    const listing = await otc.createListing({
      sellerId: bob.id, assetId: asset.id, quantity: 20, pricePerUnit: 10_000,
    });
    await expectInvariants();

    // 购买非法: 自购 / 数量非法 / 超量 / 现金不足
    await expect(otc.buyListing(bob.id, listing.id, 5)).rejects.toThrow(otc.OtcError);
    await expect(otc.buyListing(alice.id, listing.id, 0)).rejects.toThrow(otc.OtcError);
    await expect(otc.buyListing(alice.id, listing.id, 25)).rejects.toThrow(otc.OtcError);
    const dave = await fundUser("dave", 5_000);
    await expect(otc.buyListing(dave.id, listing.id, 10)).rejects.toThrow(otc.OtcError);

    // 全部被拒后,冻结与余量必须原封不动
    await expectInvariants();
    const listingAfter = await prisma.otcListing.findUniqueOrThrow({ where: { id: listing.id } });
    expect(listingAfter).toMatchObject({ status: "ACTIVE", quantity: 20 });
    expect(await prisma.otcDeal.count()).toBe(0);
  });

  it("价格必须是整数分", async () => {
    const { asset, bob } = await setupOtc();
    await expect(
      otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 1, pricePerUnit: 100.5 }),
    ).rejects.toThrow(/integer/i);
  });

  it("超过单笔名义额上限拒单", async () => {
    const { asset, bob } = await setupOtc();
    await expect(
      otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 11, pricePerUnit: 100_000_000 }),
    ).rejects.toThrow(/notional/i);
  });
});
