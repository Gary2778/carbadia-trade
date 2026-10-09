// 提交后钩子 afterOrderCommit(计划 §6.3.2 C5)对真实 SQLite(临时库 + migrate deploy)、真实 placeOrder 的集成测试:
// 离线的真人 maker 被机器人的单吃到也有通知、真人 taker 的 TAKER 通知、真人对真人的 taker + 每个 maker、数量与均价对得上成交;
// 机器人对机器人的成交零数据库工作(名单未知时只查一次名单、已知后同步返回:不入队、零查询);
// 重放 / 撤单 / 自成交防护撤掉的挂单不写;连续两次部分成交各写一条(dedupeKey 不同),同一结果重复交给钩子只有一条;
// 钩子不拖慢也不弄坏下单:写通知卡住时 placeOrder 照常返回、写库失败 / 名单查不到只记日志不抛、写通知一次一条。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../server/bus.mjs";
import type { BusMessage, Presence } from "@/shared/bus";

const database = vi.hoisted(() => ({ directory: "", path: "", client: null as unknown }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// 显式钉在临时库上,绝不触碰 dev.db;带查询事件日志,「零查询」靠它数
vi.mock("./db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  database.client ??= new PrismaClient({ datasourceUrl: `file:${database.path}`, log: [{ emit: "event", level: "query" }] });
  return { prisma: database.client };
});

type Db = (typeof import("./db"))["prisma"];
let prisma: Db;
let matching: typeof import("../exchange/matching");
let hooks: typeof import("./order-hooks");
let publisher: typeof import("./market-publisher");
const sql: string[] = [];
const received: BusMessage[] = [];

let run = 0;
const ctx = { assetId: "", symbol: "", alice: "", bob: "", carol: "", bot1: "", bot2: "" };

beforeAll(async () => {
  database.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-order-hooks-")));
  database.path = join(database.directory, "hooks.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("./db"));
  (prisma as unknown as { $on(event: "query", cb: (e: { query: string }) => void): void }).$on("query", (e) => void sql.push(e.query));
  matching = await import("../exchange/matching");
  hooks = await import("./order-hooks");
  publisher = await import("./market-publisher");
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.startsWith(database.directory)) throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
}, 120_000);

afterAll(async () => {
  publisher?._internal.reset();
  globalThis.__carbadiaBus = undefined;
  globalThis.__carbadiaPresence = undefined;
  globalThis.__carbadiaOrderHooks = undefined;
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  run += 1;
  const asset = await prisma.asset.create({
    data: { symbol: `HOOK-${run}`, name: "Hook test", standard: "VCS", projectType: "Forestry", vintage: 2024, country: "Example", registry: "Demo registry", lastPrice: 10_000 },
  });
  const user = (name: string, isBot = false) =>
    prisma.user.create({ data: { email: `${name}-${run}@hooks.test`, name, passwordHash: "x", isBot, cashBalance: BigInt(1_000_000_000) } });
  const [alice, bob, carol, bot1, bot2] = [await user("alice"), await user("bob"), await user("carol"), await user("bot1", true), await user("bot2", true)];
  await prisma.holding.createMany({ data: [alice, bob, carol, bot1, bot2].map((u) => ({ userId: u.id, assetId: asset.id, quantity: 1_000 })) });
  Object.assign(ctx, { assetId: asset.id, symbol: asset.symbol, alice: alice.id, bob: bob.id, carol: carol.id, bot1: bot1.id, bot2: bot2.id });
  publisher._internal.reset(); // 机器人名单回到「还没查过」:每个用例自己的第一笔成交去查
  globalThis.__carbadiaPresence = undefined;
  received.length = 0;
  const bus = createBus();
  bus.subscribe((msg) => void received.push(msg));
  globalThis.__carbadiaBus = bus;
  sql.length = 0;
});

afterEach(async () => {
  await hooks.drainOrderHooks(); // 不留未写完的通知到下一个用例或库关掉之后
  publisher._internal.reset();
  vi.restoreAllMocks();
});

// ---- 夹具 ----

type Who = "alice" | "bob" | "carol" | "bot1" | "bot2";
const limit = (who: Who, side: "BUY" | "SELL", price: number, quantity: number, clientOrderId?: string) =>
  matching.placeOrder({ userId: ctx[who], assetId: ctx.assetId, side, type: "LIMIT", price, quantity, clientOrderId });
const market = (who: Who, side: "BUY" | "SELL", quantity: number) => matching.placeOrder({ userId: ctx[who], assetId: ctx.assetId, side, type: "MARKET", quantity });
/** 只做事务、不走钩子:拿到结果后由测试自己交给 afterOrderCommit(为了把钩子的查询与撮合的查询分开数) */
const marketTx = (who: Who, side: "BUY" | "SELL", quantity: number) => matching.placeOrderTx({ userId: ctx[who], assetId: ctx.assetId, side, type: "MARKET", quantity });
const limitTx = (who: Who, side: "BUY" | "SELL", price: number, quantity: number) =>
  matching.placeOrderTx({ userId: ctx[who], assetId: ctx.assetId, side, type: "LIMIT", price, quantity });

const noticeRows = async (userId: string) => {
  await hooks.drainOrderHooks();
  const rows = await prisma.notification.findMany({ where: { userId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((row) => ({ kind: row.kind, dedupeKey: row.dedupeKey, payload: JSON.parse(row.payload) }));
};
const noticeCount = async () => {
  await hooks.drainOrderHooks();
  return prisma.notification.count({ where: { userId: { in: [ctx.alice, ctx.bob, ctx.carol, ctx.bot1, ctx.bot2] } } });
};
const botListQueries = () => sql.filter((q) => /isBot`?\s*=/.test(q)).length;
const online = (...users: string[]) => {
  const p: Presence = { users: new Map(users.map((u) => [u, 1])), topics: new Map() };
  globalThis.__carbadiaPresence = p;
};
const pending = () => globalThis.__carbadiaOrderHooks?.pending ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("成交通知的内容", () => {
  it("离线的真人 maker 被机器人的单吃到:落一条 MAKER fill(数量与均价对得上成交);连续两次部分成交各一条、dedupeKey 不同;机器人一侧没有通知", async () => {
    const resting = await limit("alice", "SELL", 10_000, 10); // alice 不在线(没有 hub 连接)
    const first = await market("bot1", "BUY", 4);
    expect(first.trades).toHaveLength(1);
    const second = await market("bot2", "BUY", 6);
    expect(second.trades).toHaveLength(1);

    const orderId = resting.order.id;
    expect(await noticeRows(ctx.alice)).toEqual([
      {
        kind: "fill",
        dedupeKey: `fill:${orderId}:4`,
        payload: { kind: "fill", orderId, symbol: ctx.symbol, side: "SELL", role: "MAKER", quantity: 4, price: 10_000, orderStatus: "PARTIAL" },
      },
      {
        kind: "fill",
        dedupeKey: `fill:${orderId}:10`, // 累计成交量,不是这次的 6
        payload: { kind: "fill", orderId, symbol: ctx.symbol, side: "SELL", role: "MAKER", quantity: 6, price: 10_000, orderStatus: "FILLED" },
      },
    ]);
    expect(await noticeRows(ctx.bot1)).toEqual([]);
    expect(await noticeRows(ctx.bot2)).toEqual([]);
    expect(received.filter((m) => m.kind === "account")).toEqual([]); // 不在线:没有 notice 事件(行是记录,上线后经 REST 取)
  });

  it("真人 taker:自己的可成交单一条 TAKER fill —— quantity = 这次下单成交的吨数,price = 各笔成交的加权均价(分,四舍五入,与订单的 avgFillPrice 同值),orderStatus = 下单之后的状态", async () => {
    await limit("bot1", "SELL", 10_000, 1);
    await limit("bot1", "SELL", 10_001, 2);
    const placed = await limit("alice", "BUY", 10_001, 5); // 吃 3 吨(均价 30 002 / 3 = 10 000.67 → 10 001),余 2 吨挂着
    expect(placed.filledQty).toBe(3);
    expect(placed.order).toMatchObject({ status: "PARTIAL", avgFillPrice: 10_001 });

    expect(await noticeRows(ctx.alice)).toEqual([
      {
        kind: "fill",
        dedupeKey: `fill:${placed.order.id}:3`,
        payload: { kind: "fill", orderId: placed.order.id, symbol: ctx.symbol, side: "BUY", role: "TAKER", quantity: 3, price: 10_001, orderStatus: "PARTIAL" },
      },
    ]);
    expect(await noticeRows(ctx.bot1)).toEqual([]);
  });

  it("没有成交的下单(限价单挂着、市价单没有对手盘)不写通知", async () => {
    await limit("alice", "BUY", 9_000, 5); // 没有卖盘:挂着
    const empty = await market("bob", "BUY", 3); // 市价买碰上一个没有卖单的簿:0 成交、剩余撤销
    expect(empty.filledQty).toBe(0);
    await hooks.drainOrderHooks();
    expect(await noticeCount()).toBe(0);
  });

  it("真人对真人:taker 一条、每张被成交的 maker 单各一条(各用自己的数量 / 价格 / 状态)", async () => {
    const bobSell = await limit("bob", "SELL", 10_000, 3);
    const carolSell = await limit("carol", "SELL", 10_100, 4);
    const taker = await market("alice", "BUY", 6); // bob 3 吨 @10 000(FILLED)、carol 3 吨 @10 100(PARTIAL)
    expect(taker.trades.map((t) => [t.price, t.quantity])).toEqual([[10_000, 3], [10_100, 3]]);

    expect(await noticeRows(ctx.alice)).toEqual([
      {
        kind: "fill",
        dedupeKey: `fill:${taker.order.id}:6`,
        payload: { kind: "fill", orderId: taker.order.id, symbol: ctx.symbol, side: "BUY", role: "TAKER", quantity: 6, price: 10_050, orderStatus: "FILLED" },
      },
    ]);
    expect((await noticeRows(ctx.bob)).map((n) => [n.dedupeKey, n.payload])).toEqual([
      [`fill:${bobSell.order.id}:3`, { kind: "fill", orderId: bobSell.order.id, symbol: ctx.symbol, side: "SELL", role: "MAKER", quantity: 3, price: 10_000, orderStatus: "FILLED" }],
    ]);
    expect((await noticeRows(ctx.carol)).map((n) => [n.dedupeKey, n.payload])).toEqual([
      [`fill:${carolSell.order.id}:3`, { kind: "fill", orderId: carolSell.order.id, symbol: ctx.symbol, side: "SELL", role: "MAKER", quantity: 3, price: 10_100, orderStatus: "PARTIAL" }],
    ]);
  });

  it("用户在线:除了落库还发 notice 账户事件,带最新未读数(只发给在线的那一位)", async () => {
    online(ctx.alice);
    await limit("bot1", "SELL", 10_000, 5);
    const placed = await market("alice", "BUY", 2);
    await hooks.drainOrderHooks();
    const notices = received.flatMap((m) => (m.kind === "account" && m.event.t === "notice" ? [{ userId: m.userId, event: m.event }] : []));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      userId: ctx.alice,
      event: { t: "notice", unread: 1, notice: { kind: "fill", orderId: placed.order.id, role: "TAKER", quantity: 2, price: 10_000, readAt: null } },
    });
  });

  it("自成交防护撤掉的本人挂单(CANCELLED、本次没有成交)不产生 MAKER 通知,taker 的那条照写", async () => {
    const own = await limit("alice", "SELL", 10_000, 2); // 会被她自己的买单撤掉
    await limit("bot1", "SELL", 10_050, 5);
    const taker = await market("alice", "BUY", 3);
    expect(taker.selfTradeCancelled).toBe(1);
    expect(taker.makerOrders.map((m) => m.status)).toEqual(["CANCELLED", "PARTIAL"]);
    const notices = await noticeRows(ctx.alice);
    expect(notices.map((n) => n.dedupeKey)).toEqual([`fill:${taker.order.id}:3`]);
    expect(notices.some((n) => n.payload.orderId === own.order.id)).toBe(false);
  });
});

describe("不写通知的结果", () => {
  it("撤单结果什么都不做;同一 clientOrderId 的重放不写第二条、也不入队;同一份结果重复交给钩子只有一条(dedupeKey 挡住)", async () => {
    const bid = await limit("alice", "BUY", 10_000, 5);
    const cancelled = await matching.cancelOrder(ctx.alice, bid.order.id);
    await hooks.drainOrderHooks();
    expect(await noticeCount()).toBe(0);
    expect(() => hooks.afterOrderCommit(cancelled)).not.toThrow();
    expect(pending()).toBe(0); // 撤单结果当场返回,没有排任务

    await limit("bot1", "SELL", 10_000, 5);
    const clientOrderId = randomUUID();
    const placed = await limit("alice", "BUY", 10_000, 2, clientOrderId);
    expect(placed.replayed).toBe(false);
    expect(await noticeRows(ctx.alice)).toHaveLength(1);

    const replay = await limit("alice", "BUY", 10_000, 2, clientOrderId);
    expect(replay.replayed).toBe(true);
    expect(pending()).toBe(0); // 重放结果:当场返回
    expect(await noticeRows(ctx.alice)).toHaveLength(1);

    hooks.afterOrderCommit(placed); // 同一份(非重放)结果再来一次:排了任务,但 dedupeKey 撞上、什么都不加
    expect(pending()).toBe(1);
    expect(await noticeRows(ctx.alice)).toHaveLength(1);
  });
});

describe("机器人对机器人:零数据库工作", () => {
  it("名单还没查过的第一笔:只为名单查一次库(isBot)、不写通知;名单已知之后同步返回 —— 不入队、零查询", async () => {
    await limitTx("bot1", "SELL", 10_000, 5);
    const cold = await marketTx("bot2", "BUY", 1);
    expect(cold.trades).toHaveLength(1);
    expect(publisher.knownBotUserIds()).toBeNull();

    sql.length = 0;
    hooks.afterOrderCommit(cold);
    expect(pending()).toBe(1); // 名单未知:排队去查
    await hooks.drainOrderHooks();
    expect(botListQueries()).toBe(1);
    expect(sql.filter((q) => /Notification/.test(q))).toEqual([]);
    expect(publisher.knownBotUserIds()).toEqual(expect.arrayContaining([ctx.bot1, ctx.bot2]));

    const warm = await marketTx("bot2", "BUY", 1);
    expect(warm.trades).toHaveLength(1);
    sql.length = 0;
    hooks.afterOrderCommit(warm);
    expect(pending()).toBe(0); // 同步返回:连队列都没进
    await hooks.drainOrderHooks();
    expect(sql).toEqual([]); // 零查询
    expect(await noticeCount()).toBe(0);
  });

  it("机器人循环已把名单放进缓存(seedBotUserIds,bot.ts 的 tick 每轮顺带做):进程里的第一笔机器人对机器人成交就同步返回、零查询;冷启动不放则如上一用例,恰好一次查询", async () => {
    await limitTx("bot1", "SELL", 10_000, 5);
    const first = await marketTx("bot2", "BUY", 1);
    expect(first.trades).toHaveLength(1);
    expect(publisher.knownBotUserIds()).toBeNull(); // 还没有任何人放过名单

    publisher.seedBotUserIds([ctx.bot1, ctx.bot2]);
    expect(publisher.knownBotUserIds()).toEqual([ctx.bot1, ctx.bot2]);
    sql.length = 0;
    hooks.afterOrderCommit(first);
    expect(pending()).toBe(0); // 第一笔就同步返回:没入队
    await hooks.drainOrderHooks();
    expect(sql).toEqual([]); // 零查询,名单也没有再查
    expect(await noticeCount()).toBe(0);

    // 放进缓存的名单照样让真人的成交走队列:机器人 maker、真人 taker 只给真人一条,且仍不为名单查库
    sql.length = 0;
    await market("alice", "BUY", 1);
    expect(await noticeRows(ctx.alice)).toHaveLength(1);
    expect(botListQueries()).toBe(0);
    expect(await noticeRows(ctx.bot1)).toEqual([]);
  });

  it("端到端 placeOrder 的机器人对机器人成交(名单已知)不留 Notification 行、钩子不查名单也不碰 Notification;混着真人的那一笔照写", async () => {
    await publisher.loadBotUserIds(); // 名单已知
    await hooks.drainOrderHooks();
    await limit("bot1", "SELL", 10_000, 5);
    sql.length = 0;
    const result = await market("bot2", "BUY", 2); // placeOrder 自己的事务有查询;钩子没有:Notification / isBot 都不该出现
    expect(result.trades).toHaveLength(1);
    await hooks.drainOrderHooks();
    expect(sql.filter((q) => /Notification/.test(q))).toEqual([]);
    expect(botListQueries()).toBe(0);
    expect(await noticeCount()).toBe(0);

    await market("alice", "BUY", 1); // 机器人 maker、真人 taker:只有真人一条
    expect(await noticeCount()).toBe(1);
    expect(await noticeRows(ctx.alice)).toHaveLength(1);
  });
});

describe("不拖慢、不弄坏下单", () => {
  it("写通知被卡住时 placeOrder 照常返回(钩子不被 await);放开之后通知才落库", async () => {
    await limit("bot1", "SELL", 10_000, 5);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realCreate = prisma.notification.create.bind(prisma.notification);
    const create = vi.spyOn(prisma.notification, "create").mockImplementation(((args: Parameters<typeof realCreate>[0]) => gate.then(() => realCreate(args))) as never);

    const result = await market("alice", "BUY", 3); // 钩子的 create 还卡在 gate 上,下单已经返回
    expect(result).toMatchObject({ filledQty: 3, replayed: false, order: { status: "FILLED", filledQuantity: 3 } });
    expect(pending()).toBe(1);
    await sleep(30);
    expect(await prisma.notification.count({ where: { userId: ctx.alice } })).toBe(0);

    release();
    await hooks.drainOrderHooks();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await noticeRows(ctx.alice)).toHaveLength(1);
  });

  it("写库失败(create 抛错)时 afterOrderCommit 不抛、drain 不 reject,只记一行结构化日志;下单结果不受影响", async () => {
    await limit("bot1", "SELL", 10_000, 5);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.notification, "create").mockRejectedValue(new Error("disk I/O error"));
    const taker = await limitTx("alice", "BUY", 10_000, 2);

    expect(() => hooks.afterOrderCommit(taker)).not.toThrow();
    await expect(hooks.drainOrderHooks()).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({ src: "notices", ev: "notify_failed", userId: ctx.alice, error: "disk I/O error" });
    expect(await prisma.notification.count({ where: { userId: ctx.alice } })).toBe(0);
    expect(taker).toMatchObject({ filledQty: 2, order: { status: "FILLED" } });
  });

  it("机器人名单查不到(查库失败)时这一批不写、不把机器人当真人;名单恢复后下一批照写", async () => {
    await limit("bot1", "SELL", 10_000, 10);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lookup = vi.spyOn(prisma.user, "findMany").mockRejectedValueOnce(new Error("database is locked"));
    const botTaker = await marketTx("bot2", "BUY", 1);
    hooks.afterOrderCommit(botTaker);
    await expect(hooks.drainOrderHooks()).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await noticeCount()).toBe(0); // 机器人 taker + 机器人 maker:名单未知也不给它们写
    expect(errors.mock.calls.map(([line]) => String(line)).some((line) => line.includes("bot user lookup failed"))).toBe(true);
    expect(publisher.knownBotUserIds()).toBeNull(); // 没有把「查失败」缓存成「没有机器人」

    await market("alice", "BUY", 1); // 这次名单查得到
    expect(await noticeRows(ctx.alice)).toHaveLength(1);
    expect(await noticeRows(ctx.bot1)).toEqual([]);
  });

  it("入参不对(null / 空对象)也不抛、不排任务", () => {
    expect(() => hooks.afterOrderCommit(null as never)).not.toThrow();
    expect(() => hooks.afterOrderCommit({} as never)).not.toThrow();
    expect(pending()).toBe(0);
  });

  it("写通知一次一条:两张单的通知不会并发写库,顺序 = 提交顺序", async () => {
    await limit("bot1", "SELL", 10_000, 10);
    const realCreate = prisma.notification.create.bind(prisma.notification);
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(prisma.notification, "create").mockImplementation((async (args: Parameters<typeof realCreate>[0]) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(20);
      try {
        return await realCreate(args);
      } finally {
        inFlight -= 1;
      }
    }) as never);
    const first = await market("alice", "BUY", 1);
    const second = await market("bob", "BUY", 1);
    expect(pending()).toBe(2); // 两个任务都排着(第一个还在 sleep)
    await hooks.drainOrderHooks();
    expect(peak).toBe(1);
    const rows = await prisma.notification.findMany({ where: { userId: { in: [ctx.alice, ctx.bob] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    expect(rows.map((row) => row.userId)).toEqual([ctx.alice, ctx.bob]);
    expect(first.order.userId).toBe(ctx.alice);
    expect(second.order.userId).toBe(ctx.bob);
  });
});
