// 经真实路由(临时 SQLite + migrate deploy + 模拟 cookie)验证通知的两个接口与 /api/auth/me 的 unreadNotices(计划 §6.3.2 C3):
// 未登录 401、private no-store(错误响应也带)、键集分页(新的在前、无重复无遗漏、读不回来的行跳过但游标越过)、unread 是本人全部未读、
// 按 ids / all 标已读(只改本人 readAt 为空的行,别人的 id 忽略、已读的保持原来的读取时刻)、请求体恰好二选一、按用户限流、me 带未读数。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice, NoticePayload } from "@/shared/types";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上, 绝不触碰 dev.db
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: testState.databaseUrl }) };
});
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (testState.cookie ? { value: testState.cookie } : undefined),
    set: (_name: string, value: string) => { testState.cookie = value; },
    delete: () => { testState.cookie = ""; },
  }),
}));

let prisma: (typeof import("@/lib/server/db"))["prisma"];
let listRoute: typeof import("./notices/route");
let readRoute: typeof import("./notices/read/route");
let meRoute: typeof import("../auth/me/route");
let rateLimit: (typeof import("@/lib/server/rate-limit"))["rateLimit"];
let createSession: (typeof import("@/lib/server/auth"))["createSession"];

let run = 0;
let seq = 0;
const ids = { alice: "", bob: "" };

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-notices-routes-")));
  writeFileSync(join(testState.directory, "notices.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "notices.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  listRoute = await import("./notices/route");
  readRoute = await import("./notices/read/route");
  meRoute = await import("../auth/me/route");
  ({ rateLimit } = await import("@/lib/server/rate-limit"));
  ({ createSession } = await import("@/lib/server/auth"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(async () => {
  // 每个用例新的用户:未读数、分页与限流桶都按用户算,用例之间互不影响
  run += 1;
  const user = (name: string) => prisma.user.create({ data: { email: `${name}-${run}@notices-routes.test`, name, passwordHash: "test", cashBalance: BigInt(100_000_000) } });
  const [alice, bob] = [await user("alice"), await user("bob")];
  Object.assign(ids, { alice: alice.id, bob: bob.id });
  testState.cookie = "";
});

const fill = (orderId: string): NoticePayload => ({ kind: "fill", orderId, symbol: "VCS-TEST", side: "BUY", role: "TAKER", quantity: 3, price: 10_000, orderStatus: "FILLED" });
const BASE = Date.UTC(2026, 9, 1, 12, 0, 0);

/** 给一个用户落 n 条通知(createdAt 每条隔 1 s;same 条数的几条同一毫秒,靠 id 排先后);返回新的在前的 id 列表 */
async function seed(userId: string, n: number, over: { read?: number[]; sameMs?: boolean } = {}): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const row = await prisma.notification.create({
      data: {
        userId,
        kind: "fill",
        payload: JSON.stringify(fill(`order-${i}`)),
        dedupeKey: `seed:${++seq}`,
        createdAt: new Date(over.sameMs ? BASE : BASE + i * 1_000),
        readAt: over.read?.includes(i) ? new Date(BASE + 500) : null,
      },
    });
    created.push(row.id);
  }
  // 新的在前:createdAt 降序、同时刻按 id 降序
  const rows = await prisma.notification.findMany({ where: { id: { in: created } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
  return rows.map((row) => row.id);
}

const list = (query = "") => listRoute.GET(new Request(`http://localhost/api/account/notices${query}`));
const post = (body: unknown) =>
  readRoute.POST(new Request("http://localhost/api/account/notices/read", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
const me = () => meRoute.GET();

async function expectError(res: Response, status: number, error: string | RegExp) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  const body = await res.json();
  expect(body.ok).toBe(false);
  if (typeof error === "string") expect(body.error).toBe(error);
  else expect(body.error).toMatch(error);
}
const unreadOf = (userId: string) => prisma.notification.count({ where: { userId, readAt: null } });

describe("鉴权", () => {
  it("未登录:两个接口都是 401(private, no-store),什么都不改", async () => {
    const [mine] = await seed(ids.alice, 1);
    await expectError(await list(), 401, "Not logged in");
    await expectError(await post({ all: true }), 401, "Not logged in");
    await expectError(await post({ ids: [mine] }), 401, "Not logged in");
    expect(await unreadOf(ids.alice)).toBe(1);
  });
});

describe("GET /api/account/notices", () => {
  it("新的在前、键集分页无重复无遗漏(含同一毫秒的几条);每页的 unread 都是本人全部未读;不外露 userId / dedupeKey;别人的通知不出现", async () => {
    await createSession(ids.alice);
    const aliceIds = await seed(ids.alice, 7, { read: [0, 1] }); // 7 条,最早的两条已读 → 5 条未读
    const same = await seed(ids.alice, 3, { sameMs: true }); // 另外 3 条同一毫秒
    await seed(ids.bob, 4);
    const expected = (await prisma.notification.findMany({ where: { id: { in: [...aliceIds, ...same] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } })).map((r) => r.id);

    const seen: Notice[] = [];
    let cursor = "";
    let pages = 0;
    for (;;) {
      const res = await list(`?limit=4${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      const { ok, data } = await res.json();
      expect(ok).toBe(true);
      expect(data.unread).toBe(8); // 5 + 3,不是本页的条数
      seen.push(...data.items);
      pages += 1;
      if (!data.nextCursor) break;
      expect(data.items).toHaveLength(4);
      cursor = data.nextCursor;
    }
    expect(pages).toBe(3); // 10 条,每页 4
    expect(seen.map((n) => n.id)).toEqual(expected);
    expect(new Set(seen.map((n) => n.id)).size).toBe(10);
    expect(seen[0]).toMatchObject({ id: expected[0], readAt: null, kind: "fill", symbol: "VCS-TEST", side: "BUY", role: "TAKER", quantity: 3, price: 10_000, orderStatus: "FILLED" });
    expect(typeof seen[0].createdAt).toBe("number");
    expect("userId" in seen[0] || "dedupeKey" in seen[0]).toBe(false);
    const readOnes = seen.filter((n) => n.readAt !== null);
    expect(readOnes).toHaveLength(2);
    expect(readOnes[0].readAt).toBe(BASE + 500);
  });

  it("缺省 limit = 50;limit 夹到 1..100;没有通知是空页、unread 0", async () => {
    await createSession(ids.alice);
    await expect((await list()).json()).resolves.toEqual({ ok: true, data: { items: [], nextCursor: null, unread: 0 } });
    await seed(ids.alice, 3);
    const one = (await (await list("?limit=0")).json()).data; // 夹到 1
    expect(one.items).toHaveLength(1);
    expect(one.nextCursor).toEqual(expect.any(String));
    expect((await (await list("?limit=1000")).json()).data.items).toHaveLength(3);
  });

  it("payload 读不回来的行不进 items,但游标越过它们、翻到底不卡住;它被顺手标成已读(行还在库里),之后不再算进未读数", async () => {
    await createSession(ids.alice);
    const [newest, middle, oldest] = await seed(ids.alice, 3);
    await prisma.notification.update({ where: { id: middle }, data: { payload: "not json" } });

    const got: string[] = [];
    const unreadSeen: number[] = [];
    let cursor = "";
    for (let i = 0; i < 5; i += 1) {
      const { data } = await (await list(`?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json();
      got.push(...data.items.map((n: Notice) => n.id));
      unreadSeen.push(data.unread);
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    expect(got).toEqual([newest, oldest]);
    expect(unreadSeen).toEqual([3, 2, 2]); // 翻到坏行那一页:应答里的未读数已经减去它
    expect(await prisma.notification.findUnique({ where: { id: middle } })).toMatchObject({ payload: "not json", readAt: expect.any(Date) });
    expect((await (await list()).json()).data).toMatchObject({ items: [{ id: newest }, { id: oldest }], unread: 2 });
    expect((await (await me()).json()).data.unreadNotices).toBe(2);
  });

  it("顺手标已读失败不影响列表:照常 200、未读数不减,记一行 notices 日志", async () => {
    await createSession(ids.alice);
    const [newest, middle] = await seed(ids.alice, 2);
    await prisma.notification.update({ where: { id: middle }, data: { payload: "{}" } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma.notification, "updateMany").mockRejectedValueOnce(new Error("database is locked"));
    const res = await list();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ items: [{ id: newest }], unread: 2 });
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toEqual({ src: "notices", ev: "mark_unreadable_failed", userId: ids.alice, rows: 1, error: "database is locked" });
    vi.restoreAllMocks();
    expect((await (await list()).json()).data.unread).toBe(1); // 下一次就标上了
  });

  it("非法 limit / cursor → 400(带 private, no-store)", async () => {
    await createSession(ids.alice);
    await expectError(await list("?limit=abc"), 400, "Invalid limit");
    await expectError(await list("?cursor=not-a-cursor"), 400, "Invalid cursor");
  });

  it("按用户限流 60/min:超过 → 429 带 Retry-After 与 private, no-store;与标已读各自一个桶", async () => {
    await createSession(ids.alice);
    for (let i = 0; i < 60; i += 1) expect(rateLimit(`notices:user:${ids.alice}`, 60, 60_000)).toBe(true);
    const limited = await list();
    await expectError(limited, 429, "Too many requests, please retry later");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await post({ all: true })).status).toBe(200); // 读取的桶满了不影响标已读
  });
});

describe("POST /api/account/notices/read", () => {
  it("{ ids }:只标这几条;别人的 id 与不存在的 id 忽略;已读的保持原来的读取时刻;应答是标完之后的本人未读数", async () => {
    await createSession(ids.alice);
    const aliceIds = await seed(ids.alice, 4, { read: [3] }); // 新的在前:aliceIds[0] 是 i = 3,已读
    const bobIds = await seed(ids.bob, 2);
    const unreadMine = aliceIds.filter((_, index) => index !== 0); // 三条未读

    const res = await post({ ids: [unreadMine[0], unreadMine[1], aliceIds[0], bobIds[0], "no-such-id"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ ok: true, data: { unread: 1 } });

    const rows = new Map((await prisma.notification.findMany({ where: { id: { in: [...aliceIds, ...bobIds] } } })).map((r) => [r.id, r.readAt?.getTime() ?? null]));
    expect(rows.get(unreadMine[0])).toEqual(expect.any(Number));
    expect(rows.get(unreadMine[1])).toEqual(expect.any(Number));
    expect(rows.get(unreadMine[2])).toBeNull();
    expect(rows.get(aliceIds[0])).toBe(BASE + 500); // 原来就读过:时刻不动
    expect(rows.get(bobIds[0])).toBeNull(); // 别人的:忽略
    expect(rows.get(bobIds[1])).toBeNull();
    expect(await unreadOf(ids.bob)).toBe(2);
  });

  it("{ all: true }:标本人全部、不碰别人的;应答 unread 0;再来一次仍是 0", async () => {
    await createSession(ids.alice);
    await seed(ids.alice, 5, { read: [0] });
    await seed(ids.bob, 3);
    expect(await (await post({ all: true })).json()).toEqual({ ok: true, data: { unread: 0 } });
    expect(await unreadOf(ids.alice)).toBe(0);
    expect(await unreadOf(ids.bob)).toBe(3);
    expect(await (await post({ all: true })).json()).toEqual({ ok: true, data: { unread: 0 } });
    // 原本读过的那条没被改写成新的读取时刻
    expect((await prisma.notification.findMany({ where: { userId: ids.alice, readAt: new Date(BASE + 500) } })).length).toBe(1);
  });

  it("请求体恰好二选一:空对象、空 ids、超过 100 条、空串 id、ids 与 all 同给、all 不是 true、多余的键、不是 JSON、ids 不是数组 → 400,什么都不改", async () => {
    await createSession(ids.alice);
    await seed(ids.alice, 2);
    await expectError(await post({}), 400, "Give ids (1 to 100) or all: true");
    await expectError(await post("not json"), 400, "Request body is not valid JSON");
    // 其余的 zod 会指出具体哪一支的哪个字段不对,措辞不钉死,只要是 400
    for (const body of [{ ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => `n${i}`) }, { ids: [""] }, { ids: ["x"], all: true }, { all: false }, { all: true, extra: 1 }, { ids: "x" }, null]) {
      await expectError(await post(body), 400, /./);
    }
    expect(await unreadOf(ids.alice)).toBe(2);
    expect((await post({ ids: Array.from({ length: 100 }, (_, i) => `n${i}`) })).status).toBe(200); // 100 条是上限
  });

  it("按用户限流 60/min:超过 → 429 带 Retry-After", async () => {
    await createSession(ids.alice);
    for (let i = 0; i < 60; i += 1) expect(rateLimit(`notices:read:user:${ids.alice}`, 60, 60_000)).toBe(true);
    const limited = await post({ all: true });
    await expectError(limited, 429, "Too many requests, please retry later");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/auth/me", () => {
  it("未登录:data 仍是 null(private, no-store);登录后多一个 unreadNotices(本人未读条数,别人的不算),标已读后随之减少", async () => {
    const anonymous = await me();
    expect(anonymous.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await anonymous.json()).toEqual({ ok: true, data: null });

    await createSession(ids.alice);
    const before = await me();
    expect(before.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await before.json()).data).toEqual({ id: ids.alice, email: `alice-${run}@notices-routes.test`, name: "alice", cashBalance: 100_000_000, lockedCash: 0, unreadNotices: 0 });

    const aliceIds = await seed(ids.alice, 4, { read: [0] });
    await seed(ids.bob, 6);
    expect((await (await me()).json()).data.unreadNotices).toBe(3);
    await post({ ids: [aliceIds[0], aliceIds[1]] }); // aliceIds[0] 是 i = 3(未读),aliceIds[1] 是 i = 2(未读)
    expect((await (await me()).json()).data.unreadNotices).toBe(1);
    await post({ all: true });
    expect((await (await me()).json()).data.unreadNotices).toBe(0);
  });

  it("数未读失败 → unreadNotices 按 0 答、仍是 200,记一行 notices 日志;其余字段照常", async () => {
    await createSession(ids.alice);
    await seed(ids.alice, 2);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const count = vi.spyOn(prisma.notification, "count").mockRejectedValueOnce(new Error("database is locked"));
    const res = await me();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: ids.alice, email: `alice-${run}@notices-routes.test`, name: "alice", cashBalance: 100_000_000, lockedCash: 0, unreadNotices: 0 });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errors.mock.calls[0][0]))).toEqual({ src: "notices", ev: "count_unread_failed", userId: ids.alice, error: "database is locked" });
    count.mockRestore();
    errors.mockRestore();
    expect((await (await me()).json()).data.unreadNotices).toBe(2);
  });
});
