// 发布器对真实 SQLite(临时库 + migrate deploy)的集成测试(计划 §3.2、§3.4 两级门控):
// vi.mock 掉 db 指向临时库;总线用 server/bus.mjs 的 createBus() 挂在 globalThis 上,测试自己当订阅者;presence 直接写 globalThis.__carbadiaPresence。
// 断言:穿价成交 → 立即 trades(takerSide = 下单方)、50 ms 后 book(delta 只含变化档)、6 条 candle、ticker;同一去抖窗口内两次标脏只读一次盘口;
// 对 book:SYM 无兴趣 → getOrderBook 零调用、兴趣恢复后先发整份快照;无订阅者 → 零派生、零查询;presence 不含用户 → 无 account 事件,
// 含时 order / fill / balance / position 各一;撤单、重放、OTC buyListing → ticker 与标的列表缓存作废、订阅者抛错不影响后续、
// ticker 250 ms 节流、account 快照钩子(一个事务读完)。
// 每个用例一个新标的与两个新用户(freshMarket),盘口在 beforeEach 里不经发布器铺好:用例之间不共享盘口、成交与持仓,单独跑某一个(-t)也成立。
//
// 另外:两次读盘口乱序返回时旧的那份丢掉;K 线稳态折桶(不再查库、跨桶先发上一根的最终状态)与两个 bundle 乱序时的水位;
// ticker 兴趣中断期间丢掉 24 h 统计;订单行按提交顺序领票(跨 bundle 乱序时旧行不发);机器人账户不发 account 事件;
// 每用户票号表随用户离线回收。
//
// P2-03(计划 §6.2.2 C1 / C2):注销与 OTC 挂牌 / 撤牌提交后的 position 事件(publishPositionChange);整仓注销的行在事件与快照里;
// lockedBy(挂单 / 场外)每一步对得上;持仓读取票号(按用户与标的,乱序的旧行不发);发布器出错不让业务请求失败。
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createBus } from "../../../server/bus.mjs";
import type { BusMessage, Presence } from "@/shared/bus";
import { INTERVAL_MS } from "@/shared/candle-live";
import { CANDLE_INTERVALS } from "@/shared/constants";
import type { CandleBar, CandleInterval } from "@/shared/types";
import type { Topic } from "@/shared/ws-protocol";

const database = vi.hoisted(() => ({ directory: "", path: "", client: null as unknown }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

vi.mock("./db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  // 与生产的 db.ts 一样整个进程一份(生产挂在 globalThis.prisma 上):模拟第二个 bundle 而重新求值本模块时,拿到的还是这一个
  database.client ??= new PrismaClient({ datasourceUrl: `file:${database.path}`, log: [{ emit: "event", level: "query" }] });
  return { prisma: database.client };
});

type Db = (typeof import("./db"))["prisma"];
type Matching = typeof import("../exchange/matching");
type Otc = typeof import("../exchange/otc");
type RetirementLib = typeof import("../exchange/retirement");
type Publisher = typeof import("./market-publisher");
type Snapshots = typeof import("./market-snapshots");
type PositionsLib = typeof import("./positions");
type Stats = typeof import("../exchange/stats24h");

let prisma: Db;
let matching: Matching;
let otc: Otc;
let retirement: RetirementLib;
let publisher: Publisher;
let snapshots: Snapshots;
let getOrderBook: MockInstance<Matching["getOrderBook"]>;
let stats24h: MockInstance<Stats["stats24h"]>;
let realStats24h: Stats["stats24h"];
/** 未打桩的 getOrderBook(乱序读取的用例要在桩里调真的那个) */
let realGetOrderBook: Matching["getOrderBook"];
/** 发布器用的那份 market-snapshots(K 线用例 spy 它的 getBars;在 beforeAll 里取,原因同 stats24h) */
let barsSource: typeof import("./market-snapshots");
/** 发布器用的那份 positions.ts(holdNextPositionRead 拦它的 loadPositions;在 beforeAll 里取,原因同 stats24h) */
let positionsSource: PositionsLib;
let bus: ReturnType<typeof createBus>;
let queries = 0;
/** 最近的 SQL(只在需要看语句的用例里清空再读) */
const sql: string[] = [];

// 当前用例的标的与用户(freshMarket 每个用例重建)
let run = 0;
let symbol: string;
let assetId: string;
let alice: string;
let bob: string;

const received: BusMessage[] = [];
let unsubscribe: (() => void) | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ofKind<K extends BusMessage["kind"]>(kind: K): Extract<BusMessage, { kind: K }>[] {
  return received.filter((m): m is Extract<BusMessage, { kind: K }> => m.kind === kind);
}
function accountOf(userId: string) {
  return ofKind("account").filter((m) => m.userId === userId);
}
/** 当前标的的六个 candles topic */
function candleTopics(): Topic[] {
  return CANDLE_INTERVALS.map((i) => `candles:${symbol}:${i}` as Topic);
}
/** 当前标的的全部 topic(book / trades / ticker / 六个 candles)都有人订 */
function all(): Topic[] {
  return ["book", "trades", "ticker"].map((p) => `${p}:${symbol}` as Topic).concat(candleTopics());
}
/** 某个 interval 最后发出的那根 bar */
function lastCandle(interval: CandleInterval): CandleBar | undefined {
  return ofKind("candle").filter((m) => m.interval === interval).at(-1)?.candle;
}
/** 独立的对照:库里「uptoTs 所在的桶」从桶起点到 uptoTs 的全部成交聚合成的 bar(按 createdAt, id 排序取开收) */
async function bucketFromDb(interval: CandleInterval, uptoTs: number): Promise<CandleBar> {
  const ms = INTERVAL_MS[interval];
  const t = Math.floor(uptoTs / ms) * ms;
  const rows = await prisma.trade.findMany({
    where: { assetId, createdAt: { gte: new Date(t), lte: new Date(uptoTs) } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { price: true, quantity: true },
  });
  const prices = rows.map((r) => r.price);
  return { t, o: prices[0], h: Math.max(...prices), l: Math.min(...prices), c: prices[prices.length - 1], v: rows.reduce((s, r) => s + r.quantity, 0) };
}
function presence(topics: Topic[], users: string[] = []) {
  const p: Presence = { users: new Map(users.map((u) => [u, 1])), topics: new Map(topics.map((t) => [t, 1])) };
  globalThis.__carbadiaPresence = p;
}
/** 等去抖(50 ms)与串行派生都跑完 */
async function settle(ms = 120) {
  await sleep(ms);
  await publisher._internal.idle();
}
function subscribe() {
  unsubscribe?.();
  unsubscribe = bus.subscribe((m) => received.push(m));
}
/** 不经发布器改库:期间总线没有订阅者(门控 ①),下单只落库、不派生、不发消息 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  unsubscribe?.();
  unsubscribe = null;
  try {
    return await fn();
  } finally {
    subscribe();
  }
}
const buy = (userId: string, price: number, quantity: number, clientOrderId?: string) =>
  matching.placeOrder({ userId, assetId, side: "BUY", type: "LIMIT", price, quantity, clientOrderId });
const sell = (userId: string, price: number, quantity: number) => matching.placeOrder({ userId, assetId, side: "SELL", type: "LIMIT", price, quantity });

/** 新标的 + 两个新用户(alice 有现金,bob 有 100 000 吨持仓) */
async function freshMarket() {
  run += 1;
  const a = await prisma.user.create({ data: { email: `alice-${run}@publisher.test`, name: "Alice", passwordHash: "x", cashBalance: BigInt(10_000_000_00) } });
  const b = await prisma.user.create({ data: { email: `bob-${run}@publisher.test`, name: "Bob", passwordHash: "x", cashBalance: BigInt(10_000_000_00) } });
  alice = a.id;
  bob = b.id;
  symbol = `PUB-TEST-${run}`;
  const asset = await prisma.asset.create({
    data: { symbol, name: "Publisher test", standard: "VCS", projectType: "Forestry", vintage: 2026, country: "Example", registry: "Demo", lastPrice: 10_000 },
  });
  assetId = asset.id;
  await prisma.holding.create({ data: { userId: bob, assetId, quantity: 100_000, locked: 0 } });
}

beforeAll(async () => {
  database.directory = mkdtempSync(join(tmpdir(), "carbadia-publisher-"));
  database.path = join(database.directory, "publisher.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  bus = createBus();
  globalThis.__carbadiaBus = bus;
  ({ prisma } = await import("./db"));
  // db.ts 的类型是按无事件日志构造的 client(\$on 参数为 never);这里的实例在 mock 里带了 emit: "event",运行时可用
  (prisma as unknown as { $on(event: "query", cb: (e: { query: string }) => void): void }).$on("query", (e) => {
    queries += 1;
    sql.push(e.query);
    if (sql.length > 200) sql.shift();
  });
  matching = await import("../exchange/matching");
  realGetOrderBook = matching.getOrderBook; // 取在 spyOn 之前
  barsSource = await import("./market-snapshots");
  positionsSource = await import("./positions");
  otc = await import("../exchange/otc");
  retirement = await import("../exchange/retirement");
  publisher = await import("./market-publisher");
  snapshots = await import("./market-snapshots");
  getOrderBook = vi.spyOn(matching, "getOrderBook");
  // 在 beforeAll 里取:之后「两个 bundle」的用例 vi.resetModules() 了,再 import 拿到的是新实例,不是发布器用的这一份
  const statsModule = await import("../exchange/stats24h");
  realStats24h = statsModule.stats24h;
  stats24h = vi.spyOn(statsModule, "stats24h");
}, 60_000);

afterAll(async () => {
  unsubscribe?.();
  publisher?._internal.reset();
  globalThis.__carbadiaBus = undefined;
  globalThis.__carbadiaPresence = undefined;
  globalThis.__carbadiaAccountSnapshot = undefined;
  globalThis.__carbadiaBookRefresh = undefined;
  globalThis.__carbadiaRecentTrades = undefined;
  globalThis.__carbadiaInstrumentsCache = undefined;
  globalThis.__carbadiaLockMismatchLog = undefined;
  vi.restoreAllMocks();
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  unsubscribe?.();
  unsubscribe = null;
  publisher._internal.reset();
  received.length = 0;
  await freshMarket();
  // 标准盘口:bob 在 10_000 挂 100、在 10_100 挂 50(总线还没有订阅者,不经发布器)
  await sell(bob, 10_000, 100);
  await sell(bob, 10_100, 50);
  getOrderBook.mockClear();
  presence(all());
  subscribe();
});

afterEach(async () => {
  await publisher._internal.idle();
});

describe("门控 ①:无订阅者", () => {
  it("bus.hasSubscribers() 为 false → 零派生、零查询(placeOrder 之后再没有任何 SQL),也不读盘口", async () => {
    unsubscribe?.();
    unsubscribe = null;
    expect(bus.hasSubscribers()).toBe(false);
    const r = await buy(alice, 10_000, 10); // 穿价成交,若不门控会派生 ticker / candle / account
    expect(r.trades).toHaveLength(1);
    await settle(50); // 让事务自己的最后一条查询事件落地
    const after = queries;
    await settle(200);
    expect(queries).toBe(after);
    expect(getOrderBook).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
  });
});

describe("撮合结果 → book / trades / ticker / candle", () => {
  it("穿价成交:立即 trades(takerSide = 下单方,auditRef),50 ms 后 book(delta 只含变化档)、ticker、6 条 candle(当前桶从库里补齐)", async () => {
    await quietly(() => buy(alice, 10_000, 10)); // 此前的一笔成交(不经发布器):10_000 档剩 90
    await publisher._internal.flushBook(assetId); // 基线:第一次 delta 为 null = 整份快照
    expect(ofKind("book")).toHaveLength(1);
    expect(ofKind("book")[0].delta).toBeNull();
    received.length = 0;
    getOrderBook.mockClear();

    const r = await buy(alice, 10_050, 30); // 吃掉 10_000 档的 30(90 → 60)
    expect(r.trades).toHaveLength(1);
    // trades 在 placeOrder 返回前就已同步发出
    expect(ofKind("trades")).toHaveLength(1);
    expect(ofKind("trades")[0]).toEqual({
      kind: "trades",
      symbol,
      trades: [{ id: r.trades[0].id, symbol, price: 10_000, quantity: 30, takerSide: "BUY", ts: r.trades[0].createdAt.getTime(), auditRef: `SIM-TRD-${r.trades[0].id}` }],
    });

    await vi.waitFor(() => expect(ofKind("book")).toHaveLength(1));
    const book = ofKind("book")[0];
    expect(getOrderBook).toHaveBeenCalledTimes(1);
    expect(getOrderBook).toHaveBeenCalledWith(assetId, 50);
    expect(book.snapshot.asks).toEqual([
      { price: 10_000, quantity: 60, orders: 1 },
      { price: 10_100, quantity: 50, orders: 1 },
    ]);
    expect(book.snapshot.bids).toEqual([]);
    // 只有 10_000 档变了;10_100 没变不在 delta 里
    expect(book.delta).toEqual({ symbol, bids: [], asks: [{ price: 10_000, quantity: 60, orders: 1 }], ts: book.snapshot.ts });

    await settle();
    const candles = ofKind("candle");
    expect(candles.map((c) => c.interval).sort()).toEqual([...CANDLE_INTERVALS].sort());
    const tradeTs = r.trades[0].createdAt.getTime();
    for (const c of candles) {
      const ms = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 }[c.interval];
      const bucket = Math.floor(tradeTs / ms) * ms;
      expect(c.symbol).toBe(symbol);
      expect(c.candle.t).toBe(bucket);
      // 当前桶从库里补齐:含同一桶里此前那笔 10 吨(不跨桶时),不是只有这一笔
      const inBucket = await prisma.trade.aggregate({ where: { assetId, createdAt: { gte: new Date(bucket), lte: new Date(tradeTs) } }, _sum: { quantity: true } });
      expect(inBucket._sum.quantity).toBeGreaterThanOrEqual(30);
      expect(c.candle).toEqual({ t: bucket, o: 10_000, h: 10_000, l: 10_000, c: 10_000, v: inBucket._sum.quantity });
    }

    // 基线那次 flush 已发过一条书顶 ticker,成交这条落在 250 ms 节流窗口里,尾随发出
    await vi.waitFor(() => expect(ofKind("ticker").some((t) => t.ticker.lastPrice != null)).toBe(true), { timeout: 1_000 });
    const last = ofKind("ticker").find((t) => t.ticker.lastPrice != null)!;
    expect(last.ticker).toMatchObject({ symbol, lastPrice: 10_000, change24h: 0, high24h: 10_000, low24h: 10_000, volume24h: 40 });
    expect(typeof last.ticker.ts).toBe("number");
  });

  it("同一 50 ms 窗口内标脏两次(两次下单各标一次)→ getOrderBook 只调用一次,一条 book 带两档变化", async () => {
    await publisher._internal.flushBook(assetId); // 基线
    // 两次下单先落库(不经发布器),再同步连着标脏两次:必然落在同一个窗口里,不靠两个事务恰好在 50 ms 内提交
    await quietly(async () => {
      await sell(bob, 10_200, 10);
      await sell(bob, 10_300, 10);
    });
    received.length = 0;
    getOrderBook.mockClear();
    publisher.markBookDirty(assetId);
    publisher.markBookDirty(assetId);
    await settle(150);
    expect(getOrderBook).toHaveBeenCalledTimes(1);
    expect(ofKind("book")).toHaveLength(1);
    const { delta, snapshot } = ofKind("book")[0];
    expect(delta).toMatchObject({ bids: [], asks: [{ price: 10_200, quantity: 10, orders: 1 }, { price: 10_300, quantity: 10, orders: 1 }] });
    expect(snapshot.asks.map((l) => l.price)).toEqual([10_000, 10_100, 10_200, 10_300]);
  });

  it("盘口没变化时不发 book(去抖窗口后再读到同样的簿)", async () => {
    await publisher._internal.flushBook(assetId); // 建基线
    received.length = 0;
    getOrderBook.mockClear();
    publisher.markBookDirty(assetId); // 标脏但库里没变
    await settle();
    expect(getOrderBook).toHaveBeenCalledTimes(1);
    expect(ofKind("book")).toHaveLength(0);
  });

  it("两次读盘口乱序返回(较早发出的读取较晚回来)→ 较旧的那份不当基线、不发,hub 的盘口不被倒回去", async () => {
    await publisher._internal.flushBook(assetId); // 基线:10_000 / 10_100
    await quietly(() => sell(bob, 10_200, 10));
    received.length = 0;
    let firstReadDone!: () => void;
    const firstRead = new Promise<void>((resolve) => (firstReadDone = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    getOrderBook.mockImplementationOnce(async (id, depth) => {
      const book = await realGetOrderBook(id, depth); // 读到的是 10_300 挂上之前的簿
      firstReadDone();
      await gate; // 另一个 bundle / 下一次 flush 的读取先回来
      return book;
    });
    const slow = publisher._internal.flushBook(assetId);
    await firstRead;
    await quietly(() => sell(bob, 10_300, 10));
    await publisher._internal.flushBook(assetId); // 较晚发出、先回来:含 10_200 与 10_300
    release();
    await slow;
    const books = ofKind("book");
    expect(books).toHaveLength(1); // 旧的那份若当了基线,会再发一条 { 10_300 → 0 } 的 delta
    expect(books[0].snapshot.asks.map((l) => l.price)).toEqual([10_000, 10_100, 10_200, 10_300]);
    expect(globalThis.__carbadiaBookCache?.get(assetId)?.asks.map((l) => l.price)).toEqual([10_000, 10_100, 10_200, 10_300]);
    // 基线仍是较新的那份:库没变时再读一次不发
    await publisher._internal.flushBook(assetId);
    expect(ofKind("book")).toHaveLength(1);
  });

  it("dev HMR:globalThis 上是加全局票号之前的旧状态(每个 key 各数各的,没有 ticketSeq)→ 全局序列从旧表里最大的票号接着数,读取照常被采用", async () => {
    // 旧模块版本建的 __carbadiaPublisherState:没有 ticketSeq / balanceReads / orderReads / sweptAt / botUserIds,
    // bookReads 的计数器随运行时长涨到了 N。若 ticketSeq 从 0 开始,新票号 1、2… 全都小于 applied,盘口读取被一律判为过期
    globalThis.__carbadiaPublisherState = {
      stats: new Map(),
      bookReads: new Map([[assetId, { issued: 4_000, applied: 4_000 }]]),
      candleMarks: new Map(),
    } as unknown as NonNullable<typeof globalThis.__carbadiaPublisherState>;
    await publisher._internal.flushBook(assetId);
    expect(ofKind("book")).toHaveLength(1);
    expect(globalThis.__carbadiaPublisherState?.ticketSeq).toBe(4_001);
    // 余额表里更大的旧计数同样算进去(issued 与 applied 取大)
    publisher._internal.reset();
    globalThis.__carbadiaPublisherState = {
      stats: new Map(),
      bookReads: new Map([[assetId, { issued: 10, applied: 10 }]]),
      balanceReads: new Map([["someone", { issued: 70, applied: 90 }]]),
      candleMarks: new Map(),
    } as unknown as NonNullable<typeof globalThis.__carbadiaPublisherState>;
    received.length = 0;
    await publisher._internal.flushBook(assetId);
    expect(ofKind("book")).toHaveLength(1);
    expect(globalThis.__carbadiaPublisherState?.ticketSeq).toBe(91);
  });

  it("对 book:SYM 无兴趣 → getOrderBook 零调用,trades 照发;candles / ticker 无兴趣也不派生", async () => {
    presence([`trades:${symbol}`]);
    const r = await buy(alice, 10_100, 5);
    expect(r.trades).toHaveLength(1);
    expect(ofKind("trades")).toHaveLength(1);
    await settle(150);
    expect(getOrderBook).not.toHaveBeenCalled();
    expect(ofKind("book")).toHaveLength(0);
    expect(ofKind("candle")).toHaveLength(0);
    expect(ofKind("ticker")).toHaveLength(0);
    expect(ofKind("account")).toHaveLength(0);
  });

  it("无人订 book 期间丢掉差分基线:兴趣恢复后第一次 flush 发整份快照(delta null)与书顶 ticker,不在停住的基线上叠增量", async () => {
    await publisher._internal.flushBook(assetId); // 有人订时的基线(10_000 × 100)
    presence([`trades:${symbol}`]); // 订阅者走了
    await buy(alice, 10_100, 5); // 10_000 档 100 → 95,书顶价不变
    await settle(150);
    expect(getOrderBook).toHaveBeenCalledTimes(1); // 只有基线那次
    presence(all()); // 又有人订
    received.length = 0;
    await publisher._internal.flushBook(assetId);
    const books = ofKind("book");
    expect(books).toHaveLength(1);
    expect(books[0].delta).toBeNull(); // 整份,而不是 { asks: [10_000 × 95] }
    expect(books[0].snapshot.asks[0]).toEqual({ price: 10_000, quantity: 95, orders: 1 });
    // 书顶价没变也重发一次:hub 上的 bestBid / bestAsk 可能停在无人订阅之前(基线那次 flush 的 ticker 还在 250 ms 节流窗口里,这条尾随发出)
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(1), { timeout: 1_000 });
    expect(ofKind("ticker")[0].ticker).toMatchObject({ symbol, bestBid: null, bestAsk: 10_000 });
  });

  it("ticker:* 有订阅视为对 ticker:SYM 有兴趣;只订了一个 interval 就只发那一档 candle", async () => {
    presence(["ticker:*", `candles:${symbol}:5m`]);
    await buy(alice, 10_100, 1);
    await settle();
    expect(ofKind("ticker")).toHaveLength(1);
    expect(ofKind("ticker")[0].ticker.lastPrice).toBe(10_000);
    expect(ofKind("candle")).toHaveLength(1);
    expect(ofKind("candle")[0].interval).toBe("5m");
    expect(getOrderBook).not.toHaveBeenCalled();
  });

  it("ticker 250 ms 节流:第一条立即发,窗口内的后续更新合并成一条尾随更新", async () => {
    presence([`ticker:${symbol}`]);
    await Promise.all([buy(alice, 10_100, 1), buy(alice, 10_100, 1)]);
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(1));
    const first = ofKind("ticker")[0].ticker;
    await sleep(100);
    expect(ofKind("ticker")).toHaveLength(1); // 窗口内不发第二条
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(2), { timeout: 1_000 });
    const second = ofKind("ticker")[1].ticker;
    expect(second.ts - first.ts).toBeGreaterThanOrEqual(200);
    expect(second.lastPrice).toBe(10_000);
    expect(second.volume24h).toBeGreaterThanOrEqual(first.volume24h!);
    await sleep(300);
    expect(ofKind("ticker")).toHaveLength(2); // 没有更多更新就不再发
  });

  it("24 h 统计的刷新时刻取在查询返回之后:查询发出前刚提交的成交已在结果里,它自己的派生不再折一次(量不重复)", async () => {
    presence([`ticker:${symbol}`]);
    stats24h.mockImplementationOnce(async (id, lastPrice) => {
      await sleep(5);
      await buy(alice, 10_000, 20); // 刷新查询发出前另一笔成交落库并提交:createdAt 晚于「查询之前」那一刻,但已在查询结果里
      return realStats24h(id, lastPrice);
    });
    await buy(alice, 10_000, 10);
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(2), { timeout: 1_000 }); // 第二条是后一笔的派生,落在节流窗口里尾随发出
    await sleep(300);
    // 刷新时刻若取在查询之前,后一笔(ts 晚于它)会被再折一次:30 → 50
    expect(ofKind("ticker").map((t) => t.ticker.volume24h)).toEqual([30, 30]);
  });

  it("没人订 ticker 期间丢掉 24 h 统计缓存:兴趣恢复后的第一条 ticker 从库里刷新,不漏掉中断期间的成交", async () => {
    presence([`ticker:${symbol}`]);
    await buy(alice, 10_000, 10);
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(1)); // 刷新统计,量 10
    presence([`trades:${symbol}`]); // ticker 的订阅者走了
    await buy(alice, 10_000, 20); // 这笔不会被折进缓存
    await settle();
    expect(ofKind("ticker")).toHaveLength(1);
    presence([`ticker:${symbol}`]); // 10 s 内又有人订
    stats24h.mockClear();
    await buy(alice, 10_000, 30);
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(2), { timeout: 1_000 });
    // 缓存还在的话:10 + 30 = 40,少了中断期间那 20 吨,要到 10 s 后的刷新才补上
    expect(ofKind("ticker")[1].ticker.volume24h).toBe(60);
    expect(stats24h).toHaveBeenCalledTimes(1);
  });

  it("重放结果(replayed: true)→ 不标脏盘口、不发 account、不派生", async () => {
    presence(all(), [alice]);
    const key = "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab";
    await buy(alice, 9_000, 2, key);
    await settle();
    received.length = 0;
    getOrderBook.mockClear();
    const replay = await buy(alice, 9_000, 2, key);
    expect(replay.replayed).toBe(true);
    await settle(150);
    expect(received).toHaveLength(0);
    expect(getOrderBook).not.toHaveBeenCalled();
  });
});

describe("candle 稳态折桶(__carbadiaCandleState 已有当前桶)", () => {
  it("第一笔从库里补桶;之后的成交按 bucketUpdate 折进去、不再查库:六个 interval 各一条,数值 = 补的桶折进新成交 = 库里该桶的聚合", async () => {
    presence(candleTopics());
    const getBars = vi.spyOn(barsSource, "getBars");
    try {
      await buy(alice, 10_000, 10); // 冷启动:六个 interval 各补一次桶
      await settle();
      expect(getBars).toHaveBeenCalledTimes(6);
      const seeds = new Map(CANDLE_INTERVALS.map((i) => [i, lastCandle(i)!]));
      received.length = 0;
      getBars.mockClear();

      const second = await buy(alice, 10_100, 100); // 一批两笔:90 @ 10_000 + 10 @ 10_100
      expect(second.trades.map((t) => [t.price, t.quantity])).toEqual([[10_000, 90], [10_100, 10]]);
      await settle();
      expect(getBars).not.toHaveBeenCalled(); // 走的是折桶,不是补桶
      expect(ofKind("candle").map((c) => c.interval).sort()).toEqual([...CANDLE_INTERVALS].sort());
      const secondTs = second.trades[1].createdAt.getTime();
      for (const interval of CANDLE_INTERVALS) {
        const seed = seeds.get(interval)!;
        const bar = lastCandle(interval)!;
        if (Math.floor(secondTs / INTERVAL_MS[interval]) * INTERVAL_MS[interval] === seed.t) {
          expect(bar).toEqual({ t: seed.t, o: seed.o, h: 10_100, l: 10_000, c: 10_100, v: seed.v + 100 });
        }
        expect(bar).toEqual(await bucketFromDb(interval, secondTs));
      }

      // 再一笔更低的价:低价与收盘价往下走
      await quietly(() => buy(alice, 9_900, 10)); // alice 在 9_900 挂买单(不经发布器)
      received.length = 0;
      const third = await sell(bob, 9_900, 5); // bob 砸进去:5 @ 9_900
      await settle();
      expect(getBars).not.toHaveBeenCalled();
      const thirdTs = third.trades[0].createdAt.getTime();
      expect(ofKind("candle")).toHaveLength(6);
      for (const interval of CANDLE_INTERVALS) {
        const bar = lastCandle(interval)!;
        expect(bar).toMatchObject({ l: 9_900, c: 9_900 });
        expect(bar).toEqual(await bucketFromDb(interval, thirdTs));
      }
    } finally {
      getBars.mockRestore();
    }
  });

  it("当前桶是上一个桶(成交落进新桶)→ 开一根新 bar,t = 新桶起点;旧桶此前已发过,不重发", async () => {
    presence(candleTopics());
    const now = Date.now();
    for (const interval of CANDLE_INTERVALS) {
      const ms = INTERVAL_MS[interval];
      const t = Math.floor(now / ms) * ms - ms;
      (globalThis.__carbadiaCandleState ??= new Map()).set(`${assetId}:${interval}`, { t, o: 9_000, h: 9_000, l: 9_000, c: 9_000, v: 3 });
    }
    const getBars = vi.spyOn(barsSource, "getBars");
    try {
      const r = await buy(alice, 10_000, 10);
      await settle();
      expect(getBars).not.toHaveBeenCalled();
      const ts = r.trades[0].createdAt.getTime();
      expect(ofKind("candle")).toHaveLength(6);
      for (const interval of CANDLE_INTERVALS) {
        const ms = INTERVAL_MS[interval];
        expect(lastCandle(interval)).toEqual({ t: Math.floor(ts / ms) * ms, o: 10_000, h: 10_000, l: 10_000, c: 10_000, v: 10 });
        expect(globalThis.__carbadiaCandleState!.get(`${assetId}:${interval}`)).toEqual(lastCandle(interval));
      }
    } finally {
      getBars.mockRestore();
    }
  });

  it("一批成交跨桶:先发上一根的最终状态(含本批落在旧桶的那笔),再发新桶", async () => {
    presence(candleTopics());
    // 取一个整日边界 T0(也是其余五个 interval 的桶边界),构造一批横跨它的成交:T0 − 1 s 与 T0 + 1 s
    const day = INTERVAL_MS["1d"];
    const t0 = Math.floor(Date.now() / day) * day;
    for (const interval of CANDLE_INTERVALS) {
      const ms = INTERVAL_MS[interval];
      (globalThis.__carbadiaCandleState ??= new Map()).set(`${assetId}:${interval}`, { t: t0 - ms, o: 9_000, h: 9_500, l: 8_900, c: 9_100, v: 7 });
    }
    const real = await quietly(() => buy(alice, 10_100, 110)); // 100 @ 10_000 + 10 @ 10_100,落库但不经发布器
    expect(real.trades.map((t) => [t.price, t.quantity])).toEqual([[10_000, 100], [10_100, 10]]);
    const crossing = {
      ...real,
      trades: [
        { ...real.trades[0], createdAt: new Date(t0 - 1_000) },
        { ...real.trades[1], createdAt: new Date(t0 + 1_000) },
      ],
    };
    publisher.publishOrderResult(crossing);
    await settle();
    for (const interval of CANDLE_INTERVALS) {
      const ms = INTERVAL_MS[interval];
      expect(ofKind("candle").filter((c) => c.interval === interval).map((c) => c.candle)).toEqual([
        { t: t0 - ms, o: 9_000, h: 10_000, l: 8_900, c: 10_000, v: 107 }, // 上一根的最终状态:折进了 T0 − 1 s 那笔
        { t: t0, o: 10_100, h: 10_100, l: 10_100, c: 10_100, v: 10 }, // 新桶只有 T0 + 1 s 那笔
      ]);
    }
  });
});

describe("account 事件(门控 ②:hasUser)", () => {
  it("presence 不含用户 → 无 account 消息", async () => {
    presence(all(), []);
    await buy(alice, 10_100, 2);
    await settle();
    expect(ofKind("account")).toHaveLength(0);
  });

  it("含 taker 用户 → order / fill / balance / position 各一;fill 从 taker 视角、ledgerRefs 是本人账本行;maker 不在线则没有", async () => {
    presence(all(), [alice]);
    const r = await buy(alice, 10_100, 4); // 以 10_000 成交(价格改善)
    await settle();
    const mine = accountOf(alice).map((m) => m.event);
    expect(mine.map((e) => e.t)).toEqual(["order", "fill", "balance", "position"]);
    const order = mine[0].t === "order" ? mine[0].order : null;
    expect(order).toMatchObject({ id: r.order.id, symbol, side: "BUY", status: "FILLED", filledQuantity: 4, avgFillPrice: 10_000, cancelReason: null });
    const fill = mine[1].t === "fill" ? mine[1].fill : null;
    expect(fill).toMatchObject({ id: r.trades[0].id, orderId: r.order.id, symbol, side: "BUY", role: "TAKER", price: 10_000, quantity: 4, notional: 40_000, feeCents: 0, auditRef: `SIM-TRD-${r.trades[0].id}` });
    const ledger = await prisma.ledgerEntry.findMany({ where: { userId: alice, refType: "TRADE", refId: r.trades[0].id }, select: { id: true } });
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    expect(fill!.ledgerRefs.sort()).toEqual(ledger.map((l) => l.id).sort());
    const user = await prisma.user.findUniqueOrThrow({ where: { id: alice } });
    expect(mine[2]).toEqual({ t: "balance", balance: { cashBalance: Number(user.cashBalance), lockedCash: Number(user.lockedCash) } });
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: alice, assetId } } });
    expect(holding.quantity).toBe(4);
    expect(mine[3].t === "position" && mine[3].position).toMatchObject({ assetId, symbol, quantity: 4, locked: holding.locked, available: 4 - holding.locked, retired: 0, isScenario: false });
    expect(accountOf(bob)).toHaveLength(0);
  });

  it("含 maker 用户 → maker 收到自己的 order(均价按实际成交重算)/ fill(MAKER)/ balance / position", async () => {
    presence(all(), [bob]);
    const r = await buy(alice, 10_000, 3);
    await settle();
    expect(accountOf(alice)).toHaveLength(0);
    const events = accountOf(bob).map((m) => m.event);
    expect(events.map((e) => e.t)).toEqual(["order", "fill", "balance", "position"]);
    const maker = r.makerOrders[0];
    expect(events[0].t === "order" && events[0].order).toMatchObject({ id: maker.id, side: "SELL", status: "PARTIAL", filledQuantity: 3, avgFillPrice: 10_000 });
    expect(events[1].t === "fill" && events[1].fill).toMatchObject({ id: r.trades[0].id, orderId: maker.id, side: "SELL", role: "MAKER", quantity: 3 });
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: bob, assetId } } });
    expect(events[3].t === "position" && events[3].position).toMatchObject({ assetId, quantity: holding.quantity, locked: holding.locked });
  });

  it("撤单 → order 事件 CANCELLED / cancelReason USER + balance + position,盘口 delta 删档", async () => {
    await quietly(() => buy(alice, 10_000, 5)); // alice 持有 5:撤单后照样收到该标的的持仓
    const resting = await buy(alice, 9_100, 3);
    await settle();
    presence(all(), [alice]);
    received.length = 0;
    await matching.cancelOrder(alice, resting.order.id);
    await settle();
    const events = accountOf(alice).map((m) => m.event);
    expect(events.map((e) => e.t)).toEqual(["order", "balance", "position"]);
    expect(events[0].t === "order" && events[0].order).toMatchObject({ id: resting.order.id, status: "CANCELLED", cancelReason: "USER" });
    expect(events[2].t === "position" && events[2].position).toMatchObject({ assetId, quantity: 5 });
    expect(ofKind("book")).toHaveLength(1);
    expect(ofKind("book")[0].delta).toMatchObject({ bids: [{ price: 9_100, quantity: 0, orders: 0 }], asks: [] });
  });

  it("account 快照钩子 globalThis.__carbadiaAccountSnapshot:balance + 当前挂单 + 持仓(与 REST 同形),余额 / 挂单 / 持仓在一个事务里读", async () => {
    await quietly(() => buy(alice, 10_000, 5)); // alice 持有 5
    const open = await buy(alice, 9_200, 7);
    sql.length = 0;
    const transaction = vi.spyOn(prisma, "$transaction");
    const snapshot = await globalThis.__carbadiaAccountSnapshot!(alice);
    const statements = [...sql];
    // 一个批量事务装下全部七个读取(余额、挂单 + 持仓的五个:持仓行、账本、注销、SELL 挂单汇总、场外挂牌汇总;
    // 不是 Promise.all 里各读各的,再加一个只管持仓的小事务)
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][0]).toHaveLength(7);
    transaction.mockRestore();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: alice } });
    expect(snapshot.balance).toEqual({ cashBalance: Number(user.cashBalance), lockedCash: Number(user.lockedCash) });
    expect(snapshot.orders).toEqual([expect.objectContaining({ id: open.order.id, symbol, side: "BUY", status: "OPEN", price: 9_200, quantity: 7 })]);
    expect(snapshot.positions).toEqual([expect.objectContaining({ assetId, symbol, quantity: 5, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 5 })]);
    // 余额、挂单、持仓、账本、注销聚合、锁定来源的读取夹在同一对 BEGIN / COMMIT 之间:不会拼出「余额含某笔成交、挂单还是成交前」的快照
    const begin = statements.findIndex((s) => /^BEGIN/i.test(s));
    const commit = statements.findIndex((s) => /^COMMIT/i.test(s));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    const inTx = statements.slice(begin + 1, commit).join("\n");
    for (const table of ["User", "Order", "Holding", "LedgerEntry", "Retirement", "OtcListing"]) expect(inTx).toContain(`\`${table}\``);
    expect(statements.filter((s) => /^BEGIN/i.test(s))).toHaveLength(1);
    await matching.cancelOrder(alice, open.order.id);
  });
});

describe("两个 bundle(instrumentation 的 bot 与 route handler 的用户下单各有一份本模块)", () => {
  it("24 h 统计缓存挂在 globalThis 上:两份模块交替发 ticker,volume24h 逐笔累加、不倒退也不重复", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // 第二份模块实例 = 另一个 bundle;总线、presence 与缓存经 globalThis 共用
    presence([`ticker:${symbol}`]);
    await buy(alice, 10_000, 10); // bundle A(本文件导入的那份):刷新统计后发 ticker,量 10
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(1));
    const r = await quietly(() => buy(alice, 10_000, 20)); // 另一个 bundle 里的下单:由 bundle B 发布
    other.publishOrderResult(r);
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(2));
    await other._internal.idle();
    await buy(alice, 10_000, 30); // 回到 bundle A(落在它 250 ms 节流窗口里就尾随发出)
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(3), { timeout: 1_000 });
    // 各 bundle 一份缓存时:B 从库里刷新得 30,A 仍在自己的 10 上累加得 40——相邻两条先 30 再 40,第三条少算了 B 那笔
    expect(ofKind("ticker").map((t) => t.ticker.volume24h)).toEqual([10, 30, 60]);
    expect(ofKind("ticker").map((t) => t.ticker.lastPrice)).toEqual([10_000, 10_000, 10_000]);
  });

  it("K 线:另一个 bundle 先提交、后发布的成交已在本 bundle 补的桶里 → 跳过(水位 seedTo),量不翻倍、收盘价不倒回", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence(candleTopics());
    const early = await quietly(() => buy(alice, 10_000, 100)); // bundle B 的成交:先提交(吃光 10_000 档),派生还没跑
    const late = await buy(alice, 10_100, 5); // bundle A:冷启动补桶,库里的桶已含 B 那 100 吨
    await settle();
    const lateTs = late.trades[0].createdAt.getTime();
    for (const interval of CANDLE_INTERVALS) expect(lastCandle(interval)).toEqual(await bucketFromDb(interval, lateTs));
    received.length = 0;
    other.publishOrderResult(early); // B 的派生这时才跑
    await settle();
    await other._internal.idle();
    expect(ofKind("candle")).toHaveLength(0); // 桶没变,不发
    for (const interval of CANDLE_INTERVALS) {
      // 再折一次的话:量 105 → 205,收盘 10_100 → 10_000
      expect(globalThis.__carbadiaCandleState?.get(`${assetId}:${interval}`)).toEqual(await bucketFromDb(interval, lateTs));
    }
  });

  it("K 线:比已折进来的最新成交更早、又不在补桶里的成交晚到(另一个 bundle)→ 只补量与高低,收盘价不倒回", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence(candleTopics());
    await buy(alice, 10_000, 10); // bundle A:冷启动补桶(10 @ 10_000)
    await settle();
    await quietly(() => buy(alice, 9_900, 20)); // alice 在 9_900 挂买单
    const early = await quietly(() => sell(bob, 9_900, 20)); // bundle B 的成交:20 @ 9_900,先提交,派生还没跑
    const late = await buy(alice, 10_000, 5); // bundle A:5 @ 10_000,正常折进当前桶
    await settle();
    received.length = 0;
    other.publishOrderResult(early);
    await settle();
    await other._internal.idle();
    const lateTs = late.trades[0].createdAt.getTime();
    for (const interval of CANDLE_INTERVALS) {
      // 开盘价比不了:晚到的那笔若恰好是新桶的第一笔(跨桶),开盘价应是它,但桶已按后一笔开好;其余四项与库一致
      const expected = await bucketFromDb(interval, lateTs);
      const bar = globalThis.__carbadiaCandleState!.get(`${assetId}:${interval}`)!;
      // 同一桶时:高 10_000、低 9_900、收 10_000(按 bucketUpdate 折的话收盘退回 9_900)、量 35
      expect({ ...bar, o: expected.o }).toEqual(expected);
    }
    for (const { interval, candle } of ofKind("candle")) expect(candle).toEqual(globalThis.__carbadiaCandleState!.get(`${assetId}:${interval}`));
    expect(ofKind("candle").length).toBeGreaterThan(0);
  });
});

describe("盘口全量刷新钩子 globalThis.__carbadiaBookRefresh(hub 在 book 订阅时没有这本簿的缓存)", () => {
  beforeEach(() => {
    // 前面「两个 bundle」的用例 vi.resetModules() 过,钩子此刻是最后加载的那份模块挂的;这里要的是打了 getOrderBook 桩的这一份
    globalThis.__carbadiaBookRefresh = publisher.refreshBook;
  });

  it("模块加载即挂钩子(与 account 快照钩子一样不用 ??=:最后加载的一份生效)", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    expect(globalThis.__carbadiaBookRefresh).toBe(other.refreshBook);
    expect(globalThis.__carbadiaAccountSnapshot).toBe(other.loadAccountSnapshot);
    expect(globalThis.__carbadiaRecentTrades).toBe(other.recentTrades);
  });

  it("同步丢掉差分基线,再读一次盘口发整份快照(delta null)与书顶 ticker——即使基线还在、库也没变", async () => {
    await publisher._internal.flushBook(assetId); // 基线(hub 那边的缓存已因无人订阅被淘汰,发布器的基线还在)
    received.length = 0;
    getOrderBook.mockClear();
    const pending = globalThis.__carbadiaBookRefresh!(symbol);
    // 同步部分已丢基线:此后先完成的任何一次读取(包括别的 bundle 在途的那次)都发整份快照,不会先来一条叠在旧基线上的 delta
    expect(globalThis.__carbadiaBookCache?.has(assetId)).toBe(false);
    await pending;
    expect(getOrderBook).toHaveBeenCalledTimes(1);
    const books = ofKind("book");
    expect(books).toHaveLength(1);
    expect(books[0].delta).toBeNull();
    expect(books[0].snapshot.asks).toEqual([
      { price: 10_000, quantity: 100, orders: 1 },
      { price: 10_100, quantity: 50, orders: 1 },
    ]);
    await vi.waitFor(() => expect(ofKind("ticker")).toHaveLength(1), { timeout: 1_000 });
    expect(ofKind("ticker")[0].ticker).toMatchObject({ symbol, bestBid: null, bestAsk: 10_000 });
  });

  it("刷新开始前已在途、刷新之后才返回的读取:基线已丢,它发的也是整份快照(不是对旧基线的 delta)", async () => {
    await publisher._internal.flushBook(assetId); // 基线:10_000 / 10_100
    await quietly(() => sell(bob, 10_200, 10));
    received.length = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const inflight = new Promise<void>((resolve) => (reached = resolve));
    getOrderBook.mockImplementationOnce(async (id, depth) => {
      const book = await realGetOrderBook(id, depth);
      reached();
      await gate;
      return book;
    });
    getOrderBook.mockImplementationOnce(async () => {
      throw new Error("refresh read failed"); // 让刷新自己的那次读取失败:只看在途的那次发了什么
    });
    const slow = publisher._internal.flushBook(assetId);
    await inflight;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(globalThis.__carbadiaBookRefresh!(symbol)).rejects.toThrow("refresh read failed");
    errors.mockRestore();
    release();
    await slow;
    const books = ofKind("book");
    expect(books).toHaveLength(1);
    expect(books[0].delta).toBeNull(); // 不丢基线的话这里是 { asks: [10_200 × 10] } 的 delta,新订阅者手里没有簿,拼不出来
    expect(books[0].snapshot.asks.map((l) => l.price)).toEqual([10_000, 10_100, 10_200]);
  });

  it("没人订 book:SYM(hub 已退订)或 symbol 不存在:不读盘口、不发;结果区分两者(found),hub 据此对不存在的 symbol 不再请", async () => {
    presence([`trades:${symbol}`]);
    await expect(globalThis.__carbadiaBookRefresh!(symbol)).resolves.toEqual({ found: true });
    await expect(globalThis.__carbadiaBookRefresh!("NO-SUCH-SYMBOL")).resolves.toEqual({ found: false });
    expect(getOrderBook).not.toHaveBeenCalled();
    expect(ofKind("book")).toHaveLength(0);
  });

  it("找到了且有人订:{ found: true } 并发出整份快照", async () => {
    await expect(globalThis.__carbadiaBookRefresh!(symbol)).resolves.toEqual({ found: true });
    expect(ofKind("book")).toHaveLength(1);
  });

  it("接上真实的 hub:订阅一个不存在的 symbol 的盘口,asset.findUnique 只查一次,之后多少个冷却期都不再查(修复前每个冷却期一次,没有尽头)", async () => {
    const { createHub } = await import("../../../server/ws-hub.mjs");
    const ghost = `NO-SUCH-${run}`;
    const findUnique = vi.spyOn(prisma.asset, "findUnique");
    const lookups = () => findUnique.mock.calls.filter(([args]) => (args as { where: { symbol?: string } }).where.symbol === ghost).length;
    const logs: string[] = [];
    const saved = { presence: globalThis.__carbadiaPresence, stats: globalThis.__carbadiaWsStats, seq: globalThis.__carbadiaTopicSeq };
    // 标的列表从没出现过时 symbolVerdict 放行任何 symbol(部署后的那段窗口,按连接限流);冷却调到 20 ms,300 ms 里修复前会查十几次
    const hub = createHub({ bus, log: (line) => logs.push(line), batchMs: 5, bookRefreshCooldownMs: 20, isKnownSymbol: () => true });
    // 最小的假 socket(同 ws-hub.test.ts 的 FakeWs):hub 只用 send / close / terminate / ping、readyState、bufferedAmount 与事件
    class GhostSocket extends EventEmitter {
      readyState = 1;
      bufferedAmount = 0;
      frames: unknown[][] = [];
      send(data: string) {
        this.frames.push(JSON.parse(data));
      }
      close(code?: number) {
        this.readyState = 3;
        queueMicrotask(() => this.emit("close", code ?? 1005, ""));
      }
      terminate() {
        this.close(1006);
      }
      ping() {}
    }
    const socket = new GhostSocket();
    try {
      hub.accept(socket, { userId: null, ip: "local" });
      socket.emit("message", JSON.stringify({ op: "subscribe", topics: [`book:${ghost}`] }), false);
      await vi.waitFor(() => expect(lookups()).toBe(1));
      await sleep(300);
      expect(lookups()).toBe(1);
      expect(socket.frames.flat()).toContainEqual({ t: "subscribed", topic: `book:${ghost}`, seq: 0 });
      expect(logs.filter((l) => l.includes("book refresh failed"))).toEqual([]);
    } finally {
      await hub.close(1001, "test over");
      findUnique.mockRestore();
      globalThis.__carbadiaPresence = saved.presence;
      globalThis.__carbadiaWsStats = saved.stats;
      globalThis.__carbadiaTopicSeq = saved.seq;
    }
  });
});

describe("成交带预读钩子 globalThis.__carbadiaRecentTrades(hub 的成交环在重启后是空的;终审 P1-25a)", () => {
  it("读库里最近 64 笔,时间升序,takerSide 与 auditRef 同 REST;查无此 symbol → found: false", async () => {
    expect(globalThis.__carbadiaRecentTrades).toEqual(expect.any(Function)); // 最后加载的一份(见上面「模块加载即挂钩子」)
    const made: string[] = [];
    for (let i = 0; i < 3; i += 1) made.push(...(await quietly(() => buy(alice, 10_000, 1))).trades.map((t) => t.id));
    const result = await globalThis.__carbadiaRecentTrades!(symbol);
    expect(result.found).toBe(true);
    expect(result.trades.map((t) => t.id)).toEqual(made);
    expect(result.trades[0]).toMatchObject({ symbol, price: 10_000, quantity: 1, takerSide: "BUY", auditRef: `SIM-TRD-${made[0]}` });
    await expect(globalThis.__carbadiaRecentTrades!("NO-SUCH-SYMBOL")).resolves.toEqual({ found: false, trades: [] });
  });

  it("接上真实的 hub:进程刚起(环是空的)时第一次订阅 trades:SYM 拿到库里的成交,之后的成交照常增量", async () => {
    const { createHub } = await import("../../../server/ws-hub.mjs");
    const before: string[] = [];
    for (let i = 0; i < 3; i += 1) before.push(...(await quietly(() => buy(alice, 10_000, 1))).trades.map((t) => t.id));
    const saved = { presence: globalThis.__carbadiaPresence, stats: globalThis.__carbadiaWsStats, seq: globalThis.__carbadiaTopicSeq };
    const hub = createHub({ bus, log: () => {}, batchMs: 5, isKnownSymbol: () => true });
    class TapeSocket extends EventEmitter {
      readyState = 1;
      bufferedAmount = 0;
      frames: { t: string; seq?: number; trades?: { id: string }[] }[][] = [];
      send(data: string) {
        this.frames.push(JSON.parse(data));
      }
      close(code?: number) {
        this.readyState = 3;
        queueMicrotask(() => this.emit("close", code ?? 1005, ""));
      }
      terminate() {
        this.close(1006);
      }
      ping() {}
    }
    const socket = new TapeSocket();
    const tapeEvents = () => socket.frames.flat().filter((e) => e.t === "trades");
    try {
      hub.accept(socket, { userId: null, ip: "local" });
      socket.emit("message", JSON.stringify({ op: "subscribe", topics: [`trades:${symbol}`] }), false);
      await vi.waitFor(() => expect(tapeEvents()).toHaveLength(1));
      expect(tapeEvents()[0].trades!.map((t) => t.id)).toEqual(before); // 修复前:[](直到下一笔成交)
      const r = await buy(alice, 10_000, 1); // 经发布器:hub 的环接着收增量
      await vi.waitFor(() => expect(tapeEvents()).toHaveLength(2));
      expect(tapeEvents()[1]).toMatchObject({ seq: 1, trades: [{ id: r.trades[0].id }] });
    } finally {
      await hub.close(1001, "test over");
      globalThis.__carbadiaPresence = saved.presence;
      globalThis.__carbadiaWsStats = saved.stats;
      globalThis.__carbadiaTopicSeq = saved.seq;
    }
  });
});

/** 让 userId 的下一次余额读取在读完库之后停住,等 release 才返回:一次读得早、发得晚的慢派生 */
function holdNextBalanceRead(userId: string) {
  const real = prisma.user.findUniqueOrThrow.bind(prisma.user);
  let readDone!: () => void;
  const read = new Promise<void>((resolve) => (readDone = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let armed = true;
  const spy = vi.spyOn(prisma.user, "findUniqueOrThrow").mockImplementation(((args: { where: { id?: string } }) => {
    const query = real(args as Parameters<typeof real>[0]);
    if (!armed || args.where.id !== userId) return query; // 其余调用原样(快照的批量事务要的是 PrismaPromise)
    armed = false;
    return (async () => {
      const row = await query;
      readDone();
      await gate;
      return row;
    })();
  }) as unknown as typeof real);
  // restore 顺带放行:用例在 release 之前断言失败时,停住的派生不至于把 afterEach 的 idle() 挂到超时
  return {
    read,
    release,
    restore: () => {
      release();
      spy.mockRestore();
    },
  };
}
async function balanceNow(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return { cashBalance: Number(user.cashBalance), lockedCash: Number(user.lockedCash) };
}

describe("余额读取票号(余额按用户,派生按标的、按 bundle 排队)", () => {
  it("较早发出、较晚返回的余额读取不发:另一个 bundle 已发了更晚读到的余额(否则客户端整行覆盖成旧余额,空闲用户一直错下去)", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // 另一个 bundle
    presence([], [alice]);
    const r1 = await quietly(() => buy(alice, 10_000, 10)); // C1 已提交,派生还没跑
    const hold = holdNextBalanceRead(alice);
    try {
      publisher.publishOrderResult(r1); // bundle A 派生 C1:余额读在 C2 之前,停住
      await hold.read;
      const r2 = await quietly(() => buy(alice, 10_000, 20)); // C2
      other.publishOrderResult(r2); // bundle B 派生 C2:读到 C2 之后的余额,先发出
      await other._internal.idle();
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    const events = accountOf(alice).map((m) => m.event);
    expect(events.filter((e) => e.t === "balance")).toEqual([{ t: "balance", balance: await balanceNow(alice) }]);
    // 其余事件照发:B 的 order / fill / balance / position,A 的 order / fill。A 的持仓读取与余额同时发出(C2 之前)、同样晚到,
    // 按持仓票号也不发(计划 §6.2.2 C2:旧行不盖新行);最后一条 position 是 B 读到的、含 C2 的那一行
    expect(events.map((e) => e.t)).toEqual(["order", "fill", "balance", "position", "order", "fill"]);
    expect(events.filter((e) => e.t === "position").map((e) => e.t === "position" && e.position.quantity)).toEqual([30]);
  });

  it("按发出顺序返回时两条都发;票号跨 bundle 单调,之后较晚发出的读取照常发", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence([], [alice]);
    await buy(alice, 10_000, 10); // bundle A
    await settle();
    const r2 = await quietly(() => buy(alice, 10_000, 20));
    other.publishOrderResult(r2); // bundle B
    await other._internal.idle();
    await buy(alice, 10_000, 5); // 回到 bundle A
    await settle();
    const balances = accountOf(alice).filter((m) => m.event.t === "balance");
    expect(balances).toHaveLength(3);
    expect(balances.at(-1)!.event).toEqual({ t: "balance", balance: await balanceNow(alice) });
  });

  it("OTC 路径同样领票:OTC 派生的余额读取较早发出、较晚返回时不发", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence([], [alice, bob]);
    const listing = await otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 });
    received.length = 0;
    const hold = holdNextBalanceRead(alice);
    try {
      await otc.buyListing(alice, listing.id, 5); // 提交后 publishLastPrice(bundle A):alice 的余额读完停住
      await hold.read;
      const r2 = await quietly(() => buy(alice, 10_000, 20));
      other.publishOrderResult(r2); // bundle B:更晚的余额先发出
      await other._internal.idle();
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    expect(accountOf(alice).filter((m) => m.event.t === "balance").map((m) => m.event)).toEqual([{ t: "balance", balance: await balanceNow(alice) }]);
    // 别的用户的票号各自独立:bob 是 C2 的 maker(bundle B 先发一条),OTC 派生里他的余额读取发出得更晚,照常发出
    const bobBalances = accountOf(bob).filter((m) => m.event.t === "balance").map((m) => m.event);
    expect(bobBalances).toHaveLength(2);
    expect(bobBalances.at(-1)).toEqual({ t: "balance", balance: await balanceNow(bob) });
    await otc.cancelListing(bob, listing.id);
  });
});

describe("订单事件票号(按订单,在提交后同步领票;终审 P1-25a)", () => {
  /** alice 的一张挂单 O(9_500 买 10,低于 bob 的卖价,不成交);bob 吃掉 O 的 4 吨(r1:O PARTIAL);alice 撤掉 O(r2:O CANCELLED)。都不经发布器 */
  async function partialThenCancel() {
    const resting = await quietly(() => buy(alice, 9_500, 10));
    const r1 = await quietly(() => sell(bob, 9_500, 4));
    const r2 = await quietly(() => matching.cancelOrder(alice, resting.order.id));
    return { id: resting.order.id, r1, r2 };
  }
  const orderEvents = (userId: string) =>
    accountOf(userId)
      .map((m) => m.event)
      .flatMap((e) => (e.t === "order" ? [[e.order.id, e.order.status] as const] : []));

  it("较早提交的结果(bot 部分成交,instrumentation bundle)派生慢、晚到:不覆盖较晚提交、已发布的撤单(否则撤掉的单以 PARTIAL 回到挂单列表)", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // route handler bundle(REST 撤单)
    presence([], [alice]);
    const { id, r1, r2 } = await partialThenCancel();
    const hold = holdNextBalanceRead(alice);
    try {
      publisher.publishOrderResult(r1); // 按提交顺序领票:r1 先
      await hold.read; // bundle A 的派生停在读库之后(chain 里排着 stats24h、K 线、五个账户读取……)
      other.publishOrderResult(r2); // bundle B:撤单没有成交,只读账户,先发出
      await other._internal.idle();
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    expect(orderEvents(alice)).toEqual([[id, "CANCELLED"]]); // 修复前:[CANCELLED, PARTIAL]
    // 其余事件照发(余额按余额票号、持仓按持仓票号裁决:A 的余额与持仓都读在 B 之前、晚到,也不发)
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["order", "balance", "position", "fill"]);
  });

  it("按提交顺序到达时两条都发:PARTIAL 之后 CANCELLED;票号跨 bundle 单调", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence([], [alice]);
    const { id, r1, r2 } = await partialThenCancel();
    publisher.publishOrderResult(r1);
    await settle();
    other.publishOrderResult(r2);
    await other._internal.idle();
    expect(orderEvents(alice)).toEqual([
      [id, "PARTIAL"],
      [id, "CANCELLED"],
    ]);
  });

  it("在途的派生 → 用户掉线 → 掉线期间的提交(撤单)→ 重连拿到快照 → 在途的派生返回:旧的 PARTIAL 行不发(提交发现用户不在线时删掉这张单的票号条目)", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // 另一个 bundle(同一 bundle 同一标的的派生排在在途那次之后)
    presence([], [alice]);
    const { id, r1, r2 } = await partialThenCancel();
    const hold = holdNextBalanceRead(alice);
    try {
      publisher.publishOrderResult(r1); // 提交时在线:领了这张单的票;派生读到 PARTIAL,停住(在途)
      await hold.read;
      expect(globalThis.__carbadiaPublisherState!.orderReads.has(id)).toBe(true);
      presence([], []); // alice 掉线
      other.publishOrderResult(r2); // 掉线期间的提交(撤单):不领票,并删掉这张单的条目
      await other._internal.idle();
      expect(globalThis.__carbadiaPublisherState!.orderReads.has(id)).toBe(false);
      presence([], [alice]); // 重连
      const snapshot = await globalThis.__carbadiaAccountSnapshot!(alice); // 新快照读在撤单之后:没有这张单
      expect(snapshot.orders).toEqual([]);
      hold.release(); // 在途的派生这时才返回
      await settle();
    } finally {
      hold.restore();
    }
    // 修复前:[[id, "PARTIAL"]] —— 在快照之后到达,把撤掉的单放回挂单列表;客户端的 closedOrders 兜底只认事件里见过的终结,挡不住
    expect(orderEvents(alice)).toEqual([]);
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["fill"]); // 成交是追加的,照发;余额与持仓同样按票号丢掉
  });

  it("提交时在线(领了票)、派生开始前掉线:不读库,这张单的条目同样删掉,更早那次在途的派生返回时不发旧行", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence([], [alice]);
    const { id, r1, r2 } = await partialThenCancel();
    const hold = holdNextBalanceRead(alice);
    try {
      publisher.publishOrderResult(r1);
      await hold.read;
      other.publishOrderResult(r2); // 提交时在线:领了更晚的一张票
      presence([], []); // 派生排在微任务里:在它开始前掉线,CANCELLED 行没有发出去
      await other._internal.idle();
      expect(globalThis.__carbadiaPublisherState!.orderReads.has(id)).toBe(false);
      presence([], [alice]); // 重连(快照里没有这张单)
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    expect(orderEvents(alice)).toEqual([]); // 修复前:[[id, "PARTIAL"]]
  });

  it("提交时用户不在线(没领票)、派生时才上线:不发这张单的行(他订阅时拿到的快照读在提交之后,不比它旧),成交 / 余额 / 持仓照发", async () => {
    presence([], []);
    const { r1 } = await partialThenCancel();
    publisher.publishOrderResult(r1);
    presence([], [alice]); // 派生是异步的:在它跑之前上线
    await settle();
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["fill", "balance", "position"]);
  });
});

/** holdNextPositionRead 等事件路径的持仓读取出现的时限:过了就以明确的错误失败,不让用例干等到超时 */
const HOLD_POSITION_READ_MS = 3_000;

/**
 * 让 bundle A(beforeAll 里加载的那份发布器)的下一次事件路径持仓读取在读完库之后停住,等 release 才返回:一次读得早、发得晚的慢派生。
 * 拦在 positions.ts 的 loadPositions 上:发布器的事件路径(成交 / 撤单 / OTC / 注销 / 挂牌之后的那一行)只经它读持仓,
 * 快照与 REST 走 positionReads + positionsFromRows,不经这里。不靠「批量事务里恰好有几个读取」认人:批量的组成变了不影响这里;
 * 事件路径若不再经 loadPositions,read 在 HOLD_POSITION_READ_MS 后 reject 并说明原因。
 */
function holdNextPositionRead() {
  const real = positionsSource.loadPositions;
  let readDone!: () => void;
  let readFailed!: (err: Error) => void;
  const read = new Promise<void>((resolve, reject) => {
    readDone = resolve;
    readFailed = reject;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let armed = true;
  const timer = setTimeout(
    () => readFailed(new Error("holdNextPositionRead: the publisher's event path did not read positions through loadPositions (positions.ts)")),
    HOLD_POSITION_READ_MS,
  );
  const spy = vi.spyOn(positionsSource, "loadPositions").mockImplementation(async (...args: Parameters<PositionsLib["loadPositions"]>) => {
    const pending = real(...args);
    if (!armed) return pending;
    armed = false;
    const positions = await pending;
    clearTimeout(timer);
    readDone();
    await gate;
    return positions;
  });
  return {
    read,
    release,
    // restore 顺带放行:用例在 release 之前断言失败时,停住的派生不至于把 afterEach 的 idle() 挂到超时
    restore: () => {
      clearTimeout(timer);
      release();
      spy.mockRestore();
    },
  };
}

describe("只动持仓的提交 → position 事件:注销、OTC 挂牌 / 撤牌(计划 §6.2.2 C2)", () => {
  const positionEvents = (userId: string) =>
    accountOf(userId)
      .map((m) => m.event)
      .flatMap((e) => (e.t === "position" ? [e.position] : []));
  const retire = (userId: string, quantity: number, idempotencyKey: string) =>
    retirement.retireCredits(userId, { assetId, quantity, reason: "Test", beneficiary: "Example org", purpose: "Test", publicMessage: "", acknowledged: true, idempotencyKey });

  it("门控:无订阅者、用户不在线都不查库;在线时只发 position(现金没变,不发 balance);机器人不发", async () => {
    // 机器人名单首次需要时查一次库、之后不再查(进程内不会新增机器人):所以先建好
    const bot = await prisma.user.create({ data: { email: `bot-pos-${run}@publisher.test`, name: "Bot", passwordHash: "x", isBot: true, cashBalance: BigInt(0) } });
    await prisma.holding.create({ data: { userId: bot.id, assetId, quantity: 10, locked: 0 } });
    unsubscribe?.();
    unsubscribe = null;
    const before = queries;
    publisher.publishPositionChange(bob, assetId); // 门控 ①
    await settle();
    expect(queries).toBe(before);
    subscribe();
    presence(all(), [alice]); // bob 不在线:门控 ②
    publisher.publishPositionChange(bob, assetId);
    await settle();
    expect(queries).toBe(before);
    expect(ofKind("account")).toHaveLength(0);

    presence(all(), [bob]);
    publisher.publishPositionChange(bob, assetId);
    await settle();
    expect(accountOf(bob).map((m) => m.event.t)).toEqual(["position"]);
    expect(positionEvents(bob)[0]).toMatchObject({ assetId, symbol, quantity: 100_000, locked: 150, lockedBy: { orders: 150, otc: 0 }, available: 99_850, retired: 0 });

    presence(all(), [bot.id]);
    publisher.publishPositionChange(bot.id, assetId);
    await settle();
    expect(accountOf(bot.id)).toHaveLength(0);
  });

  it("OTC 挂牌 → position(locked 与 lockedBy.otc 增加,挂单那部分不变);撤牌 → 复原", async () => {
    presence([], [bob]);
    const listing = await otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 });
    await settle();
    expect(accountOf(bob).map((m) => m.event.t)).toEqual(["position"]);
    expect(positionEvents(bob)[0]).toMatchObject({ assetId, quantity: 100_000, locked: 170, lockedBy: { orders: 150, otc: 20 }, available: 99_830 });
    await otc.cancelListing(bob, listing.id);
    await settle();
    expect(accountOf(bob).map((m) => m.event.t)).toEqual(["position", "position"]);
    expect(positionEvents(bob)[1]).toMatchObject({ assetId, quantity: 100_000, locked: 150, lockedBy: { orders: 150, otc: 0 }, available: 99_850 });
  });

  it("注销 → position(quantity 减少、retired 增加);重放同一 idempotencyKey 不再发", async () => {
    presence([], [bob]);
    const first = await retire(bob, 40, `pub-retire-${run}-0001`);
    await settle();
    expect(first.replayed).toBe(false);
    expect(accountOf(bob).map((m) => m.event.t)).toEqual(["position"]); // 现金不变:没有 balance
    expect(positionEvents(bob)[0]).toMatchObject({ assetId, quantity: 99_960, locked: 150, lockedBy: { orders: 150, otc: 0 }, available: 99_810, retired: 40 });
    const replay = await retire(bob, 40, `pub-retire-${run}-0001`);
    await settle();
    expect(replay.replayed).toBe(true);
    expect(accountOf(bob)).toHaveLength(1);
    await retire(bob, 10, `pub-retire-${run}-0002`);
    await settle();
    expect(positionEvents(bob).map((p) => [p.quantity, p.retired])).toEqual([
      [99_960, 40],
      [99_950, 50],
    ]);
  });

  it("整仓注销 → 事件里是 quantity 0、retired > 0 的行,快照钩子也带这一行;卖光且没注销过的行只在事件里(空行)、不在快照里", async () => {
    await quietly(() => buy(alice, 10_000, 6)); // alice 持有 6
    presence([], [alice]);
    await retire(alice, 6, `pub-retire-${run}-full`);
    await settle();
    const retiredOut = positionEvents(alice).at(-1)!;
    expect(retiredOut).toMatchObject({ assetId, symbol, quantity: 0, locked: 0, lockedBy: { orders: 0, otc: 0 }, available: 0, retired: 6, marketValue: 0 });
    const snapshot = await globalThis.__carbadiaAccountSnapshot!(alice);
    expect(snapshot.positions).toEqual([retiredOut]); // 同一份查询与映射:逐字段相等

    // 对照:另一个用户买 3 吨再全部卖掉(没注销过)→ 事件里有 quantity 0、retired 0 的空行(客户端靠它清行),快照里没有这一行
    const carol = await prisma.user.create({ data: { email: `carol-${run}@publisher.test`, name: "Carol", passwordHash: "x", cashBalance: BigInt(10_000_000_00) } });
    await quietly(() => matching.placeOrder({ userId: carol.id, assetId, side: "BUY", type: "LIMIT", price: 10_000, quantity: 3 }));
    await quietly(() => buy(alice, 9_000, 3)); // 买盘
    presence([], [carol.id]);
    await matching.placeOrder({ userId: carol.id, assetId, side: "SELL", type: "LIMIT", price: 9_000, quantity: 3 });
    await settle();
    expect(positionEvents(carol.id).at(-1)).toMatchObject({ assetId, quantity: 0, retired: 0, available: 0 });
    expect((await globalThis.__carbadiaAccountSnapshot!(carol.id)).positions).toEqual([]);
  });

  it("lockedBy.orders:挂 SELL 限价单、部分成交、撤单,每一步都等于未完结卖单的剩余量之和;再加一笔场外挂牌,两项相加等于 locked", async () => {
    presence([], [bob]);
    const extra = await sell(bob, 10_200, 30); // 新挂一张:150 → 180
    await settle();
    expect(positionEvents(bob).at(-1)).toMatchObject({ quantity: 100_000, locked: 180, lockedBy: { orders: 180, otc: 0 }, available: 99_820 });
    await buy(alice, 10_000, 40); // bob 在 10_000 的那张(100)被吃掉 40:PARTIAL,剩 60
    await settle();
    expect(positionEvents(bob).at(-1)).toMatchObject({ quantity: 99_960, locked: 140, lockedBy: { orders: 140, otc: 0 }, available: 99_820 });
    await matching.cancelOrder(bob, extra.order.id); // 撤掉 30
    await settle();
    expect(positionEvents(bob).at(-1)).toMatchObject({ quantity: 99_960, locked: 110, lockedBy: { orders: 110, otc: 0 }, available: 99_850 });
    const listing = await otc.createListing({ sellerId: bob, assetId, quantity: 25, pricePerUnit: 12_000 });
    await settle();
    const last = positionEvents(bob).at(-1)!;
    expect(last).toMatchObject({ quantity: 99_960, locked: 135, lockedBy: { orders: 110, otc: 25 }, available: 99_825 });
    expect(last.lockedBy.orders + last.lockedBy.otc).toBe(last.locked);
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: bob, assetId } } });
    expect([holding.quantity, holding.locked]).toEqual([last.quantity, last.locked]);
    await otc.cancelListing(bob, listing.id);
  });

  it("发布器出错不让业务请求失败:同步抛错与读库失败都只记日志,注销 / 挂牌照常返回且已落库", async () => {
    presence([], [bob]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const has = vi.spyOn(bus, "hasSubscribers").mockImplementation(() => {
      throw new Error("bus is broken");
    });
    let listingId = "";
    try {
      const listing = await otc.createListing({ sellerId: bob, assetId, quantity: 5, pricePerUnit: 12_000 });
      listingId = listing.id;
      expect(listing).toMatchObject({ status: "ACTIVE", quantity: 5 });
      const result = await retire(bob, 1, `pub-retire-${run}-err`);
      expect(result.replayed).toBe(false);
      expect(errors.mock.calls.filter(([line]) => String(line).includes("position change publish failed"))).toHaveLength(2);
    } finally {
      has.mockRestore();
    }
    // 读库失败(派生在队列里,已脱离请求):同样只记日志
    const failing = vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) =>
      Array.isArray(args[0]) ? Promise.reject(new Error("db is down")) : (Object.getPrototypeOf(prisma).$transaction as (...a: unknown[]) => unknown).apply(prisma, args)) as never);
    try {
      publisher.publishPositionChange(bob, assetId);
      await settle();
      expect(errors.mock.calls.some(([line]) => String(line).includes("derive failed"))).toBe(true);
    } finally {
      failing.mockRestore();
      errors.mockRestore();
    }
    expect(accountOf(bob)).toHaveLength(0);
    const holding = await prisma.holding.findUniqueOrThrow({ where: { userId_assetId: { userId: bob, assetId } } });
    expect([holding.quantity, holding.locked]).toEqual([99_999, 155]);
    await otc.cancelListing(bob, listingId);
  });

  it("lockedBy 与 locked 对不上:不抛错,locked / available 以 Holding 行为准、lockedBy 照实给出,记一行日志(只带 userId 尾号与 assetId);同一(用户, 标的)10 分钟内全进程只记一次(节流表在 globalThis 上,两个 bundle 共用)", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // 另一个 bundle:带着它自己的一份 positions.ts
    globalThis.__carbadiaLockMismatchLog = undefined; // 从空表开始,不靠「这个用例的用户与标的是新建的」
    await quietly(() => prisma.holding.update({ where: { userId_assetId: { userId: bob, assetId } }, data: { locked: { increment: 7 } } })); // 没有来源的 7 吨锁定
    presence([], [bob]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const lines = () => warn.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("[positions]"));
    try {
      publisher.publishPositionChange(bob, assetId); // bundle A
      await settle();
      other.publishPositionChange(bob, assetId); // bundle B:节流表若是模块级的(每个 bundle 一份),这里会再记一行
      await other._internal.idle();
      expect(positionEvents(bob)).toHaveLength(2);
      expect(positionEvents(bob)[0]).toMatchObject({ quantity: 100_000, locked: 157, lockedBy: { orders: 150, otc: 0 }, available: 99_843 });
      expect(lines()).toEqual([`[positions] lockedBy does not add up to locked user=…${bob.slice(-6)} asset=${assetId}`]);
      expect(lines()[0]).not.toContain(bob); // 只有尾号,没有完整 userId,也没有数量
      expect(lines()[0]).not.toMatch(/157|150/);
      // 过了节流窗口(把记下的时刻拨回 10 分钟前)再记一行
      const log = globalThis.__carbadiaLockMismatchLog!;
      expect([...log.keys()]).toEqual([`${bob}:${assetId}`]);
      log.set(`${bob}:${assetId}`, Date.now() - 10 * 60_000 - 1);
      other.publishPositionChange(bob, assetId);
      await other._internal.idle();
      expect(lines()).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("持仓读取票号(按用户与标的;计划 §6.2.2 C2:旧行不盖新行)", () => {
  const positionEvents = (userId: string) =>
    accountOf(userId)
      .map((m) => m.event)
      .flatMap((e) => (e.t === "position" ? [e.position] : []));

  it("较早发出、较晚返回的持仓读取不发:另一个 bundle 已发了更晚读到的那一行(否则客户端按 assetId 整行覆盖成旧的锁定数量,之后没有事件来纠正)", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // 另一个 bundle
    presence([], [bob]);
    const listing = await quietly(() => otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 })); // C1 已提交:locked 170
    const hold = holdNextPositionRead();
    try {
      publisher.publishPositionChange(bob, assetId); // bundle A 派生 C1:读到 locked 170,停住
      await hold.read;
      await quietly(() => otc.cancelListing(bob, listing.id)); // C2:locked 回到 150
      other.publishPositionChange(bob, assetId); // bundle B 派生 C2:读在 C2 之后,先发出
      await other._internal.idle();
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    // 修复前:两条,最后一条是 A 的旧行(locked 170、lockedBy.otc 20)
    expect(positionEvents(bob).map((p) => [p.locked, p.lockedBy.otc])).toEqual([[150, 0]]);
  });

  it("按发出顺序返回时两条都发;票号跨 bundle 单调,之后较晚发出的读取照常发", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence([], [bob]);
    const listing = await quietly(() => otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 }));
    publisher.publishPositionChange(bob, assetId); // bundle A
    await settle();
    await quietly(() => otc.cancelListing(bob, listing.id));
    other.publishPositionChange(bob, assetId); // bundle B
    await other._internal.idle();
    publisher.publishPositionChange(bob, assetId); // 回到 bundle A
    await settle();
    expect(positionEvents(bob).map((p) => [p.locked, p.lockedBy.otc])).toEqual([
      [170, 20],
      [150, 0],
      [150, 0],
    ]);
  });

  it("成交路径同样领票:成交派生的持仓读取较早发出、较晚返回时不发;别的标的、别的用户各自独立", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    presence([], [alice, bob]);
    const r1 = await quietly(() => buy(alice, 10_000, 10)); // C1:alice 持有 10
    const hold = holdNextPositionRead();
    try {
      publisher.publishOrderResult(r1); // bundle A:先读 alice(taker)的持仓,停住
      await hold.read;
      const r2 = await quietly(() => buy(alice, 10_000, 5)); // C2:alice 持有 15
      other.publishOrderResult(r2); // bundle B 先发出
      await other._internal.idle();
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    expect(positionEvents(alice).map((p) => p.quantity)).toEqual([15]);
    // bob(maker)的两次读取按发出顺序返回(B 的在前,A 的被排在 alice 之后才发出):两条都发,最后一条是最新的
    expect(positionEvents(bob).map((p) => p.quantity)).toEqual([99_985, 99_985]);
  });

  it("在途的读取 → 用户掉线 → 掉线期间的提交 → 重连拿到快照 → 在途的读取返回:旧行不发(提交发现用户不在线时删掉他在该标的上的票号条目)", async () => {
    presence([], [bob]);
    const key = `${bob}:${assetId}`;
    const listing = await quietly(() => otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 })); // C1:locked 170
    const hold = holdNextPositionRead();
    try {
      publisher.publishPositionChange(bob, assetId); // C1 的派生:读到 locked 170,停住(在途)
      await hold.read;
      expect(globalThis.__carbadiaPublisherState!.positionTickets.has(key)).toBe(true);
      presence([], []); // bob 掉线
      await otc.cancelListing(bob, listing.id); // C2 在掉线期间提交(真实路径:提交后调 publishPositionChange),locked 回到 150
      expect(globalThis.__carbadiaPublisherState!.positionTickets.has(key)).toBe(false); // 没到清扫时刻(每分钟一次),是这次提交删的
      presence([], [bob]); // 重连
      const snapshot = await globalThis.__carbadiaAccountSnapshot!(bob); // hub 给他的新快照:读在 C2 之后
      expect(snapshot.positions.map((p) => [p.locked, p.lockedBy.otc])).toEqual([[150, 0]]);
      hold.release(); // 在途的读取这时才返回
      await settle();
    } finally {
      hold.restore();
    }
    // 修复前:[[170, 20]] —— 在快照之后到达,把行盖回撤牌前的锁定,而掉线期间的那次提交没有事件来纠正
    expect(positionEvents(bob)).toEqual([]);
    // 之后的提交照常领票、照常发
    publisher.publishPositionChange(bob, assetId);
    await settle();
    expect(positionEvents(bob).map((p) => [p.locked, p.lockedBy.otc])).toEqual([[150, 0]]);
  });

  it("提交时在线、派生开始前掉线:同样不读库,并删掉这一条票号", async () => {
    presence([], [bob]);
    const key = `${bob}:${assetId}`;
    publisher.publishPositionChange(bob, assetId);
    await settle();
    expect(positionEvents(bob)).toHaveLength(1);
    expect(globalThis.__carbadiaPublisherState!.positionTickets.has(key)).toBe(true);
    const before = queries;
    publisher.publishPositionChange(bob, assetId); // 同步门控时在线
    presence([], []); // 派生排在微任务里:在它开始前掉线
    await settle();
    expect(queries).toBe(before);
    expect(positionEvents(bob)).toHaveLength(1);
    expect(globalThis.__carbadiaPublisherState!.positionTickets.has(key)).toBe(false);
  });

  it("成交路径与余额同理:在途的余额 / 持仓读取 → 掉线 → 掉线期间成交(另一个 bundle 派生,发现他不在线)→ 重连拿到快照 → 旧余额、旧持仓都不发", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher"); // 另一个 bundle(同一 bundle 同一标的的派生排在在途那次之后)
    presence([], [alice]);
    const r1 = await quietly(() => buy(alice, 10_000, 10)); // C1:alice 持有 10
    const hold = holdNextBalanceRead(alice);
    try {
      publisher.publishOrderResult(r1); // bundle A 派生 C1:余额与持仓都读在 C2 之前,整次派生停住(在途)
      await hold.read;
      presence([], []); // alice 掉线
      const r2 = await quietly(() => buy(alice, 10_000, 20)); // C2 在掉线期间提交:alice 持有 30,现金再减
      other.publishOrderResult(r2); // bundle B 派生 C2:alice 不在线,不读库
      await other._internal.idle();
      expect(globalThis.__carbadiaPublisherState!.balanceReads.has(alice)).toBe(false);
      expect(globalThis.__carbadiaPublisherState!.positionTickets.has(`${alice}:${assetId}`)).toBe(false);
      presence([], [alice]); // 重连
      const snapshot = await globalThis.__carbadiaAccountSnapshot!(alice);
      expect(snapshot.balance).toEqual(await balanceNow(alice));
      expect(snapshot.positions.map((p) => p.quantity)).toEqual([30]);
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    // 修复前:["order", "fill", "balance", "position"],后两条是 C2 之前的余额与 10 吨的持仓,在快照之后到达。
    // order / fill 照发:C1 的那张单已终结(不比快照旧),成交是追加的
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["order", "fill"]);
  });

  it("OTC 成交路径同理:卖方掉线期间挂牌被买走(派生发现他不在线)→ 他掉线前在途的持仓读取不发", async () => {
    vi.resetModules();
    const other: Publisher = await import("./market-publisher");
    const otherOtc: Otc = await import("../exchange/otc"); // 另一个 bundle 的 otc:提交后调的是 other 的 publishLastPrice
    presence([], [bob]);
    const listing = await quietly(() => otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 })); // C1:locked 170
    const hold = holdNextPositionRead();
    try {
      publisher.publishPositionChange(bob, assetId); // bundle A:读到 quantity 100 000、locked 170,停住
      await hold.read;
      presence([], []); // bob 掉线
      await otherOtc.buyListing(alice, listing.id, 5); // C2:bob 卖出 5,quantity 99 995、locked 165
      await other._internal.idle();
      expect(globalThis.__carbadiaPublisherState!.positionTickets.has(`${bob}:${assetId}`)).toBe(false);
      presence([], [bob]); // 重连
      const snapshot = await globalThis.__carbadiaAccountSnapshot!(bob);
      expect(snapshot.positions.map((p) => [p.quantity, p.locked])).toEqual([[99_995, 165]]);
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    expect(accountOf(bob)).toEqual([]); // 修复前:一条 position(quantity 100 000、locked 170)
    await quietly(() => otc.cancelListing(bob, listing.id));
  });

  it("持仓票号有界:用户离线后下一次清扫回收他的票号;dev HMR 留下的旧状态(没有 positionTickets)照常补上", async () => {
    presence([], [alice, bob]);
    await buy(alice, 10_000, 1);
    await settle();
    const state = () => globalThis.__carbadiaPublisherState!;
    expect([...state().positionTickets.keys()].sort()).toEqual([`${alice}:${assetId}`, `${bob}:${assetId}`].sort());
    presence([], [alice]); // bob 下线
    state().sweptAt = 0;
    await buy(alice, 10_000, 1);
    await settle();
    expect([...state().positionTickets.keys()]).toEqual([`${alice}:${assetId}`]);
    // 加 positionTickets 之前的模块版本建的状态:取用时补上空表,序列接着数
    const seqBefore = state().ticketSeq;
    (state() as unknown as { positionTickets?: unknown }).positionTickets = undefined;
    publisher.publishPositionChange(alice, assetId);
    await settle();
    expect(state().positionTickets.size).toBe(1);
    expect(state().ticketSeq).toBeGreaterThan(seqBefore);
    expect(accountOf(alice).at(-1)?.event.t).toBe("position");
  });
});

describe("做市机器人账户与每用户状态回收(终审 P1-25a)", () => {
  /** 一个做市机器人账户(isBot)在 9_900 挂卖 5(比 bob 的 10_000 便宜):alice 买它时机器人是 maker */
  async function botQuote() {
    const bot = await prisma.user.create({
      data: { email: `bot-${run}@publisher.test`, name: "Bot", passwordHash: "x", isBot: true, cashBalance: BigInt(10_000_000_00) },
    });
    await prisma.holding.create({ data: { userId: bot.id, assetId, quantity: 1_000, locked: 0 } });
    await quietly(() => matching.placeOrder({ userId: bot.id, assetId, side: "SELL", type: "LIMIT", price: 9_900, quantity: 5 }));
    return bot.id;
  }
  const botQueries = () => sql.filter((q) => /isBot`?\s*=/.test(q)).length;

  it("机器人不发 account 事件,即使它有 account 订阅(P1-25b 之前签出的旧会话);名单首次需要时查一次库、挂在 globalThis 上;快照钩子拒绝机器人", async () => {
    const botId = await botQuote();
    presence(all(), [alice, botId]);
    sql.length = 0;
    await buy(alice, 9_900, 2); // taker alice,maker 机器人
    await settle();
    await buy(alice, 9_900, 1);
    await settle();
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["order", "fill", "balance", "position", "order", "fill", "balance", "position"]);
    expect(accountOf(botId)).toHaveLength(0);
    expect(botQueries()).toBe(1);
    expect(globalThis.__carbadiaPublisherState?.botUserIds).toContain(botId);
    await expect(globalThis.__carbadiaAccountSnapshot!(botId)).rejects.toThrow(/bot/i);
    expect(globalThis.__carbadiaPublisherState?.orderReads.size).toBe(0); // 机器人的挂单不领票;alice 的两张都已 FILLED,发布即回收
  });

  it("没人在线时不为机器人名单查库", async () => {
    await botQuote();
    presence(all(), []);
    sql.length = 0;
    await buy(alice, 9_900, 1);
    await settle();
    expect(botQueries()).toBe(0);
  });

  it("余额 / 订单票号有界:终结的挂单一发布就回收;用户离线后下一次清扫(每分钟至多一次,随发布触发)回收他的全部票号", async () => {
    const users: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const u = await prisma.user.create({ data: { email: `many-${run}-${i}@publisher.test`, name: "U", passwordHash: "x", cashBalance: BigInt(10_000_000_00) } });
      users.push(u.id);
    }
    presence(all(), [alice, ...users]);
    const state = () => globalThis.__carbadiaPublisherState!;
    for (const u of users) {
      await buy(u, 10_000, 1); // FILLED:终结
      await buy(u, 9_000, 1); // 挂着:OPEN,用户在线期间票号保留
    }
    await settle();
    expect(state().balanceReads.size).toBe(20);
    expect(state().orderReads.size).toBe(20); // 只剩 20 张挂着的
    presence(all(), [alice]); // 20 个用户下线
    state().sweptAt = 0; // 距上次清扫已超过一分钟
    await buy(alice, 10_000, 1); // 任何一次发布都会顺带清扫
    await settle();
    expect([...state().balanceReads.keys()]).toEqual([alice]);
    expect(state().orderReads.size).toBe(0);
  });

  it("回收之后才返回的旧读取不发:用户下线、票号被回收、又上线,那次在途的派生(读在回收之前)的余额、订单行与持仓行都丢掉", async () => {
    presence([], [alice]);
    await quietly(() => buy(alice, 9_500, 10));
    const r1 = await quietly(() => sell(bob, 9_500, 4)); // alice 的挂单 PARTIAL
    const hold = holdNextBalanceRead(alice);
    try {
      publisher.publishOrderResult(r1); // 领了订单票与余额票
      await hold.read;
      presence([], []); // 下线
      globalThis.__carbadiaPublisherState!.sweptAt = 0;
      await sell(bob, 10_200, 1); // 与 alice 无关的任何一次发布都会触发清扫
      presence([], [alice]); // 又上线(hub 此时给他发了一份新快照)
      hold.release();
      await settle();
    } finally {
      hold.restore();
    }
    // 持仓行同样按票号丢掉(P2-03):他又上线时 hub 给的快照读在这之后,不比它旧
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["fill"]);
  });
});

describe("成本价读取收窄到该标的(终审 P1-25a,minor)", () => {
  it("成交 / 撤单后的持仓只读该标的买入引用的现金行(不再整本扫描用户的现金账),成本价与整本账本的算法(快照 / REST)逐字段一致", async () => {
    // 另一个标的上的成交:它的现金行与本标的无关
    const other = await prisma.asset.create({
      data: { symbol: `${symbol}-B`, name: "Other", standard: "VCS", projectType: "Forestry", vintage: 2026, country: "Example", registry: "Demo", lastPrice: 5_000 },
    });
    await prisma.holding.create({ data: { userId: bob, assetId: other.id, quantity: 1_000, locked: 0 } });
    await quietly(() => matching.placeOrder({ userId: bob, assetId: other.id, side: "SELL", type: "LIMIT", price: 5_000, quantity: 10 }));
    const elsewhere = await quietly(() => matching.placeOrder({ userId: alice, assetId: other.id, side: "BUY", type: "LIMIT", price: 5_000, quantity: 3 }));
    const earlier = await quietly(() => buy(alice, 10_100, 2)); // 价格改善:成交 10_000,另有 PRICE_IMPROVE_REFUND
    presence([], [alice]);
    const findMany = vi.spyOn(prisma.ledgerEntry, "findMany");
    try {
      const r = await buy(alice, 10_000, 3);
      await settle();
      const position = accountOf(alice)
        .map((m) => m.event)
        .find((e) => e.t === "position");
      const snapshot = await globalThis.__carbadiaAccountSnapshot!(alice); // 整本账本的算法(与 /api/account/positions 同一 toPosition)
      expect(position?.t === "position" && position.position).toEqual(snapshot.positions.find((p) => p.assetId === assetId));
      expect(position?.t === "position" && position.position).toMatchObject({ quantity: 5, averagePurchasePrice: 10_000, costBasisStatus: "complete" });
      // 派生里读现金行的那一次按引用取,只含本标的的两笔买入;另一个标的的成交不在其中
      type Where = { where?: { account?: { in?: string[] }; refId?: { in?: string[] } } };
      const cashReads = findMany.mock.calls
        .map(([args]) => (args as Where)?.where)
        .filter((where) => where?.account?.in?.includes("CASH"))
        .map((where) => where?.refId?.in)
        .filter((ids): ids is string[] => Array.isArray(ids));
      expect(cashReads.length).toBeGreaterThan(0);
      expect(new Set(cashReads.flat())).toEqual(new Set([...earlier.trades, ...r.trades].map((t) => t.id)));
      expect(cashReads.flat()).not.toContain(elsewhere.trades[0].id);
    } finally {
      findMany.mockRestore();
    }
  });
});

describe("现金结算行的查询计划不依赖 sqlite_stat1(P1-25a 复审)", () => {
  it("按引用取现金行的那条 SQL 在没有统计信息的库上走 (refType, refId) 索引,而不是按用户扫整本现金账", async () => {
    // 迁移出来的临时库从没 ANALYZE 过,与丢了 sqlite_stat1 的生产库同一处境
    const stat1 = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'`);
    expect(Number(stat1[0]?.n)).toBe(0);
    await quietly(() => buy(alice, 10_000, 2));
    presence([], [alice]);
    sql.length = 0;
    await buy(alice, 10_000, 3);
    await settle();
    // 现金行那一条:account IN (CASH, CASH_LOCKED) + reason IN (…) + refId IN (…)(ledgerIdsByTrade 那条也按 refId 取,但不带 account / reason)
    const cashRead = sql.find((q) => /LedgerEntry/.test(q) && /`account` IN \(/.test(q) && /`reason` IN \(/.test(q) && /`refId` IN \(/.test(q));
    expect(cashRead).toBeDefined();
    const placeholders = (cashRead!.match(/\?/g) ?? []).length;
    const plan = await prisma.$queryRawUnsafe<{ detail: string }[]>(`EXPLAIN QUERY PLAN ${cashRead}`, ...Array.from({ length: placeholders }, () => null));
    const details = plan.map((row) => row.detail).join(" | ");
    expect(details).toContain("LedgerEntry_refType_refId_idx");
    expect(details).not.toContain("LedgerEntry_userId_account_createdAt_idx");
  });
});

describe("OTC 与总线隔离", () => {
  it("buyListing 事务提交后 → ticker(lastPrice = 挂牌价);在线的买卖双方各收 balance + position", async () => {
    presence(["ticker:*"], [alice, bob]);
    const listing = await otc.createListing({ sellerId: bob, assetId, quantity: 20, pricePerUnit: 12_000 });
    await settle(); // 挂牌自己也给 bob 发一条 position(P2-03);等它发完再清
    received.length = 0;
    await otc.buyListing(alice, listing.id, 5);
    await settle();
    expect(ofKind("ticker")).toHaveLength(1);
    expect(ofKind("ticker")[0].ticker).toMatchObject({ symbol, lastPrice: 12_000 });
    expect(accountOf(alice).map((m) => m.event.t)).toEqual(["balance", "position"]);
    expect(accountOf(bob).map((m) => m.event.t)).toEqual(["balance", "position"]);
    expect(ofKind("trades")).toHaveLength(0); // OTC 不是撮合成交,不进 tape
    await otc.cancelListing(bob, listing.id);
  });

  it("OTC 成交作废标的列表缓存:在成交前开始读库、在作废后才返回的 listInstruments 不把旧价写回缓存", async () => {
    const cached = () => globalThis.__carbadiaInstrumentsCache; // 函数里读:赋值后的直接读取会被 TS 收窄成 undefined
    globalThis.__carbadiaInstrumentsCache = undefined;
    const inflight = snapshots.listInstruments(); // 同步部分已记下代数、发出读库;结果还没回来
    publisher.publishLastPrice({ assetId, symbol, lastPrice: 12_345, buyerId: alice, sellerId: bob });
    const stale = await inflight;
    expect(stale.instruments.find((i) => i.instrument.symbol === symbol)?.ticker.lastPrice).toBe(10_000); // 这个请求照常拿到它读到的
    expect(cached()).toBeUndefined(); // 但没写回:只清空的话这里会挂着旧价 2 s
    // 下一次查询照常写缓存
    const fresh = await snapshots.listInstruments();
    expect(cached()?.value).toBe(fresh);
  });

  it("某个订阅者抛错不影响其它订阅者与后续发布", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const off = bus.subscribe(() => {
      throw new Error("boom");
    });
    try {
      await buy(alice, 10_100, 1);
      expect(ofKind("trades")).toHaveLength(1);
      await buy(alice, 10_100, 1);
      expect(ofKind("trades")).toHaveLength(2);
      await settle();
      expect(bus.subscriberErrors()).toBeGreaterThanOrEqual(2);
      expect(ofKind("book").length).toBeGreaterThanOrEqual(1); // 派生照常
    } finally {
      off();
      errors.mockRestore();
    }
  });
});
