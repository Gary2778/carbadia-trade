// 触发引擎(计划 §6.3.2 C4)对真实 SQLite(临时库 + migrate deploy)、真实 placeOrder、真实总线的集成测试:
// 到价触发(ABOVE / BELOW,委托的 clientOrderId = 条件单 id)、未到价不触发、撤销后不触发、OCO 一个触发另一个撤、
// 同一条成交消息重复投递与「重启」(停引擎再起、留一行 TRIGGERING)不双发、余额 / 持仓不足记 REJECTED 并写通知、
// 下单忙时留在 TRIGGERING 并由 30 s 定时器的恢复补完、机器人对机器人的成交触发人类的条件单且机器人不收通知、
// 没有 hub 与 presence(START_MODE=next)时同一笔成交之后 drain 一次即触发(不靠定时器)、订阅回调同步且不抛、
// 「可能有 PENDING」标志为假时机器人成交零查询。
// 审查修复(计划 §9.1 第 60 条):市价单 0 成交记 REJECTED / NO_FILL(新下与重放同一结论)、条件单不被它创建之前的成交触发、
// 触发超过 10 分钟仍在 TRIGGERING 的行不再下单、直接收尾成 REJECTED / INVALID(已有委托按它收尾)、OCO 同组的通知写在下单之后、通知清理不挡触发、生产路径(不调 drain)也触发。
// 下单的故障注入:按 clientOrderId(= 条件单 id)一次性地让 placeOrder 先抛 BusyError(忙),或在提交之后抛错(模拟进程在收尾前死掉)。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../server/bus.mjs";
import type { BusMessage } from "@/shared/bus";
import type { CreateTriggerRequest } from "@/shared/api-shapes";
import type { TapeEntry, Trigger } from "@/shared/types";

const database = vi.hoisted(() => ({ directory: "", path: "" }));
const faults = vi.hoisted(() => new Map<string, "busy" | "crash">());
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// 显式钉在临时库上,绝不触碰 dev.db
vi.mock("./db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${database.path}` }) };
});

vi.mock("../exchange/matching", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../exchange/matching")>();
  return {
    ...actual,
    placeOrder: async (input: Parameters<typeof actual.placeOrder>[0]) => {
      const fault = input.clientOrderId ? faults.get(input.clientOrderId) : undefined;
      if (input.clientOrderId) faults.delete(input.clientOrderId);
      if (fault === "busy") throw new actual.BusyError();
      const result = await actual.placeOrder(input);
      if (fault === "crash") throw new Error("process died after the order committed");
      return result;
    },
  };
});

let prisma: (typeof import("./db"))["prisma"];
let matching: typeof import("../exchange/matching");
let engine: typeof import("./trigger-engine");
let triggers: typeof import("./triggers");
let publisher: typeof import("./market-publisher");
let drainOrderHooks: (typeof import("./order-hooks"))["drainOrderHooks"];
let bus: ReturnType<typeof createBus>;
const received: BusMessage[] = [];

let run = 0;
const ctx = { assetId: "", symbol: "", alice: "", bob: "", bot1: "", bot2: "" };

beforeAll(async () => {
  database.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-triggers-")));
  database.path = join(database.directory, "triggers.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("./db"));
  matching = await import("../exchange/matching");
  engine = await import("./trigger-engine");
  triggers = await import("./triggers");
  publisher = await import("./market-publisher");
  ({ drainOrderHooks } = await import("./order-hooks"));
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.startsWith(database.directory)) throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
}, 120_000);

afterAll(async () => {
  await engine?.stopTriggerEngine();
  publisher?._internal.reset();
  globalThis.__carbadiaBus = undefined;
  globalThis.__carbadiaPresence = undefined;
  globalThis.__carbadiaAccountSnapshot = undefined;
  globalThis.__carbadiaBookRefresh = undefined;
  globalThis.__carbadiaRecentTrades = undefined;
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // 每个用例一个干净的条件单 / 通知表(「可能有 PENDING」的校准看的是全站),新的标的与用户
  await prisma.notification.deleteMany();
  await prisma.trigger.deleteMany();
  run += 1;
  const asset = await prisma.asset.create({
    data: { symbol: `TRG-TEST-${run}`, name: "Trigger test", standard: "VCS", projectType: "Forestry", vintage: 2024, country: "Example", registry: "Demo registry", lastPrice: 10_000 },
  });
  const user = (name: string, isBot = false, cash = 100_000_000) =>
    prisma.user.create({ data: { email: `${name}-${run}@triggers.test`, name, passwordHash: "x", isBot, cashBalance: BigInt(cash) } });
  const [alice, bob, bot1, bot2] = [await user("alice"), await user("bob"), await user("bot1", true), await user("bot2", true)];
  await prisma.holding.createMany({
    data: [
      { userId: bob.id, assetId: asset.id, quantity: 100 },
      { userId: bot1.id, assetId: asset.id, quantity: 10_000 },
      { userId: bot2.id, assetId: asset.id, quantity: 10_000 },
    ],
  });
  Object.assign(ctx, { assetId: asset.id, symbol: asset.symbol, alice: alice.id, bob: bob.id, bot1: bot1.id, bot2: bot2.id });
  faults.clear();
  received.length = 0;
  bus = createBus();
  globalThis.__carbadiaBus = bus;
  bus.subscribe((msg) => void received.push(msg));
  vi.spyOn(console, "log").mockImplementation(() => {}); // 引擎启动 / 恢复的一行日志
  engine.startTriggerEngine();
});

afterEach(async () => {
  await engine.drainTriggerEngine();
  await engine.stopTriggerEngine();
  vi.useRealTimers();
  await drainOrderHooks(); // 真人成交的通知由提交后钩子写:等它写完,不留到下一个用例或库关掉之后
  await publisher._internal.idle();
  publisher._internal.reset();
  globalThis.__carbadiaPresence = undefined;
  vi.restoreAllMocks();
});

// ---- 夹具 ----

/** 机器人对机器人的一笔成交(向上走):bot1 在 price 挂卖 1 吨,bot2 市价买 1 吨 */
async function botTradeAt(price: number) {
  await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "SELL", type: "LIMIT", price, quantity: 1 });
  await matching.placeOrder({ userId: ctx.bot2, assetId: ctx.assetId, side: "BUY", type: "MARKET", quantity: 1 });
}

/** 机器人对机器人的一笔成交(向下走):bot1 在 price 挂买 bid 吨,bot2 市价卖 1 吨;剩下 bid − 1 吨留在簿上接被触发的卖单 */
async function botTradeDownAt(price: number, bid = 1) {
  await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "BUY", type: "LIMIT", price, quantity: bid });
  await matching.placeOrder({ userId: ctx.bot2, assetId: ctx.assetId, side: "SELL", type: "MARKET", quantity: 1 });
}

/** 请求体去掉 assetId / clientKey(按 kind 分别去,联合不塌成公共字段) */
type TriggerDraft = CreateTriggerRequest extends infer T ? (T extends unknown ? Omit<T, "assetId" | "clientKey"> : never) : never;

function create(userId: string, body: TriggerDraft): Promise<Trigger> {
  return triggers.createTrigger(userId, { ...body, assetId: ctx.assetId, clientKey: randomUUID() });
}

/** 一条合成的逐笔成交(引擎只看价格) */
const tape = (id: string, price: number): TapeEntry => ({ id, symbol: ctx.symbol, price, quantity: 1, takerSide: "BUY", ts: Date.now(), auditRef: `SIM-TRD-${id}` });

const row = (id: string) => prisma.trigger.findUniqueOrThrow({ where: { id } });
const ordersFor = (clientOrderIds: string[]) => prisma.order.findMany({ where: { clientOrderId: { in: clientOrderIds } } });
/** 本人的通知,旧的在前。默认只看引擎写的(trigger / price_alert):真人的委托成交了,提交后钩子还会另写 fill 通知(order-hooks.integration.test.ts 管它),fills 为真时才算上 */
const noticesOf = async (userId: string, fills = false) => {
  await drainOrderHooks();
  const rows = await prisma.notification.findMany({ where: { userId, ...(fills ? {} : { kind: { not: "fill" } }) }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((n) => ({ kind: n.kind, dedupeKey: n.dedupeKey, payload: JSON.parse(n.payload) }));
};
const triggerEvents = (id: string) =>
  received.flatMap((m) => (m.kind === "account" && m.event.t === "trigger" && m.event.trigger.id === id ? [m.event.trigger.status] : []));

/** 让一行看起来已经在 TRIGGERING 里停了 10 s(恢复只接手超过 5 s 的) */
const backdate = (id: string) => prisma.$executeRaw`UPDATE "Trigger" SET "updatedAt" = ${Date.now() - 10_000} WHERE "id" = ${id}`;

describe("到价触发", () => {
  it("ABOVE:成交价达到触发价就下单,委托的 clientOrderId = 条件单 id;TRIGGERING → TRIGGERED 两条事件与一条 TRIGGERED 通知", async () => {
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 11_000, quantity: 2 });
    await botTradeAt(10_400); // 差一分
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("PENDING");

    await botTradeAt(10_500);
    await engine.drainTriggerEngine();
    const fired = await row(t.id);
    const [order] = await ordersFor([t.id]);
    expect(fired).toMatchObject({ status: "TRIGGERED", reason: null, orderId: order.id, firedPrice: 10_500 });
    expect(fired.firedAt).toBeInstanceOf(Date);
    expect(order).toMatchObject({ userId: ctx.alice, clientOrderId: t.id, side: "BUY", type: "LIMIT", price: 11_000, quantity: 2, status: "OPEN" });
    expect(triggerEvents(t.id)).toEqual(["PENDING", "TRIGGERING", "TRIGGERED"]);
    expect(await noticesOf(ctx.alice)).toEqual([
      {
        kind: "trigger",
        dedupeKey: `trigger:${t.id}:TRIGGERED`,
        payload: { kind: "trigger", triggerId: t.id, symbol: ctx.symbol, outcome: "TRIGGERED", reason: null, side: "BUY", quantity: 2, triggerPrice: 10_500, orderId: order.id },
      },
    ]);
  });

  it("BELOW:成交价跌到触发价就以市价卖出(成交在留下的买盘上)", async () => {
    const t = await create(ctx.bob, { kind: "ORDER", direction: "BELOW", triggerPrice: 9_500, side: "SELL", orderType: "MARKET", quantity: 3 });
    await botTradeDownAt(9_600); // 差一档
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("PENDING");

    await botTradeDownAt(9_500, 10);
    await engine.drainTriggerEngine();
    const [order] = await ordersFor([t.id]);
    expect(await row(t.id)).toMatchObject({ status: "TRIGGERED", orderId: order.id, firedPrice: 9_500, limitPrice: null });
    expect(order).toMatchObject({ userId: ctx.bob, clientOrderId: t.id, side: "SELL", type: "MARKET", price: null, quantity: 3, filledQuantity: 3, status: "FILLED" });
    expect((await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: ctx.bob, assetId: ctx.assetId } } })).quantity).toBe(97);
  });

  it("一批成交里取最高 / 最低价:同一条 trades 消息里先跌后涨,ABOVE 与 BELOW 都触发,firedPrice 各是最高价与最低价", async () => {
    const up = await create(ctx.alice, { kind: "ALERT", direction: "ABOVE", triggerPrice: 10_200 });
    const down = await create(ctx.alice, { kind: "ALERT", direction: "BELOW", triggerPrice: 9_800 });
    bus.publish({ kind: "trades", symbol: ctx.symbol, trades: [tape("x1", 9_700), tape("x2", 10_000), tape("x3", 10_300)] });
    await engine.drainTriggerEngine();
    expect(await row(up.id)).toMatchObject({ status: "TRIGGERED", firedPrice: 10_300 });
    expect(await row(down.id)).toMatchObject({ status: "TRIGGERED", firedPrice: 9_700 });
  });

  it("引擎自己下的单产生的成交再进总线,同一次 drain 里触发下一条(不递归)", async () => {
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "BUY", type: "LIMIT", price: 9_800, quantity: 10 }); // 接卖单的买盘
    const sell = await create(ctx.bob, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "SELL", orderType: "MARKET", quantity: 5 });
    const alert = await create(ctx.alice, { kind: "ALERT", direction: "BELOW", triggerPrice: 9_800 });
    await botTradeAt(10_500); // bob 的止盈触发 → 市价卖 5 吨,成交在 9_800 → alice 的提醒触发
    await engine.drainTriggerEngine();
    expect((await row(sell.id)).status).toBe("TRIGGERED");
    expect(await row(alert.id)).toMatchObject({ status: "TRIGGERED", firedPrice: 9_800 });
  });
});

describe("撤销、OCO、幂等", () => {
  it("撤掉的条件单永不触发;撤一条已不是 PENDING 的 → TriggerConflictError(路由 409)", async () => {
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "MARKET", quantity: 1 });
    const cancelled = await triggers.cancelTrigger(ctx.alice, t.id);
    expect(cancelled).toMatchObject({ id: t.id, status: "CANCELLED", reason: "USER" });
    await botTradeAt(10_600);
    await engine.drainTriggerEngine();
    expect(await row(t.id)).toMatchObject({ status: "CANCELLED", reason: "USER", orderId: null, firedPrice: null });
    expect(await ordersFor([t.id])).toEqual([]);
    await expect(triggers.cancelTrigger(ctx.alice, t.id)).rejects.toBeInstanceOf(triggers.TriggerConflictError);

    const fired = await create(ctx.alice, { kind: "ALERT", direction: "ABOVE", triggerPrice: 10_700 });
    await botTradeAt(10_700);
    await engine.drainTriggerEngine();
    expect((await row(fired.id)).status).toBe("TRIGGERED");
    await expect(triggers.cancelTrigger(ctx.alice, fired.id)).rejects.toBeInstanceOf(triggers.TriggerConflictError);
    await expect(triggers.cancelTrigger(ctx.bob, fired.id)).rejects.toThrow("Trigger not found"); // 不是本人的
  });

  it("OCO:止盈触发 → 止损变 CANCELLED / OCO(事件 + 通知,通知写在止盈下单之后),只有一张委托;之后跌破止损价也不再下单", async () => {
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "BUY", type: "LIMIT", price: 10_000, quantity: 10 }); // 接止盈卖单的买盘
    const [tp, sl] = await triggers.createOco(ctx.bob, { assetId: ctx.assetId, quantity: 10, takeProfit: 11_000, stopLoss: 9_000, clientKey: randomUUID() });
    expect(tp.ocoGroupId).toBe(sl.ocoGroupId);
    await botTradeAt(11_000);
    await engine.drainTriggerEngine();
    const [order] = await ordersFor([tp.id]);
    expect(await row(tp.id)).toMatchObject({ status: "TRIGGERED", orderId: order.id });
    expect(order).toMatchObject({ filledQuantity: 10, status: "FILLED" });
    expect(await row(sl.id)).toMatchObject({ status: "CANCELLED", reason: "OCO", orderId: null });
    expect(triggerEvents(sl.id)).toEqual(["PENDING", "CANCELLED"]);
    const bobNotices = await noticesOf(ctx.bob);
    expect(bobNotices.map((n) => n.dedupeKey)).toEqual([`trigger:${tp.id}:TRIGGERED`, `trigger:${sl.id}:CANCELLED`]); // 同组的通知不挡在下单前面
    expect(bobNotices[1]).toEqual({
      kind: "trigger",
      dedupeKey: `trigger:${sl.id}:CANCELLED`,
      payload: { kind: "trigger", triggerId: sl.id, symbol: ctx.symbol, outcome: "CANCELLED", reason: "OCO", side: "SELL", quantity: 10, triggerPrice: 9_000, orderId: null },
    });
    // 人类的触发单成交了:引擎的 trigger 通知之外,提交后钩子另写一条 fill(TAKER,这张止盈单成交的 10 吨与均价)—— 两条都要
    expect((await noticesOf(ctx.bob, true)).filter((n) => n.kind === "fill")).toEqual([
      {
        kind: "fill",
        dedupeKey: `fill:${order.id}:10`,
        payload: { kind: "fill", orderId: order.id, symbol: ctx.symbol, side: "SELL", role: "TAKER", quantity: 10, price: 10_000, orderStatus: "FILLED" },
      },
    ]);
    const siblingNotice = await prisma.notification.findFirstOrThrow({ where: { dedupeKey: `trigger:${sl.id}:CANCELLED` } });
    expect(siblingNotice.createdAt.getTime()).toBeGreaterThanOrEqual(order.createdAt.getTime());
    await botTradeDownAt(9_000);
    await engine.drainTriggerEngine();
    expect(await ordersFor([tp.id, sl.id])).toHaveLength(1);
    expect((await ordersFor([tp.id]))[0].userId).toBe(ctx.bob);
  });

  it("OCO:两条腿在同一批里都到价 → 先建的止盈抢到,止损撤销,仍只有一张委托", async () => {
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "BUY", type: "LIMIT", price: 10_000, quantity: 5 }); // 接止盈卖单的买盘
    const [tp, sl] = await triggers.createOco(ctx.bob, { assetId: ctx.assetId, quantity: 5, takeProfit: 10_500, stopLoss: 9_500, clientKey: randomUUID() });
    bus.publish({ kind: "trades", symbol: ctx.symbol, trades: [tape("y1", 9_400), tape("y2", 10_600)] });
    await engine.drainTriggerEngine();
    expect((await row(tp.id)).status).toBe("TRIGGERED");
    expect(await row(sl.id)).toMatchObject({ status: "CANCELLED", reason: "OCO" });
    expect(await ordersFor([tp.id, sl.id])).toHaveLength(1);
  });

  it("同一条成交消息投递两次(同一批里两次、drain 之后再一次)→ 只下一张单", async () => {
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_600, quantity: 1 });
    await botTradeAt(10_500);
    const tradesMessage = received.find((m) => m.kind === "trades" && m.trades.some((e) => e.price === 10_500));
    expect(tradesMessage).toBeDefined();
    bus.publish(tradesMessage!);
    await engine.drainTriggerEngine();
    bus.publish(tradesMessage!);
    await engine.drainTriggerEngine();
    expect(await ordersFor([t.id])).toHaveLength(1);
    expect((await row(t.id)).status).toBe("TRIGGERED");
    expect(await prisma.notification.count({ where: { userId: ctx.alice } })).toBe(1);
  });

  it("重启:下单提交了、收尾前进程没了(行留在 TRIGGERING)→ 5 s 内重启不接手;之后重启由恢复重放同一张单补完,不下第二张、通知只一条", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_600, quantity: 1 });
    faults.set(t.id, "crash");
    await botTradeAt(10_500);
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("TRIGGERING");
    const [order] = await ordersFor([t.id]);
    expect(order).toBeDefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('"ev":"place_failed"'));

    await engine.stopTriggerEngine();
    engine.startTriggerEngine(); // 刚停下 < 5 s:可能还有一次下单在途,恢复不碰它
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("TRIGGERING");

    await backdate(t.id);
    await engine.stopTriggerEngine();
    engine.startTriggerEngine();
    await engine.drainTriggerEngine();
    expect(await row(t.id)).toMatchObject({ status: "TRIGGERED", orderId: order.id, firedPrice: 10_500 });
    expect(await ordersFor([t.id])).toHaveLength(1);
    expect(await prisma.notification.count({ where: { userId: ctx.alice } })).toBe(1);
  });
});

describe("被拒与恢复", () => {
  it("触发时现金不够(限价买)→ REJECTED / INSUFFICIENT_CASH;可用持仓不够(卖)→ REJECTED / INSUFFICIENT_QTY;各一条 REJECTED 通知,没有委托", async () => {
    const broke = await prisma.user.create({ data: { email: `broke-${run}@triggers.test`, name: "Broke", passwordHash: "x", cashBalance: BigInt(0) } });
    const buy = await create(broke.id, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 11_000, quantity: 1 });
    const sell = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "SELL", orderType: "MARKET", quantity: 5 }); // alice 没有持仓
    await botTradeAt(10_500);
    await engine.drainTriggerEngine();
    expect(await row(buy.id)).toMatchObject({ status: "REJECTED", reason: "INSUFFICIENT_CASH", orderId: null, firedPrice: 10_500 });
    expect(await row(sell.id)).toMatchObject({ status: "REJECTED", reason: "INSUFFICIENT_QTY", orderId: null });
    expect(await ordersFor([buy.id, sell.id])).toEqual([]);
    expect((await noticesOf(broke.id)).map((n) => [n.dedupeKey, n.payload.outcome, n.payload.reason])).toEqual([[`trigger:${buy.id}:REJECTED`, "REJECTED", "INSUFFICIENT_CASH"]]);
    expect((await noticesOf(ctx.alice)).map((n) => [n.payload.outcome, n.payload.reason])).toEqual([["REJECTED", "INSUFFICIENT_QTY"]]);
  });

  it("下单忙(BusyError)→ 留在 TRIGGERING、没有委托;30 s 定时器的恢复把停了 5 s 以上的行补完", async () => {
    await engine.stopTriggerEngine();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // 只假恢复定时器;setImmediate 与 Prisma 用的计时器照常
    engine.startTriggerEngine();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "MARKET", quantity: 1 });
    faults.set(t.id, "busy");
    await botTradeAt(10_500);
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("TRIGGERING");
    expect(await ordersFor([t.id])).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('"ev":"place_failed"'));

    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "SELL", type: "LIMIT", price: 10_800, quantity: 1 }); // 恢复时市价买单吃得到的卖盘
    await backdate(t.id);
    vi.advanceTimersByTime(engine.RECOVERY_INTERVAL_MS);
    await engine.drainTriggerEngine();
    const [order] = await ordersFor([t.id]);
    expect(await row(t.id)).toMatchObject({ status: "TRIGGERED", orderId: order.id });
    expect(order).toMatchObject({ clientOrderId: t.id, side: "BUY", type: "MARKET", filledQuantity: 1 });
  });
});

describe("机器人、无 hub、订阅回调", () => {
  it("机器人对机器人的成交触发人类的价格提醒(price_alert 通知 + 在线时的 notice 事件);机器人一条通知都没有", async () => {
    globalThis.__carbadiaPresence = { users: new Map([[ctx.alice, 1]]), topics: new Map() };
    const t = await create(ctx.alice, { kind: "ALERT", direction: "BELOW", triggerPrice: 9_900 });
    await botTradeDownAt(9_900);
    await engine.drainTriggerEngine();
    expect(await row(t.id)).toMatchObject({ status: "TRIGGERED", firedPrice: 9_900, orderId: null });
    expect(await noticesOf(ctx.alice)).toEqual([
      { kind: "price_alert", dedupeKey: `alert:${t.id}`, payload: { kind: "price_alert", triggerId: t.id, symbol: ctx.symbol, direction: "BELOW", triggerPrice: 9_900, firedPrice: 9_900 } },
    ]);
    const notices = received.flatMap((m) => (m.kind === "account" && m.event.t === "notice" ? [m] : []));
    expect(notices).toEqual([expect.objectContaining({ userId: ctx.alice, event: expect.objectContaining({ t: "notice", unread: 1, notice: expect.objectContaining({ kind: "price_alert", triggerId: t.id }) }) })]);
    expect(await prisma.notification.count({ where: { userId: { in: [ctx.bot1, ctx.bot2] } } })).toBe(0);
  });

  it("START_MODE=next 的条件(没有 hub、没有 presence):引擎自己订阅后发布器照样发 trades;同一笔成交之后 drain 一次就触发,不靠定时器", async () => {
    await engine.stopTriggerEngine();
    globalThis.__carbadiaBus = undefined; // 没有 server.mjs:第一次 getBus() 才建
    globalThis.__carbadiaPresence = undefined;
    engine.startTriggerEngine();
    const liveBus = () => globalThis.__carbadiaBus; // 经函数读:上面置 undefined 之后的窄化不作数
    expect(liveBus()?.hasSubscribers()).toBe(true);
    expect(liveBus()).not.toBe(bus);
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_600, quantity: 1 });
    await botTradeAt(10_500);
    const startedAt = performance.now();
    await engine.drainTriggerEngine(); // 只跑排着的 setImmediate;30 s 定时器没到
    expect(performance.now() - startedAt).toBeLessThan(2_500); // ≤ 1 个机器人节拍(BOT_TICK_MS 默认 2500)
    const [order] = await ordersFor([t.id]);
    expect(await row(t.id)).toMatchObject({ status: "TRIGGERED", orderId: order.id });
  });

  it("订阅回调同步返回、不抛:形状不对的消息被忽略(总线不记订阅者异常),合法的 trades 只入队、回调里不查库", async () => {
    await engine.stopTriggerEngine();
    const subscribe = vi.spyOn(bus, "subscribe");
    engine.startTriggerEngine();
    const callback = subscribe.mock.calls[0][0];
    const findMany = vi.spyOn(prisma.trigger, "findMany");
    const count = vi.spyOn(prisma.trigger, "count");
    const malformed: unknown[] = [
      null,
      "trades",
      { kind: "trades" },
      { kind: "trades", symbol: 42, trades: [] },
      { kind: "trades", symbol: ctx.symbol, trades: "x" },
      { kind: "trades", symbol: ctx.symbol, trades: [null, { price: "10", ts: 1 }, { price: Infinity, ts: 1 }, { price: Number.NaN, ts: 1 }] },
      // 价格对、时间不对(缺、负数、Date 表示不了):没法证明成交晚于条件单,跳过
      { kind: "trades", symbol: ctx.symbol, trades: [{ price: 10_000 }, { price: 10_000, ts: -1 }, { price: 10_000, ts: 1e300 }, { price: 10_000, ts: "now" }] },
      { kind: "account", userId: "u", event: null },
    ];
    for (const msg of malformed) {
      expect(callback(JSON.parse(JSON.stringify(msg ?? null)))).toBeUndefined();
      bus.publish(JSON.parse(JSON.stringify(msg ?? null)));
    }
    expect(bus.subscriberErrors()).toBe(0);
    expect(globalThis.__carbadiaTriggerEngine?.queue.size).toBe(0);

    const result = callback({ kind: "trades", symbol: ctx.symbol, trades: [{ id: "z", symbol: ctx.symbol, price: 10_100, quantity: 1, takerSide: "BUY", ts: 0, auditRef: "SIM-TRD-z" }] });
    expect(result).toBeUndefined(); // 不是 Promise
    expect(globalThis.__carbadiaTriggerEngine?.queue.get(ctx.symbol)).toEqual({ min: 10_100, minTs: 0, max: 10_100, maxTs: 0 });
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    await engine.drainTriggerEngine();
    expect(globalThis.__carbadiaTriggerEngine?.queue.size).toBe(0);
  });

  it("「可能有 PENDING」为假时机器人成交零查询;创建条件单把它置真,下一笔成交就触发;count 期间有人创建,这次的 0 不作数", async () => {
    await botTradeAt(10_100); // 启动后第一次处理:count 校准 → 0 → 标志为假
    await engine.drainTriggerEngine();
    expect(globalThis.__carbadiaTriggerEngine?.mayHavePending).toBe(false);

    const findMany = vi.spyOn(prisma.trigger, "findMany");
    const count = vi.spyOn(prisma.trigger, "count");
    await botTradeAt(10_200);
    await botTradeAt(10_300);
    await engine.drainTriggerEngine();
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();

    // 校验没过(方向与最新价 10_300 不一致)的创建不碰标志;过了的在写库前置真
    await expect(create(ctx.alice, { kind: "ALERT", direction: "ABOVE", triggerPrice: 10_300 })).rejects.toThrow("wouldTriggerNow");
    expect(globalThis.__carbadiaTriggerEngine?.mayHavePending).toBe(false);
    const t = await create(ctx.alice, { kind: "ALERT", direction: "ABOVE", triggerPrice: 10_600 });
    expect(globalThis.__carbadiaTriggerEngine?.mayHavePending).toBe(true);
    await botTradeAt(10_600);
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("TRIGGERED");

    // 校准查询在途时有人创建了条件单(markTriggersPending 改了代数):这次 count 的结果不能把标志改成假
    const state = globalThis.__carbadiaTriggerEngine!;
    state.checkedAt = 0;
    bus.publish({ kind: "trades", symbol: ctx.symbol, trades: [{ id: "w", symbol: ctx.symbol, price: 10_000, quantity: 1, takerSide: "BUY", ts: 0, auditRef: "SIM-TRD-w" }] });
    count.mockClear();
    const draining = engine.drainTriggerEngine(); // 同步跑到 count 的 await 为止
    expect(count).toHaveBeenCalledTimes(1);
    engine.markTriggersPending();
    await draining;
    expect(state.mayHavePending).toBe(true);
  });
});

describe("市价单 0 成交、创建之前的成交、10 分钟上限", () => {
  it("市价买单没钱、市价卖单碰上空买盘 → REJECTED / NO_FILL,orderId 照记,通知 outcome REJECTED / reason NO_FILL", async () => {
    const broke = await prisma.user.create({ data: { email: `broke-${run}@triggers.test`, name: "Broke", passwordHash: "x", cashBalance: BigInt(0) } });
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "SELL", type: "LIMIT", price: 10_800, quantity: 5 }); // 有卖盘,只是买不起
    const buy = await create(broke.id, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "MARKET", quantity: 1 });
    const sell = await create(ctx.bob, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "SELL", orderType: "MARKET", quantity: 3 }); // 簿上没有买盘
    await botTradeAt(10_500);
    await engine.drainTriggerEngine();
    const [buyOrder] = await ordersFor([buy.id]);
    const [sellOrder] = await ordersFor([sell.id]);
    expect(buyOrder).toMatchObject({ type: "MARKET", filledQuantity: 0, status: "CANCELLED" });
    expect(sellOrder).toMatchObject({ type: "MARKET", filledQuantity: 0, status: "CANCELLED" });
    expect(await row(buy.id)).toMatchObject({ status: "REJECTED", reason: "NO_FILL", orderId: buyOrder.id, firedPrice: 10_500 });
    expect(await row(sell.id)).toMatchObject({ status: "REJECTED", reason: "NO_FILL", orderId: sellOrder.id });
    expect(triggerEvents(buy.id)).toEqual(["PENDING", "TRIGGERING", "REJECTED"]);
    expect(await noticesOf(broke.id)).toEqual([
      {
        kind: "trigger",
        dedupeKey: `trigger:${buy.id}:REJECTED`,
        payload: { kind: "trigger", triggerId: buy.id, symbol: ctx.symbol, outcome: "REJECTED", reason: "NO_FILL", side: "BUY", quantity: 1, triggerPrice: 10_500, orderId: buyOrder.id },
      },
    ]);
    expect((await noticesOf(ctx.bob)).map((n) => [n.payload.outcome, n.payload.reason, n.payload.orderId])).toEqual([["REJECTED", "NO_FILL", sellOrder.id]]);
  });

  it("恢复重放市价单:成交过的那张仍记 TRIGGERED(看订单行的累计成交量),0 成交的那张记 REJECTED / NO_FILL;都不下第二张", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "BUY", type: "LIMIT", price: 10_000, quantity: 3 }); // 只够第一张卖单
    const filled = await create(ctx.bob, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "SELL", orderType: "MARKET", quantity: 3 });
    const empty = await create(ctx.bob, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "SELL", orderType: "MARKET", quantity: 2 });
    faults.set(filled.id, "crash");
    faults.set(empty.id, "crash");
    await botTradeAt(10_500);
    await engine.drainTriggerEngine();
    expect((await row(filled.id)).status).toBe("TRIGGERING");
    expect((await row(empty.id)).status).toBe("TRIGGERING");
    const [filledOrder] = await ordersFor([filled.id]);
    const [emptyOrder] = await ordersFor([empty.id]);
    expect(filledOrder).toMatchObject({ filledQuantity: 3, status: "FILLED" });
    expect(emptyOrder).toMatchObject({ filledQuantity: 0, status: "CANCELLED" });
    expect(errors).toHaveBeenCalledTimes(2);

    await backdate(filled.id);
    await backdate(empty.id);
    await engine.stopTriggerEngine();
    engine.startTriggerEngine(); // 恢复:placeOrder 按 clientOrderId 重放,拿回的是同一张单的当前行
    await engine.drainTriggerEngine();
    expect(await row(filled.id)).toMatchObject({ status: "TRIGGERED", reason: null, orderId: filledOrder.id });
    expect(await row(empty.id)).toMatchObject({ status: "REJECTED", reason: "NO_FILL", orderId: emptyOrder.id });
    expect(await ordersFor([filled.id, empty.id])).toHaveLength(2);
    expect((await noticesOf(ctx.bob)).map((n) => [n.payload.triggerId, n.payload.outcome, n.payload.reason])).toEqual([
      [filled.id, "TRIGGERED", null],
      [empty.id, "REJECTED", "NO_FILL"],
    ]);
  });

  it("条件单不被它创建之前的成交触发:成交已入队、还没处理时建的条件单,这一批不触发,下一笔越过触发价的成交才触发", async () => {
    // 一张市价买单吃两档:成交 10_100 与 10_700,最新价(均价)10_400 —— 所以之后还能建 ABOVE 10_600,而队列里的最高价 10_700 已越过它
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "SELL", type: "LIMIT", price: 10_100, quantity: 1 });
    await matching.placeOrder({ userId: ctx.bot1, assetId: ctx.assetId, side: "SELL", type: "LIMIT", price: 10_700, quantity: 1 });
    await matching.placeOrder({ userId: ctx.bot2, assetId: ctx.assetId, side: "BUY", type: "MARKET", quantity: 2 });
    // 发布与这里之间没有宏任务:成交在队列里、处理排在 setImmediate 上还没跑。按住它,让条件单在处理之前建好
    const state = globalThis.__carbadiaTriggerEngine!;
    expect(state.queue.get(ctx.symbol)).toMatchObject({ min: 10_100, max: 10_700 });
    expect(state.immediate).toBeTruthy();
    clearImmediate(state.immediate!);
    // 隔开至少 1 ms:引擎按「创建时间 ≤ 成交时间」放行,同一毫秒建的条件单会被这笔成交触发
    await new Promise((resolve) => setTimeout(resolve, 2));
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_600, side: "BUY", orderType: "LIMIT", limitPrice: 10_700, quantity: 1 });
    expect(t.createdAt).toBeGreaterThan(state.queue.get(ctx.symbol)!.maxTs);
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("PENDING");
    expect(await ordersFor([t.id])).toEqual([]);

    await botTradeAt(10_600);
    await engine.drainTriggerEngine();
    expect(await row(t.id)).toMatchObject({ status: "TRIGGERED", firedPrice: 10_600 });
  });

  it("触发超过 10 分钟仍在 TRIGGERING 的行不再下单:没有委托 → REJECTED / INVALID 并通知;已有委托 → 按它收尾;9 分钟的照常下单", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const limitBuy = { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_600, quantity: 1 } as const;
    const old = await create(ctx.alice, limitBuy);
    const young = await create(ctx.alice, limitBuy);
    const placed = await create(ctx.alice, limitBuy);
    const order = await matching.placeOrder({ userId: ctx.alice, assetId: ctx.assetId, side: "BUY", type: "LIMIT", price: 10_600, quantity: 1, clientOrderId: placed.id }); // 抢占后下过单、收尾前进程没了
    const firedAgo = (id: string, ms: number) =>
      prisma.$executeRaw`UPDATE "Trigger" SET "status" = 'TRIGGERING', "firedPrice" = 10500, "firedAt" = ${Date.now() - ms}, "updatedAt" = ${Date.now() - ms} WHERE "id" = ${id}`;
    await firedAgo(old.id, 11 * 60_000); // 抢占后进程被杀 / 回滚到旧镜像 / TRIGGERS_DISABLED 期间留下的行;下单本来会成功(没有注入故障)
    await firedAgo(young.id, 9 * 60_000);
    await firedAgo(placed.id, 11 * 60_000);

    await engine.stopTriggerEngine();
    engine.startTriggerEngine(); // 启动即恢复
    await engine.drainTriggerEngine();
    expect(await row(old.id)).toMatchObject({ status: "REJECTED", reason: "INVALID", orderId: null });
    expect(await ordersFor([old.id])).toEqual([]); // 一次 placeOrder 都没调:限价买单本来会挂上簿
    expect(await row(placed.id)).toMatchObject({ status: "TRIGGERED", orderId: order.order.id });
    expect(await ordersFor([placed.id])).toHaveLength(1);
    const [youngOrder] = await ordersFor([young.id]);
    expect(youngOrder).toMatchObject({ clientOrderId: young.id, side: "BUY", type: "LIMIT", price: 10_600 });
    expect(await row(young.id)).toMatchObject({ status: "TRIGGERED", orderId: youngOrder.id });
    expect((await noticesOf(ctx.alice)).map((n) => [n.payload.triggerId, n.payload.outcome, n.payload.reason]).sort()).toEqual(
      [
        [old.id, "REJECTED", "INVALID"],
        [placed.id, "TRIGGERED", null],
        [young.id, "TRIGGERED", null],
      ].sort(),
    );
    const gaveUp = errors.mock.calls.map(([line]) => JSON.parse(String(line))).filter((line) => line.ev === "gave_up");
    expect(gaveUp.map((line) => [line.triggerId, line.orderId])).toEqual([
      [old.id, null],
      [placed.id, order.order.id],
    ]);
  });

  it("不到 10 分钟时下单忙 → 留在 TRIGGERING 等恢复重试;到了 10 分钟以上,恢复不再下单,收尾成 REJECTED / INVALID", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await create(ctx.alice, { kind: "ORDER", direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_600, quantity: 1 });
    await prisma.$executeRaw`UPDATE "Trigger" SET "status" = 'TRIGGERING', "firedPrice" = 10500, "firedAt" = ${Date.now() - 9 * 60_000}, "updatedAt" = ${Date.now() - 9 * 60_000} WHERE "id" = ${t.id}`;
    faults.set(t.id, "busy");
    await engine.stopTriggerEngine();
    engine.startTriggerEngine();
    await engine.drainTriggerEngine();
    expect((await row(t.id)).status).toBe("TRIGGERING");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('"ev":"place_failed"'));

    await prisma.$executeRaw`UPDATE "Trigger" SET "firedAt" = ${Date.now() - 11 * 60_000} WHERE "id" = ${t.id}`;
    await engine.stopTriggerEngine();
    engine.startTriggerEngine();
    await engine.drainTriggerEngine();
    expect(await row(t.id)).toMatchObject({ status: "REJECTED", reason: "INVALID", orderId: null });
    expect(await ordersFor([t.id])).toEqual([]);
  });
});

describe("生产路径:不调 drain", () => {
  it("一笔越过触发价的成交发布之后,处理已排在 setImmediate 上,条件单自己走到终态", async () => {
    const t = await create(ctx.alice, { kind: "ALERT", direction: "ABOVE", triggerPrice: 10_500 });
    await botTradeAt(10_500);
    expect(globalThis.__carbadiaTriggerEngine!.immediate).toBeTruthy();
    await vi.waitFor(async () => expect((await row(t.id)).status).toBe("TRIGGERED"));
    expect((await row(t.id)).firedPrice).toBe(10_500);
  });

  it("通知清理在单飞循环之外:清理卡住时条件单照样触发", async () => {
    await engine.stopTriggerEngine();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    engine.startTriggerEngine();
    let release!: () => void;
    const gate = new Promise<number>((resolve) => (release = () => resolve(0)));
    const executeRaw = vi.spyOn(prisma, "$executeRaw").mockReturnValueOnce(gate as unknown as ReturnType<typeof prisma.$executeRaw>); // 清理的第一批卡住
    const t = await create(ctx.alice, { kind: "ALERT", direction: "ABOVE", triggerPrice: 10_500 });
    vi.advanceTimersByTime(engine.RECOVERY_INTERVAL_MS); // 第一次定时器:恢复 + 清理
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(globalThis.__carbadiaTriggerEngine?.pruning).not.toBeNull();
    await botTradeAt(10_500);
    await vi.waitFor(async () => expect((await row(t.id)).status).toBe("TRIGGERED"));
    expect(globalThis.__carbadiaTriggerEngine?.pruning).not.toBeNull(); // 还卡着
    release();
    await engine.drainTriggerEngine(); // 也等清理做完
    expect(globalThis.__carbadiaTriggerEngine?.pruning).toBeNull();
  });
});
