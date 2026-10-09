// 健康路由的深探门槛(设计 §3.1、§3.4):临时 SQLite + migrate deploy 走真实路由。
// 不带头 / 头错 / 服务端未设密钥 → 字段集合与原来一样、Heartbeat 不落行;头对 → write true、落一行、disk 三个数合理、no-store。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "" }));

vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let route: typeof import("./route");

const SECRET = "watchdog-test-secret-0123456789";
const SHALLOW_KEYS = ["bot", "db", "startMode", "ws"];
const get = (headers: Record<string, string> = {}) => route.GET(new Request("http://localhost/api/health", { headers }));

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-health-route-")));
  writeFileSync(join(testState.directory, "health.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "health.db")}`;
  // 深探按 DATABASE_URL 找卷目录:钉到临时库所在目录,与 shell / Docker 构建环境无关
  process.env.DATABASE_URL = testState.databaseUrl;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  route = await import("./route");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
}, 120_000);

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

async function expectShallow(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toBeNull();
  const { ok, data } = await res.json();
  expect(ok).toBe(true);
  expect(Object.keys(data).sort()).toEqual(SHALLOW_KEYS);
  expect(data.db).toBe(true);
  expect(await prisma.heartbeat.count()).toBe(0);
}

describe("GET /api/health 深探门槛", () => {
  it("不带密钥头:字段集合与原来一样,不写 Heartbeat", async () => {
    vi.stubEnv("WATCHDOG_SECRET", SECRET);
    await expectShallow(await get());
  });

  it("密钥错:同上", async () => {
    vi.stubEnv("WATCHDOG_SECRET", SECRET);
    await expectShallow(await get({ "x-watchdog-secret": `${SECRET}x` }));
  });

  it("服务端没设 WATCHDOG_SECRET:带头也不深探", async () => {
    vi.stubEnv("WATCHDOG_SECRET", "");
    await expectShallow(await get({ "x-watchdog-secret": SECRET }));
  });

  it("密钥对:原有四个字段都在,write true、Heartbeat 一行、disk 三个数合理、no-store", async () => {
    vi.stubEnv("WATCHDOG_SECRET", SECRET);
    const res = await get({ "x-watchdog-secret": SECRET });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { ok, data } = await res.json();
    expect(ok).toBe(true);
    expect(Object.keys(data).sort()).toEqual([...SHALLOW_KEYS, "disk", "write"].sort());
    expect(data.db).toBe(true);
    expect(data.write).toBe(true);
    expect(data.disk.totalMb).toBeGreaterThan(0);
    expect(data.disk.freeMb).toBeGreaterThanOrEqual(0);
    expect(data.disk.usedPct).toBeGreaterThanOrEqual(0);
    expect(data.disk.usedPct).toBeLessThanOrEqual(100);
    expect(await prisma.heartbeat.count()).toBe(1);
  });
});
