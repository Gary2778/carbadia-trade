import crypto from "node:crypto";
import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

// 金额一律整数分; 数量为整数吨
const HUMAN_CASH = 50_000_000; // ¥500,000
const BOT_CASH = 5_000_000_000; // ¥50,000,000

const ASSETS = [
  { symbol: "VCS-FOR-2021", name: "云南森林经营碳汇项目", standard: "VCS", projectType: "林业碳汇", vintage: 2021, country: "中国", registry: "Verra", mid: 6800, desc: "通过可持续森林经营增加碳储量的核证减排量。" },
  { symbol: "CCER-SOL-2023", name: "青海光伏发电项目", standard: "CCER", projectType: "可再生能源", vintage: 2023, country: "中国", registry: "国家温室气体自愿减排登记簿", mid: 8200, desc: "大型地面光伏电站替代化石能源发电。" },
  { symbol: "GS-WIND-2022", name: "印度拉贾斯坦风电项目", standard: "GS", projectType: "可再生能源", vintage: 2022, country: "印度", registry: "Gold Standard", mid: 4500, desc: "陆上风电场并网发电减排。" },
  { symbol: "GS-MANG-2022", name: "印尼红树林蓝碳修复", standard: "GS", projectType: "蓝碳", vintage: 2022, country: "印度尼西亚", registry: "Gold Standard", mid: 9500, desc: "红树林生态修复带来的高质量蓝碳信用。" },
  { symbol: "VCS-COOK-2020", name: "肯尼亚高效炉灶项目", standard: "VCS", projectType: "能效", vintage: 2020, country: "肯尼亚", registry: "Verra", mid: 1200, desc: "推广高效生物质炉灶减少薪柴消耗。" },
  { symbol: "CDM-METH-2019", name: "巴西垃圾填埋气回收", standard: "CDM", projectType: "甲烷回收", vintage: 2019, country: "巴西", registry: "UNFCCC", mid: 900, desc: "填埋场甲烷收集发电避免温室气体排放。" },
];

async function main() {
  console.log("清空旧数据…");
  await prisma.ledgerEntry.deleteMany(); // seed 重建全部账户, 旧流水一并清空(否则 Σdelta==余额 不变量被孤儿流水破坏)
  await prisma.otcDeal.deleteMany();
  await prisma.otcListing.deleteMany();
  await prisma.trade.deleteMany();
  await prisma.order.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.user.deleteMany();

  console.log("创建用户…");
  const pw = hashPassword("password123");
  const users = await Promise.all(
    [
      { email: "alice@carbadia.io", name: "Alice（碳资产开发商）" },
      { email: "bob@carbadia.io", name: "Bob（减排企业）" },
      { email: "carol@carbadia.io", name: "Carol（碳基金）" },
      { email: "dave@carbadia.io", name: "Dave（履约企业）" },
    ].map((u) => prisma.user.create({ data: { ...u, passwordHash: pw, cashBalance: BigInt(HUMAN_CASH) } }))
  );
  const [alice, bob, carol, dave] = users;
  for (const u of users) {
    await prisma.ledgerEntry.create({ data: { userId: u.id, account: "CASH", delta: BigInt(HUMAN_CASH), reason: "SEED" } });
  }

  console.log("创建做市机器人…");
  const bots = await Promise.all(
    ["mm1", "mm2", "mm3"].map((n) =>
      prisma.user.create({
        data: { email: `${n}@carbadia.bot`, name: `做市商 ${n.toUpperCase()}`, passwordHash: pw, isBot: true, cashBalance: BigInt(BOT_CASH) },
      })
    )
  );
  for (const b of bots) {
    await prisma.ledgerEntry.create({ data: { userId: b.id, account: "CASH", delta: BigInt(BOT_CASH), reason: "SEED" } });
  }

  console.log("创建标的…");
  const assets = await Promise.all(
    ASSETS.map((a) =>
      prisma.asset.create({
        data: {
          symbol: a.symbol, name: a.name, standard: a.standard, projectType: a.projectType,
          vintage: a.vintage, country: a.country, registry: a.registry, description: a.desc, lastPrice: a.mid, anchorPrice: a.mid,
        },
      })
    )
  );

  // 给卖方分配持仓
  async function grant(userId: string, assetId: string, qty: number) {
    await prisma.holding.upsert({
      where: { userId_assetId: { userId, assetId } },
      create: { userId, assetId, quantity: qty, locked: 0 },
      update: { quantity: { increment: qty } },
    });
    await prisma.ledgerEntry.create({ data: { userId, account: "HOLDING", assetId, delta: BigInt(qty), reason: "SEED" } });
  }
  console.log("分配持仓…");
  for (const asset of assets) {
    await grant(alice.id, asset.id, 3000);
    await grant(bob.id, asset.id, 1500);
    await grant(carol.id, asset.id, 400);
    for (const b of bots) await grant(b.id, asset.id, 1_000_000);
  }

  // 挂单助手(维护冻结一致 + 冻结流水; seed 阶段 refId 留空)
  async function restingSell(userId: string, assetId: string, price: number, qty: number) {
    await prisma.holding.update({ where: { userId_assetId: { userId, assetId } }, data: { locked: { increment: qty } } });
    await prisma.order.create({ data: { userId, assetId, side: "SELL", type: "LIMIT", price, quantity: qty, status: "OPEN" } });
    await prisma.ledgerEntry.create({ data: { userId, account: "HOLDING_LOCKED", assetId, delta: BigInt(qty), reason: "ORDER_LOCK" } });
  }
  async function restingBuy(userId: string, assetId: string, price: number, qty: number) {
    const lock = price * qty;
    await prisma.user.update({ where: { id: userId }, data: { cashBalance: { decrement: BigInt(lock) }, lockedCash: { increment: BigInt(lock) } } });
    await prisma.order.create({ data: { userId, assetId, side: "BUY", type: "LIMIT", price, quantity: qty, status: "OPEN" } });
    await prisma.ledgerEntry.createMany({
      data: [
        { userId, account: "CASH", delta: BigInt(-lock), reason: "ORDER_LOCK" },
        { userId, account: "CASH_LOCKED", delta: BigInt(lock), reason: "ORDER_LOCK" },
      ],
    });
  }

  console.log("铺设订单簿…");
  const ASSET = Object.fromEntries(assets.map((a, i) => [ASSETS[i].symbol, a]));
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const m = ASSETS[i].mid;
    const sp = Math.max(50, Math.round(m * 0.03)); // 价差步长(分)
    // 卖盘(asks)
    await restingSell(alice.id, a.id, m + sp, 120);
    await restingSell(bob.id, a.id, m + sp * 2, 90);
    await restingSell(alice.id, a.id, m + sp * 3, 200);
    // 买盘(bids)
    await restingBuy(carol.id, a.id, m - sp, 100);
    await restingBuy(dave.id, a.id, m - sp * 2, 130);
    await restingBuy(carol.id, a.id, m - sp * 3, 80);
  }

  console.log("创建 OTC 挂牌…");
  async function otc(userId: string, assetId: string, qty: number, price: number, minQty: number) {
    await prisma.holding.update({ where: { userId_assetId: { userId, assetId } }, data: { locked: { increment: qty } } });
    await prisma.otcListing.create({ data: { sellerId: userId, assetId, quantity: qty, pricePerUnit: price, minQuantity: minQty } });
    await prisma.ledgerEntry.create({ data: { userId, account: "HOLDING_LOCKED", assetId, delta: BigInt(qty), reason: "OTC_LOCK" } });
  }
  await otc(alice.id, ASSET["VCS-FOR-2021"].id, 500, 6600, 50);
  await otc(alice.id, ASSET["GS-MANG-2022"].id, 300, 9300, 100);
  await otc(bob.id, ASSET["CCER-SOL-2023"].id, 400, 8000, 50);
  await otc(bob.id, ASSET["VCS-COOK-2020"].id, 1000, 1150, 200);

  console.log("✓ 种子数据完成");
  console.log("  演示账号: alice@carbadia.io / bob@... / carol@... / dave@...  密码均为 password123");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
