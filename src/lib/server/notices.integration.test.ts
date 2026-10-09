// notifyUser 与 pruneOldNotices(计划 §6.3.2 C5 末句、C4 的 30 天清理)对真实 SQLite(临时库 + migrate deploy)的集成测试:
// 落库与形状、同一 dedupeKey 只落一条、在线才发 notice 事件且带未读数、读不回来的载荷不落库、失败不抛只记日志;
// 30 天清理只删旧的、分批删完、失败返回已删条数。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../../server/bus.mjs";
import type { BusMessage } from "@/shared/bus";
import type { NoticePayload } from "@/shared/types";

const database = vi.hoisted(() => ({ directory: "", path: "" }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// 显式钉在临时库上,绝不触碰 dev.db
vi.mock("./db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${database.path}` }) };
});

let prisma: (typeof import("./db"))["prisma"];
let notices: typeof import("./notices");
const received: BusMessage[] = [];
let userId = "";
let run = 0;

beforeAll(async () => {
  database.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-notices-")));
  database.path = join(database.directory, "notices.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("./db"));
  notices = await import("./notices");
  const rows = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!rows[0]?.file.startsWith(database.directory)) throw new Error(`测试连到了意外的数据库: ${rows[0]?.file}`);
}, 120_000);

afterAll(async () => {
  globalThis.__carbadiaBus = undefined;
  globalThis.__carbadiaPresence = undefined;
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  run += 1;
  userId = (await prisma.user.create({ data: { email: `n-${run}@notices.test`, name: "N", passwordHash: "x" } })).id;
  received.length = 0;
  const bus = createBus();
  bus.subscribe((msg) => void received.push(msg));
  globalThis.__carbadiaBus = bus;
});

afterEach(() => {
  globalThis.__carbadiaPresence = undefined;
  vi.restoreAllMocks();
});

const alert = (firedPrice: number): NoticePayload => ({ kind: "price_alert", triggerId: "t1", symbol: "VCS-TEST", direction: "ABOVE", triggerPrice: 10_000, firedPrice });
const online = (id: string) => (globalThis.__carbadiaPresence = { users: new Map([[id, 1]]), topics: new Map() });

describe("notifyUser", () => {
  it("落一行(payload 是 JSON、kind 列 = 载荷的 kind),返回 Notice;同一 dedupeKey 再来一次什么都不做、返回 null", async () => {
    const notice = await notices.notifyUser(userId, alert(10_100), "alert:t1");
    expect(notice).toMatchObject({ kind: "price_alert", triggerId: "t1", symbol: "VCS-TEST", direction: "ABOVE", triggerPrice: 10_000, firedPrice: 10_100, readAt: null });
    expect(typeof notice?.createdAt).toBe("number");
    const rows = await prisma.notification.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: notice!.id, kind: "price_alert", dedupeKey: "alert:t1", readAt: null });
    expect(JSON.parse(rows[0].payload)).toEqual(alert(10_100));

    expect(await notices.notifyUser(userId, alert(10_200), "alert:t1")).toBeNull();
    expect(await prisma.notification.count({ where: { userId } })).toBe(1);
    expect(JSON.parse((await prisma.notification.findFirstOrThrow({ where: { userId } })).payload).firedPrice).toBe(10_100); // 先到的那条留下
  });

  it("用户在线:发 { t: notice, notice, unread },unread 数的是本人全部未读(已读的不算);不在线:照样落库,不发事件", async () => {
    await notices.notifyUser(userId, alert(10_100), "k1");
    expect(received).toEqual([]); // 不在线
    await prisma.notification.updateMany({ where: { userId }, data: { readAt: new Date() } });
    await notices.notifyUser(userId, alert(10_200), "k2");
    online(userId);
    const third = await notices.notifyUser(userId, alert(10_300), "k3");
    expect(received).toEqual([{ kind: "account", userId, event: { t: "notice", notice: third, unread: 2 } }]);
    expect(await prisma.notification.count({ where: { userId } })).toBe(3);
  });

  it("读不回来的载荷(负数)不落库;写库失败(用户不存在)返回 null、不抛,只记一行结构化日志", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await notices.notifyUser(userId, alert(-1), "bad")).toBeNull();
    expect(await prisma.notification.count({ where: { userId } })).toBe(0);
    expect(await notices.notifyUser("no-such-user", alert(10_000), "k")).toBeNull();
    const lines = errors.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(lines).toEqual([
      expect.objectContaining({ src: "notices", ev: "bad_payload", userId, dedupeKey: "bad" }),
      expect.objectContaining({ src: "notices", ev: "notify_failed", userId: "no-such-user", dedupeKey: "k", error: expect.any(String) }),
    ]);
  });
});

describe("pruneOldNotices", () => {
  it("只删 createdAt 早于 30 天的,返回删掉的条数;超过一批(5000)的分批删完", async () => {
    const day = 86_400_000;
    const now = Date.now();
    const row = (i: number, ageMs: number) => ({ userId, kind: "price_alert", payload: JSON.stringify(alert(10_000)), dedupeKey: `p${i}`, createdAt: new Date(now - ageMs) });
    await prisma.notification.createMany({ data: Array.from({ length: 5_003 }, (_, i) => row(i, 31 * day)) });
    await prisma.notification.createMany({ data: [row(-1, 29 * day), row(-2, 0)] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const executeRaw = vi.spyOn(prisma, "$executeRaw");
    expect(await notices.pruneOldNotices()).toBe(5_003);
    expect(executeRaw).toHaveBeenCalledTimes(2); // 5000 + 3
    expect((await prisma.notification.findMany({ where: { userId }, select: { dedupeKey: true } })).map((r) => r.dedupeKey).sort()).toEqual(["p-1", "p-2"]);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ src: "notices", ev: "prune", deleted: 5_003 }));
    expect(await notices.pruneOldNotices(day)).toBe(1); // 自定的保留期:一天前的那条
  });

  it("删除失败:不抛,返回已删条数并记日志", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$executeRaw").mockRejectedValueOnce(new Error("database is locked"));
    expect(await notices.pruneOldNotices()).toBe(0);
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toMatchObject({ src: "notices", ev: "prune_failed", deleted: 0, error: "database is locked" });
  });
});
