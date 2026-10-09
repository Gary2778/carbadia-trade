// 经真实路由(临时 SQLite + migrate deploy + 模拟 cookie)验证条件单的四个接口(计划 §6.3.2 C3):
// 未登录 401、Cache-Control private no-store(错误响应也带)、请求体校验、wouldTriggerNow / tooManyTriggers / overPosition、
// OCO 的价格关系与持仓、clientKey 幂等重放(参数不同 409)、创建与撤销发 trigger 事件、只有 PENDING 能撤(否则 409)、
// 列表 open / history 键集分页、创建共用 60/min 的按用户限流桶、TRIGGERS_DISABLED=1 时两个创建接口 503(列表与撤销照常)。
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../../server/bus.mjs";
import type { BusMessage } from "@/shared/bus";
import type { Trigger } from "@/shared/types";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上, 绝不触碰 dev.db
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (testState.cookie ? { value: testState.cookie } : undefined),
    set: (_name: string, value: string) => { testState.cookie = value; },
    delete: () => { testState.cookie = ""; },
  }),
}));

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let triggersRoute: typeof import("./triggers/route");
let ocoRoute: typeof import("./triggers/oco/route");
let triggerByIdRoute: typeof import("./triggers/[id]/route");
let rateLimit: (typeof import("@/lib/server/rate-limit"))["rateLimit"];
let createSession: (typeof import("@/lib/server/auth"))["createSession"];
const received: BusMessage[] = [];

let run = 0;
const ids = { asset: "", unpriced: "", alice: "", bob: "" };

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-triggers-routes-")));
  writeFileSync(join(testState.directory, "triggers.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "triggers.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  const bus = createBus();
  bus.subscribe((msg) => void received.push(msg));
  globalThis.__carbadiaBus = bus;
  ({ prisma } = await import("@/lib/server/db"));
  triggersRoute = await import("./triggers/route");
  ocoRoute = await import("./triggers/oco/route");
  triggerByIdRoute = await import("./triggers/[id]/route");
  ({ rateLimit } = await import("@/lib/server/rate-limit"));
  ({ createSession } = await import("@/lib/server/auth"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
}, 120_000);

afterAll(async () => {
  globalThis.__carbadiaBus = undefined;
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // 每个用例新的标的与用户:未完结上限、限流桶、分页都按用户算,用例之间互不影响
  run += 1;
  const meta = { name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" };
  const asset = await prisma.asset.create({ data: { ...meta, symbol: `TRG-ROUTE-${run}`, lastPrice: 10_000 } });
  const unpriced = await prisma.asset.create({ data: { ...meta, symbol: `TRG-NEW-${run}` } });
  const user = (name: string) => prisma.user.create({ data: { email: `${name}-${run}@triggers-routes.test`, name, passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  const [alice, bob] = [await user("alice"), await user("bob")];
  await prisma.holding.create({ data: { userId: alice.id, assetId: asset.id, quantity: 50 } });
  Object.assign(ids, { asset: asset.id, unpriced: unpriced.id, alice: alice.id, bob: bob.id });
  testState.cookie = "";
  received.length = 0;
});

const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (body: unknown) => triggersRoute.POST(new Request("http://localhost/api/account/triggers", json(body)));
const postOco = (body: unknown) => ocoRoute.POST(new Request("http://localhost/api/account/triggers/oco", json(body)));
const list = (query = "") => triggersRoute.GET(new Request(`http://localhost/api/account/triggers${query}`));
const del = (id: string) => triggerByIdRoute.DELETE(new Request(`http://localhost/api/account/triggers/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

const limitBuy = (over: Record<string, unknown> = {}) => ({
  kind: "ORDER",
  assetId: ids.asset,
  direction: "ABOVE",
  triggerPrice: 10_500,
  side: "BUY",
  orderType: "LIMIT",
  limitPrice: 10_600,
  quantity: 3,
  clientKey: randomUUID(),
  ...over,
});
const oco = (over: Record<string, unknown> = {}) => ({ assetId: ids.asset, quantity: 10, takeProfit: 11_000, stopLoss: 9_000, clientKey: randomUUID(), ...over });

async function expectError(res: Response, status: number, error: string | RegExp) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const body = await res.json();
  expect(body.ok).toBe(false);
  if (typeof error === "string") expect(body.error).toBe(error);
  else expect(body.error).toMatch(error);
}

const triggerEvents = () => received.flatMap((m) => (m.kind === "account" && m.event.t === "trigger" ? [{ userId: m.userId, trigger: m.event.trigger }] : []));

describe("鉴权与形状", () => {
  it("未登录:四个接口都是 401(private, no-store),什么都不落库", async () => {
    await expectError(await post(limitBuy()), 401, "Not logged in");
    await expectError(await postOco(oco()), 401, "Not logged in");
    await expectError(await list(), 401, "Not logged in");
    await expectError(await del("anything"), 401, "Not logged in");
    expect(await prisma.trigger.count({ where: { assetId: ids.asset } })).toBe(0);
  });

  it("POST ORDER / LIMIT:200 { trigger }(PENDING、整数分、不外露 userId / clientKey),给主人发一条 trigger 事件;MARKET 带了限价也落 null;ALERT 没有下单字段", async () => {
    await createSession(ids.alice);
    const res = await post(limitBuy());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { trigger } = (await res.json()).data as { trigger: Trigger };
    expect(trigger).toMatchObject({
      kind: "ORDER", assetId: ids.asset, symbol: `TRG-ROUTE-${run}`, direction: "ABOVE", triggerPrice: 10_500, side: "BUY", orderType: "LIMIT", limitPrice: 10_600, quantity: 3,
      ocoGroupId: null, status: "PENDING", reason: null, orderId: null, firedPrice: null, firedAt: null,
    });
    expect(typeof trigger.createdAt).toBe("number");
    expect("userId" in trigger || "clientKey" in trigger).toBe(false);
    expect(triggerEvents()).toEqual([{ userId: ids.alice, trigger }]);

    const market = (await (await post(limitBuy({ orderType: "MARKET", limitPrice: 12_345 }))).json()).data.trigger;
    expect(market).toMatchObject({ orderType: "MARKET", limitPrice: null });
    const alertRes = await post({ kind: "ALERT", assetId: ids.asset, direction: "BELOW", triggerPrice: 9_000, clientKey: randomUUID() });
    expect((await alertRes.json()).data.trigger).toMatchObject({ kind: "ALERT", direction: "BELOW", triggerPrice: 9_000, side: null, orderType: null, limitPrice: null, quantity: null });
  });

  it("请求体校验 → 400:LIMIT 没给限价、clientKey 不是 UUID、价格不是整数分、未知 kind、标的不存在", async () => {
    await createSession(ids.alice);
    await expectError(await post(limitBuy({ limitPrice: null })), 400, "Limit orders require a price greater than 0");
    await expectError(await post(limitBuy({ clientKey: "not-a-uuid" })), 400, "clientKey must be a UUID");
    await expectError(await post(limitBuy({ triggerPrice: 10_500.5 })), 400, "Price must be an integer amount in cents");
    await expectError(await post(limitBuy({ kind: "STOP" })), 400, /./);
    await expectError(await post(limitBuy({ assetId: "nope" })), 400, "Instrument not found");
    expect(await prisma.trigger.count({ where: { userId: ids.alice } })).toBe(0);
  });
});

describe("创建校验", () => {
  it("wouldTriggerNow:ABOVE 要求触发价 > 最新价、BELOW 要求 <(等于也拒);最新价为空的标的放行", async () => {
    await createSession(ids.alice);
    await expectError(await post(limitBuy({ triggerPrice: 10_000 })), 400, "wouldTriggerNow");
    await expectError(await post(limitBuy({ direction: "BELOW", triggerPrice: 10_000 })), 400, "wouldTriggerNow");
    await expectError(await post(limitBuy({ direction: "BELOW", triggerPrice: 10_100 })), 400, "wouldTriggerNow");
    expect((await post(limitBuy({ direction: "BELOW", triggerPrice: 9_999 }))).status).toBe(200);
    expect((await post(limitBuy({ assetId: ids.unpriced, triggerPrice: 1 }))).status).toBe(200);
  });

  it("tooManyTriggers:未完结(PENDING + TRIGGERING)已有 50 条就拒,历史不算;撤掉一条又能建;OCO 两条腿一起算", async () => {
    await createSession(ids.bob);
    const base = { userId: ids.bob, assetId: ids.asset, kind: "ALERT", direction: "ABOVE", triggerPrice: 12_000 };
    await prisma.trigger.createMany({
      data: [
        ...Array.from({ length: 49 }, () => ({ ...base, status: "PENDING" })),
        { ...base, status: "TRIGGERING" },
        ...["TRIGGERED", "REJECTED", "CANCELLED"].map((status) => ({ ...base, status })),
      ],
    });
    await expectError(await post(limitBuy()), 400, "tooManyTriggers");
    const pending = await prisma.trigger.findFirstOrThrow({ where: { userId: ids.bob, status: "PENDING" } });
    expect((await del(pending.id)).status).toBe(200);
    await prisma.holding.create({ data: { userId: ids.bob, assetId: ids.asset, quantity: 10 } });
    await expectError(await postOco(oco()), 400, "tooManyTriggers"); // 49 + 2 > 50
    expect((await post(limitBuy())).status).toBe(200); // 49 + 1 = 50
    await expectError(await post(limitBuy()), 400, "tooManyTriggers");
  });

  it("OCO:200 两条 SELL MARKET(止盈 ABOVE 在前、止损 BELOW),同一 ocoGroupId;只给一个价 → 一条;价格关系、持仓与「至少一个价」不对 → 400", async () => {
    await createSession(ids.alice);
    const res = await postOco(oco());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { triggers } = (await res.json()).data as { triggers: Trigger[] };
    const leg = { kind: "ORDER", assetId: ids.asset, side: "SELL", orderType: "MARKET", limitPrice: null, quantity: 10, status: "PENDING" };
    expect(triggers).toEqual([
      expect.objectContaining({ ...leg, direction: "ABOVE", triggerPrice: 11_000 }),
      expect.objectContaining({ ...leg, direction: "BELOW", triggerPrice: 9_000 }),
    ]);
    expect(triggers[0].ocoGroupId).toEqual(expect.any(String));
    expect(triggers[1].ocoGroupId).toBe(triggers[0].ocoGroupId);
    expect(triggerEvents().map((e) => e.trigger.id)).toEqual(triggers.map((t) => t.id));

    const single = (await (await postOco(oco({ takeProfit: null }))).json()).data.triggers;
    expect(single).toEqual([expect.objectContaining({ direction: "BELOW", triggerPrice: 9_000, ocoGroupId: expect.any(String) })]);

    await expectError(await postOco(oco({ takeProfit: null, stopLoss: null })), 400, "Give a take-profit price, a stop-loss price, or both");
    await expectError(await postOco(oco({ takeProfit: 10_000 })), 400, "wouldTriggerNow");
    await expectError(await postOco(oco({ stopLoss: 10_000 })), 400, "wouldTriggerNow");
    await expectError(await postOco(oco({ quantity: 51 })), 400, "overPosition"); // 持有 50
    await expectError(await postOco(oco({ assetId: ids.unpriced, takeProfit: 9_000, stopLoss: 9_000 })), 400, "Take-profit price must be above the stop-loss price");
    await expectError(await postOco(oco({ clientKey: "x" })), 400, "clientKey must be a UUID");
  });
});

describe("幂等", () => {
  it("同一 clientKey 同样参数重发 → 同一条,只落一行、只发一次事件;参数不同 → 409;同一个键拿去建 OCO → 409", async () => {
    await createSession(ids.alice);
    const body = limitBuy();
    const first = (await (await post(body)).json()).data.trigger;
    const again = await post(body);
    expect(again.status).toBe(200);
    expect((await again.json()).data.trigger).toEqual(first);
    expect(await prisma.trigger.count({ where: { userId: ids.alice } })).toBe(1);
    expect(triggerEvents()).toHaveLength(1);
    await expectError(await post({ ...body, quantity: 4 }), 409, "clientKey already used with a different trigger");
    await expectError(await postOco(oco({ clientKey: body.clientKey })), 409, "clientKey already used with a different trigger");
  });

  it("OCO 重发 → 同样的两条;改了任一个价、或少给一条腿 → 409;重放不受当前最新价影响", async () => {
    await createSession(ids.alice);
    const body = oco();
    const first = (await (await postOco(body)).json()).data.triggers;
    await prisma.asset.update({ where: { id: ids.asset }, data: { lastPrice: 11_500 } }); // 价格已越过止盈价:新建会被 wouldTriggerNow 拒,重放不会
    const again = await postOco(body);
    expect(again.status).toBe(200);
    expect((await again.json()).data.triggers).toEqual(first);
    expect(await prisma.trigger.count({ where: { userId: ids.alice } })).toBe(2);
    await expectError(await postOco({ ...body, stopLoss: 8_000 }), 409, "clientKey already used with a different trigger");
    await expectError(await postOco({ ...body, stopLoss: null }), 409, "clientKey already used with a different trigger");
  });
});

describe("撤销与列表", () => {
  it("DELETE:PENDING → 200 CANCELLED / USER 并发事件;再撤 409;别人的与不存在的都是 400「找不到」", async () => {
    await createSession(ids.alice);
    const { trigger } = (await (await post(limitBuy())).json()).data;
    received.length = 0;
    const res = await del(trigger.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const cancelled = (await res.json()).data.trigger;
    expect(cancelled).toMatchObject({ id: trigger.id, status: "CANCELLED", reason: "USER" });
    expect(triggerEvents()).toEqual([{ userId: ids.alice, trigger: cancelled }]);
    await expectError(await del(trigger.id), 409, "Trigger can no longer be cancelled");

    const mine = (await (await post(limitBuy())).json()).data.trigger;
    await createSession(ids.bob);
    await expectError(await del(mine.id), 400, "Trigger not found");
    await expectError(await del("missing"), 400, "Trigger not found");
    expect((await prisma.trigger.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe("PENDING");
  });

  it("GET:open = PENDING / TRIGGERING,history = 其余,缺省全部;新的在前;键集分页无重复无遗漏;非法 status / cursor → 400", async () => {
    await createSession(ids.bob);
    const t0 = Date.now() - 60_000;
    const statuses = ["PENDING", "TRIGGERED", "PENDING", "TRIGGERING", "REJECTED", "PENDING", "CANCELLED", "PENDING"];
    await prisma.trigger.createMany({
      data: statuses.map((status, i) => ({ userId: ids.bob, assetId: ids.asset, kind: "ALERT", direction: "ABOVE", triggerPrice: 12_000 + i, status, createdAt: new Date(t0 + i * 1_000) })),
    });
    // 另一个用户的不进来
    await prisma.trigger.create({ data: { userId: ids.alice, assetId: ids.asset, kind: "ALERT", direction: "ABOVE", triggerPrice: 99_999 } });

    async function pages(query: string): Promise<Trigger[][]> {
      const out: Trigger[][] = [];
      let cursor: string | null = null;
      do {
        const res = await list(`?${query}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        expect(res.headers.get("Cache-Control")).toBe("private, no-store");
        const data: { triggers: Trigger[]; nextCursor: string | null } = (await res.json()).data;
        out.push(data.triggers);
        cursor = data.nextCursor;
      } while (cursor);
      return out;
    }
    const prices = (p: Trigger[][]) => p.flat().map((t) => t.triggerPrice - 12_000);
    const open = await pages("status=open");
    expect(open.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(prices(open)).toEqual([7, 5, 3, 2, 0]);
    expect(prices(await pages("status=history"))).toEqual([6, 4, 1]);
    expect(prices(await pages("status="))).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    // 账户快照用的那份读取:同样的行、同样的顺序
    const { loadOpenTriggers } = await import("@/lib/server/triggers");
    expect(await loadOpenTriggers(ids.bob)).toEqual(open.flat());

    await expectError(await list("?status=toString"), 400, "Invalid status");
    await expectError(await list("?status=PENDING"), 400, "Invalid status");
    await expectError(await list("?cursor=garbage"), 400, "Invalid cursor");
  });
});

describe("限流", () => {
  it("创建按用户 60/min,POST 与 OCO 共用一个桶;429 带 Retry-After 与 private, no-store", async () => {
    await createSession(ids.alice);
    const key = `triggers:user:${ids.alice}`;
    for (let i = 0; i < 59; i++) rateLimit(key, 60, 60_000);
    expect((await post(limitBuy())).status).toBe(200); // 第 60 次
    for (const res of [await post(limitBuy()), await postOco(oco())]) {
      await expectError(res, 429, "Too many requests, please retry later");
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    }
    expect((await list()).status).toBe(200); // 列表不在这个桶里
  });
});

describe("TRIGGERS_DISABLED=1", () => {
  it("两个创建接口 → 503 triggersDisabled(private, no-store),什么都不落库;列表与撤销照常", async () => {
    await createSession(ids.alice);
    const before = (await (await post(limitBuy())).json()).data.trigger as Trigger; // 开关打开之前建的一条
    vi.stubEnv("TRIGGERS_DISABLED", "1");
    try {
      await expectError(await post(limitBuy()), 503, "triggersDisabled");
      await expectError(await post({ kind: "ALERT", assetId: ids.asset, direction: "BELOW", triggerPrice: 9_000, clientKey: randomUUID() }), 503, "triggersDisabled");
      await expectError(await postOco(oco()), 503, "triggersDisabled");
      expect(await prisma.trigger.count({ where: { userId: ids.alice } })).toBe(1);
      const listed = await list("?status=open");
      expect(listed.status).toBe(200);
      expect((await listed.json()).data.triggers.map((t: Trigger) => t.id)).toEqual([before.id]);
      const cancelled = await del(before.id);
      expect(cancelled.status).toBe(200);
      expect((await cancelled.json()).data.trigger).toMatchObject({ id: before.id, status: "CANCELLED", reason: "USER" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
