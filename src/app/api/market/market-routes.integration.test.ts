// 经真实路由(临时 SQLite + migrate deploy)验证四个公开行情端点(计划 §3.4 路由表、§3.5 api-shapes、§9.1 第 22/25 条):
// data 用 zod 逐字段校验(strict:多一个键都不行,anchorPrice 永不外露);depth 上限 50;takerSide 与下单方一致;
// candles interval 非法 → 400、limit 钳到 1..1500 且 1m 能取到 >240 根;无 hub 时 seq === 0;seq 在查库之前读;Cache-Control 与路由表逐字相等。
// K 线的根数断言一律带 to=seededAt:窗口终点钉在夹具时刻,不随请求时的分钟边界漂移(否则最新一桶可能是空的,少一根)。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CANDLE_INTERVALS, DEFAULT_FEE_SCHEDULE, MAX_BARS } from "@/shared/constants";
import { toCandleBar } from "@/shared/candle-live";

const testState = vi.hoisted(() => ({
  directory: "",
  databaseUrl: "",
  /** 查询钩子:在路由的「查库」期间模拟 hub 发布(seq +1),验证 seq 是在查库之前读的 */
  onOrderFindMany: undefined as (() => void) | undefined,
  onTradeFindMany: undefined as (() => void) | undefined,
  /** 原生 SQL 钩子:getBars 的 K 线聚合走 $queryRaw,缓存用例靠它数查库次数、注入一次失败 */
  onQueryRaw: undefined as (() => void) | undefined,
}));

// 显式钉在临时库上, 绝不触碰 dev.db;$extends 的 query 钩子只在测试里挂,默认什么都不做
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../../generated/prisma");
  const prisma = new PrismaClient({ datasourceUrl: testState.databaseUrl }).$extends({
    query: {
      order: { findMany({ args, query }) { testState.onOrderFindMany?.(); return query(args); } },
      trade: { findMany({ args, query }) { testState.onTradeFindMany?.(); return query(args); } },
      $queryRaw({ args, query }) { testState.onQueryRaw?.(); return query(args); },
    },
  });
  return { prisma };
});

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let instruments: typeof import("./instruments/route");
let book: typeof import("./[symbol]/book/route");
let trades: typeof import("./[symbol]/trades/route");
let candles: typeof import("./[symbol]/candles/route");
let legacyCandles: typeof import("../assets/[symbol]/candles/route");
let snapshots: typeof import("@/lib/server/market-snapshots");

const SYMBOL = "VCS-TEST-2021";
const DENSE = "DENSE-1M";
const QUIET = "QUIET-2020";
/** 1m 成交连续 1600 分钟:> MAX_BARS(1500),能证明 limit=2000 被钳到 1500 而不是取满 */
const DENSE_MINUTES = 1_600;
const CACHE = {
  instruments: "public, max-age=1, s-maxage=2, stale-while-revalidate=4",
  book: "public, max-age=1, s-maxage=1, stale-while-revalidate=2",
  trades: "public, max-age=1, s-maxage=1, stale-while-revalidate=2",
  candles: "public, max-age=1, s-maxage=5, stale-while-revalidate=10",
};

let firstTradeId = "";
let secondTradeId = "";
let seededAt = 0;

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-market-routes-")));
  writeFileSync(join(testState.directory, "market.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "market.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  vi.stubEnv("PROXY_SECRET", undefined); // 无反代密钥:x-forwarded-for 末跳就是限流分桶 IP(K 线限流用例每个用自己的 IP)
  ({ prisma } = await import("@/lib/server/db"));
  instruments = await import("./instruments/route");
  book = await import("./[symbol]/book/route");
  trades = await import("./[symbol]/trades/route");
  candles = await import("./[symbol]/candles/route");
  legacyCandles = await import("../assets/[symbol]/candles/route");
  snapshots = await import("@/lib/server/market-snapshots");
  const { placeOrder } = await import("@/lib/exchange/matching");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");

  const base = { standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" };
  const asset = await prisma.asset.create({ data: { ...base, symbol: SYMBOL, name: "Test forest", anchorPrice: 9_950, description: "internal" } });
  const dense = await prisma.asset.create({ data: { ...base, symbol: DENSE, name: "Dense tape", lastPrice: 1_000 } });
  await prisma.asset.create({ data: { ...base, symbol: QUIET, name: "Quiet", vintage: 2020 } });
  const alice = await prisma.user.create({ data: { email: "alice@market.test", name: "Alice", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  const bob = await prisma.user.create({ data: { email: "bob@market.test", name: "Bob", passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  await prisma.holding.create({ data: { userId: bob.id, assetId: asset.id, quantity: 1_000 } });

  // 成交 1:bob 的 SELL 10000 先挂,alice 的 BUY 10000 后到吃掉 2 → taker = BUY(两张都是 LIMIT、价相同,按 createdAt 晚者)
  await placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 10_000, quantity: 5 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const first = await placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 10_000, quantity: 2 });
  firstTradeId = first.trades[0].id;
  // 成交 2:alice 的 BUY 9900 先挂,bob 的市价 SELL 吃 1 → taker = SELL(MARKET 单)
  await placeOrder({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_900, quantity: 3 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await placeOrder({ userId: bob.id, assetId: asset.id, side: "SELL", type: "MARKET", quantity: 1 });
  secondTradeId = second.trades[0].id;
  // 再挂 60 档不同价的买单(9000 往下),盘口买方 > 50 档,用来证明 depth 上限
  await prisma.order.createMany({
    data: Array.from({ length: 60 }, (_, i) => ({ userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 9_000 - i, quantity: 1 })),
  });

  // DENSE:每分钟一笔,连续 1600 分钟(直接写表,K 线只看 price / quantity / createdAt)
  const buy = await prisma.order.create({ data: { userId: alice.id, assetId: dense.id, side: "BUY", type: "LIMIT", price: 1_000, quantity: DENSE_MINUTES, status: "FILLED" } });
  const sell = await prisma.order.create({ data: { userId: bob.id, assetId: dense.id, side: "SELL", type: "LIMIT", price: 1_000, quantity: DENSE_MINUTES, status: "FILLED" } });
  seededAt = Date.now();
  await prisma.trade.createMany({
    data: Array.from({ length: DENSE_MINUTES }, (_, k) => ({
      assetId: dense.id, buyOrderId: buy.id, sellOrderId: sell.id, buyerId: alice.id, sellerId: bob.id,
      price: 1_000 + (k % 50), quantity: 1, createdAt: new Date(seededAt - k * 60_000),
    })),
  });
}, 120_000);

// K 线查库预算是全进程共享的(P1-25e):每个用例从满桶开始,前面用例的查库不会让后面的用例意外拿到 503
beforeEach(() => {
  delete globalThis.__carbadiaBarsBudget;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  delete globalThis.__carbadiaTopicSeq;
  delete globalThis.__carbadiaInstrumentsCache;
  delete globalThis.__carbadiaBarsCache;
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

// ---- 形状(计划 §3.5):strict = 多一个键都不通过 ----
const int = z.number().int();
const nullableInt = int.nullable();
const instrumentSchema = z.object({
  id: z.string(), symbol: z.string(), name: z.string(), standard: z.string(), projectType: z.string(), vintage: int,
  country: z.string(), registry: z.string(), isScenario: z.boolean(), projectId: z.string().nullable(), methodology: z.string().nullable(),
  verificationStatus: z.literal("SIMULATED_UNVERIFIED").nullable(), tickSize: int, pricePrecision: int, qtyStep: int, minQty: int,
  currency: z.literal("USD"), lastPrice: nullableInt,
}).strict();
const tickerSchema = z.object({
  symbol: z.string(), lastPrice: nullableInt, bestBid: nullableInt, bestAsk: nullableInt, change24h: z.number().nullable(),
  high24h: nullableInt, low24h: nullableInt, volume24h: int, ts: int,
}).strict();
const instrumentsSchema = z.object({
  instruments: z.array(z.object({ instrument: instrumentSchema, ticker: tickerSchema }).strict()),
  feeSchedule: z.object({ makerBps: int, takerBps: int, minFeeCents: int, demo: z.literal(true) }).strict(),
  serverTime: int,
}).strict();
const levelSchema = z.object({ price: int, quantity: int.positive(), orders: int.positive() }).strict();
const bookSchema = z.object({ symbol: z.string(), bids: z.array(levelSchema), asks: z.array(levelSchema), ts: int, seq: int.nonnegative() }).strict();
const tapeSchema = z.object({
  id: z.string(), symbol: z.string(), price: int, quantity: int.positive(), takerSide: z.enum(["BUY", "SELL"]), ts: int, auditRef: z.string().regex(/^SIM-TRD-.+$/),
}).strict();
const tradesSchema = z.object({ trades: z.array(tapeSchema), seq: int.nonnegative() }).strict();
const barSchema = z.object({ t: int, o: int, h: int, l: int, c: int, v: int }).strict();
const candlesSchema = z.object({ interval: z.enum(CANDLE_INTERVALS), candles: z.array(barSchema) }).strict();

const params = (symbol: string) => ({ params: Promise.resolve({ symbol }) });
const getBook = (symbol: string, query = "") => book.GET(new Request(`http://localhost/api/market/${symbol}/book${query}`), params(symbol));
const getTrades = (symbol: string, query = "") => trades.GET(new Request(`http://localhost/api/market/${symbol}/trades${query}`), params(symbol));
const getCandles = (symbol: string, query = "") => candles.GET(new Request(`http://localhost/api/market/${symbol}/candles${query}`), params(symbol));

async function okData<T extends z.ZodTypeAny>(response: Response, schema: T, cacheControl: string): Promise<z.infer<T>> {
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe(cacheControl);
  const body = (await response.json()) as { ok: boolean; data: unknown };
  expect(body.ok).toBe(true);
  return schema.parse(body.data);
}

describe("GET /api/market/instruments", () => {
  it("InstrumentsResponse 形状、按 symbol 排序、费率表全零、anchorPrice / description / createdAt 不外露", async () => {
    const data = await okData(await instruments.GET(), instrumentsSchema, CACHE.instruments);
    expect(data.instruments.map((item) => item.instrument.symbol)).toEqual([DENSE, QUIET, SYMBOL]);
    expect(data.feeSchedule).toEqual(DEFAULT_FEE_SCHEDULE);
    for (const { instrument } of data.instruments) {
      expect("anchorPrice" in instrument).toBe(false);
      expect("description" in instrument).toBe(false);
      expect("createdAt" in instrument).toBe(false);
    }
  });

  it("ticker:change24h 是百分数(首笔 10000 → lastPrice 9900 = −1)、高低量按 24 h 窗口、最优买卖价来自盘口", async () => {
    const data = await okData(await instruments.GET(), instrumentsSchema, CACHE.instruments);
    const { ticker } = data.instruments.find((item) => item.instrument.symbol === SYMBOL)!;
    expect(ticker).toMatchObject({ lastPrice: 9_900, change24h: -1, high24h: 10_000, low24h: 9_900, volume24h: 3, bestBid: 9_900, bestAsk: 10_000 });
    const quiet = data.instruments.find((item) => item.instrument.symbol === QUIET)!.ticker;
    expect(quiet).toMatchObject({ lastPrice: null, change24h: null, high24h: null, low24h: null, volume24h: 0, bestBid: null, bestAsk: null });
  });

  it("进程缓存 2 s:两次调用同一份(serverTime 相同),挂在 globalThis.__carbadiaInstrumentsCache", async () => {
    const a = await okData(await instruments.GET(), instrumentsSchema, CACHE.instruments);
    const b = await okData(await instruments.GET(), instrumentsSchema, CACHE.instruments);
    expect(b.serverTime).toBe(a.serverTime);
    expect(globalThis.__carbadiaInstrumentsCache?.value.serverTime).toBe(a.serverTime);
  });
});

describe("GET /api/market/[symbol]/book", () => {
  it("BookResponse 形状、bids 降序 / asks 升序、每档带 orders 计数", async () => {
    const data = await okData(await getBook(SYMBOL, "?depth=50"), bookSchema, CACHE.book);
    expect(data.symbol).toBe(SYMBOL);
    expect(data.asks).toEqual([{ price: 10_000, quantity: 3, orders: 1 }]);
    expect(data.bids[0]).toEqual({ price: 9_900, quantity: 2, orders: 1 });
    for (let i = 1; i < data.bids.length; i++) expect(data.bids[i].price).toBeLessThan(data.bids[i - 1].price);
  });

  it("depth 上限 50:默认 50、?depth=500 仍 50、?depth=5 → 5、非数字回默认、0 钳到 1", async () => {
    expect((await okData(await getBook(SYMBOL), bookSchema, CACHE.book)).bids).toHaveLength(50);
    expect((await okData(await getBook(SYMBOL, "?depth=500"), bookSchema, CACHE.book)).bids).toHaveLength(50);
    expect((await okData(await getBook(SYMBOL, "?depth=5"), bookSchema, CACHE.book)).bids).toHaveLength(5);
    expect((await okData(await getBook(SYMBOL, "?depth=abc"), bookSchema, CACHE.book)).bids).toHaveLength(50);
    expect((await okData(await getBook(SYMBOL, "?depth=0"), bookSchema, CACHE.book)).bids).toHaveLength(1);
  });

  it("无 hub 时 seq === 0;hub 写入 __carbadiaTopicSeq 后原样读出", async () => {
    delete globalThis.__carbadiaTopicSeq;
    expect((await okData(await getBook(SYMBOL), bookSchema, CACHE.book)).seq).toBe(0);
    globalThis.__carbadiaTopicSeq = new Map([[`book:${SYMBOL}`, 7], [`trades:${SYMBOL}`, 3]]);
    expect((await okData(await getBook(SYMBOL), bookSchema, CACHE.book)).seq).toBe(7);
    expect((await okData(await getTrades(SYMBOL), tradesSchema, CACHE.trades)).seq).toBe(3);
    expect((await okData(await getBook(QUIET), bookSchema, CACHE.book)).seq).toBe(0);
    delete globalThis.__carbadiaTopicSeq;
  });

  it("seq 在查库之前读:查询期间 hub 又发布了一条(7 → 8),响应仍带查询前的 7;trades 同理(3 → 4 仍回 3)", async () => {
    // 先读只会让 seq 落后一位(客户端重放一条已含在快照里的 delta,档位是绝对量、成交按 id 去重,都无害);
    // 后读会领先一位,客户端把真正缺的那条当成已应用而丢掉。
    globalThis.__carbadiaTopicSeq = new Map([[`book:${SYMBOL}`, 7], [`trades:${SYMBOL}`, 3]]);
    testState.onOrderFindMany = () => globalThis.__carbadiaTopicSeq!.set(`book:${SYMBOL}`, 8);
    testState.onTradeFindMany = () => globalThis.__carbadiaTopicSeq!.set(`trades:${SYMBOL}`, 4);
    try {
      expect((await okData(await getBook(SYMBOL), bookSchema, CACHE.book)).seq).toBe(7);
      expect(globalThis.__carbadiaTopicSeq.get(`book:${SYMBOL}`)).toBe(8);
      expect((await okData(await getTrades(SYMBOL), tradesSchema, CACHE.trades)).seq).toBe(3);
      expect(globalThis.__carbadiaTopicSeq.get(`trades:${SYMBOL}`)).toBe(4);
    } finally {
      testState.onOrderFindMany = undefined;
      testState.onTradeFindMany = undefined;
      delete globalThis.__carbadiaTopicSeq;
    }
  });

  it("未知 symbol → 404 'Instrument not found'", async () => {
    const response = await getBook("NOPE");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "Instrument not found" });
  });
});

describe("GET /api/market/[symbol]/trades", () => {
  it("TradesResponse 形状、时间升序、takerSide 与 placeOrder 的下单方一致、auditRef = SIM-TRD-<id>", async () => {
    const data = await okData(await getTrades(SYMBOL), tradesSchema, CACHE.trades);
    expect(data.trades.map((t) => t.id)).toEqual([firstTradeId, secondTradeId]);
    expect(data.trades[0]).toMatchObject({ symbol: SYMBOL, price: 10_000, quantity: 2, takerSide: "BUY", auditRef: `SIM-TRD-${firstTradeId}` });
    expect(data.trades[1]).toMatchObject({ symbol: SYMBOL, price: 9_900, quantity: 1, takerSide: "SELL", auditRef: `SIM-TRD-${secondTradeId}` });
    expect(data.trades[0].ts).toBeLessThanOrEqual(data.trades[1].ts);
    expect(data.seq).toBe(0);
  });

  it("limit 与 before:?limit=1 只给最新一笔;?before=<最新 ts> 只给它之前的;limit 钳到 1..200", async () => {
    const all = await okData(await getTrades(SYMBOL), tradesSchema, CACHE.trades);
    const latest = all.trades[all.trades.length - 1];
    const one = await okData(await getTrades(SYMBOL, "?limit=1"), tradesSchema, CACHE.trades);
    expect(one.trades.map((t) => t.id)).toEqual([latest.id]);
    const before = await okData(await getTrades(SYMBOL, `?before=${latest.ts}`), tradesSchema, CACHE.trades);
    expect(before.trades.map((t) => t.id)).toEqual([firstTradeId]);
    const dense = await okData(await getTrades(DENSE, "?limit=5000"), tradesSchema, CACHE.trades);
    expect(dense.trades).toHaveLength(200);
    const defaults = await okData(await getTrades(DENSE), tradesSchema, CACHE.trades);
    expect(defaults.trades).toHaveLength(100);
    expect(defaults.trades[99].ts).toBeGreaterThan(defaults.trades[0].ts);
  });

  it("未知 symbol → 404", async () => {
    expect((await getTrades("NOPE")).status).toBe(404);
  });
});

describe("GET /api/market/[symbol]/candles", () => {
  it("CandlesResponse 形状、默认 1m × 500 根、按 t 升序、桶起点对齐到分钟", async () => {
    const data = await okData(await getCandles(DENSE, `?to=${seededAt}`), candlesSchema, CACHE.candles);
    expect(data.interval).toBe("1m");
    expect(data.candles).toHaveLength(500);
    for (let i = 0; i < data.candles.length; i++) {
      const bar = data.candles[i];
      expect(bar.t % 60_000).toBe(0);
      if (i > 0) expect(bar.t).toBeGreaterThan(data.candles[i - 1].t);
      expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c));
      expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c));
    }
  });

  it("interval=1m&limit=1500 返回 1500 根(> 旧端点的 240),limit=2000 被钳到 1500,limit=300 恰 300", async () => {
    const full = await okData(await getCandles(DENSE, `?interval=1m&limit=1500&to=${seededAt}`), candlesSchema, CACHE.candles);
    expect(full.candles).toHaveLength(MAX_BARS);
    expect(full.candles.length).toBeGreaterThan(240);
    const clamped = await okData(await getCandles(DENSE, `?interval=1m&limit=2000&to=${seededAt}`), candlesSchema, CACHE.candles);
    expect(clamped.candles).toHaveLength(MAX_BARS);
    expect(clamped.candles).toEqual(full.candles);
    expect((await okData(await getCandles(DENSE, `?interval=1m&limit=300&to=${seededAt}`), candlesSchema, CACHE.candles)).candles).toHaveLength(300);
    expect((await okData(await getCandles(DENSE, `?limit=0&to=${seededAt}`), candlesSchema, CACHE.candles)).candles).toHaveLength(1);
  });

  it("interval 六个都合法(15m / 4h 是新的),非法 → 400", async () => {
    for (const interval of CANDLE_INTERVALS) {
      const data = await okData(await getCandles(DENSE, `?interval=${interval}&limit=10&to=${seededAt}`), candlesSchema, CACHE.candles);
      expect(data.interval).toBe(interval);
      expect(data.candles.length).toBeGreaterThan(0);
    }
    const fifteen = await okData(await getCandles(DENSE, `?interval=15m&limit=1500&to=${seededAt}`), candlesSchema, CACHE.candles);
    // 1600 分钟连续成交落进 107 或 108 个刻钟桶(看 seededAt 落在桶内哪个位置),按同一公式算出精确值
    const quarterBars = Math.floor(seededAt / 900_000) - Math.floor((seededAt - (DENSE_MINUTES - 1) * 60_000) / 900_000) + 1;
    expect(quarterBars).toBeGreaterThanOrEqual(107);
    expect(quarterBars).toBeLessThanOrEqual(108);
    expect(fifteen.candles).toHaveLength(quarterBars);
    for (const bar of fifteen.candles) expect(bar.t % 900_000).toBe(0);
    const bad = await getCandles(DENSE, "?interval=2m");
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toEqual({ ok: false, error: "interval must be one of 1m/5m/15m/1h/4h/1d" });
  });

  it("?to=<ms> 把窗口终点往前挪:最后一根的桶含 to,且没有 t > to 的 bar", async () => {
    const to = seededAt - 100 * 60_000;
    const data = await okData(await getCandles(DENSE, `?interval=1m&limit=10&to=${to}`), candlesSchema, CACHE.candles);
    expect(data.candles).toHaveLength(10);
    expect(data.candles[9].t).toBe(Math.floor(to / 60_000) * 60_000);
    for (const bar of data.candles) expect(bar.t).toBeLessThanOrEqual(to);
  });

  it("无成交的标的返回空数组而不是 404;未知 symbol → 404", async () => {
    const quiet = await okData(await getCandles(QUIET), candlesSchema, CACHE.candles);
    expect(quiet.candles).toEqual([]);
    expect((await getCandles("NOPE")).status).toBe(404);
  });

  it("to / before 超出 Date 可表示范围(> 8.64e15)或为负 → 按未提供处理,200 而不是 500", async () => {
    for (const query of ["?to=1e20", "?to=99999999999999999999", "?to=-1", "?to=Infinity"]) {
      await okData(await getCandles(DENSE, `${query}&limit=10`), candlesSchema, CACHE.candles);
    }
    const before = await okData(await getTrades(SYMBOL, "?before=1e20"), tradesSchema, CACHE.trades);
    expect(before.trades.map((t) => t.id)).toEqual([firstTradeId, secondTradeId]);
  });
});

describe("GET /api/assets/[symbol]/candles(旧端点,计划 §3.4「保留、不变」)", () => {
  const getLegacy = (query: string) => legacyCandles.GET(new Request(`http://localhost/api/assets/${DENSE}/candles${query}`), params(DENSE));

  it("只认 1m/5m/1h/1d:INTERVALS 多出的 15m / 4h 在这里仍是 400,文案与接受集一致;1m 仍最多 240 根", async () => {
    for (const interval of ["15m", "4h", "2m"]) {
      const response = await getLegacy(`?interval=${interval}`);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, error: "interval must be one of 1m/5m/1h/1d" });
    }
    const response = await getLegacy("?interval=1m");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { candles: { t: string }[] } };
    expect(body.ok).toBe(true);
    expect(body.data.candles.length).toBeLessThanOrEqual(240);
    expect(body.data.candles.length).toBeGreaterThan(200);
  });
});

describe("invalidateInstrumentsCache(OTC 成交后,P1-25b)", () => {
  it("标记过期而不是删掉:OTC 买入后列表仍在(hub 的 symbolKnown 按它判断),下一次读拿到新价并重新缓存", async () => {
    const otc = await import("@/lib/exchange/otc");
    const [alice, bob] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: "alice@market.test" } }),
      prisma.user.findUniqueOrThrow({ where: { email: "bob@market.test" } }),
    ]);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { symbol: SYMBOL } });
    const warm = await okData(await instruments.GET(), instrumentsSchema, CACHE.instruments); // 缓存里是成交前的列表
    expect(warm.instruments.find((item) => item.instrument.symbol === SYMBOL)?.ticker.lastPrice).not.toBe(12_345);

    const listing = await otc.createListing({ sellerId: bob.id, assetId: asset.id, quantity: 2, pricePerUnit: 12_345 });
    await otc.buyListing(alice.id, listing.id, 1); // 提交后 publishLastPrice → invalidateInstrumentsCache()

    // 期间:旧列表还在(只是过期),标的集合不变
    const stale = globalThis.__carbadiaInstrumentsCache;
    expect(stale?.value.instruments.map((item) => item.instrument.symbol)).toEqual([DENSE, QUIET, SYMBOL]);
    // 第一次读就是新价(过期的条目不再命中),并写回缓存
    const fresh = await okData(await instruments.GET(), instrumentsSchema, CACHE.instruments);
    expect(fresh.instruments.find((item) => item.instrument.symbol === SYMBOL)?.ticker.lastPrice).toBe(12_345);
    expect(globalThis.__carbadiaInstrumentsCache?.value.serverTime).toBe(fresh.serverTime);
    await otc.cancelListing(bob.id, listing.id);
  });
});

describe("getBars:SQL 聚合与进程缓存(P1-25b)", () => {
  const dense = () => prisma.asset.findUniqueOrThrow({ where: { symbol: DENSE }, select: { id: true, symbol: true } });
  /** 数这段时间里 $queryRaw 的次数(getBars 的聚合是唯一的原生查询) */
  async function countingRaw<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
    let queries = 0;
    testState.onQueryRaw = () => void queries++;
    try {
      return { result: await fn(), queries };
    } finally {
      testState.onQueryRaw = undefined;
    }
  }
  const withIp = (symbol: string, query: string, ip: string) =>
    candles.GET(new Request(`http://localhost/api/market/${symbol}/candles${query}`, { headers: { "x-forwarded-for": ip } }), params(symbol));

  it("与旧的 JS 分桶逐根相等:同一毫秒多笔成交时开盘取 id 最小、收盘取 id 最大(createdAt, id 升序)", async () => {
    const [alice, bob] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: "alice@market.test" } }),
      prisma.user.findUniqueOrThrow({ where: { email: "bob@market.test" } }),
    ]);
    const asset = await prisma.asset.create({
      data: { symbol: "TIES-2021", name: "Ties", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" },
    });
    const buy = await prisma.order.create({ data: { userId: alice.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 1, quantity: 100, status: "FILLED" } });
    const sell = await prisma.order.create({ data: { userId: bob.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 1, quantity: 100, status: "FILLED" } });
    const t0 = Math.floor(seededAt / 3_600_000) * 3_600_000 - 3 * 3_600_000; // 三小时前的整点
    const rows: [id: string, offsetMs: number, price: number, quantity: number][] = [
      ["tie-b", 0, 500, 1], ["tie-a", 0, 400, 2], ["tie-c", 0, 600, 3], // 同一毫秒:开盘 = id 最小的 tie-a(400)
      ["tie-d", 30_000, 450, 1], ["tie-f", 59_999, 700, 1], ["tie-e", 59_999, 300, 1], // 收盘 = 同毫秒 id 最大的 tie-f(700)
      ["tie-g", 60_000, 800, 4], ["tie-h", 3_599_999, 350, 5], ["tie-i", 3_600_000, 900, 6],
    ];
    await prisma.trade.createMany({
      data: rows.map(([id, offset, price, quantity]) => ({
        id, assetId: asset.id, buyOrderId: buy.id, sellOrderId: sell.id, buyerId: alice.id, sellerId: bob.id, price, quantity, createdAt: new Date(t0 + offset),
      })),
    });
    const { bucketTrades, INTERVALS } = await import("@/lib/exchange/candles");
    const sorted = await prisma.trade.findMany({
      where: { assetId: asset.id }, select: { price: true, quantity: true, createdAt: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const to = t0 + 3_600_000; // 最后一笔(tie-i)的时刻:窗口右端含等号;1m × 100 的窗口起点在 t0 之前,九笔全在窗口里
    for (const interval of ["1m", "5m", "1h", "1d"] as const) {
      const bars = await snapshots.getBars(asset, interval, 100, to);
      expect(bars).toEqual(bucketTrades(sorted, INTERVALS[interval].ms, 100).map(toCandleBar));
    }
    const minute = await snapshots.getBars(asset, "1m", 100, to);
    expect(minute).toHaveLength(4);
    expect(minute[0]).toEqual({ t: t0, o: 400, h: 700, l: 300, c: 700, v: 9 });
    expect(await snapshots.getBars(asset, "1m", 2, to)).toEqual(minute.slice(-2)); // limit 取最新的几根
  });

  it("不带 to:并发 20 次只查一次库,拿到同一份结果;TTL 内再取仍命中", async () => {
    delete globalThis.__carbadiaBarsCache;
    const asset = await dense();
    const { result, queries } = await countingRaw(() => Promise.all(Array.from({ length: 20 }, () => snapshots.getBars(asset, "1d", 500))));
    expect(queries).toBe(1);
    for (const bars of result) expect(bars).toBe(result[0]);
    expect(result[0].length).toBeGreaterThan(0);
    const again = await countingRaw(() => snapshots.getBars(asset, "1d", 500));
    expect(again.queries).toBe(0);
    expect(again.result).toBe(result[0]);
    // 键按 limit 分档(≤ 500 一档,更大的按周期上限一档,P1-25e):同档的 limit 命中同一条,按时间窗截取;换 interval 是另一条
    const fewer = await countingRaw(() => snapshots.getBars(asset, "1d", 499));
    expect(fewer.queries).toBe(0);
    expect(fewer.result).toEqual(result[0].filter((bar) => bar.t >= Math.floor(Date.now() / 86_400_000) * 86_400_000 - 498 * 86_400_000));
    expect((await countingRaw(() => snapshots.getBars(asset, "1h", 500))).queries).toBe(1);
  });

  it("limit 分档后截取的结果与直接按 limit 查库逐根相同(窗口仍是 limit × interval,不是「最新 limit 根有成交的桶」)", async () => {
    delete globalThis.__carbadiaBarsCache;
    const asset = await dense();
    vi.useFakeTimers({ toFake: ["Date"] }); // 冻住时钟:缓存那次查库的「现在」与这里的 to 是同一刻
    try {
      const to = Date.now();
      for (const limit of [1, 7, 60, 499, 500]) {
        const exact = await snapshots.getBars(asset, "1m", limit, to); // 带 to:精确查库、不走缓存
        expect(await snapshots.getBars(asset, "1m", limit)).toEqual(exact);
      }
      for (const limit of [501, 1440, 1500]) expect(await snapshots.getBars(asset, "1m", limit)).toEqual(await snapshots.getBars(asset, "1m", limit, to));
    } finally {
      vi.useRealTimers();
    }
    const barsCache = () => globalThis.__carbadiaBarsCache; // 函数里读:delete 之后的直接读取会被 TS 收窄成 undefined
    expect(barsCache()?.size).toBe(2); // 1m 两档:500 与 1500
  });

  it(`TTL ${5_000} ms 后重新查库;带 to 的窗口(发布器补桶、翻历史)从不走缓存`, async () => {
    delete globalThis.__carbadiaBarsCache;
    const asset = await dense();
    expect(snapshots.BARS_CACHE_TTL_MS).toBe(5_000);
    await snapshots.getBars(asset, "1m", 100);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + snapshots.BARS_CACHE_TTL_MS - 50);
      expect((await countingRaw(() => snapshots.getBars(asset, "1m", 100))).queries).toBe(0);
      vi.setSystemTime(Date.now() + 100);
      expect((await countingRaw(() => snapshots.getBars(asset, "1m", 100))).queries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    const to = Date.now();
    const pinned = await countingRaw(() => Promise.all([snapshots.getBars(asset, "1m", 100, to), snapshots.getBars(asset, "1m", 100, to)]));
    expect(pinned.queries).toBe(2);
  });

  it("查询失败:在途的等待者拿到同一个错误,条目随即删除,下一次重新查", async () => {
    delete globalThis.__carbadiaBarsCache;
    const asset = await dense();
    testState.onQueryRaw = () => {
      throw new Error("boom");
    };
    const failed = await Promise.allSettled([snapshots.getBars(asset, "5m", 100), snapshots.getBars(asset, "5m", 100)]);
    testState.onQueryRaw = undefined;
    expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    const retry = await countingRaw(() => snapshots.getBars(asset, "5m", 100));
    expect(retry.queries).toBe(1);
    expect(retry.result.length).toBeGreaterThan(0);
  });

  it(`缓存键有上限(${512}):limit 刷遍 1..1500 只落两档;过去的 to 刷遍也不会无限长`, async () => {
    delete globalThis.__carbadiaBarsCache;
    const quiet = await prisma.asset.findUniqueOrThrow({ where: { symbol: QUIET }, select: { id: true, symbol: true } });
    expect(snapshots.BARS_CACHE_MAX_KEYS).toBe(512);
    const barsCache = () => globalThis.__carbadiaBarsCache; // 函数里读:delete 之后的直接读取会被 TS 收窄成 undefined
    for (let limit = 1; limit <= 1500; limit++) await snapshots.getBars(quiet, "1m", limit);
    expect(barsCache()?.size).toBe(2);
    const now = Date.now();
    for (let i = 1; i <= snapshots.BARS_CACHE_MAX_KEYS + 40; i++) await snapshots.getPublicBars(quiet, "1m", 10, now - i * 60_000, () => true);
    expect(barsCache()?.size).toBeLessThanOrEqual(snapshots.BARS_CACHE_MAX_KEYS);
  });

  it("每个周期的根数上限(P1-25e 收紧):1m 1500(分时要 1440)、5m / 15m / 1h 1000、4h / 1d 500;超出的 limit 钳到上限", async () => {
    expect(snapshots.PUBLIC_MAX_BARS).toEqual({ "1m": 1500, "5m": 1000, "15m": 1000, "1h": 1000, "4h": 500, "1d": 500 });
    delete globalThis.__carbadiaBarsCache;
    const clamped = await countingRaw(async () => okData(await withIp(DENSE, "?interval=1d&limit=1500", "198.18.0.4"), candlesSchema, CACHE.candles));
    const canonical = await countingRaw(async () => okData(await withIp(DENSE, "?interval=1d&limit=500", "198.18.0.4"), candlesSchema, CACHE.candles));
    expect(clamped.queries).toBe(1);
    expect(canonical.queries).toBe(0); // 钳到 500 之后与终端的规范请求是同一条缓存
    expect(canonical.result).toEqual(clamped.result);
  });

  it("过去的 to 对齐到所在桶的末尾并缓存(键含对齐后的 to):同一个桶里的不同 to 只查一次库", async () => {
    delete globalThis.__carbadiaBarsCache;
    const bucket = Math.floor((seededAt - 3 * 3_600_000) / 60_000) * 60_000;
    const first = await countingRaw(async () => okData(await withIp(DENSE, `?interval=1m&limit=30&to=${bucket + 5}`, "198.18.0.5"), candlesSchema, CACHE.candles));
    const second = await countingRaw(async () => okData(await withIp(DENSE, `?interval=1m&limit=20&to=${bucket + 59_000}`, "198.18.0.5"), candlesSchema, CACHE.candles));
    expect(first.queries).toBe(1);
    expect(second.queries).toBe(0);
    expect(first.result.candles).toHaveLength(30);
    expect(first.result.candles.at(-1)?.t).toBe(bucket); // 最后一根 = to 所在的整桶
    expect(second.result.candles).toEqual(first.result.candles.slice(-20));
    // 与 getBars 按桶末尾精确查库一致
    expect(first.result.candles).toEqual(await snapshots.getBars({ id: (await dense()).id, symbol: DENSE }, "1m", 30, bucket + 59_999));
  });

  it("未命中缓存的查库有全进程共享的预算(多 IP 也绕不过):用完 → 503 + Retry-After: 1,命中缓存的照常 200", async () => {
    delete globalThis.__carbadiaBarsCache;
    delete globalThis.__carbadiaBarsBudget;
    expect(snapshots.BARS_QUERY_BUDGET).toEqual({ perSecond: 10, burst: 20 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = Math.floor((seededAt - 6 * 3_600_000) / 60_000) * 60_000;
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await withIp(DENSE, `?interval=1m&limit=10&to=${base - i * 60_000}`, `198.18.1.${i}`)).status);
      expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(20).every((s) => s === 503)).toBe(true);
      const busy = await withIp(DENSE, `?interval=1m&limit=10&to=${base - 99 * 60_000}`, "198.18.1.99");
      expect(busy.status).toBe(503);
      expect(busy.headers.get("Retry-After")).toBe("1");
      await expect(busy.json()).resolves.toEqual({ ok: false, error: "Busy, please retry later" });
      // 已缓存的窗口不花预算
      expect((await withIp(DENSE, `?interval=1m&limit=10&to=${base}`, "198.18.1.100")).status).toBe(200);
      // 一秒回 10 个
      vi.setSystemTime(Date.now() + 1_000);
      for (let i = 30; i < 40; i++) expect((await withIp(DENSE, `?interval=1m&limit=10&to=${base - i * 60_000}`, "198.18.2.1")).status).toBe(200);
      expect((await withIp(DENSE, `?interval=1m&limit=10&to=${base - 41 * 60_000}`, "198.18.2.1")).status).toBe(503);
    } finally {
      vi.useRealTimers();
      delete globalThis.__carbadiaBarsBudget;
    }
  });

  it("预算被过去的 to 抽干时,「到现在」的窗口未命中照常 200、照常查库,也不花预算(终端的正常图表不跟着 503)", async () => {
    delete globalThis.__carbadiaBarsCache;
    delete globalThis.__carbadiaBarsBudget;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = Math.floor((seededAt - 8 * 3_600_000) / 60_000) * 60_000;
      for (let i = 0; i < 20; i++) expect((await withIp(DENSE, `?interval=1m&limit=10&to=${base - i * 60_000}`, `198.18.3.${i}`)).status).toBe(200);
      expect((await withIp(DENSE, `?interval=1m&limit=10&to=${base - 20 * 60_000}`, "198.18.3.20")).status).toBe(503);
      const tokens = () => globalThis.__carbadiaBarsBudget?.tokens; // 函数里读:delete 之后的直接读取会被 TS 收窄成 undefined
      const drained = tokens();
      expect(drained).toBeLessThan(1);
      // 终端的规范请求(1m × 1440 与其余周期 × 500)和未来的 to(= 到现在,1m 的 500 档):四个不同的键,全是未命中
      for (const query of ["?interval=1m&limit=1440", "?interval=5m&limit=500", "?interval=1d&limit=500", `?interval=1m&limit=200&to=${Date.now() + 86_400_000}`]) {
        const miss = await countingRaw(async () => withIp(DENSE, query, "198.18.3.99"));
        expect(miss.result.status).toBe(200);
        expect(miss.queries).toBe(1);
      }
      expect(tokens()).toBe(drained);
      // 过去的窗口仍然受预算约束
      expect((await withIp(DENSE, `?interval=1m&limit=10&to=${base - 21 * 60_000}`, "198.18.3.21")).status).toBe(503);
    } finally {
      vi.useRealTimers();
      delete globalThis.__carbadiaBarsBudget;
    }
  });

  it("路由:未来的 to 按「到现在」处理(走缓存,不会取到一段空的未来窗口);过去的 to 照常精确取", async () => {
    delete globalThis.__carbadiaBarsCache;
    const now = await okData(await withIp(DENSE, "?interval=1m&limit=200", "198.18.0.1"), candlesSchema, CACHE.candles);
    const { result, queries } = await countingRaw(async () =>
      okData(await withIp(DENSE, `?interval=1m&limit=200&to=${Date.now() + 86_400_000}`, "198.18.0.1"), candlesSchema, CACHE.candles),
    );
    expect(queries).toBe(0);
    expect(result.candles).toEqual(now.candles);
    const past = await countingRaw(async () =>
      okData(await withIp(DENSE, `?interval=1m&limit=10&to=${seededAt - 60 * 60_000}`, "198.18.0.1"), candlesSchema, CACHE.candles),
    );
    expect(past.queries).toBe(1);
    expect(past.result.candles.at(-1)?.t).toBe(Math.floor((seededAt - 60 * 60_000) / 60_000) * 60_000);
  });

  it(`路由按 IP 限流 ${120}/min:第 121 次 → 429 + Retry-After,另一个 IP 不受影响`, async () => {
    expect(snapshots.CANDLES_RATE_LIMIT).toEqual({ limit: 120, windowMs: 60_000 });
    for (let i = 0; i < 120; i++) expect((await withIp(QUIET, "?interval=1h", "198.18.0.2")).status).toBe(200);
    const limited = await withIp(QUIET, "?interval=1h", "198.18.0.2");
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    await expect(limited.json()).resolves.toEqual({ ok: false, error: "Too many requests, please retry later" });
    expect((await withIp(QUIET, "?interval=1h", "198.18.0.3")).status).toBe(200);
  });
});
