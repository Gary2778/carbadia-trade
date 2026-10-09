import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// 独立测试库,绝不触碰 dev.db(机制同 matching.test.ts: vi.mock 替换 db 模块,
// 用 datasourceUrl 把连接显式钉在测试库上)
const DB_FILE = fileURLToPath(new URL("../../../prisma/test-ledger.db", import.meta.url));
const DB_URL = `file:${DB_FILE}`;
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  const { fileURLToPath: toPath } = await import("node:url");
  const url = `file:${toPath(new URL("../../../prisma/test-ledger.db", import.meta.url))}`;
  return { prisma: new PrismaClient({ datasourceUrl: url, log: ["error"] }) };
});

type DbModule = typeof import("../server/db");
type MatchingModule = typeof import("./matching");
type OtcModule = typeof import("./otc");
type LedgerModule = typeof import("./ledger");
type RetirementModule = typeof import("./retirement");
type MappersModule = typeof import("../server/account-mappers");

let prisma: DbModule["prisma"];
let matching: MatchingModule;
let otc: OtcModule;
let ledgerLib: LedgerModule;
let retirement: RetirementModule;
let mappers: MappersModule;

let buyer: { id: string };
let seller: { id: string };
let assetId: string;
/** 自成交场景里的两张单:被自成交防护撤掉的 seller 买单、seller 自己撤掉的卖单;以及 buyer 手动撤掉的买单 */
let stpBidId: string;
let stpAskId: string;
let userCancelledBuyId: string;
/** buyer 的那次注销(15 吨)与它经 writeLedger 写入时的参数 */
let retirementId: string;
let retirementLedgerCalls: Parameters<LedgerModule["writeLedger"]>[1][];

const GRANT_CENTS = 10_000_000; // $100,000 赠金(整数分)

// SQLite 主文件之外还可能有日志/WAL 附属文件,一并清理才算干净
const wipeDbFiles = () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(DB_FILE + suffix, { force: true });
};

beforeAll(async () => {
  wipeDbFiles();
  process.env.DATABASE_URL = DB_URL;
  execSync("npx prisma migrate deploy", {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "pipe",
  });
  matching = await import("./matching");
  otc = await import("./otc");
  ledgerLib = await import("./ledger");
  retirement = await import("./retirement");
  mappers = await import("../server/account-mappers");
  ({ prisma } = await import("../server/db"));

  // 保险丝: 确认连的是测试库再继续
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.endsWith("test-ledger.db")) {
    throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
  }

  // ---- 场景: 赠金 → 限价卖挂单 → 限价买(部分成交,含价格改善) → 撤单 → OTC 挂牌 → 购买 → 撤牌 → 自成交防护撤单 → 注销 ----
  const asset = await prisma.asset.create({
    data: {
      symbol: "VCS-LEDGER-2021",
      name: "审计流水测试标的",
      standard: "VCS",
      projectType: "林业碳汇",
      vintage: 2021,
      country: "中国",
      registry: "Verra",
    },
  });
  assetId = asset.id;

  seller = await prisma.user.create({
    data: { email: "seller@ledger.test", name: "seller", passwordHash: "test", cashBalance: BigInt(GRANT_CENTS) },
  });
  buyer = await prisma.user.create({
    data: { email: "buyer@ledger.test", name: "buyer", passwordHash: "test", cashBalance: BigInt(GRANT_CENTS) },
  });
  await ledgerLib.writeLedger(prisma, [
    { userId: seller.id, account: "CASH", delta: GRANT_CENTS, reason: "GRANT" },
    { userId: buyer.id, account: "CASH", delta: GRANT_CENTS, reason: "GRANT" },
  ]);
  await prisma.holding.create({ data: { userId: seller.id, assetId, quantity: 1_000 } });
  await ledgerLib.writeLedger(prisma, [{ userId: seller.id, account: "HOLDING", assetId, delta: 1_000, reason: "SEED" }]);

  // 限价卖挂单: 50 吨 @ 10,000 分
  await matching.placeOrder({ userId: seller.id, assetId, side: "SELL", type: "LIMIT", price: 10_000, quantity: 50 });
  // 限价买: 80 吨 @ 10,100 分 → 按挂单价 10,000 成交 50(价格改善 100 分/吨), 余 30 挂簿
  const buy = await matching.placeOrder({ userId: buyer.id, assetId, side: "BUY", type: "LIMIT", price: 10_100, quantity: 80 });
  // 撤掉未成交的 30 吨(解冻 303,000 分)
  await matching.cancelOrder(buyer.id, buy.order.id);
  userCancelledBuyId = buy.order.id;
  // OTC: 挂牌 100 吨 @ 11,000 分 → 买 40 吨 → 撤牌(解冻剩余 60 吨)
  const listing = await otc.createListing({ sellerId: seller.id, assetId, quantity: 100, pricePerUnit: 11_000 });
  await otc.buyListing(buyer.id, listing.id, 40);
  await otc.cancelListing(seller.id, listing.id);
  // 自成交防护(EXPIRE_MAKER,计划 §9.1 第 41 条): seller 挂买 10 @ 9,000(冻结 90,000 分),再挂卖 5 @ 8,900 ——
  // 会与自己的买单成交 → 撤掉那张买单(SELF_TRADE_UNLOCK: CASH_LOCKED −90,000 / CASH +90,000),卖单挂出;随后 seller 自己撤卖单。
  // 现金净额为零,终态余额与没有这一段时相同。
  const bid = await matching.placeOrder({ userId: seller.id, assetId, side: "BUY", type: "LIMIT", price: 9_000, quantity: 10 });
  const ask = await matching.placeOrder({ userId: seller.id, assetId, side: "SELL", type: "LIMIT", price: 8_900, quantity: 5 });
  if (ask.selfTradeCancelled !== 1 || ask.filledQty !== 0) throw new Error("自成交场景没有按预期撤掉本人买单");
  await matching.cancelOrder(seller.id, ask.order.id);
  stpBidId = bid.order.id;
  stpAskId = ask.order.id;
  // 注销(计划 §6.2.2 C3): buyer 持有 50(成交)+ 40(OTC)= 90 吨, 注销 15 吨 → Holding.quantity 75, 账本 HOLDING −15。
  // 账本行经 writeLedger 写入(与其它写入同一个入口): 记下这次调用的参数, 下面断言
  const writes = vi.spyOn(ledgerLib, "writeLedger");
  const retired = await retirement.retireCredits(buyer.id, {
    assetId,
    quantity: 15,
    reason: "Ledger test",
    beneficiary: "Example org",
    purpose: "Test",
    publicMessage: "",
    acknowledged: true,
    idempotencyKey: "ledger-retire-0001",
  });
  retirementLedgerCalls = writes.mock.calls.map(([, lines]) => lines);
  writes.mockRestore();
  if (retired.replayed) throw new Error("注销场景不该是重放");
  retirementId = retired.retirement.id;
}, 120_000);

afterAll(async () => {
  await (await import("@/lib/server/order-hooks")).drainOrderHooks(); // 真人成交的通知由提交后钩子写:等它写完再关库
  await prisma?.$disconnect();
  wipeDbFiles();
});

async function ledgerSum(userId: string, account: string, forAssetId?: string): Promise<number> {
  const rows = forAssetId
    ? await prisma.$queryRaw<{ s: bigint | null }[]>`
        SELECT SUM(delta) AS s FROM "LedgerEntry" WHERE userId = ${userId} AND account = ${account} AND assetId = ${forAssetId}`
    : await prisma.$queryRaw<{ s: bigint | null }[]>`
        SELECT SUM(delta) AS s FROM "LedgerEntry" WHERE userId = ${userId} AND account = ${account}`;
  return Number(rows[0]?.s ?? BigInt(0));
}

describe("审计流水 — 对账不变量", () => {
  it("流水对账: 每用户每账户 Σdelta == 列值", async () => {
    for (const u of [buyer, seller]) {
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      await expect(ledgerSum(u.id, "CASH")).resolves.toBe(Number(fresh.cashBalance));
      await expect(ledgerSum(u.id, "CASH_LOCKED")).resolves.toBe(Number(fresh.lockedCash));
      const holdings = await prisma.holding.findMany({ where: { userId: u.id } });
      for (const h of holdings) {
        await expect(ledgerSum(u.id, "HOLDING", h.assetId)).resolves.toBe(h.quantity);
        await expect(ledgerSum(u.id, "HOLDING_LOCKED", h.assetId)).resolves.toBe(h.locked);
      }
    }
  });

  it("现金零和: 交易只转移不创造(GRANT 之外)", async () => {
    const cash = await prisma.$queryRaw<{ s: bigint | null }[]>`
      SELECT SUM(delta) AS s FROM "LedgerEntry" WHERE account = 'CASH' AND reason IN ('TRADE_SETTLE','OTC_SETTLE','PRICE_IMPROVE_REFUND','ORDER_LOCK','ORDER_UNLOCK','SELF_TRADE_UNLOCK')`;
    const locked = await prisma.$queryRaw<{ s: bigint | null }[]>`
      SELECT SUM(delta) AS s FROM "LedgerEntry" WHERE account = 'CASH_LOCKED'`;
    expect(Number(cash[0]?.s ?? BigInt(0)) + Number(locked[0]?.s ?? BigInt(0))).toBe(0);
  });

  it("列值终态正确且流水种类齐全(冻结/结算/退款/解冻/OTC 全覆盖)", async () => {
    // buyer: 10,000,000 − 500,000(成交 50×10,000) − 440,000(OTC 40×11,000) = 9,060,000
    const buyerAfter = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(Number(buyerAfter.cashBalance)).toBe(9_060_000);
    expect(Number(buyerAfter.lockedCash)).toBe(0);
    // seller: 10,000,000 + 500,000 + 440,000 = 10,940,000
    const sellerAfter = await prisma.user.findUniqueOrThrow({ where: { id: seller.id } });
    expect(Number(sellerAfter.cashBalance)).toBe(10_940_000);
    expect(Number(sellerAfter.lockedCash)).toBe(0);

    const reasons = await prisma.$queryRaw<{ reason: string; n: bigint | number }[]>`
      SELECT reason, COUNT(*) AS n FROM "LedgerEntry" GROUP BY reason`;
    const byReason = new Map(reasons.map((r) => [r.reason, Number(r.n)]));
    for (const expected of [
      "GRANT",
      "SEED",
      "ORDER_LOCK",
      "ORDER_UNLOCK",
      "TRADE_SETTLE",
      "PRICE_IMPROVE_REFUND",
      "OTC_LOCK",
      "OTC_SETTLE",
      "OTC_UNLOCK",
      "SELF_TRADE_UNLOCK",
      "SIMULATED_RETIREMENT",
    ]) {
      expect(byReason.get(expected) ?? 0, `缺少流水种类: ${expected}`).toBeGreaterThan(0);
    }
  });

  it("自成交防护撤单: 解冻流水 SELF_TRADE_UNLOCK 挂在被撤订单上,现金一进一出", async () => {
    const lines = await prisma.ledgerEntry.findMany({ where: { reason: "SELF_TRADE_UNLOCK" }, orderBy: { account: "asc" } });
    expect(lines.map((l) => [l.userId, l.account, Number(l.delta), l.refType, l.refId])).toEqual([
      [seller.id, "CASH", 90_000, "ORDER", stpBidId],
      [seller.id, "CASH_LOCKED", -90_000, "ORDER", stpBidId],
    ]);
  });

  it("注销: 账本行经 writeLedger 写入(HOLDING 负行, refType RETIREMENT), 持仓列值与 Σdelta 同步减少, 现金不动", async () => {
    expect(retirementLedgerCalls).toEqual([
      [{ userId: buyer.id, account: "HOLDING", assetId, delta: -15, reason: "SIMULATED_RETIREMENT", refType: "RETIREMENT", refId: retirementId }],
    ]);
    const lines = await prisma.ledgerEntry.findMany({ where: { reason: "SIMULATED_RETIREMENT" } });
    expect(lines.map((l) => [l.userId, l.account, l.assetId, Number(l.delta), l.refType, l.refId])).toEqual([
      [buyer.id, "HOLDING", assetId, -15, "RETIREMENT", retirementId],
    ]);
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: buyer.id, assetId } } });
    expect(holding).toMatchObject({ quantity: 75, locked: 0 });
    await expect(ledgerSum(buyer.id, "HOLDING", assetId)).resolves.toBe(75);
    await expect(ledgerSum(buyer.id, "HOLDING_LOCKED", assetId)).resolves.toBe(0);
    // 重放同一请求不再写账本
    const replay = await retirement.retireCredits(buyer.id, {
      assetId,
      quantity: 15,
      reason: "Ledger test",
      beneficiary: "Example org",
      purpose: "Test",
      publicMessage: "",
      acknowledged: true,
      idempotencyKey: "ledger-retire-0001",
    });
    expect(replay.replayed).toBe(true);
    await expect(prisma.ledgerEntry.count({ where: { reason: "SIMULATED_RETIREMENT" } })).resolves.toBe(1);
  });

  it("撤单原因由流水派生: 自成交防护撤掉的单 → SELF_TRADE, 用户自己撤的 → USER(订单表没有原因列)", async () => {
    const rows = await prisma.order.findMany({
      where: { id: { in: [stpBidId, stpAskId, userCancelledBuyId] } },
      include: { asset: { select: { symbol: true } } },
    });
    expect(rows.every((r) => r.status === "CANCELLED")).toBe(true);
    const selfTraded = await mappers.selfTradeCancelledIds(prisma, rows);
    expect([...selfTraded]).toEqual([stpBidId]);
    const reasons = new Map(rows.map((r) => [r.id, mappers.toOrder(r, undefined, selfTraded).cancelReason]));
    expect(reasons.get(stpBidId)).toBe("SELF_TRADE");
    expect(reasons.get(stpAskId)).toBe("USER");
    expect(reasons.get(userCancelledBuyId)).toBe("USER");
    // 不查流水的调用方(不传 selfTraded)仍是旧口径
    expect(mappers.toOrder(rows.find((r) => r.id === stpBidId)!).cancelReason).toBe("USER");
  });
});
