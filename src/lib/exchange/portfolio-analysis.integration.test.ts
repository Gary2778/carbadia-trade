import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: "" }));
const DB_FILE = fileURLToPath(
  new URL("../../../prisma/test-portfolio-analysis.db", import.meta.url),
);
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  const { fileURLToPath: toPath } = await import("node:url");
  return {
    prisma: new PrismaClient({
      datasourceUrl: `file:${toPath(new URL("../../../prisma/test-portfolio-analysis.db", import.meta.url))}`,
    }),
  };
});
// Only the Next request cookie context is replaced. The API, Prisma queries,
// matching, retirement and ledger serialization all run against a real DB.
vi.mock("../server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/auth")>();
  const { prisma } = await import("../server/db");
  return {
    ...actual,
    requireUser: async () => {
      if (!session.userId) throw new actual.AuthError("Not logged in");
      return prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    },
  };
});

let prisma: (typeof import("../server/db"))["prisma"];
let portfolio: (typeof import("../../app/api/portfolio/route"))["GET"];
let transactions: (typeof import("../../app/api/transactions/route"))["GET"];
let buyerId: string;
let sellerId: string;
let foreignCursor: string;
const wipe = () => {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(DB_FILE + suffix, { force: true });
};

beforeAll(async () => {
  wipe();
  // Prisma's missing-SQLite-database probe needs its structured info output;
  // the host's RUST_LOG=warn suppresses it and prevents database creation.
  execSync("npx prisma migrate deploy", {
    cwd: ROOT,
    env: { ...process.env, RUST_LOG: "info", DATABASE_URL: `file:${DB_FILE}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("../server/db"));
  const files = await prisma.$queryRaw<
    { file: string }[]
  >`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!files[0]?.file.endsWith("test-portfolio-analysis.db"))
    throw new Error("Refusing to test against a non-test database");
  ({ GET: portfolio } = await import("../../app/api/portfolio/route"));
  ({ GET: transactions } = await import("../../app/api/transactions/route"));
  const { placeOrder } = await import("./matching");
  const { retireCredits } = await import("./retirement");
  const { writeLedger } = await import("./ledger");
  const buyer = await prisma.user.create({
    data: {
      email: "buyer@portfolio.test",
      name: "Buyer",
      passwordHash: "test",
      cashBalance: BigInt(100_000),
    },
  });
  const seller = await prisma.user.create({
    data: {
      email: "seller@portfolio.test",
      name: "Seller",
      passwordHash: "test",
    },
  });
  buyerId = buyer.id;
  sellerId = seller.id;
  session.userId = buyerId;
  const asset = await prisma.asset.create({
    data: {
      symbol: "TEST-CREDIT",
      name: "Demo forest",
      standard: "VCS",
      registry: "Verra",
      vintage: 2022,
      country: "Kenya",
      projectType: "Forestry",
      lastPrice: 1_000,
    },
  });
  const scenario = await prisma.asset.create({
    data: {
      symbol: "TEST-SCENARIO",
      name: "Scenario",
      standard: "CEA",
      registry: "Simulation",
      vintage: 2026,
      country: "China",
      projectType: "Allowance",
      isScenario: true,
      lastPrice: 2_000,
    },
  });
  await prisma.holding.create({
    data: { userId: sellerId, assetId: asset.id, quantity: 100 },
  });
  await prisma.holding.create({
    data: { userId: buyerId, assetId: scenario.id, quantity: 3 },
  });
  await writeLedger(prisma, [
    { userId: buyerId, account: "CASH", delta: 100_000, reason: "GRANT" },
    {
      userId: sellerId,
      assetId: asset.id,
      account: "HOLDING",
      delta: 100,
      reason: "SEED",
    },
    {
      userId: buyerId,
      assetId: scenario.id,
      account: "HOLDING",
      delta: 3,
      reason: "SEED",
    },
  ]);
  await placeOrder({
    userId: sellerId,
    assetId: asset.id,
    side: "SELL",
    type: "LIMIT",
    price: 1_000,
    quantity: 20,
  });
  await placeOrder({
    userId: buyerId,
    assetId: asset.id,
    side: "BUY",
    type: "LIMIT",
    price: 1_100,
    quantity: 10,
  });
  await retireCredits(buyerId, {
    assetId: asset.id,
    quantity: 2,
    reason: "Learning",
    beneficiary: "Test Buyer",
    purpose: "Simulation exercise",
    idempotencyKey: "portfolio-test-retire-1",
    acknowledged: true,
  });
  await prisma.asset.update({
    where: { id: asset.id },
    data: { lastPrice: 1_200 },
  });
  foreignCursor = (
    await prisma.ledgerEntry.findFirstOrThrow({ where: { userId: sellerId } })
  ).id;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  wipe();
});

describe("portfolio and activity API boundaries", () => {
  it("reports remaining purchase basis, nominal credit quantities and retirement totals", async () => {
    const response = await portfolio();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { data } = await response.json();
    expect(data.heldCredits).toBe(8);
    expect(data.retiredCredits).toBe(2);
    expect(data.totalAssets).toBe(105_600);
    expect(data.unrealisedPnl).toBeNull();
    expect(data.change24h).toBeNull();
    expect(
      data.positions.find(
        (p: { symbol: string }) => p.symbol === "TEST-CREDIT",
      ),
    ).toMatchObject({
      quantity: 8,
      available: 8,
      registry: "Verra",
      standard: "VCS",
      vintage: 2022,
      averagePurchasePrice: 1_000,
      costBasis: 8_000,
      unrealisedPnl: 1_600,
      costBasisComplete: true,
    });
    expect(
      data.positions.find(
        (p: { symbol: string }) => p.symbol === "TEST-SCENARIO",
      ).costBasisComplete,
    ).toBe(false);
  });

  it("paginates every own account movement once and attaches assets to cash settlements", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    let expectedTotal = 0;
    let sawCashCredit = false;
    let sawRetirement = false;
    do {
      const response = await transactions(
        new Request(
          `http://localhost/api/transactions?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        ),
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const { data } = await response.json();
      expectedTotal = data.pagination.total;
      for (const entry of data.entries) {
        ids.push(entry.id);
        expect(typeof entry.delta).toBe("number");
        if (
          entry.account === "CASH_LOCKED" &&
          entry.reason === "TRADE_SETTLE"
        ) {
          expect(entry.asset.symbol).toBe("TEST-CREDIT");
          sawCashCredit = true;
        }
        if (entry.type === "RETIREMENT") sawRetirement = true;
      }
      cursor = data.pagination.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(expectedTotal);
    expect(ids).toHaveLength(expectedTotal);
    expect(ids).not.toContain(foreignCursor);
    expect(sawCashCredit).toBe(true);
    expect(sawRetirement).toBe(true);
  });

  it("rejects another user's cursor and invalid page limits", async () => {
    expect(
      (
        await transactions(
          new Request(
            `http://localhost/api/transactions?cursor=${foreignCursor}`,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await transactions(
          new Request("http://localhost/api/transactions?limit=1000"),
        )
      ).status,
    ).toBe(400);
  });

  it("preserves unusually large ledger values as exact decimal strings", async () => {
    const record = await prisma.ledgerEntry.create({
      data: {
        userId: buyerId,
        account: "CASH",
        delta: BigInt("9007199254740993"),
        reason: "MIGRATION_BASELINE",
        createdAt: new Date("2099-01-01T00:00:00Z"),
      },
    });
    const response = await transactions(
      new Request("http://localhost/api/transactions?limit=1"),
    );
    const { data } = await response.json();
    expect(data.entries[0]).toMatchObject({
      id: record.id,
      delta: "9007199254740993",
      deltaIsExactNumber: false,
    });
  });

  it("requires authentication for both endpoints", async () => {
    session.userId = "";
    try {
      expect((await portfolio()).status).toBe(401);
      const response = await transactions(
        new Request("http://localhost/api/transactions"),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    } finally {
      session.userId = buyerId;
    }
  });
});

describe("order workspace pagination", () => {
  it("keeps every historical order reachable and applies filters on the server", async () => {
    const { GET } = await import("../../app/api/orders/route");
    const asset = await prisma.asset.findUniqueOrThrow({
      where: { symbol: "TEST-CREDIT" },
    });
    await prisma.order.createMany({
      data: Array.from({ length: 53 }, (_, i) => ({
        userId: buyerId,
        assetId: asset.id,
        side: "BUY",
        type: "LIMIT",
        price: 900,
        quantity: 1,
        status: "CANCELLED",
        createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, i)),
      })),
    });
    const ids: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const response = await GET(
        new Request(
          `http://localhost/api/orders?page=${page}&status=CANCELLED&side=BUY`,
        ),
      );
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const { data } = await response.json();
      expect(data.total).toBe(53);
      expect(data.pages).toBe(3);
      ids.push(...data.orders.map((o: { id: string }) => o.id));
    }
    expect(ids).toHaveLength(53);
    expect(new Set(ids).size).toBe(53);
    const { data: active } = await (
      await GET(new Request("http://localhost/api/orders?page=1&status=ACTIVE"))
    ).json();
    expect(active.orders).toEqual([]);
    const { data: legacy } = await (
      await GET(new Request("http://localhost/api/orders"))
    ).json();
    expect(Array.isArray(legacy)).toBe(true);
    expect(legacy).toHaveLength(50);
  });

  it("rejects invalid filters and unauthenticated order history", async () => {
    const { GET } = await import("../../app/api/orders/route");
    expect(
      (await GET(new Request("http://localhost/api/orders?page=0"))).status,
    ).toBe(400);
    expect(
      (
        await GET(
          new Request("http://localhost/api/orders?page=1&status=OTHER"),
        )
      ).status,
    ).toBe(400);
    session.userId = "";
    try {
      expect(
        (await GET(new Request("http://localhost/api/orders?page=1"))).status,
      ).toBe(401);
    } finally {
      session.userId = buyerId;
    }
  });

  it("reports only the remaining executable sell supply, excluding cancelled orders", async () => {
    const { GET } = await import("../../app/api/assets/route");
    const { data } = await (await GET()).json();
    expect(
      data.find((a: { symbol: string }) => a.symbol === "TEST-CREDIT")
        .availableSupply,
    ).toBe(10);
  });
});

describe("order execution price evidence", () => {
  it("derives the average fill price of a resting maker order from executions", async () => {
    const { placeOrder } = await import("./matching");
    const { GET } = await import("../../app/api/orders/route");
    const asset = await prisma.asset.findUniqueOrThrow({
      where: { symbol: "TEST-CREDIT" },
    });
    const placed = await placeOrder({
      userId: buyerId,
      assetId: asset.id,
      side: "BUY",
      type: "LIMIT",
      price: 900,
      quantity: 3,
    });
    await placeOrder({
      userId: sellerId,
      assetId: asset.id,
      side: "SELL",
      type: "MARKET",
      price: null,
      quantity: 2,
    });
    const { data } = await (
      await GET(new Request("http://localhost/api/orders?page=1&status=ACTIVE"))
    ).json();
    expect(
      data.orders.find((o: { id: string }) => o.id === placed.order.id),
    ).toMatchObject({ filledQuantity: 2, avgFillPrice: 900 });
  });
});
