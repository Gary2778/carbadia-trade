import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ directory: "", path: "" }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = Date.parse("2026-09-09T12:00:00.000Z");

// Exercise the actual market route against an isolated database.
vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return {
    prisma: new PrismaClient({
      datasourceUrl: `file:${database.path}`,
    }),
  };
});

let prisma: (typeof import("../server/db"))["prisma"];
let getAssets: (typeof import("../../app/api/assets/route"))["GET"];
let getAsset: (typeof import("../../app/api/assets/[symbol]/route"))["GET"];
let getInstruments: (typeof import("../../app/api/market/instruments/route"))["GET"];

beforeAll(async () => {
  database.directory = mkdtempSync(join(tmpdir(), "carbadia-market-trend-"));
  database.path = join(database.directory, "market.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, RUST_LOG: "info", DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("../server/db"));
  ({ GET: getAssets } = await import("../../app/api/assets/route"));
  ({ GET: getAsset } = await import("../../app/api/assets/[symbol]/route"));
  ({ GET: getInstruments } = await import("../../app/api/market/instruments/route"));
  vi.spyOn(Date, "now").mockReturnValue(NOW);

  const buyer = await prisma.user.create({
    data: { email: "buyer@candles.test", name: "Buyer", passwordHash: "test" },
  });
  const seller = await prisma.user.create({
    data: { email: "seller@candles.test", name: "Seller", passwordHash: "test" },
  });

  for (const symbol of ["ACTIVE", "QUIET", "SINGLE", "DENSE"]) {
    const asset = await prisma.asset.create({
      data: {
        symbol, name: symbol, standard: "VCS", projectType: "Forestry",
        vintage: 2022, country: "Kenya", registry: "Verra", lastPrice: 1_100,
      },
    });
    const buy = await prisma.order.create({
      data: { userId: buyer.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 1_500, quantity: 100 },
    });
    const sell = await prisma.order.create({
      data: { userId: seller.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 1_000, quantity: 100 },
    });
    // A trade outside the rolling day must not appear as current market data.
    const trades = [{ minutesAgo: 1_441, price: 9_000, quantity: 99 }];
    if (symbol === "ACTIVE") trades.push(
      { minutesAgo: 1_439, price: 1_000, quantity: 2 },
      { minutesAgo: 1_435, price: 1_200, quantity: 3 },
      { minutesAgo: 1_430, price: 900, quantity: 4 },
      { minutesAgo: 1_415, price: 1_100, quantity: 5 },
      { minutesAgo: 1, price: 1_100, quantity: 6 },
    );
    if (symbol === "SINGLE") trades.push({ minutesAgo: 1, price: 1_100, quantity: 7 });
    if (symbol === "DENSE") {
      for (let index = 0; index < 49; index++) trades.push({
        minutesAgo: Math.max(0, 1_432 - index * 30), price: 1_000 + index, quantity: 1,
      });
    }
    await prisma.trade.createMany({
      data: trades.map(({ minutesAgo, price, quantity }) => ({
        assetId: asset.id, buyOrderId: buy.id, sellOrderId: sell.id,
        buyerId: buyer.id, sellerId: seller.id, price, quantity,
        createdAt: new Date(NOW - minutesAgo * 60_000),
      })),
    });
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

type MarketAsset = {
  symbol: string;
  change24h: number | null;
  volume24h: number;
  spark: number[];
} & Record<string, unknown>;

/** 计划 §3.5 Instrument 的 18 个键: 两个旧端点的标的行必须恰为这 18 个 + 各自的统计字段 */
const INSTRUMENT_KEYS = [
  "id", "symbol", "name", "standard", "projectType", "vintage", "country", "registry", "isScenario",
  "projectId", "methodology", "verificationStatus", "tickSize", "pricePrecision", "qtyStep", "minQty", "currency", "lastPrice",
].sort();

async function market() {
  const response = await getAssets();
  expect(response.status).toBe(200);
  return (await response.json()).data as MarketAsset[];
}

describe("Exchange market trend data", () => {
  it("preserves price changes across the available day of trades", async () => {
    const active = (await market()).find((asset) => asset.symbol === "ACTIVE")!;
    expect(active.spark).toEqual([1_000, 1_200, 900, 1_100, 1_100]);
    expect(active.change24h).toBe(10);
    expect(active.volume24h).toBe(20);
  });

  it("returns a single recent price without inventing a trend", async () => {
    const single = (await market()).find((asset) => asset.symbol === "SINGLE")!;
    expect(single.spark).toEqual([1_100]);
  });

  it("does not turn stale history into a current chart or daily change", async () => {
    const quiet = (await market()).find((asset) => asset.symbol === "QUIET")!;
    expect(quiet.spark).toEqual([]);
    expect(quiet.change24h).toBeNull();
    expect(quiet.volume24h).toBe(0);
  });

  it("bounds the trend size while keeping the first and latest prices in the rolling day", async () => {
    vi.mocked(Date.now).mockReturnValue(NOW + 7 * 60_000);
    const dense = (await market()).find((asset) => asset.symbol === "DENSE")!;
    expect(dense.spark).toHaveLength(48);
    expect(dense.spark[0]).toBe(1_000);
    expect(dense.spark.at(-1)).toBe(1_048);
  });
});

describe("Old public endpoints never leak internal Asset columns (plan §3.4)", () => {
  it("/api/assets rows carry the 18 Instrument keys plus stats, and no anchorPrice / createdAt / description", async () => {
    const rows = await market();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect("anchorPrice" in row).toBe(false);
      expect("createdAt" in row).toBe(false);
      expect("description" in row).toBe(false);
      const extra = ["bestBid", "bestAsk", "volume24h", "availableSupply", "change24h", "spark"];
      expect(Object.keys(row).sort()).toEqual([...INSTRUMENT_KEYS, ...extra].sort());
      // 迁移默认值经白名单原样到达客户端; 登记数据未知即 null
      expect(row).toMatchObject({ projectId: null, methodology: null, verificationStatus: null, tickSize: 1, pricePrecision: 2, qtyStep: 1, minQty: 1, currency: "USD" });
    }
  });

  it("/api/assets/[symbol] asset is the Instrument shape only, and the response is private / no-store", async () => {
    const response = await getAsset(new Request("http://localhost/api/assets/ACTIVE"), { params: Promise.resolve({ symbol: "ACTIVE" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { data } = (await response.json()) as { data: { asset: Record<string, unknown> } };
    expect("anchorPrice" in data.asset).toBe(false);
    expect("createdAt" in data.asset).toBe(false);
    expect("description" in data.asset).toBe(false);
    expect(Object.keys(data.asset).sort()).toEqual(INSTRUMENT_KEYS);
    expect(data.asset).toMatchObject({ symbol: "ACTIVE", lastPrice: 1_100, currency: "USD", verificationStatus: null });
  });

  it("/api/assets/[symbol] returns 404 for an unknown symbol", async () => {
    const response = await getAsset(new Request("http://localhost/api/assets/NOPE"), { params: Promise.resolve({ symbol: "NOPE" }) });
    expect(response.status).toBe(404);
  });
});

describe("change24h is one number in one unit across old and new endpoints (plan §3.4, §9.1 #38, §9.2 D12)", () => {
  // 两个进程缓存(/api/assets 模块内 2 s、listInstruments 的 globalThis 2 s)都按 Date.now 判新旧:
  // 换一个新的“现在”让两边都重算,同一夹具、同一时刻,数值必须逐位相等
  const AT = NOW + 9 * 60_000;

  async function both() {
    vi.mocked(Date.now).mockReturnValue(AT);
    delete globalThis.__carbadiaInstrumentsCache;
    const rows = await market();
    const response = await getInstruments();
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: { instruments: { instrument: { symbol: string }; ticker: { change24h: number | null; volume24h: number } }[] } };
    return { rows, items: data.instruments };
  }

  it("/api/assets rows render the same toFixed(2) + '%' string the pre-stats24h formula produced on the same fixture", async () => {
    const { rows } = await both();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 改前:火花线首点(= 24 h 窗口内最早成交)对比 lastPrice × 100;spark 为空则 null
      const lastPrice = row.lastPrice as number | null;
      const before = row.spark.length > 0 && lastPrice != null ? ((lastPrice - row.spark[0]) / row.spark[0]) * 100 : null;
      const render = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);
      expect(render(row.change24h)).toBe(render(before));
    }
    // AT 时刻 ACTIVE 的 24 h 窗口从 NOW − 1431 min 起:1439 / 1435 min 前的两笔已出窗,首笔是 1430 min 前的 900,
    // lastPrice 1100 → (1100 − 900) × 100 / 900 = 22.22(百分数,不是 0.2222)
    const active = rows.find((row) => row.symbol === "ACTIVE")!;
    expect(`${active.change24h!.toFixed(2)}%`).toBe("22.22%");
  });

  it("/api/market/instruments ticker.change24h equals /api/assets change24h for every symbol, and volume24h too", async () => {
    const { rows, items } = await both();
    expect(items.map((item) => item.instrument.symbol)).toEqual(rows.map((row) => row.symbol));
    for (const row of rows) {
      const item = items.find((candidate) => candidate.instrument.symbol === row.symbol)!;
      expect(item.ticker.change24h).toBe(row.change24h);
      expect(item.ticker.volume24h).toBe(row.volume24h);
    }
  });
});
