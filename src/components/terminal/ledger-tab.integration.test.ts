// 流水页签对真实接口的集成测试(P2-07):临时 SQLite + migrate deploy + 模拟 cookie,
// 客户端的分页查询(ledgerQueries → api → fetch)直接打到真实的 GET /api/transactions 路由处理函数上。
// 守住的是两头的约定:页签发出的每一个筛选参数服务端都认(不回 400)、筛出来的就是界面上说的那些行;
// 下一笔限价单再撤掉,流水里出现冻结与解冻(各两条腿);翻页不重不漏;账户有动静后 refresh 把新行并到顶上。
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "@/i18n/test-support";
import en from "@/i18n/messages/en";
import { ACTIVITY_TYPES, LEDGER_ACCOUNTS } from "@/lib/exchange/ledger-activity";
import type { LedgerActivity } from "@/shared/api-shapes";
import { DEFAULT_LEDGER_FILTERS, LEDGER_RANGES, ledgerPageUrl, ledgerQueries, ledgerRequest, LedgerView, refTail, type LedgerFilterState, type LedgerRequest } from "./LedgerTab";

const testState = vi.hoisted(() => ({ directory: "", databaseUrl: "", cookie: "" }));

// 显式钉在临时库上,绝不触碰 dev.db
vi.mock("@/lib/server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
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
let route: typeof import("@/app/api/transactions/route");
let matching: typeof import("@/lib/exchange/matching");
let createSession: (typeof import("@/lib/server/auth"))["createSession"];

const T = en.terminal;
const SYMBOL_A = "VCS-TEST-2021";
const SYMBOL_B = "GS-TEST-2022";
const DAY = 86_400_000;
/** bob 的合成账本行数:两页半(每页 50) */
const BOB_ROWS = 130;
const ids = { assetA: "", assetB: "", alice: "", bob: "", order: "" };
/** 页签发出的请求(路径 + 查询串),按先后 */
const requests: string[] = [];

const ALL: LedgerRequest = { account: null, type: null, symbol: null, range: "all" };
const request = (patch: Partial<LedgerFilterState>, symbol = SYMBOL_A): LedgerRequest => ledgerRequest({ ...DEFAULT_LEDGER_FILTERS, ...patch }, symbol);

/** 以某位用户的身份,把这一份筛选的流水翻到底 */
async function loadAll(userId: string, req: LedgerRequest): Promise<readonly LedgerActivity[]> {
  await createSession(userId);
  const query = ledgerQueries.forUser(userId, req)!;
  while (query.status !== "done") {
    await query.loadMore();
    if (query.status === "error") throw new Error(`ledger request failed: ${query.error} (${requests.at(-1)})`);
  }
  return query.items;
}

beforeAll(async () => {
  testState.directory = realpathSync(mkdtempSync(join(tmpdir(), "carbadia-ledger-tab-")));
  writeFileSync(join(testState.directory, "ledger.db"), "");
  testState.databaseUrl = `file:${join(testState.directory, "ledger.db")}`;
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: testState.databaseUrl },
    stdio: "pipe",
  });
  ({ prisma } = await import("@/lib/server/db"));
  route = await import("@/app/api/transactions/route");
  matching = await import("@/lib/exchange/matching");
  ({ createSession } = await import("@/lib/server/auth"));
  const databases = await prisma.$queryRaw<{ file: string }[]>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
  if (!databases[0]?.file.startsWith(testState.directory)) throw new Error("Unexpected test database");

  const assetA = await prisma.asset.create({ data: { symbol: SYMBOL_A, name: "Test forest", standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" } });
  const assetB = await prisma.asset.create({ data: { symbol: SYMBOL_B, name: "Test wind", standard: "GS", projectType: "Wind", vintage: 2022, country: "Example", registry: "Demo registry" } });
  const user = (name: string) => prisma.user.create({ data: { email: `${name}@ledger-tab.test`, name, passwordHash: "test", cashBalance: BigInt(10_000_000) } });
  const [alice, bob] = [await user("alice"), await user("bob")];
  Object.assign(ids, { assetA: assetA.id, assetB: assetB.id, alice: alice.id, bob: bob.id });

  // alice:40 天前的演示赠金、10 天前的一笔调整(给时间段筛选用),然后下一笔没有对手的限价买单(10 吨 @ 68.50)再撤掉
  const now = Date.now();
  await prisma.ledgerEntry.createMany({ data: [
    { userId: alice.id, account: "CASH", delta: BigInt(10_000_000), reason: "GRANT", createdAt: new Date(now - 40 * DAY) },
    { userId: alice.id, account: "CASH", delta: BigInt(500), reason: "SOMETHING_NEW", createdAt: new Date(now - 10 * DAY) },
  ] });
  const placed = await matching.placeOrder({ userId: alice.id, assetId: assetA.id, side: "BUY", type: "LIMIT", price: 6_850, quantity: 10 });
  ids.order = placed.order.id;
  await new Promise((resolve) => setTimeout(resolve, 5)); // 冻结与解冻不落在同一毫秒:断言里解冻排在冻结前面
  await matching.cancelOrder(alice.id, placed.order.id);

  // bob:130 行,前 60 行挤在同一毫秒(一毫秒跨过一页),四个账户轮着来
  await prisma.ledgerEntry.createMany({ data: Array.from({ length: BOB_ROWS }, (_, i) => ({
    userId: bob.id, account: LEDGER_ACCOUNTS[i % 4], reason: "GRANT", delta: BigInt(i + 1),
    assetId: LEDGER_ACCOUNTS[i % 4].startsWith("HOLDING") ? assetB.id : null,
    createdAt: new Date(now - DAY + (i < 60 ? 0 : i)),
  })) });
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (testState.directory) rmSync(testState.directory, { recursive: true, force: true });
});

beforeEach(() => {
  testState.cookie = "";
  requests.length = 0;
  // 页签的请求经 @/lib/http/client 的 api() 走全局 fetch:这里接到真实的路由处理函数上(会话来自上面的模拟 cookie)
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    return route.GET(new Request(`http://localhost${url}`));
  });
});

afterEach(() => {
  ledgerQueries.clear();
  vi.unstubAllGlobals();
});

describe("下一笔限价单再撤掉", () => {
  it("流水里出现冻结与解冻,各是现金与冻结现金两条腿,标的与订单引用都补得出来", async () => {
    const items = await loadAll(ids.alice, ALL);
    expect(requests).toEqual(["/api/transactions?limit=50"]);
    expect(items.map((row) => row.type)).toEqual(["RELEASE", "RELEASE", "RESERVE", "RESERVE", "ADJUSTMENT", "GRANT"]);
    const [releaseA, releaseB, reserveA, reserveB] = items;
    // 同一毫秒里两条腿的先后取决于 id,按账户取
    const leg = (rows: LedgerActivity[], account: string) => rows.find((row) => row.account === account)!;
    expect(leg([reserveA, reserveB], "CASH").delta).toBe(-68_500);
    expect(leg([reserveA, reserveB], "CASH_LOCKED").delta).toBe(68_500);
    expect(leg([releaseA, releaseB], "CASH_LOCKED").delta).toBe(-68_500);
    expect(leg([releaseA, releaseB], "CASH").delta).toBe(68_500);
    for (const row of [releaseA, releaseB, reserveA, reserveB]) {
      expect(row).toMatchObject({ symbol: SYMBOL_A, isScenario: false, refType: "ORDER", refId: ids.order });
    }

    // 界面上:两行冻结、两行解冻,金额带正负号与单位,引用是订单号尾段
    const html = renderToStaticMarkup(createElement(LedgerView, { symbol: SYMBOL_A, filters: DEFAULT_LEDGER_FILTERS, onFilters: () => {}, items, pager: { status: "done", onLoadMore: () => {} }, onOpenFill: () => {} }));
    const count = (needle: string) => html.split(needle).length - 1;
    expect(count(`>${T.ledger.types.RESERVE}</span>`)).toBe(2);
    expect(count(`>${T.ledger.types.RELEASE}</span>`)).toBe(2);
    expect(count(">+685.00<")).toBe(2);
    expect(count(">-685.00<")).toBe(2);
    expect(count(`>${T.ledger.refs.ORDER} ${refTail(ids.order)}</span>`)).toBe(4);
    expect(count(`>${SYMBOL_A}</span>`)).toBe(4);
    // 赠金行没有标的也没有引用
    expect(html).toContain(">+100,000.00<");
    expect([...html.matchAll(/data-ledger-id="([^"]+)"/g)].map((m) => m[1])).toEqual(items.map((row) => row.id));
  });
});

describe("筛选条的每一项服务端都认", () => {
  it("账户:只剩那个账户的行", async () => {
    const locked = await loadAll(ids.alice, request({ account: "CASH_LOCKED" }));
    expect(requests.at(-1)).toBe("/api/transactions?limit=50&account=CASH_LOCKED");
    expect(locked.map((row) => [row.account, row.type, row.delta])).toEqual([["CASH_LOCKED", "RELEASE", -68_500], ["CASH_LOCKED", "RESERVE", 68_500]]);
    expect(await loadAll(ids.alice, request({ account: "HOLDING" }))).toEqual([]);
  });

  it("类型:冻结 / 解冻 / 演示赠予 / 调整各自筛得出", async () => {
    expect((await loadAll(ids.alice, request({ type: "RELEASE" }))).map((row) => row.type)).toEqual(["RELEASE", "RELEASE"]);
    expect((await loadAll(ids.alice, request({ type: "RESERVE" }))).map((row) => row.type)).toEqual(["RESERVE", "RESERVE"]);
    expect((await loadAll(ids.alice, request({ type: "GRANT" }))).map((row) => row.delta)).toEqual([10_000_000]);
    expect((await loadAll(ids.alice, request({ type: "ADJUSTMENT" }))).map((row) => row.reason)).toEqual(["SOMETHING_NEW"]);
    expect(await loadAll(ids.alice, request({ type: "BUY" }))).toEqual([]);
  });

  it("标的:「当前标的」带出该标的订单的现金行;换到另一个标的就没有", async () => {
    const current = await loadAll(ids.alice, request({ scope: "current" }, SYMBOL_A));
    expect(requests.at(-1)).toBe(`/api/transactions?limit=50&symbol=${SYMBOL_A}`);
    expect(current.map((row) => row.type)).toEqual(["RELEASE", "RELEASE", "RESERVE", "RESERVE"]);
    expect(await loadAll(ids.alice, request({ scope: "current" }, SYMBOL_B))).toEqual([]);
  });

  it("时间段:今天 / 7 天只有刚才的四行,30 天多出 10 天前那一行,全部再多出 40 天前的赠金", async () => {
    const reasons = async (range: LedgerFilterState["range"]) => (await loadAll(ids.alice, request({ range }))).map((row) => row.reason);
    const recent = ["ORDER_UNLOCK", "ORDER_UNLOCK", "ORDER_LOCK", "ORDER_LOCK"];
    expect(await reasons("today")).toEqual(recent);
    expect(requests.at(-1)).toMatch(/^\/api\/transactions\?limit=50&from=\d+$/);
    expect(await reasons("7d")).toEqual(recent);
    expect(await reasons("30d")).toEqual([...recent, "SOMETHING_NEW"]);
    expect(await reasons("all")).toEqual([...recent, "SOMETHING_NEW", "GRANT"]);
  });

  it("四项一起:现金账户上、当前标的、今天的冻结,正好一行", async () => {
    const rows = await loadAll(ids.alice, request({ account: "CASH", type: "RESERVE", scope: "current", range: "today" }));
    expect(requests.at(-1)).toMatch(new RegExp(`^/api/transactions\\?limit=50&account=CASH&type=RESERVE&symbol=${SYMBOL_A}&from=\\d+$`));
    expect(rows.map((row) => [row.account, row.type, row.delta])).toEqual([["CASH", "RESERVE", -68_500]]);
  });

  it("下拉里的每一个取值(全部账户、全部类型、全部时间段)都不是 400", async () => {
    await createSession(ids.alice);
    const combos: LedgerRequest[] = [
      ...LEDGER_ACCOUNTS.map((account) => ({ ...ALL, account })),
      ...ACTIVITY_TYPES.map((type) => ({ ...ALL, type })),
      ...LEDGER_RANGES.map((range) => ({ ...ALL, range })),
    ];
    expect(combos).toHaveLength(LEDGER_ACCOUNTS.length + ACTIVITY_TYPES.length + LEDGER_RANGES.length);
    for (const combo of combos) {
      // ledgerPageUrl 就是查询对象发请求时用的那个拼法
      const res = await route.GET(new Request(`http://localhost${ledgerPageUrl(combo, null, Date.now())}`));
      expect(res.status, JSON.stringify(combo)).toBe(200);
    }
  });
});

describe("翻页与刷新", () => {
  it("130 行(其中 60 行在同一毫秒)三页翻完:不重不漏,顺序与库里一致", async () => {
    const items = await loadAll(ids.bob, ALL);
    expect(requests).toHaveLength(3);
    expect(requests[0]).toBe("/api/transactions?limit=50");
    expect(requests[1]).toMatch(/^\/api\/transactions\?limit=50&cursor=[\w-]+$/);
    expect(requests[2]).not.toBe(requests[1]);
    const expected = await prisma.ledgerEntry.findMany({ where: { userId: ids.bob }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    expect(items).toHaveLength(BOB_ROWS);
    expect(new Set(items.map((row) => row.id)).size).toBe(BOB_ROWS);
    expect(items.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    // 别人的行不在里面
    expect(items.every((row) => row.symbol === null || row.symbol === SYMBOL_B)).toBe(true);
  });

  it("账户有动静后 refresh:新的冻结行并到顶上,已加载的行还在、不重复", async () => {
    await createSession(ids.alice);
    const query = ledgerQueries.forUser(ids.alice, ALL)!;
    await query.loadMore();
    const before = query.items.map((row) => row.id);
    const placed = await matching.placeOrder({ userId: ids.alice, assetId: ids.assetB, side: "BUY", type: "LIMIT", price: 4_000, quantity: 2 });
    try {
      await query.refresh();
      const after = query.items;
      expect(after).toHaveLength(before.length + 2);
      expect(after.slice(0, 2).map((row) => [row.type, row.symbol, row.refId])).toEqual([["RESERVE", SYMBOL_B, placed.order.id], ["RESERVE", SYMBOL_B, placed.order.id]]);
      expect(after.slice(2).map((row) => row.id)).toEqual(before);
    } finally {
      await matching.cancelOrder(ids.alice, placed.order.id);
    }
  });

  it("未登录:请求 401,查询落在 error 态(界面显示 ErrorState,不是空表)", async () => {
    const query = ledgerQueries.forUser(ids.alice, ALL)!;
    await query.loadMore();
    expect(query.status).toBe("error");
    expect(query.items).toEqual([]);
  });
});
