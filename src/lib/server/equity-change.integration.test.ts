// 24 小时资产变化的集成测试(计划 §6.2.2 C6、§6.2.3 P2-05、§9.2 D29):临时 SQLite(migrate deploy)+ 真实的撮合、场外、注销写入。
// 时间线分三段:① 旧历史(写完整体往前挪 48 小时)② 定基准价的成交(往前挪 30 小时)③ 窗口内(此刻)。基准时刻 T 在 ② 与 ③ 之间。
// 断言:
//   - 倒推的 E(T) 与「从零开始逐行重放账本到 T、再乘 T 时刻最后成交价」独立算出的值相等,四个分量与手算的数字相等;
//   - 新账户(赠金在窗口内)的 amount 是交易与行情的盈亏,不是 +10 万美元;
//   - 窗口内注销不算亏损;窗口内卖光的标的在 T 时刻照样计入;没有变动、价格不变 → amount 0;
//   - 取不到价格(T 之前没有成交 / 现在没有价格)、机器人、没有任何账本行、账本与列对不上、窗口汇总的类别认不得 → null;
//   - T 时刻价格的进程内缓存(globalThis)命中与上限;三条查询各走哪个索引(EXPLAIN QUERY PLAN)。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EquityWindowRow } from "./equity-change";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "" }));

// 显式钉在临时库上,绝不触碰 dev.db;带查询事件,EXPLAIN 用的是实际发出去的 SQL
vi.mock("./db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl, log: [{ emit: "event", level: "query" }] }) };
});

let prisma: (typeof import("./db"))["prisma"];
let equity: typeof import("./equity-change");
let matching: typeof import("../exchange/matching");
let otc: typeof import("../exchange/otc");
let retireCredits: (typeof import("../exchange/retirement"))["retireCredits"];

const HOUR = 3_600_000;
const sql: string[] = [];
const ids = {
  assetA: "", assetB: "", assetC: "", assetD: "", assetE: "",
  alice: "", bob: "", mm: "", carol: "", dave: "", erin: "", frank: "", gina: "", heidi: "", ivan: "", bot: "",
};
/** 窗口内动作都做完之后取的「现在」;各用例共用,基准时刻因此相同 */
let now = 0;

type Side = "BUY" | "SELL";
const place = (userId: string, assetId: string, side: Side, type: "LIMIT" | "MARKET", price: number | null, quantity: number) =>
  matching.placeOrder({ userId, assetId, side, type, price, quantity });

/** 一个人类用户;cash > 0 时连同赠金的账本行(与注册 / 演示账号的写法相同) */
async function human(name: string, cash: number): Promise<string> {
  const user = await prisma.user.create({ data: { email: `${name}@equity.test`, name, passwordHash: "test", cashBalance: BigInt(cash) } });
  if (cash > 0) await prisma.ledgerEntry.create({ data: { userId: user.id, account: "CASH", delta: BigInt(cash), reason: "GRANT" } });
  return user.id;
}

/** 直接给持仓,并记一行期初账本(与 prisma/seed.ts 的写法相同) */
async function seedHolding(userId: string, assetId: string, quantity: number): Promise<void> {
  await prisma.holding.upsert({
    where: { userId_assetId: { userId, assetId } },
    create: { userId, assetId, quantity },
    update: { quantity: { increment: quantity } },
  });
  await prisma.ledgerEntry.create({ data: { userId, account: "HOLDING", assetId, delta: BigInt(quantity), reason: "SEED" } });
}

/** 让标的成交一笔、把最新价定在 price:mm 挂卖、bob 吃掉(两人都不是被测用户) */
async function tradeAt(assetId: string, price: number): Promise<void> {
  await place(ids.mm, assetId, "SELL", "LIMIT", price, 1);
  const taker = await place(ids.bob, assetId, "BUY", "LIMIT", price, 1);
  if (taker.trades.length !== 1 || taker.trades[0].price !== price) throw new Error(`price-setting trade did not print at ${price}`);
}

/** 把最近一小时内写下的成交、账本与注销整体往前挪 ms(之前挪过的行不会再动) */
async function backdateRecent(ms: number): Promise<void> {
  const recent = Date.now() - HOUR;
  await prisma.$executeRaw`UPDATE "LedgerEntry" SET "createdAt" = "createdAt" - ${ms} WHERE "createdAt" > ${recent}`;
  await prisma.$executeRaw`UPDATE "Trade" SET "createdAt" = "createdAt" - ${ms} WHERE "createdAt" > ${recent}`;
  await prisma.$executeRaw`UPDATE "Retirement" SET "createdAt" = "createdAt" - ${ms} WHERE "createdAt" > ${recent}`;
}

const retire = (userId: string, assetId: string, quantity: number, idempotencyKey: string) =>
  retireCredits(userId, { assetId, quantity, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey });

/**
 * 独立的对照算法:从零开始按时间顺序逐行重放本人的账本到 at(含),得到那一刻的现金、冻结现金与各标的数量,
 * 再乘以各标的在 at 及之前的最后一笔成交价。与被测函数的「现值 − 窗口内变动」是两条路。
 */
async function replayAt(userId: string, at: number) {
  const rows = await prisma.ledgerEntry.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  let cash = 0;
  let locked = 0;
  const quantity = new Map<string, number>();
  for (const row of rows) {
    if (row.createdAt.getTime() > at) continue;
    const delta = Number(row.delta);
    if (row.account === "CASH") cash += delta;
    else if (row.account === "CASH_LOCKED") locked += delta;
    else if (row.account === "HOLDING" && row.assetId) quantity.set(row.assetId, (quantity.get(row.assetId) ?? 0) + delta);
  }
  let equity = cash + locked;
  for (const [assetId, qty] of quantity) {
    if (qty === 0) continue;
    const trades = await prisma.trade.findMany({ where: { assetId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { price: true, createdAt: true } });
    const last = trades.filter((trade) => trade.createdAt.getTime() <= at).at(-1);
    if (!last) throw new Error(`no trade for ${assetId} at or before ${at}`);
    equity += qty * last.price;
  }
  return { cash, locked, quantity, equity };
}

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-equity-")));
  writeFileSync(join(testState.directory, "equity.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "equity.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("./db"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
  // db.ts 的类型是按无事件日志构造的 client($on 参数为 never);这里的实例在 mock 里带了 emit: "event",运行时可用
  (prisma as unknown as { $on(event: "query", cb: (e: { query: string }) => void): void }).$on("query", (e) => {
    sql.push(e.query);
    if (sql.length > 400) sql.shift();
  });
  equity = await import("./equity-change");
  matching = await import("../exchange/matching");
  otc = await import("../exchange/otc");
  ({ retireCredits } = await import("../exchange/retirement"));

  const asset = (symbol: string) =>
    prisma.asset.create({ data: { symbol, name: `Test ${symbol}`, standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" } });
  const [assetA, assetB, assetC, assetD, assetE] = [await asset("EQ-A"), await asset("EQ-B"), await asset("EQ-C"), await asset("EQ-D"), await asset("EQ-E")];
  Object.assign(ids, { assetA: assetA.id, assetB: assetB.id, assetC: assetC.id, assetD: assetD.id, assetE: assetE.id });

  // 对手方与定价方:现金与库存直接给足(不是被测用户,不需要账本行)
  for (const name of ["bob", "mm"] as const) {
    const user = await prisma.user.create({ data: { email: `${name}@equity.test`, name, passwordHash: "test", cashBalance: BigInt(1_000_000_000) } });
    ids[name] = user.id;
    await prisma.holding.createMany({ data: [assetA, assetB, assetC, assetD].map((a) => ({ userId: user.id, assetId: a.id, quantity: 100_000 })) });
  }

  // ── ① 旧历史(之后整体挪到 48 小时前)──────────────────────────────────────────────
  ids.alice = await human("alice", 10_000_000);
  // 买 100 A:bob 挂卖 @1000,alice 限价 @1100 吃掉(成交在 1000,退回价差)
  await place(ids.bob, ids.assetA, "SELL", "LIMIT", 1_000, 100);
  await place(ids.alice, ids.assetA, "BUY", "LIMIT", 1_100, 100);
  // 买 50 B:市价
  await place(ids.bob, ids.assetB, "SELL", "LIMIT", 2_000, 50);
  await place(ids.alice, ids.assetB, "BUY", "MARKET", null, 50);
  // 卖 10 A @1200
  await place(ids.bob, ids.assetA, "BUY", "LIMIT", 1_200, 10);
  await place(ids.alice, ids.assetA, "SELL", "LIMIT", 1_200, 10);
  // 挂一张买单留着(冻结现金 4500,跨过 T);挂一张卖单再撤(锁定与解锁都在旧历史里)
  const oldBid = await place(ids.alice, ids.assetA, "BUY", "LIMIT", 900, 5);
  const oldAsk = await place(ids.alice, ids.assetA, "SELL", "LIMIT", 5_000, 20);
  await matching.cancelOrder(ids.alice, oldAsk.order.id);
  // 场外:挂 10 B @2100,bob 买走 4
  const aliceListing = await otc.createListing({ sellerId: ids.alice, assetId: ids.assetB, quantity: 10, pricePerUnit: 2_100 });
  await otc.buyListing(ids.bob, aliceListing.id, 4);
  // 注销 5 A
  await retire(ids.alice, ids.assetA, 5, "equity-alice-old-0001");

  // dave / frank / ivan:各有 100 万分现金与 C 的期初持仓;erin 持有 D(T 之前没有成交)
  ids.dave = await human("dave", 1_000_000);
  await seedHolding(ids.dave, ids.assetC, 50);
  ids.frank = await human("frank", 1_000_000);
  await seedHolding(ids.frank, ids.assetC, 50);
  ids.ivan = await human("ivan", 1_000_000);
  await seedHolding(ids.ivan, ids.assetC, 20);
  ids.erin = await human("erin", 1_000_000);
  await seedHolding(ids.erin, ids.assetD, 10);
  // 机器人:有账本行,照样不算
  const bot = await prisma.user.create({ data: { email: "bot@equity.test", name: "Bot", passwordHash: "!", isBot: true, cashBalance: BigInt(5_000_000) } });
  await prisma.ledgerEntry.create({ data: { userId: bot.id, account: "CASH", delta: BigInt(5_000_000), reason: "BOT_MINT_CASH" } });
  ids.bot = bot.id;
  await backdateRecent(48 * HOUR);

  // ── ② 定基准价的成交(挪到 30 小时前):A 1300、B 1900、C 700 ─────────────────────────
  await tradeAt(ids.assetA, 1_300);
  await tradeAt(ids.assetB, 1_900);
  await tradeAt(ids.assetC, 700);
  await backdateRecent(30 * HOUR);

  // ── ③ 窗口内(此刻)────────────────────────────────────────────────────────────
  // alice:赠金 50 万分、获赠 7 B
  await prisma.user.update({ where: { id: ids.alice }, data: { cashBalance: { increment: BigInt(500_000) } } });
  await prisma.ledgerEntry.create({ data: { userId: ids.alice, account: "CASH", delta: BigInt(500_000), reason: "GRANT" } });
  await seedHolding(ids.alice, ids.assetB, 7);
  // 买 20 A @1400,卖 30 B @1850
  await place(ids.bob, ids.assetA, "SELL", "LIMIT", 1_400, 20);
  await place(ids.alice, ids.assetA, "BUY", "LIMIT", 1_400, 20);
  await place(ids.bob, ids.assetB, "BUY", "LIMIT", 1_850, 30);
  await place(ids.alice, ids.assetB, "SELL", "LIMIT", 1_850, 30);
  // 撤掉旧买单(解冻 4500),新挂买 3 A @800(冻结 2400)、卖 8 A @9000(锁 8 吨,留着)
  await matching.cancelOrder(ids.alice, oldBid.order.id);
  await place(ids.alice, ids.assetA, "BUY", "LIMIT", 800, 3);
  await place(ids.alice, ids.assetA, "SELL", "LIMIT", 9_000, 8);
  // 场外:bob 再买 2 B;alice 新挂 4 A @1600;alice 从 bob 的挂牌买 3 A @1450
  await otc.buyListing(ids.bob, aliceListing.id, 2);
  await otc.createListing({ sellerId: ids.alice, assetId: ids.assetA, quantity: 4, pricePerUnit: 1_600 });
  const bobListing = await otc.createListing({ sellerId: ids.bob, assetId: ids.assetA, quantity: 10, pricePerUnit: 1_450 });
  await otc.buyListing(ids.alice, bobListing.id, 3);
  // 注销 6 A
  await retire(ids.alice, ids.assetA, 6, "equity-alice-new-0001");

  // carol:窗口内才注册(赠金 10 万美元),买 10 A @1400,再卖 4 A @1450
  ids.carol = await human("carol", 10_000_000);
  await place(ids.bob, ids.assetA, "SELL", "LIMIT", 1_400, 10);
  await place(ids.carol, ids.assetA, "BUY", "LIMIT", 1_400, 10);
  await place(ids.bob, ids.assetA, "BUY", "LIMIT", 1_450, 4);
  await place(ids.carol, ids.assetA, "SELL", "LIMIT", 1_450, 4);
  // dave:窗口内注销 10 C;ivan:窗口内把 20 C 全卖了 @700(价格不变)
  await retire(ids.dave, ids.assetC, 10, "equity-dave-new-0001");
  await place(ids.bob, ids.assetC, "BUY", "LIMIT", 700, 20);
  await place(ids.ivan, ids.assetC, "SELL", "LIMIT", 700, 20);
  // gina:窗口内获赠 E,E 从没成交过(没有现价);heidi:有余额、没有任何账本行
  ids.gina = await human("gina", 1_000_000);
  await seedHolding(ids.gina, ids.assetE, 5);
  ids.heidi = (await prisma.user.create({ data: { email: "heidi@equity.test", name: "heidi", passwordHash: "test", cashBalance: BigInt(1_000_000) } })).id;
  // 收盘价:A 1500、B 1800、D 500(D 的第一笔成交在窗口内)
  await tradeAt(ids.assetA, 1_500);
  await tradeAt(ids.assetB, 1_800);
  await tradeAt(ids.assetD, 500);

  now = Date.now();
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

describe("equitySince", () => {
  it("是 now − 24 h 向下对齐到 10 分钟", () => {
    const at = Date.UTC(2026, 9, 1, 12, 34, 56, 789);
    expect(equity.equitySince(at)).toBe(Date.UTC(2026, 8, 30, 12, 30, 0, 0));
    expect(equity.equitySince(Date.UTC(2026, 9, 1, 12, 39, 59, 999))).toBe(Date.UTC(2026, 8, 30, 12, 30, 0, 0));
    expect(equity.equitySince(Date.UTC(2026, 9, 1, 12, 40, 0, 0))).toBe(Date.UTC(2026, 8, 30, 12, 40, 0, 0));
  });
});

describe("loadEquityReplay / loadEquityChange(真实库)", () => {
  it("时间线摆对了:旧历史在 T 之前,窗口内的行在 T 之后", async () => {
    const since = equity.equitySince(now);
    const rows = await prisma.ledgerEntry.findMany({ where: { userId: ids.alice }, select: { createdAt: true } });
    const before = rows.filter((row) => row.createdAt.getTime() <= since).length;
    expect(before).toBeGreaterThan(10);
    expect(rows.length - before).toBeGreaterThan(10);
  });

  it("E(T) 与逐行重放账本得到的值相等;四个分量与手算一致", async () => {
    const replay = await equity.loadEquityReplay(prisma, ids.alice, now);
    expect(replay).not.toBeNull();
    const since = equity.equitySince(now);

    // 独立重放到 T:现金 9,815,900、冻结 4,500、A 85 吨 × 1300、B 46 吨 × 1900
    const then = await replayAt(ids.alice, since);
    expect(then.cash).toBe(9_815_900);
    expect(then.locked).toBe(4_500);
    expect(then.quantity.get(ids.assetA)).toBe(85);
    expect(then.quantity.get(ids.assetB)).toBe(46);
    expect(then.equity).toBe(10_018_300);
    expect(replay!.equityThen).toBe(then.equity);

    // 现在:账本从零重放到此刻 = 列上的现值(账本完整),也等于函数给出的 equityNow
    const current = await replayAt(ids.alice, Date.now());
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.alice } });
    expect([Number(user.cashBalance), Number(user.lockedCash)]).toEqual([current.cash, current.locked]);
    expect(current.cash).toBe(10_345_350);
    expect(current.locked).toBe(2_400);
    expect(current.quantity.get(ids.assetA)).toBe(102);
    expect(current.quantity.get(ids.assetB)).toBe(21);
    expect(replay).toEqual({
      since,
      equityThen: 10_018_300,
      equityNow: 10_345_350 + 2_400 + 102 * 1_500 + 21 * 1_800, // 10,538,550
      grants: 500_000 + 7 * 1_800, // 赠金按面额,获赠的 7 B 按现价
      retired: 6 * 1_500, // 窗口内注销的 6 A 按现价
    });
  });

  it("amount = (E(now) + R) − (E(T) + G),pct 是小数比例", async () => {
    const change = await equity.loadEquityChange(prisma, ids.alice, now);
    expect(change).toEqual({ amount: 16_650, pct: 16_650 / 10_530_900, baseline: 10_530_900, since: equity.equitySince(now) });
  });

  it("新账户(赠金在窗口内):amount 是交易与行情的盈亏,不是 +10 万美元", async () => {
    // 买 10 @1400、卖 4 @1450(+200)、剩 6 吨按 1500 计(+600)
    expect(await equity.loadEquityReplay(prisma, ids.carol, now)).toMatchObject({ equityThen: 0, grants: 10_000_000, retired: 0, equityNow: 10_000_800 });
    expect(await equity.loadEquityChange(prisma, ids.carol, now)).toEqual({ amount: 800, pct: 800 / 10_000_000, baseline: 10_000_000, since: equity.equitySince(now) });
  });

  it("窗口内注销不算亏损", async () => {
    // 50 C @700;注销 10 后剩 40。价格没动 → 0
    expect(await equity.loadEquityReplay(prisma, ids.dave, now)).toMatchObject({ equityThen: 1_035_000, equityNow: 1_028_000, grants: 0, retired: 7_000 });
    expect(await equity.loadEquityChange(prisma, ids.dave, now)).toMatchObject({ amount: 0, pct: 0, baseline: 1_035_000 });
  });

  it("窗口内没有任何变动、价格不变 → amount 0", async () => {
    expect(await equity.loadEquityChange(prisma, ids.frank, now)).toEqual({ amount: 0, pct: 0, baseline: 1_035_000, since: equity.equitySince(now) });
  });

  it("窗口内卖光的标的在 T 时刻照样计入(持仓行还在,数量 0)", async () => {
    expect(await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: ids.ivan, assetId: ids.assetC } } })).toMatchObject({ quantity: 0 });
    expect(await equity.loadEquityReplay(prisma, ids.ivan, now)).toMatchObject({ equityThen: 1_014_000, equityNow: 1_014_000, grants: 0, retired: 0 });
  });

  it("T 时刻持有的标的在 T 之前没有成交 → null", async () => {
    expect((await prisma.asset.findUniqueOrThrow({ where: { id: ids.assetD } })).lastPrice).toBe(500); // 现在有价格,缺的是 T 时刻的
    expect(await equity.loadEquityChange(prisma, ids.erin, now)).toBeNull();
  });

  it("现在持有的标的没有价格 → null", async () => {
    expect(await equity.loadEquityChange(prisma, ids.gina, now)).toBeNull();
  });

  it("机器人、没有任何账本行的用户、不存在的用户 → null", async () => {
    expect(await equity.loadEquityChange(prisma, ids.bot, now)).toBeNull();
    expect(await equity.loadEquityChange(prisma, ids.heidi, now)).toBeNull();
    expect(await equity.loadEquityChange(prisma, "no-such-user", now)).toBeNull();
  });

  it("只读本人的账本:对手方的成交不进结果", async () => {
    // bob 没有赠金行、整个窗口都在和别人成交;alice 的结果不因 bob 的账本而变(上面的手算已经钉住),
    // 反过来 frank 的窗口汇总是空的(同一标的上 ivan、dave 的变动不算到他头上)
    const [rows] = await prisma.$transaction([equity.equityReads(prisma, ids.frank, equity.equitySince(now))[0]]);
    expect(rows).toEqual([]);
  });
});

describe("equityReplayFrom(已读好的输入)", () => {
  const base = { since: 0, balance: { cashBalance: 1_000, lockedCash: 0 }, holdings: [], windowRows: [], hasLedger: true };

  it("没有持仓也没有变动:现在与当时都等于现金", async () => {
    expect(await equity.equityReplayFrom(prisma, base)).toEqual({ since: 0, equityNow: 1_000, equityThen: 1_000, grants: 0, retired: 0 });
  });

  it("hasLedger 为 false → null", async () => {
    expect(await equity.equityReplayFrom(prisma, { ...base, hasLedger: false })).toBeNull();
  });

  it("倒推出负的现金或数量(账本与列对不上)→ null,不给一个错的数", async () => {
    expect(await equity.equityReplayFrom(prisma, { ...base, windowRows: [{ account: "CASH", assetId: null, kind: "OTHER", delta: 5_000 }] })).toBeNull();
    expect(
      await equity.equityReplayFrom(prisma, {
        ...base,
        holdings: [{ assetId: ids.assetA, quantity: 5, lastPrice: 1_500 }],
        windowRows: [{ account: "HOLDING", assetId: ids.assetA, kind: "OTHER", delta: 10 }],
      }),
    ).toBeNull();
  });

  it("窗口汇总里出现认不得的类别(原始 SQL 与类型走岔了)→ null,不当成 OTHER 算下去", async () => {
    // 行来自 $queryRaw,类型只是声明;这里绕过类型喂一个 CASE 里没有的值
    const stray = { account: "CASH", assetId: null, kind: "BONUS", delta: 0 } as unknown as EquityWindowRow;
    expect(await equity.equityReplayFrom(prisma, { ...base, windowRows: [stray] })).toBeNull();
    expect(await equity.equityReplayFrom(prisma, { ...base, windowRows: [{ ...stray, account: "HOLDING", assetId: ids.assetA }] })).toBeNull();
    // 同一行换成认得的类别就能算(确认上面的 null 来自类别,不是别的)
    expect(await equity.equityReplayFrom(prisma, { ...base, windowRows: [{ ...stray, kind: "OTHER" }] })).toEqual({ since: 0, equityNow: 1_000, equityThen: 1_000, grants: 0, retired: 0 });
  });

  it("窗口汇总里的 bigint(SQLite 的 SUM)按数值处理;冻结现金里的赠予正行也算赠予", async () => {
    const replay = await equity.equityReplayFrom(prisma, {
      ...base,
      balance: { cashBalance: 1_000, lockedCash: 300 },
      windowRows: [
        { account: "CASH", assetId: null, kind: "GRANT", delta: BigInt(600) },
        { account: "CASH_LOCKED", assetId: null, kind: "GRANT", delta: BigInt(300) },
      ],
    });
    expect(replay).toEqual({ since: 0, equityNow: 1_300, equityThen: 400, grants: 900, retired: 0 });
    expect(equity.toEquityChange(replay)).toEqual({ amount: 0, pct: 0, baseline: 1_300, since: 0 });
  });
});

describe("toEquityChange", () => {
  it("baseline ≤ 0 时 pct 为 null;null 进 null 出", () => {
    expect(equity.toEquityChange({ since: 1, equityNow: 500, equityThen: 0, grants: 0, retired: 0 })).toEqual({ amount: 500, pct: null, baseline: 0, since: 1 });
    expect(equity.toEquityChange(null)).toBeNull();
  });
});

describe("T 时刻价格的进程内缓存", () => {
  const cache = () => globalThis.__carbadiaEquityPrices!;
  const key = (assetId: string) => `${equity.equitySince(now)}:${assetId}`;

  it("挂在 globalThis 上,键含基准时刻与标的;命中后不再查 Trade", async () => {
    cache().clear();
    await equity.loadEquityChange(prisma, ids.alice, now);
    expect(cache().get(key(ids.assetA))).toBe(1_300);
    expect(cache().get(key(ids.assetB))).toBe(1_900);

    sql.length = 0;
    await equity.loadEquityChange(prisma, ids.alice, now);
    expect(sql.some((q) => /"Trade"/.test(q))).toBe(false);
    // 别的用户、同一个标的:同样命中(所有用户共用)
    await equity.loadEquityChange(prisma, ids.dave, now);
    await equity.loadEquityChange(prisma, ids.frank, now);
    expect(sql.filter((q) => /"Trade"/.test(q))).toHaveLength(1); // 只有 dave 第一次要 C 的价格
  });

  it("读的是缓存里的值;清掉之后重新查库", async () => {
    await equity.loadEquityChange(prisma, ids.alice, now);
    cache().set(key(ids.assetA), 1_301);
    expect((await equity.loadEquityReplay(prisma, ids.alice, now))!.equityThen).toBe(10_018_300 + 85);
    cache().clear();
    expect((await equity.loadEquityReplay(prisma, ids.alice, now))!.equityThen).toBe(10_018_300);
  });

  it("T 之前没有成交也缓存(null):历史不会补出一笔更早的成交", async () => {
    cache().clear();
    await equity.loadEquityChange(prisma, ids.erin, now);
    expect(cache().has(key(ids.assetD))).toBe(true);
    expect(cache().get(key(ids.assetD))).toBeNull();
  });

  it("有上限:装满之后清空重来,不无限增长", async () => {
    cache().clear();
    for (let i = 0; i < equity.EQUITY_PRICE_CACHE_MAX; i++) cache().set(`0:filler-${i}`, 1);
    await equity.loadEquityChange(prisma, ids.alice, now);
    expect(cache().size).toBe(2);
    expect(cache().get(key(ids.assetA))).toBe(1_300);
  });
});

describe("查询计划:只用现有索引", () => {
  async function planOf(pattern: RegExp, run: () => Promise<unknown>): Promise<string> {
    sql.length = 0;
    await run();
    const query = sql.find((q) => pattern.test(q));
    if (!query) throw new Error(`query not captured: ${pattern}`);
    const placeholders = (query.match(/\?/g) ?? []).length;
    const plan = await prisma.$queryRawUnsafe<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${query}`, ...Array.from({ length: placeholders }, () => null));
    return plan.map((row) => row.detail).join(" | ");
  }

  it("窗口内账本汇总走 LedgerEntry (userId, account, createdAt)", async () => {
    const plan = await planOf(/SUM\(l\."delta"\)/, () => equity.loadEquityChange(prisma, ids.alice, now));
    expect(plan).toContain("LedgerEntry_userId_account_createdAt_idx");
    expect(plan).toMatch(/userId=\? AND account=\? AND createdAt>\?/);
    expect(plan).not.toMatch(/SCAN l\b/);
  });

  it("有没有账本行:同一个索引的 userId 前缀", async () => {
    const plan = await planOf(/FROM `main`\.`LedgerEntry`.*LIMIT/, () => equity.loadEquityChange(prisma, ids.alice, now));
    expect(plan).toContain("LedgerEntry_userId_account_createdAt_idx");
  });

  it("T 时刻的价格:每个标的在 Trade (assetId, createdAt) 上取一行", async () => {
    globalThis.__carbadiaEquityPrices!.clear();
    const plan = await planOf(/json_each/, () => equity.loadEquityChange(prisma, ids.alice, now));
    expect(plan).toContain("Trade_assetId_createdAt_idx");
    expect(plan).toMatch(/assetId=\? AND createdAt<\?/);
    expect(plan).not.toMatch(/SCAN t\b/);
  });
});
