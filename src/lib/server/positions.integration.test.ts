// 持仓口径的端到端集成测试(计划 §6.2.2 C1 / C2、§6.2.3 P2-03):真实路由(POST /api/retirements、POST /api/otc、DELETE /api/otc/[id]、
// POST /api/orders、DELETE /api/orders/[id]、GET /api/account/positions)+ 真实发布器 + 真实 hub(server/ws-hub.mjs 的 attachWsHub 接在
// http.createServer 上,ws 客户端带 cx_session cookie 订阅 account)+ 临时 SQLite(migrate deploy)。
// 断言的是四处同一口径:REST、WS 订阅快照、提交后的 position 事件逐字段相等,再把事件喂给客户端账户 store(真正的折叠与收口):
//   - 整仓注销:三处都有该行,quantity 0、retired 正确;store 保留它;
//   - 部分注销:事件里 quantity 减少、retired 增加;重放同一 idempotencyKey 不再发事件;
//   - OTC 挂牌 → locked 与 lockedBy.otc 增加,撤牌 → 复原;
//   - 挂 SELL 限价单、部分成交、撤单:lockedBy.orders 每一步都对;
//   - 情景标的的持仓照常在载荷里(不可注销是别处的规则:注销请求被拒,不发事件)。
// 每个用例一个新用户与一个新标的,互不共享持仓。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createBus } from "../../../server/bus.mjs";
import { resolveSessionSecret } from "../../../server/session.mjs";
import { attachWsHub } from "../../../server/ws-hub.mjs";
import { serverFrameSchema } from "../../../server/ws-schema.mjs";
import type { PositionsResponse } from "@/shared/api-shapes";
import type { Position } from "@/shared/types";
import type { ServerEvent } from "@/shared/ws-protocol";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上,绝不触碰 dev.db
vi.mock("./db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (testState.cookie ? { value: testState.cookie } : undefined),
    set: (_name: string, value: string) => {
      testState.cookie = value;
    },
    delete: () => {
      testState.cookie = "";
    },
  }),
}));

let prisma: (typeof import("./db"))["prisma"];
let publisher: typeof import("./market-publisher");
let createSession: (typeof import("./auth"))["createSession"];
let positionsRoute: typeof import("@/app/api/account/positions/route");
let retirementsRoute: typeof import("@/app/api/retirements/route");
let otcRoute: typeof import("@/app/api/otc/route");
let otcByIdRoute: typeof import("@/app/api/otc/[id]/route");
let ordersRoute: typeof import("@/app/api/orders/route");
let orderByIdRoute: typeof import("@/app/api/orders/[id]/route");
let store: typeof import("@/lib/market/account-store");

let server: Server;
let hub: ReturnType<typeof attachWsHub>;
let wsUrl = "";
const sockets: WebSocket[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-positions-")));
  writeFileSync(join(testState.directory, "positions.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "positions.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  const bus = createBus();
  globalThis.__carbadiaBus = bus; // 先于发布器:getBus() 直接命中(与 server.mjs 同序)
  ({ prisma } = await import("./db"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
  publisher = await import("./market-publisher"); // 加载即挂 __carbadiaAccountSnapshot
  ({ createSession } = await import("./auth"));
  positionsRoute = await import("@/app/api/account/positions/route");
  retirementsRoute = await import("@/app/api/retirements/route");
  otcRoute = await import("@/app/api/otc/route");
  otcByIdRoute = await import("@/app/api/otc/[id]/route");
  ordersRoute = await import("@/app/api/orders/route");
  orderByIdRoute = await import("@/app/api/orders/[id]/route");
  store = await import("@/lib/market/account-store");

  // 真实 hub:账户快照来自发布器挂的 globalThis.__carbadiaAccountSnapshot(不注入),presence 由 hub 自己维护;
  // 会话密钥与 auth.ts 同一个来源(resolveSessionSecret),所以路由签出的 cookie 在 /ws 上照样验得过。快照冷却关掉(同一用户连着订两次)
  server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  hub = attachWsHub(server, { bus, secret: resolveSessionSecret(), log: () => {}, batchMs: 5, accountSnapshotCooldownMs: 0, isKnownSymbol: () => true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
}, 120_000);

afterAll(async () => {
  await (await import("@/lib/server/order-hooks")).drainOrderHooks(); // 真人成交的通知由提交后钩子写:等它写完再关库
  await hub?.close(1001, "test over");
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  publisher?._internal.reset();
  globalThis.__carbadiaBus = undefined;
  globalThis.__carbadiaPresence = undefined;
  globalThis.__carbadiaWsStats = undefined;
  globalThis.__carbadiaTopicSeq = undefined;
  globalThis.__carbadiaAccountSnapshot = undefined;
  globalThis.__carbadiaBookRefresh = undefined;
  globalThis.__carbadiaRecentTrades = undefined;
  globalThis.__carbadiaInstrumentsCache = undefined;
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await publisher._internal.idle();
});

// ---- 库里的夹具:每个用例一个新标的、几个新用户 ----
let run = 0;
async function freshAsset(over: { isScenario?: boolean } = {}) {
  run += 1;
  return prisma.asset.create({
    data: { symbol: `POS-TEST-${run}`, name: "Positions test", standard: "VCS", projectType: "Forestry", vintage: 2024, country: "Example", registry: "Demo registry", lastPrice: 5_000, isScenario: over.isScenario ?? false },
  });
}
/** 新用户;holdings = 标的 → 数量(连同一行 SEED 账本,Σdelta 与列值一致) */
async function freshUser(name: string, holdings: Record<string, number> = {}) {
  run += 1;
  const user = await prisma.user.create({ data: { email: `${name}-${run}@positions.test`, name, passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  for (const [assetId, quantity] of Object.entries(holdings)) {
    await prisma.holding.create({ data: { userId: user.id, assetId, quantity } });
    await prisma.ledgerEntry.create({ data: { userId: user.id, account: "HOLDING", assetId, delta: BigInt(quantity), reason: "SEED" } });
  }
  return user.id;
}

// ---- 路由(以 userId 的会话调用) ----
const url = (path: string) => `http://localhost${path}`;
const json = (path: string, method: string, body?: unknown) =>
  new Request(url(path), { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function as<T>(userId: string, call: () => Promise<Response>): Promise<{ status: number; data: T; error?: string }> {
  await createSession(userId);
  const response = await call();
  const body = (await response.json()) as { ok: boolean; data?: T; error?: string };
  return { status: response.status, data: body.data as T, error: body.error };
}
const restPositions = async (userId: string): Promise<Position[]> => (await as<PositionsResponse>(userId, () => positionsRoute.GET())).data.positions;
const retire = (userId: string, assetId: string, quantity: number, idempotencyKey: string) =>
  as<{ retirement: { id: string; quantity: number }; replayed: boolean }>(userId, () =>
    retirementsRoute.POST(json("/api/retirements", "POST", { assetId, quantity, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey })),
  );
const listOtc = (userId: string, assetId: string, quantity: number) =>
  as<{ id: string }>(userId, () => otcRoute.POST(json("/api/otc", "POST", { assetId, quantity, pricePerUnit: 6_000 })));
const cancelOtc = (userId: string, id: string) => as<{ status: string }>(userId, () => otcByIdRoute.DELETE(json(`/api/otc/${id}`, "DELETE"), { params: Promise.resolve({ id }) }));
const placeOrder = (userId: string, assetId: string, side: "BUY" | "SELL", price: number, quantity: number) =>
  as<{ order: { id: string; status: string }; filledQty: number }>(userId, () => ordersRoute.POST(json("/api/orders", "POST", { assetId, side, type: "LIMIT", price, quantity })));
const cancelOrder = (userId: string, id: string) => as<{ order: { status: string } }>(userId, () => orderByIdRoute.DELETE(json(`/api/orders/${id}`, "DELETE"), { params: Promise.resolve({ id }) }));

// ---- WS 客户端:以 userId 的会话连上并订阅 account ----
type AccountClient = {
  events: ServerEvent[];
  /** 订阅快照里的持仓(与 subscribed 同 seq 的 position 行) */
  snapshot(): Position[];
  /** 快照之后的 position 事件(seq 大于订阅时的 seq),按到达顺序 */
  updates(): Position[];
  /** 等到第 n 条 position 事件 */
  update(n: number): Promise<Position>;
  all(): ServerEvent[];
};
async function subscribeAccount(userId: string): Promise<AccountClient> {
  await createSession(userId);
  const socket = new WebSocket(wsUrl, { headers: { cookie: `cx_session=${encodeURIComponent(testState.cookie)}` } });
  sockets.push(socket);
  const events: ServerEvent[] = [];
  socket.on("message", (data) => {
    // 每一帧都过 serverFrameSchema:带 lockedBy 的 position 是协议的一部分
    events.push(...(serverFrameSchema.parse(JSON.parse(data.toString())) as ServerEvent[]));
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  await vi.waitFor(() => expect(events.some((e) => e.t === "hello" && e.userId === userId)).toBe(true), { timeout: 2_000 });
  socket.send(JSON.stringify({ op: "subscribe", topics: ["account"] }));
  // 快照 = balance → 逐条 order → 逐条 position,同一帧、同一 seq;等到 balance 再让出一拍
  await vi.waitFor(() => expect(events.some((e) => e.t === "balance")).toBe(true), { timeout: 2_000 });
  await sleep(30);
  const base = events.find((e): e is Extract<ServerEvent, { t: "subscribed" }> => e.t === "subscribed" && e.topic === "account")!.seq;
  const positionEvents = () => events.filter((e): e is Extract<ServerEvent, { t: "position" }> => e.t === "position");
  const updates = () =>
    positionEvents()
      .filter((e) => e.seq > base)
      .map((e) => e.position);
  return {
    events,
    snapshot: () =>
      positionEvents()
        .filter((e) => e.seq === base)
        .map((e) => e.position),
    updates,
    update: async (n) => {
      await vi.waitFor(() => expect(updates().length).toBeGreaterThanOrEqual(n), { timeout: 3_000 });
      return updates()[n - 1];
    },
    all: () => events,
  };
}
/** 等发布器的派生与 hub 的合帧都过去:用来断言「没有再发事件」 */
async function quiesce() {
  await sleep(80);
  await publisher._internal.idle();
  await sleep(40);
}

/** 把一条连接收到的全部账户事件喂给客户端账户 store(真正的折叠),再按快照收口;返回 store 里的持仓(按 symbol) */
function foldIntoStore(userId: string, client: AccountClient): Position[] {
  store.useAccountStore.setState(store.createInitialAccountState(), true);
  store.setMe({ id: userId, email: "fold@positions.test", name: "Fold", cashBalance: 0, lockedCash: 0, unreadNotices: 0 });
  store.applyAccountEvents(client.all());
  return store.positionsOf(store.useAccountStore.getState().positions);
}

describe("整仓注销:REST、WS 订阅快照、注销触发的 position 事件、客户端 store 四处同一行", () => {
  it("quantity 0、retired = 注销总量;三处逐字段相等;store 保留这一行,快照收口也不收走它", async () => {
    const asset = await freshAsset();
    const other = await freshAsset();
    const userId = await freshUser("fay", { [asset.id]: 8, [other.id]: 3 });
    const live = await subscribeAccount(userId);
    expect(live.snapshot().map((p) => [p.symbol, p.quantity, p.retired])).toEqual([
      [asset.symbol, 8, 0],
      [other.symbol, 3, 0],
    ]);

    const res = await retire(userId, asset.id, 8, `pos-full-${run}-01`);
    expect(res.status).toBe(201);
    const event = await live.update(1);
    expect(event).toEqual({
      assetId: asset.id,
      symbol: asset.symbol,
      quantity: 0,
      locked: 0,
      lockedBy: { orders: 0, otc: 0 },
      available: 0,
      retired: 8,
      lastPrice: 5_000,
      marketValue: 0,
      averagePurchasePrice: null, // 没有剩余数量:没有均价
      unrealisedPnl: 0,
      costBasisStatus: "complete", // 账本对得上(SEED +8、SIMULATED_RETIREMENT −8),池子清空后成本归零
      isScenario: false,
    });
    // 现金没变:注销之后没有 balance 事件(快照里那条之外)
    await quiesce();
    expect(live.all().filter((e) => e.t === "balance")).toHaveLength(1);
    expect(live.updates()).toHaveLength(1);

    // REST:同一行
    const rest = await restPositions(userId);
    expect(rest.map((p) => p.symbol)).toEqual([asset.symbol, other.symbol]);
    expect(rest[0]).toEqual(event);
    // 新连接的订阅快照:同一行
    const late = await subscribeAccount(userId);
    expect(late.snapshot()).toEqual(rest);
    expect(late.snapshot()[0]).toEqual(event);

    // 客户端 store:事件折叠之后这一行还在(不是被当成卖光删掉);按快照收口也留着
    const folded = foldIntoStore(userId, live);
    expect(folded).toEqual(rest);
    store.retainPositions(new Set(late.snapshot().map((p) => p.assetId)));
    expect(store.positionsOf(store.useAccountStore.getState().positions)).toEqual(rest);
    expect(store.useAccountStore.getState().positions.get(asset.id)).toMatchObject({ quantity: 0, retired: 8, available: 0 });
  });
});

describe("部分注销(POST /api/retirements)", () => {
  it("事件里 quantity 减少、retired 增加;重放同一 idempotencyKey(200、replayed)不再发事件;REST 与事件一致", async () => {
    const asset = await freshAsset();
    const userId = await freshUser("gus", { [asset.id]: 50 });
    const live = await subscribeAccount(userId);

    const first = await retire(userId, asset.id, 12, `pos-part-${run}-01`);
    expect(first).toMatchObject({ status: 201, data: { replayed: false, retirement: { quantity: 12 } } });
    expect(await live.update(1)).toMatchObject({ assetId: asset.id, quantity: 38, locked: 0, available: 38, retired: 12, marketValue: 38 * 5_000 });

    const replay = await retire(userId, asset.id, 12, `pos-part-${run}-01`);
    expect(replay).toMatchObject({ status: 200, data: { replayed: true } });
    await quiesce();
    expect(live.updates()).toHaveLength(1); // 重放:库没变,不发

    const second = await retire(userId, asset.id, 5, `pos-part-${run}-02`);
    expect(second.status).toBe(201);
    const event = await live.update(2);
    expect(event).toMatchObject({ quantity: 33, retired: 17, available: 33 });
    expect(await restPositions(userId)).toEqual([event]);
    expect(foldIntoStore(userId, live)).toEqual([event]);
  });
});

describe("OTC 挂牌与撤牌(POST /api/otc、DELETE /api/otc/[id])", () => {
  it("挂牌 → position 事件:locked 与 lockedBy.otc 增加、available 减少;撤牌 → 复原;每一步 REST 与事件一致", async () => {
    const asset = await freshAsset();
    const userId = await freshUser("hal", { [asset.id]: 100 });
    const live = await subscribeAccount(userId);
    expect(live.snapshot()[0]).toMatchObject({ quantity: 100, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 100 });

    const listing = await listOtc(userId, asset.id, 30);
    expect(listing.status).toBe(200);
    const listed = await live.update(1);
    expect(listed).toMatchObject({ assetId: asset.id, quantity: 100, locked: 30, lockedBy: { orders: 0, otc: 30 }, available: 70, retired: 0 });
    expect(await restPositions(userId)).toEqual([listed]);

    const second = await listOtc(userId, asset.id, 15);
    expect(await live.update(2)).toMatchObject({ locked: 45, lockedBy: { orders: 0, otc: 45 }, available: 55 });

    expect((await cancelOtc(userId, listing.data.id)).data.status).toBe("CANCELLED");
    const afterCancel = await live.update(3);
    expect(afterCancel).toMatchObject({ locked: 15, lockedBy: { orders: 0, otc: 15 }, available: 85 });
    await cancelOtc(userId, second.data.id);
    const restored = await live.update(4);
    expect(restored).toMatchObject({ quantity: 100, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 100 });
    expect(await restPositions(userId)).toEqual([restored]);
    // 现金没动过:整段只有快照里的那一条 balance
    await quiesce();
    expect(live.all().filter((e) => e.t === "balance")).toHaveLength(1);
    expect(live.updates()).toHaveLength(4);
  });
});

describe("SELL 限价单(POST /api/orders、DELETE /api/orders/[id])", () => {
  it("挂单、部分成交、撤单:lockedBy.orders 每一步都等于未完结卖单的剩余量;与场外挂牌并存时两项相加等于 locked", async () => {
    const asset = await freshAsset();
    const seller = await freshUser("ivy", { [asset.id]: 200 });
    const buyer = await freshUser("jon");
    const live = await subscribeAccount(seller);

    const ask = await placeOrder(seller, asset.id, "SELL", 5_000, 40);
    expect(ask.data.order.status).toBe("OPEN");
    expect(await live.update(1)).toMatchObject({ quantity: 200, locked: 40, lockedBy: { orders: 40, otc: 0 }, available: 160 });

    const listing = await listOtc(seller, asset.id, 25);
    expect(await live.update(2)).toMatchObject({ quantity: 200, locked: 65, lockedBy: { orders: 40, otc: 25 }, available: 135 });

    const bid = await placeOrder(buyer, asset.id, "BUY", 5_000, 15); // 吃掉 15:卖单 PARTIAL,剩 25
    expect(bid.data.filledQty).toBe(15);
    const partial = await live.update(3);
    expect(partial).toMatchObject({ quantity: 185, locked: 50, lockedBy: { orders: 25, otc: 25 }, available: 135 });
    expect(await restPositions(seller)).toEqual([partial]);

    expect((await cancelOrder(seller, ask.data.order.id)).data.order.status).toBe("CANCELLED");
    const cancelled = await live.update(4);
    expect(cancelled).toMatchObject({ quantity: 185, locked: 25, lockedBy: { orders: 0, otc: 25 }, available: 160 });
    expect(cancelled.lockedBy.orders + cancelled.lockedBy.otc).toBe(cancelled.locked);
    expect(await restPositions(seller)).toEqual([cancelled]);
    // 新连接的快照与最后一条事件相等
    expect((await subscribeAccount(seller)).snapshot()).toEqual([cancelled]);
    await cancelOtc(seller, listing.data.id);

    // 买方:买到 15 吨,没有任何锁定
    expect(await restPositions(buyer)).toEqual([expect.objectContaining({ assetId: asset.id, quantity: 15, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 15 })]);
  });
});

describe("情景标的", () => {
  it("持仓照常出现在 REST、快照与事件里(isScenario: true);注销请求被拒(别处的规则),不发事件", async () => {
    const scenario = await freshAsset({ isScenario: true });
    const credit = await freshAsset();
    const userId = await freshUser("kim", { [scenario.id]: 20, [credit.id]: 4 });
    const live = await subscribeAccount(userId);
    const rest = await restPositions(userId);
    expect(rest.map((p) => [p.symbol, p.isScenario, p.quantity])).toEqual([
      [scenario.symbol, true, 20],
      [credit.symbol, false, 4],
    ]);
    expect(live.snapshot()).toEqual(rest);

    // 事件:情景标的上的场外挂牌照常发 position
    const listing = await listOtc(userId, scenario.id, 6);
    const event = await live.update(1);
    expect(event).toMatchObject({ assetId: scenario.id, isScenario: true, quantity: 20, locked: 6, lockedBy: { orders: 0, otc: 6 }, available: 14 });
    await cancelOtc(userId, listing.data.id);
    await live.update(2);

    const refused = await retire(userId, scenario.id, 1, `pos-scen-${run}-01`);
    expect(refused.status).toBe(400);
    await quiesce();
    expect(live.updates()).toHaveLength(2);
    expect((await restPositions(userId))[0]).toMatchObject({ assetId: scenario.id, quantity: 20, retired: 0 });
  });
});
