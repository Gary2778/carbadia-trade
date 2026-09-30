// 下单面板的提交路径经真实路由验证(临时 SQLite + migrate deploy + 模拟 cookie,同 src/app/api/orders.integration.test.ts):
// 任务 P1-20 的验收「断网提交再重试同 clientOrderId,库里只有 1 张单」,以及 verifyOrderResponse 认得服务端真实的响应形状
// (限价挂单、重放、市价吃单)—— 形状校验若过严,每一单都会被当成「结果未确认」。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_FEE_SCHEDULE } from "@/shared";
import { initialDraft, toReview, type Draft, type DraftCtx, type OrderReview } from "./order-draft";
import { accountEventsOf, submitOrder } from "./order-submit";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上, 绝不触碰 dev.db
vi.mock("@/lib/server/db", async () => {
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

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let orders: typeof import("@/app/api/orders/route");
let assetId: string;
let aliceId: string;
let bobId: string;

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-order-submit-")));
  writeFileSync(join(testState.directory, "orders.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "orders.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  vi.stubEnv("PROXY_SECRET", undefined);
  ({ prisma } = await import("@/lib/server/db"));
  orders = await import("@/app/api/orders/route");
  const { createSession } = await import("@/lib/server/auth");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");

  const asset = await prisma.asset.create({
    data: { symbol: "VCS-TEST-2021", name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" },
  });
  const alice = await prisma.user.create({ data: { email: "alice@submit.test", name: "Alice", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  const bob = await prisma.user.create({ data: { email: "bob@submit.test", name: "Bob", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  await prisma.holding.create({ data: { userId: bob.id, assetId: asset.id, quantity: 1_000 } });
  assetId = asset.id;
  aliceId = alice.id;
  bobId = bob.id;
  await createSession(aliceId);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

/** 把 submitOrder 的 fetch 接到真实路由处理函数上(同源相对路径 → http://localhost) */
const routeFetch = (ip: string) =>
  (async (url: RequestInfo | URL, init?: RequestInit) =>
    orders.POST(new Request(`http://localhost${String(url)}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-forwarded-for": ip } }))) as typeof fetch;

const ctxFor = (over: Partial<DraftCtx> = {}): DraftCtx => ({
  instrument: { id: assetId, symbol: "VCS-TEST-2021", tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1 },
  avail: { cashCents: 100_000_000, qty: 0 },
  bookTop: { bestBid: null, bestAsk: null },
  asks: [],
  bids: [],
  ...over,
});
const draft = (over: Partial<Draft>): Draft => ({ ...initialDraft(), ...over });
const reviewOf = (d: Draft, ctx: DraftCtx): OrderReview => {
  const r = toReview(d, ctx, DEFAULT_FEE_SCHEDULE);
  if ("error" in r) throw new Error(`unexpected draft error ${r.error}`);
  return r;
};
const countByCid = (cid: string) => prisma.order.count({ where: { userId: aliceId, clientOrderId: cid } });

describe("submitOrder → POST /api/orders(真实路由)", () => {
  it("请求没发出去(离线)→ uncertain;同一张确认单重试 → 成功,库里这个 clientOrderId 只有 1 张单", async () => {
    const review = reviewOf(draft({ priceText: "80.00", qtyText: "3" }), ctxFor());
    const online = routeFetch("203.0.113.10");
    let first = true;
    const flaky = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        throw new TypeError("Failed to fetch");
      }
      return online(url, init);
    }) as typeof fetch;

    expect(await submitOrder(review, flaky)).toEqual({ kind: "uncertain", status: 0 });
    expect(await countByCid(review.request.clientOrderId)).toBe(0);
    const retry = await submitOrder(review, flaky);
    expect(retry.kind).toBe("ok");
    if (retry.kind !== "ok") return;
    expect(retry.data.replayed).toBe(false);
    expect(retry.data.order).toMatchObject({ clientOrderId: review.request.clientOrderId, status: "OPEN", price: 8_000, quantity: 3 });
    expect(await countByCid(review.request.clientOrderId)).toBe(1);
  });

  it("请求到了服务端但响应丢了 → uncertain;重试得到重放(replayed)同一张单,资金只冻结一次", async () => {
    const review = reviewOf(draft({ priceText: "70.00", qtyText: "2" }), ctxFor());
    const online = routeFetch("203.0.113.11");
    const before = Number((await prisma.user.findUniqueOrThrow({ where: { id: aliceId } })).lockedCash);
    let lost = true;
    const lossy = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await online(url, init);
      if (lost) {
        lost = false;
        throw new TypeError("network connection was lost");
      }
      return res;
    }) as typeof fetch;

    expect(await submitOrder(review, lossy)).toEqual({ kind: "uncertain", status: 0 });
    expect(await countByCid(review.request.clientOrderId)).toBe(1);
    const retry = await submitOrder(review, lossy);
    expect(retry.kind).toBe("ok");
    if (retry.kind !== "ok") return;
    expect(retry.data.replayed).toBe(true);
    expect(await countByCid(review.request.clientOrderId)).toBe(1);
    const after = Number((await prisma.user.findUniqueOrThrow({ where: { id: aliceId } })).lockedCash);
    expect(after - before).toBe(14_000);
  });

  it("市价买吃掉卖盘:响应通过形状校验,accountEventsOf 带出订单与成交(auditRef SIM-TRD-…)", async () => {
    // Bob 挂两档卖单
    const { placeOrder } = await import("@/lib/exchange/matching");
    await placeOrder({ userId: bobId, assetId, side: "SELL", type: "LIMIT", price: 9_000, quantity: 5 });
    await placeOrder({ userId: bobId, assetId, side: "SELL", type: "LIMIT", price: 9_100, quantity: 5 });
    const ctx = ctxFor({ bookTop: { bestBid: 8_000, bestAsk: 9_000 }, asks: [{ price: 9_000, quantity: 5, orders: 1 }, { price: 9_100, quantity: 5, orders: 1 }] });
    const review = reviewOf(draft({ type: "MARKET", qtyText: "7" }), ctx);
    expect(review).toMatchObject({ estNotional: 5 * 9_000 + 2 * 9_100, estAvgPrice: Math.round((5 * 9_000 + 2 * 9_100) / 7), warnings: [] });

    const outcome = await submitOrder(review, routeFetch("203.0.113.12"));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.data).toMatchObject({ filledQty: 7, filledCost: 5 * 9_000 + 2 * 9_100, replayed: false });
    expect(outcome.data.order.status).toBe("FILLED");
    const events = accountEventsOf(outcome.data);
    expect(events.map((e) => e.t)).toEqual(["order", "fill", "fill"]);
    for (const ev of events) if (ev.t === "fill") expect(ev.fill.auditRef).toMatch(/^SIM-TRD-/);
  });

  it("未登录 → rejected 401(不是 uncertain),不落单", async () => {
    const saved = testState.cookie;
    testState.cookie = "";
    try {
      const review = reviewOf(draft({ priceText: "60.00", qtyText: "1" }), ctxFor());
      expect(await submitOrder(review, routeFetch("203.0.113.13"))).toEqual({ kind: "rejected", status: 401, message: "Not logged in", retryAfter: null });
      expect(await countByCid(review.request.clientOrderId)).toBe(0);
    } finally {
      testState.cookie = saved;
    }
  });
});
