import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// Explicit datasource override: these accounting tests must never connect to dev.db.
vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => testState.cookie ? { value: testState.cookie } : undefined,
    set: (_name: string, value: string) => { testState.cookie = value; },
  }),
}));

let prisma: typeof import("../server/db")["prisma"];
let retirement: typeof import("./retirement");
let routes: typeof import("../../app/api/retirements/route");
let certificate: typeof import("../../app/api/retirements/[id]/certificate/route");
let createSession: typeof import("../server/auth")["createSession"];
let ownerId: string;
let otherId: string;
let assetId: string;

beforeAll(async () => {
  const { mkdtempSync, realpathSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-retirement-")));
  writeFileSync(join(testState.directory, "retirement.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "retirement.db")}`;
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  retirement = await import("./retirement");
  ({ prisma } = await import("../server/db"));
  routes = await import("../../app/api/retirements/route");
  certificate = await import("../../app/api/retirements/[id]/certificate/route");
  ({ createSession } = await import("../server/auth"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  if (!prisma) return;
  testState.cookie = "";
  await prisma.retirement.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.holding.deleteMany();
  await prisma.user.deleteMany();
  await prisma.asset.deleteMany();
  const owner = await prisma.user.create({ data: { email: "owner@retirement.test", name: "Owner", passwordHash: "test", cashBalance: BigInt(50000) } });
  const other = await prisma.user.create({ data: { email: "other@retirement.test", name: "Other", passwordHash: "test" } });
  const asset = await prisma.asset.create({ data: { symbol: "DEMO-FOREST", name: "Demonstration forest", standard: "Demo standard", registry: "Demo registry", vintage: 2024, country: "Example", projectType: "Forest", isScenario: false } });
  ownerId = owner.id;
  otherId = other.id;
  assetId = asset.id;
  await prisma.holding.create({ data: { userId: ownerId, assetId, quantity: 100, locked: 30 } });
  await prisma.ledgerEntry.create({ data: { userId: ownerId, account: "HOLDING", assetId, delta: BigInt(100), reason: "SEED" } });
});

function input(overrides: Record<string, unknown> = {}) {
  return { assetId, quantity: 20, reason: "Practice retirement", beneficiary: "Example organisation", purpose: "Training exercise", publicMessage: "", acknowledged: true, idempotencyKey: "request-00000001", ...overrides };
}

describe("simulated retirement accounting", () => {
  it.each(["CEA-SCENARIO", "CCER-SCENARIO"])("rejects scenario index %s without debiting holdings or creating a receipt", async (symbol) => {
    await prisma.asset.update({ where: { id: assetId }, data: { symbol, isScenario: true } });
    await expect(retirement.retireCredits(ownerId, input())).rejects.toThrow(/scenario.*cannot be retired/i);
    expect(await prisma.retirement.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(1);
    expect(await prisma.holding.findUnique({ where: { userId_assetId: { userId: ownerId, assetId } } })).toMatchObject({ quantity: 100, locked: 30 });
  });

  it("removes available credits once, keeps locked credits and cash intact, and records a ledger debit", async () => {
    const result = await retirement.retireCredits(ownerId, input());
    expect(result.replayed).toBe(false);
    expect(result.retirement).toMatchObject({ quantity: 20, status: "SIMULATED", projectName: "Demonstration forest", registry: "Demo registry", vintage: 2024 });
    expect(result.retirement.reference).toMatch(/^SIM-RET-/);
    expect(await prisma.holding.findUnique({ where: { userId_assetId: { userId: ownerId, assetId } } })).toMatchObject({ quantity: 80, locked: 30 });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ownerId } })).cashBalance).toBe(BigInt(50000));
    const ledger = await prisma.ledgerEntry.findMany({ where: { refId: result.retirement.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ account: "HOLDING", delta: BigInt(-20), reason: "SIMULATED_RETIREMENT", refType: "RETIREMENT", userId: ownerId, assetId });
    const sum = await prisma.ledgerEntry.aggregate({ where: { userId: ownerId, assetId, account: "HOLDING" }, _sum: { delta: true } });
    expect(sum._sum.delta).toBe(BigInt(80));
  });

  it("allows the exact available balance and never consumes credits locked by sell orders", async () => {
    await retirement.retireCredits(ownerId, input({ quantity: 70 }));
    expect(await prisma.holding.findUnique({ where: { userId_assetId: { userId: ownerId, assetId } } })).toMatchObject({ quantity: 30, locked: 30 });
    await expect(retirement.retireCredits(ownerId, input({ quantity: 1, idempotencyKey: "request-00000002" }))).rejects.toThrow(/available holdings/i);
    expect(await prisma.retirement.count()).toBe(1);
  });

  it("rolls back when a request exceeds available holdings", async () => {
    await expect(retirement.retireCredits(ownerId, input({ quantity: 71 }))).rejects.toThrow(/available holdings/i);
    expect(await prisma.retirement.count()).toBe(0);
    expect(await prisma.ledgerEntry.count()).toBe(1);
    expect((await prisma.holding.findFirstOrThrow()).quantity).toBe(100);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, "20"])("rejects invalid quantity %s without writing", async (quantity) => {
    await expect(retirement.retireCredits(ownerId, input({ quantity }))).rejects.toThrow();
    expect(await prisma.retirement.count()).toBe(0);
    expect((await prisma.holding.findFirstOrThrow()).quantity).toBe(100);
  });

  it.each([{ acknowledged: false }, { beneficiary: " " }, { reason: "" }, { purpose: "" }, { publicMessage: "a".repeat(501) }, { idempotencyKey: "" }])("requires deliberate acknowledgement and bounded request fields: %s", async (invalid) => {
    await expect(retirement.retireCredits(ownerId, input(invalid))).rejects.toThrow();
    expect(await prisma.retirement.count()).toBe(0);
  });

  it("returns the original snapshot for a repeated request and rejects changed payloads on the same key", async () => {
    const first = await retirement.retireCredits(ownerId, input());
    await prisma.asset.update({ where: { id: assetId }, data: { name: "Renamed later", registry: "Changed later" } });
    const replay = await retirement.retireCredits(ownerId, input());
    expect(replay.replayed).toBe(true);
    expect(replay.retirement.id).toBe(first.retirement.id);
    expect(replay.retirement.projectName).toBe("Demonstration forest");
    await expect(retirement.retireCredits(ownerId, input({ quantity: 21 }))).rejects.toThrow(/already used/i);
    expect(await prisma.retirement.count()).toBe(1);
    expect((await prisma.holding.findFirstOrThrow()).quantity).toBe(80);
  });

  it("scopes idempotency and holdings to the authenticated user", async () => {
    const first = await retirement.retireCredits(ownerId, input());
    await expect(retirement.retireCredits(otherId, input())).rejects.toThrow(/available holdings/i);
    await prisma.holding.create({ data: { userId: otherId, assetId, quantity: 40 } });
    const second = await retirement.retireCredits(otherId, input());
    expect(second.retirement.id).not.toBe(first.retirement.id);
    const history = await retirement.listRetirements(otherId);
    expect(history.retirements).toHaveLength(1);
    expect(history.retirements[0].id).toBe(second.retirement.id);
    expect(history.positions[0].available).toBe(20);
    expect(await retirement.getRetirement(otherId, first.retirement.id)).toBeNull();
  });

  it("rolls back the holdings change if the audit ledger cannot be appended", async () => {
    await prisma.$executeRawUnsafe("CREATE TRIGGER fail_retirement_ledger BEFORE INSERT ON LedgerEntry WHEN NEW.reason = 'SIMULATED_RETIREMENT' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    try {
      await expect(retirement.retireCredits(ownerId, input())).rejects.toThrow();
      expect(await prisma.retirement.count()).toBe(0);
      expect((await prisma.holding.findFirstOrThrow()).quantity).toBe(100);
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER fail_retirement_ledger");
    }
  });
});

describe("private retirement API and certificate", () => {
  it("excludes scenario index holdings from the authenticated retirement choices", async () => {
    const scenario = await prisma.asset.create({ data: { symbol: "CEA-SCENARIO", name: "CEA scenario index", standard: "Scenario", registry: "", vintage: 2024, country: "Example", projectType: "Index", isScenario: true } });
    await prisma.holding.create({ data: { userId: ownerId, assetId: scenario.id, quantity: 200 } });
    await createSession(ownerId);
    const response = await routes.GET();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.positions.map((position: { assetId: string }) => position.assetId)).toEqual([assetId]);
    expect(json.data.positions[0].available).toBe(70);
  });

  it("requires a valid session for history, retirement and certificates", async () => {
    expect((await routes.GET()).status).toBe(401);
    expect((await routes.POST(new Request("http://localhost/api/retirements", { method: "POST", body: JSON.stringify(input()) }))).status).toBe(401);
    expect((await certificate.GET(new Request("http://localhost/api/retirements/x/certificate"), { params: Promise.resolve({ id: "x" }) })).status).toBe(401);
    expect(await prisma.retirement.count()).toBe(0);
  });

  it("returns validation errors and persists one confirmed request through the API", async () => {
    await createSession(ownerId);
    const invalid = await routes.POST(new Request("http://localhost/api/retirements", { method: "POST", body: JSON.stringify(input({ quantity: 1.5 })) }));
    expect(invalid.status).toBe(400);
    const response = await routes.POST(new Request("http://localhost/api/retirements", { method: "POST", body: JSON.stringify(input()) }));
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.data.retirement).toMatchObject({ quantity: 20, tonnesCO2e: 20, status: "SIMULATED" });
    const history = await (await routes.GET()).json();
    expect(history.data.totalRetired).toBe(20);
    expect(history.data.retirements).toHaveLength(1);
    expect(history.data.retirements[0].userId).toBeUndefined();
    expect(history.data.retirements[0].idempotencyKey).toBeUndefined();
  });

  it("hides another user's certificate and escapes all user content in the authenticated download", async () => {
    const result = await retirement.retireCredits(ownerId, input({ beneficiary: '<script>alert("x")</script>', publicMessage: '<img src=x onerror="alert(1)">' }));
    const context = { params: Promise.resolve({ id: result.retirement.id }) };
    const request = new Request(`http://localhost/api/retirements/${result.retirement.id}/certificate?download=1`);
    await createSession(otherId);
    expect((await certificate.GET(request, context)).status).toBe(404);
    await createSession(ownerId);
    const response = await certificate.GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const html = await response.text();
    expect(html).toContain("SIMULATION ONLY");
    expect(html).toContain("No registry retirement");
    expect(html).toContain("No real emissions claim");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain(result.retirement.reference);
    expect(html).not.toContain("owner@retirement.test");
  });
});
