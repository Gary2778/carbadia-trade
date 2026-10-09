import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DB_FILE = fileURLToPath(new URL("../../../prisma/test-cleanup.db", import.meta.url));
const DB_URL = `file:${DB_FILE}`;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  const { fileURLToPath: toPath } = await import("node:url");
  const url = `file:${toPath(new URL("../../../prisma/test-cleanup.db", import.meta.url))}`;
  return { prisma: new PrismaClient({ datasourceUrl: url, log: ["error"] }) };
});

type DbModule = typeof import("../server/db");
let prisma: DbModule["prisma"];
let cleanupHistory: typeof import("./bot")["cleanupHistory"];

const wipeDbFiles = () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(DB_FILE + suffix, { force: true });
};

beforeAll(async () => {
  wipeDbFiles();
  process.env.DATABASE_URL = DB_URL;
  execSync("npx prisma migrate deploy", { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: DB_URL }, stdio: "pipe" });
  ({ cleanupHistory } = await import("./bot"));
  ({ prisma } = await import("../server/db"));
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.endsWith("test-cleanup.db")) throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  wipeDbFiles();
});

describe("cleanupHistory", () => {
  it("只删过期的机器人自成交,保留真人参与的成交与订单", async () => {
    const mkUser = (email: string, isBot: boolean) =>
      prisma.user.create({ data: { email, name: email, passwordHash: "x", isBot, cashBalance: 0 } });
    const [bot1, bot2, human] = await Promise.all([
      mkUser("b1@t.bot", true), mkUser("b2@t.bot", true), mkUser("h@t.io", false),
    ]);
    const asset = await prisma.asset.create({
      data: { symbol: "TST-1", name: "t", standard: "VCS", projectType: "t", vintage: 2021, country: "t", registry: "t" },
    });
    const old = new Date(Date.now() - 30 * 86_400_000); // 远超默认 7 天保留期
    const mkOrder = (userId: string, status: string, createdAt: Date) =>
      prisma.order.create({ data: { userId, assetId: asset.id, side: "BUY", type: "LIMIT", price: 1, quantity: 1, status, createdAt } });
    // 过期的机器人自成交(应删)与真人参与成交(应留)
    const [ob1, ob2, oh] = await Promise.all([
      mkOrder(bot1.id, "FILLED", old), mkOrder(bot2.id, "FILLED", old), mkOrder(human.id, "FILLED", old),
    ]);
    const mkTrade = (buyerId: string, sellerId: string, buyOrderId: string, sellOrderId: string, createdAt: Date) =>
      prisma.trade.create({ data: { assetId: asset.id, buyerId, sellerId, buyOrderId, sellOrderId, price: 1, quantity: 1, createdAt } });
    const botBotOld = await mkTrade(bot1.id, bot2.id, ob1.id, ob2.id, old);
    const humanOld = await mkTrade(human.id, bot2.id, oh.id, ob2.id, old);
    const botBotNew = await mkTrade(bot1.id, bot2.id, ob1.id, ob2.id, new Date());
    // 过期的纯机器人孤儿订单(应删)与真人孤儿订单(应留)
    const orphanBot = await mkOrder(bot1.id, "CANCELLED", old);
    const orphanHuman = await mkOrder(human.id, "CANCELLED", old);

    await cleanupHistory();

    const tradeIds = (await prisma.trade.findMany({ select: { id: true } })).map((t) => t.id);
    expect(tradeIds).not.toContain(botBotOld.id);   // 过期机器人自成交:删
    expect(tradeIds).toContain(humanOld.id);        // 真人成交:哪怕过期也保留
    expect(tradeIds).toContain(botBotNew.id);       // 未过期:保留
    const orderIds = (await prisma.order.findMany({ select: { id: true } })).map((o) => o.id);
    expect(orderIds).not.toContain(orphanBot.id);   // 过期机器人孤儿终态订单:删
    expect(orderIds).toContain(orphanHuman.id);     // 真人订单:保留
  });

  it("机器人流水只留 1 天(成交仍留 7 天),真人流水永久保留", async () => {
    const [bot, human] = await Promise.all([
      prisma.user.create({ data: { email: "lb@t.bot", name: "lb", passwordHash: "x", isBot: true, cashBalance: 0 } }),
      prisma.user.create({ data: { email: "lh@t.io", name: "lh", passwordHash: "x", isBot: false, cashBalance: 0 } }),
    ]);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const mkLine = (userId: string, createdAt: Date) =>
      prisma.ledgerEntry.create({ data: { userId, account: "CASH", delta: BigInt(1), reason: "TRADE_SETTLE", createdAt } });
    const botOld = await mkLine(bot.id, twoDaysAgo);
    const botNew = await mkLine(bot.id, new Date());
    const humanOld = await mkLine(human.id, new Date(Date.now() - 30 * 86_400_000));
    const bot2 = await prisma.user.create({ data: { email: "lb2@t.bot", name: "lb2", passwordHash: "x", isBot: true, cashBalance: 0 } });
    const asset = await prisma.asset.findFirstOrThrow();
    const [buy, sell] = await Promise.all([bot.id, bot2.id].map((userId) =>
      prisma.order.create({ data: { userId, assetId: asset.id, side: "BUY", type: "LIMIT", price: 1, quantity: 1, status: "FILLED", createdAt: twoDaysAgo } })));
    const botTrade2d = await prisma.trade.create({
      data: { assetId: asset.id, buyerId: bot.id, sellerId: bot2.id, buyOrderId: buy.id, sellOrderId: sell.id, price: 1, quantity: 1, createdAt: twoDaysAgo },
    });

    await cleanupHistory();

    const lineIds = (await prisma.ledgerEntry.findMany({ select: { id: true } })).map((l) => l.id);
    expect(lineIds).not.toContain(botOld.id);       // 机器人流水 2 天前:删
    expect(lineIds).toContain(botNew.id);           // 机器人流水当天:留
    expect(lineIds).toContain(humanOld.id);         // 真人流水 30 天前:留
    expect((await prisma.trade.findMany({ select: { id: true } })).map((x) => x.id)).toContain(botTrade2d.id); // 机器人成交 2 天前:仍在 7 天内,留
  });
});
