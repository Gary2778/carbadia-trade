// 机器人账户的密码哈希在机器人循环里锁死(P1-25b):旧种子给 mm1/mm2/mm3@carbadia.bot 的是公开的演示密码(生产库里就是它),
// 机器人每轮取 isBot 用户时,发现仍是可用的 salt:hash 就改成 `!<随机十六进制>`——verifyPassword 对它恒为 false。
// 种子本身也改成直接写不可用的哈希(P1-25e),BOT_DISABLED=1 的本地 / 新库同样登不进(第二个用例真跑一遍 prisma/seed.ts)。
// 只动 isBot 用户;已锁的不再改写(每轮不写库);真人账户的哈希一个字节都不变。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "" }));

vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl, log: ["error"] }) };
});

let prisma: (typeof import("../server/db"))["prisma"];
let bot: typeof import("./bot");
let auth: typeof import("../server/auth");

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-bot-credentials-")));
  writeFileSync(join(testState.directory, "bot.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "bot.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("../server/db"));
  bot = await import("./bot");
  auth = await import("../server/auth");
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

describe("机器人账户的密码哈希", () => {
  it("一轮 tick 后三个机器人都登不进(种子密码 verify 为 false),真人不动;再一轮不改写", async () => {
    const seedHash = auth.hashPassword("password123"); // 与 prisma/seed.ts 同一个公开密码、同一份哈希给所有账户
    const bots = await Promise.all(
      ["mm1", "mm2", "mm3"].map((n) =>
        prisma.user.create({ data: { email: `${n}@carbadia.bot`, name: n, passwordHash: seedHash, isBot: true, cashBalance: BigInt(0) } }),
      ),
    );
    const human = await prisma.user.create({ data: { email: "alice@carbadia.io", name: "Alice", passwordHash: seedHash } });

    await bot._internal.tick(); // 库里没有标的:只取机器人、锁哈希,不报价

    const after = await prisma.user.findMany({ where: { id: { in: bots.map((b) => b.id) } } });
    expect(after).toHaveLength(3);
    for (const row of after) {
      expect(row.passwordHash).toMatch(/^![0-9a-f]{64}$/);
      expect(auth.verifyPassword("password123", row.passwordHash)).toBe(false);
    }
    expect(new Set(after.map((row) => row.passwordHash)).size).toBe(3); // 每个机器人各自的随机值
    expect((await prisma.user.findUniqueOrThrow({ where: { id: human.id } })).passwordHash).toBe(seedHash);
    expect(auth.verifyPassword("password123", seedHash)).toBe(true);

    await bot._internal.tick();
    const again = await prisma.user.findMany({ where: { id: { in: bots.map((b) => b.id) } } });
    expect(new Map(again.map((row) => [row.id, row.passwordHash]))).toEqual(new Map(after.map((row) => [row.id, row.passwordHash])));
  });

  it("prisma/seed.ts 本身不再给机器人可用的密码:三个 `!<64 位十六进制>` 各不相同,verify 为 false;真人仍是演示密码", async () => {
    // 真跑一遍种子(与 npm run db:seed 同一条命令),对着本用例的临时库;种子先清空全部表再重建
    execFileSync("node_modules/.bin/tsx", ["prisma/seed.ts"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env: { ...process.env, DATABASE_URL: testState.databaseUrl },
      stdio: "pipe",
    });
    const bots = await prisma.user.findMany({ where: { isBot: true }, orderBy: { email: "asc" } });
    expect(bots.map((b) => b.email)).toEqual(["mm1@carbadia.bot", "mm2@carbadia.bot", "mm3@carbadia.bot"]);
    for (const row of bots) {
      expect(row.passwordHash).toMatch(/^![0-9a-f]{64}$/);
      expect(auth.verifyPassword("password123", row.passwordHash)).toBe(false);
    }
    expect(new Set(bots.map((b) => b.passwordHash)).size).toBe(3);
    const humans = await prisma.user.findMany({ where: { isBot: false } });
    expect(humans).toHaveLength(4);
    for (const row of humans) expect(auth.verifyPassword("password123", row.passwordHash)).toBe(true);
  }, 60_000);
});
