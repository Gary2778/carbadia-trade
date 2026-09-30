// SQLite 连接池上限(P1-25b):Prisma 的默认池(2 × CPU + 1)比查询引擎的工作线程(约每核一个)多,
// 当阻塞在 SQLite 同步忙等里的写事务比工作线程还多时,持锁的那个事务拿不到线程执行下一条语句,所有写入一起卡到 5 s 超时(P1008),
// 下单回 503、撤单回 500。db.ts 给 DATABASE_URL 追加 connection_limit 后,事务在 Prisma 的连接池里排队,不再占线程忙等。
// 这里用 db.ts 本身建的客户端(不 mock),在 WAL 临时库上跑 k = 2 × availableParallelism 个不同用户同时下单,要求零失败。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let directory = "";
let db: typeof import("./db");
let matching: typeof import("../exchange/matching");

beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-db-pool-")));
  writeFileSync(join(directory, "pool.db"), "");
  const url = `file:${join(directory, "pool.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  vi.stubEnv("DATABASE_URL", url);
  delete (globalThis as { prisma?: unknown }).prisma; // 用本文件的 URL 新建单例
  db = await import("./db");
  matching = await import("../exchange/matching");
  const databases = await db.prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(directory)) throw new Error("Unexpected test database");
  await db.prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL"); // 与生产(docker-entrypoint.sh 设 WAL)一致
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db?.prisma.$disconnect();
  delete (globalThis as { prisma?: unknown }).prisma;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("withConnectionLimit", () => {
  it("file: URL 追加 connection_limit(已有查询串用 &);已写了 connection_limit 的尊重原值;非 file: 与空值原样返回", () => {
    expect(db.withConnectionLimit("file:/data/trade.db")).toBe(`file:/data/trade.db?connection_limit=${db.SQLITE_CONNECTION_LIMIT}`);
    expect(db.withConnectionLimit("file:./dev.db?socket_timeout=10", 2)).toBe("file:./dev.db?socket_timeout=10&connection_limit=2");
    expect(db.withConnectionLimit("file:./dev.db?connection_limit=4")).toBe("file:./dev.db?connection_limit=4");
    expect(db.withConnectionLimit("postgresql://h/db")).toBe("postgresql://h/db");
    expect(db.withConnectionLimit(undefined)).toBeUndefined();
    expect(db.withConnectionLimit("")).toBe("");
  });
});

describe("并发写事务(db.ts 的客户端)", () => {
  it("k = 2 × availableParallelism 个用户同时下单,3 轮全部成功,没有 BusyError", async () => {
    const k = Math.max(8, 2 * availableParallelism());
    const asset = await db.prisma.asset.create({
      data: { symbol: "POOL-2021", name: "Pool", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" },
    });
    const users = await Promise.all(
      Array.from({ length: k }, (_, i) =>
        db.prisma.user.create({ data: { email: `u${i}@pool.test`, name: `U${i}`, passwordHash: "x", cashBalance: BigInt(100_000_000) } }),
      ),
    );
    const failures: string[] = [];
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled(
        users.map((u, i) =>
          matching.placeOrderTx({ userId: u.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 1_000 + round * 10 + (i % 5), quantity: 1 }),
        ),
      );
      for (const r of results) if (r.status === "rejected") failures.push(r.reason instanceof Error ? `${r.reason.name}: ${r.reason.message}` : String(r.reason));
    }
    expect(failures).toEqual([]);
    expect(await db.prisma.order.count({ where: { assetId: asset.id } })).toBe(3 * k);
  }, 60_000);
});
