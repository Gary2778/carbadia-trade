// 自成交防护(计划 §9.1 第 41 条,EXPIRE_MAKER)对真实 SQLite(临时库 + migrate deploy)的集成测试:
// ① 发布器不改:被撤的本人挂单经 PlaceOrderResult.makerOrders(状态 CANCELLED)进入 market-publisher 的 publishAccountEvents,
//    该用户在线时收到 status CANCELLED 的 account order 事件;盘口标脏后发出的快照不交叉;
// ② 做市机器人(bot.ts)跑若干 tick:每一笔下单提交后盘口都不交叉(买一 < 卖一,或一侧为空)。只放一个机器人账户,
//    它的吃单、补档必然撞上自己的挂单——旧逻辑(撮合跳过本人对手单)下吃单会以交叉价挂出;
// ③ 升级前留下的交叉盘口(同一机器人账户的旧挂单与较新的挂单价格交叉):第一个 tick 就撤掉旧的那张,此后每笔下单都不交叉。
// 机器人经 ./matching 的 placeOrder 下单:这里把它包一层,每笔提交后跑一次探针读盘口(探针只记录,不抛——机器人会吞掉下单错误)。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../server/bus.mjs";
import type { BusMessage, Presence } from "@/shared/bus";
import type { Order } from "@/shared/types";
import type { Topic } from "@/shared/ws-protocol";

const database = vi.hoisted(() => ({ directory: "", path: "" }));
const probe = vi.hoisted(() => ({ afterPlace: null as null | ((assetId: string) => Promise<void>) }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// 显式钉在临时库上,绝不触碰 dev.db(生成的 client 可能把 datasource url 内联死,只靠环境变量不保险)
vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${database.path}` }) };
});

vi.mock("./matching", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./matching")>();
  return {
    ...actual,
    placeOrder: async (input: Parameters<typeof actual.placeOrder>[0]) => {
      const result = await actual.placeOrder(input);
      await probe.afterPlace?.(input.assetId);
      return result;
    },
  };
});

let prisma: (typeof import("../server/db"))["prisma"];
let matching: typeof import("./matching");
let bot: typeof import("./bot");
let publisher: typeof import("../server/market-publisher");
let drainOrderHooks: (typeof import("../server/order-hooks"))["drainOrderHooks"];
let bus: ReturnType<typeof createBus>;
let restoreRandom: (() => void) | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 确定性伪随机(mulberry32):机器人的公允价、报价档位与是否吃单都取 Math.random,种子固定则每次跑法相同 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

beforeAll(async () => {
  // realpath:macOS 的 tmpdir 在 /var 下,SQLite 报告的是 /private/var 真实路径,保险丝按前缀比对
  database.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-stp-")));
  database.path = join(database.directory, "stp.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  bus = createBus();
  globalThis.__carbadiaBus = bus;
  ({ prisma } = await import("../server/db"));
  matching = await import("./matching");
  bot = await import("./bot");
  publisher = await import("../server/market-publisher");
  ({ drainOrderHooks } = await import("../server/order-hooks"));
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.startsWith(database.directory)) throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
}, 120_000);

afterAll(async () => {
  publisher?._internal.reset();
  globalThis.__carbadiaBus = undefined;
  globalThis.__carbadiaPresence = undefined;
  globalThis.__carbadiaAccountSnapshot = undefined;
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // 每个用例一个干净的库:机器人的 tick 会给库里每一个标的报价
  await prisma.notification.deleteMany(); // 真人成交的通知(提交后钩子写的)引用用户,先于用户删
  await prisma.trade.deleteMany();
  await prisma.order.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.user.deleteMany();
  await prisma.asset.deleteMany();
});

afterEach(async () => {
  probe.afterPlace = null;
  restoreRandom?.();
  restoreRandom = null;
  vi.restoreAllMocks();
  await publisher._internal.idle();
  await drainOrderHooks(); // 提交后钩子在写通知:等它写完,不然下一个用例清库时撞上它
  publisher._internal.reset();
  globalThis.__carbadiaPresence = undefined;
});

async function createAsset(symbol: string, price: number | null) {
  return prisma.asset.create({
    data: { symbol, name: "STP test", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo", lastPrice: price, anchorPrice: price },
  });
}

const createUser = (email: string, isBot = false) =>
  prisma.user.create({ data: { email, name: email, passwordHash: "x", isBot, cashBalance: BigInt(isBot ? 5_000_000_000 : 100_000_000) } });

/** 每一笔下单提交后读一次盘口,交叉就记下来(不抛:机器人把下单错误吞进 console.error) */
function watchBook() {
  const violations: string[] = [];
  const state = { checks: 0, violations };
  probe.afterPlace = async (assetId) => {
    state.checks += 1;
    const { bids, asks } = await matching.getOrderBook(assetId, 1);
    if (bids.length > 0 && asks.length > 0 && bids[0].price >= asks[0].price) violations.push(`bid ${bids[0].price} >= ask ${asks[0].price}`);
  };
  return state;
}

/** 冻结列与挂单一致:lockedCash = Σ 开口限价买单 price × 余量;每个持仓的 locked = 该标的开口卖单余量(本文件不涉及 OTC) */
async function expectLocksMatchOpenOrders(userId: string) {
  const open = await prisma.order.findMany({ where: { userId, status: { in: ["OPEN", "PARTIAL"] } } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const bidLock = open.filter((o) => o.side === "BUY").reduce((sum, o) => sum + (o.price ?? 0) * (o.quantity - o.filledQuantity), 0);
  expect(Number(user.lockedCash)).toBe(bidLock);
  for (const h of await prisma.holding.findMany({ where: { userId } })) {
    const askLock = open.filter((o) => o.side === "SELL" && o.assetId === h.assetId).reduce((sum, o) => sum + (o.quantity - o.filledQuantity), 0);
    expect(h.locked).toBe(askLock);
  }
}

function quietConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("发布器经 makerOrders 通道发出被撤的本人挂单(market-publisher.ts 不改)", () => {
  it("下单方在线: account 事件里有被撤挂单的 order(status CANCELLED); 盘口快照不交叉; 不在线的对手方没有 account 事件", async () => {
    const asset = await createAsset("STP-PUB-2021", null);
    const a = await createUser("a@stp.test");
    const b = await createUser("b@stp.test");
    await prisma.holding.createMany({ data: [{ userId: a.id, assetId: asset.id, quantity: 100 }, { userId: b.id, assetId: asset.id, quantity: 100 }] });
    // 铺盘口时总线没有订阅者(门控 ①),下单只落库
    const own = await matching.placeOrder({ userId: a.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_083, quantity: 5 });
    await matching.placeOrder({ userId: b.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_100, quantity: 3 });
    await matching.placeOrder({ userId: b.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 7_200, quantity: 2 });

    const presence: Presence = { users: new Map([[a.id, 1]]), topics: new Map([[`book:STP-PUB-2021` as Topic, 1]]) };
    globalThis.__carbadiaPresence = presence;
    const received: BusMessage[] = [];
    const unsubscribe = bus.subscribe((m) => received.push(m));
    try {
      const buy = await matching.placeOrder({ userId: a.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 7_140, quantity: 5 });
      expect(buy.selfTradeCancelled).toBe(1);
      await sleep(120); // 盘口 50 ms 去抖
      await publisher._internal.idle();

      const orderEvents = received
        .filter((m): m is Extract<BusMessage, { kind: "account" }> => m.kind === "account" && m.userId === a.id)
        .flatMap((m) => (m.event.t === "order" ? [m.event.order as Order] : []));
      expect(orderEvents.map((o) => [o.id, o.status, o.filledQuantity, o.cancelReason])).toEqual([
        [buy.order.id, "PARTIAL", 3, null],
        [own.order.id, "CANCELLED", 0, "SELF_TRADE"], // 订单表没有撤单原因列:发布器与 REST 一样按 SELF_TRADE_UNLOCK 流水派生
      ]);
      expect(received.some((m) => m.kind === "account" && m.userId === b.id)).toBe(false);

      const books = received.filter((m): m is Extract<BusMessage, { kind: "book" }> => m.kind === "book");
      expect(books).toHaveLength(1);
      expect(books[0].snapshot.bids[0]).toEqual({ price: 7_140, quantity: 2, orders: 1 });
      expect(books[0].snapshot.asks[0]).toEqual({ price: 7_200, quantity: 2, orders: 1 });
    } finally {
      unsubscribe();
    }
  });
});

describe("做市机器人跑若干 tick 后盘口不交叉", () => {
  it("只有一个机器人账户: 40 个 tick 里每一笔下单提交后买一 < 卖一(或一侧为空), 自成交防护确实触发过, 冻结与挂单一致", async () => {
    const asset = await createAsset("STP-BOT-2021", 10_000);
    const mm = await createUser("mm@stp.bot", true);
    const random = vi.spyOn(Math, "random").mockImplementation(seededRandom(20_260_928));
    restoreRandom = () => random.mockRestore();
    const errors = quietConsoleError();
    const watch = watchBook();

    for (let i = 0; i < 40; i++) await bot._internal.tick();

    expect(watch.violations).toEqual([]);
    expect(watch.checks).toBeGreaterThan(40);
    expect(errors).not.toHaveBeenCalled(); // 撤单 / 下单都没有被拒(例如撤一张已被自成交防护撤掉的单)
    expect(await prisma.ledgerEntry.count({ where: { userId: mm.id, reason: "SELF_TRADE_UNLOCK" } })).toBeGreaterThan(0);
    expect(await prisma.trade.count({ where: { buyerId: mm.id, sellerId: mm.id } })).toBe(0);
    const { bids, asks } = await matching.getOrderBook(asset.id);
    expect(bids.length).toBeGreaterThan(0);
    expect(asks.length).toBeGreaterThan(0);
    await expectLocksMatchOpenOrders(mm.id);
  });

  it("三个机器人账户: 40 个 tick 里每一笔下单提交后都不交叉, 机器人之间照常成交", async () => {
    const asset = await createAsset("STP-BOT3-2021", 10_000);
    const bots = [await createUser("mm1@stp.bot", true), await createUser("mm2@stp.bot", true), await createUser("mm3@stp.bot", true)];
    const random = vi.spyOn(Math, "random").mockImplementation(seededRandom(7));
    restoreRandom = () => random.mockRestore();
    const errors = quietConsoleError();
    const watch = watchBook();

    for (let i = 0; i < 40; i++) await bot._internal.tick();

    expect(watch.violations).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(await prisma.trade.count({ where: { assetId: asset.id } })).toBeGreaterThan(0);
    for (const b of bots) {
      expect(await prisma.trade.count({ where: { buyerId: b.id, sellerId: b.id } })).toBe(0);
      await expectLocksMatchOpenOrders(b.id);
    }
  });

  it("升级前留下的交叉盘口(同一机器人的旧卖单低于较新的买单): 第一个 tick 就撤掉旧卖单, 每一笔下单提交后都不交叉", async () => {
    const asset = await createAsset("STP-LEGACY-2021", 10_000);
    const mm = await createUser("mm@legacy.bot", true);
    // 直接写库复现旧逻辑留下的状态(与 P1-18 看到的形态相同):两张旧卖单 10_010 / 10_020,一张较新的买单 10_030
    await prisma.holding.create({ data: { userId: mm.id, assetId: asset.id, quantity: 1_000_000, locked: 20 } });
    await prisma.user.update({ where: { id: mm.id }, data: { cashBalance: { decrement: BigInt(100_300) }, lockedCash: BigInt(100_300) } });
    const t0 = Date.now() - 60_000;
    const legacy = (side: "BUY" | "SELL", price: number, offsetMs: number) =>
      prisma.order.create({ data: { userId: mm.id, assetId: asset.id, side, type: "LIMIT", price, quantity: 10, status: "OPEN", createdAt: new Date(t0 + offsetMs) } });
    const oldAsk1 = await legacy("SELL", 10_010, 0);
    const oldAsk2 = await legacy("SELL", 10_020, 1_000);
    await legacy("BUY", 10_030, 2_000);
    const before = await matching.getOrderBook(asset.id);
    expect(before.bids[0].price).toBeGreaterThanOrEqual(before.asks[0].price); // 前提:确实是交叉的

    const random = vi.spyOn(Math, "random").mockImplementation(seededRandom(41));
    restoreRandom = () => random.mockRestore();
    const errors = quietConsoleError();
    const watch = watchBook();

    await bot._internal.tick();

    expect(watch.checks).toBeGreaterThan(0);
    expect(watch.violations).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    for (const id of [oldAsk1.id, oldAsk2.id]) {
      expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
    }
    await expectLocksMatchOpenOrders(mm.id);
  });
});
