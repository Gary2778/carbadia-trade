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
};

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
