// 写探针落库(设计 §3.2):临时 SQLite 跑全部迁移,upsert 两次只会有一行、at 跟着更新。显式钉在临时库上,绝不触碰 dev.db。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "" }));

vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let touchHeartbeat: (typeof import("./heartbeat"))["touchHeartbeat"];

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-heartbeat-")));
  writeFileSync(join(testState.directory, "heartbeat.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "heartbeat.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  ({ touchHeartbeat } = await import("./heartbeat"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

describe("touchHeartbeat", () => {
  it("第一次建行、第二次更新同一行,表里始终只有 id=1 一行", async () => {
    const first = new Date("2026-10-09T00:00:00.000Z");
    const second = new Date("2026-10-09T00:05:00.000Z");
    expect(await touchHeartbeat(first)).toMatchObject({ id: 1, at: first });
    expect(await touchHeartbeat(second)).toMatchObject({ id: 1, at: second });
    expect(await prisma.heartbeat.findMany()).toEqual([{ id: 1, at: second }]);
  });
});
