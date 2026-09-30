// 对真实 SQLite(临时库 + migrate deploy)验证 stats24h(计划 §3.4、§9.1 第 38 条):
// 无成交 → change24hPct null;首笔 10000、lastPrice 10123 → 1.23(百分数);窗口外的成交不算;lastPrice 参数省查询。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ directory: "", path: "" }));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

vi.mock("../server/db", async () => {
  const { PrismaClient } = await import("../../generated/prisma");
  return { prisma: new PrismaClient({ datasourceUrl: `file:${database.path}` }) };
});

let prisma: (typeof import("../server/db"))["prisma"];
let stats24h: (typeof import("./stats24h"))["stats24h"];
let quietId: string;
let activeId: string;
let noLastId: string;

beforeAll(async () => {
  database.directory = mkdtempSync(join(tmpdir(), "carbadia-stats24h-"));
  database.path = join(database.directory, "stats.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${database.path}` },
    stdio: "pipe",
  });
  ({ prisma } = await import("../server/db"));
  ({ stats24h } = await import("./stats24h"));
  vi.spyOn(Date, "now").mockReturnValue(NOW);

  const buyer = await prisma.user.create({ data: { email: "buyer@stats.test", name: "Buyer", passwordHash: "test" } });
  const seller = await prisma.user.create({ data: { email: "seller@stats.test", name: "Seller", passwordHash: "test" } });
  const base = { standard: "VCS", projectType: "Forestry", vintage: 2021, country: "Example", registry: "Demo registry" };
  const quiet = await prisma.asset.create({ data: { ...base, symbol: "QUIET", name: "Quiet", lastPrice: 5_000 } });
  const active = await prisma.asset.create({ data: { ...base, symbol: "ACTIVE", name: "Active", lastPrice: 10_123 } });
  const noLast = await prisma.asset.create({ data: { ...base, symbol: "NOLAST", name: "No last price", lastPrice: null } });
  quietId = quiet.id;
  activeId = active.id;
  noLastId = noLast.id;

  const buy = await prisma.order.create({ data: { userId: buyer.id, assetId: active.id, side: "BUY", type: "LIMIT", price: 10_200, quantity: 100 } });
  const sell = await prisma.order.create({ data: { userId: seller.id, assetId: active.id, side: "SELL", type: "LIMIT", price: 9_900, quantity: 100 } });
  const trade = (assetId: string, minutesAgo: number, price: number, quantity: number) => ({
    assetId, buyOrderId: buy.id, sellOrderId: sell.id, buyerId: buyer.id, sellerId: seller.id,
    price, quantity, createdAt: new Date(NOW - minutesAgo * 60_000),
  });
  await prisma.trade.createMany({
    data: [
      trade(active.id, 25 * 60, 5_000, 50), // 窗口外(25 h 前):不得成为首笔、不计高低量
      trade(active.id, 23 * 60, 10_000, 4), // 窗口首笔
      trade(active.id, 12 * 60, 9_900, 6),
      trade(active.id, 6 * 60, 10_200, 3),
      trade(active.id, 1, 10_123, 2),
      trade(noLast.id, 30, 7_000, 1),
    ],
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma?.$disconnect();
  if (database.directory) rmSync(database.directory, { recursive: true, force: true });
});

describe("stats24h", () => {
  it("窗口内无成交 → change24hPct / high / low / firstPrice 都是 null, volume 0", async () => {
    await expect(stats24h(quietId)).resolves.toEqual({ change24hPct: null, high24h: null, low24h: null, volume24h: 0, firstPrice: null });
  });

  it("首笔 10000、lastPrice 10123 → 恰为 1.23(百分数), 窗口外的 5000 不算, 高低量按窗口聚合", async () => {
    const s = await stats24h(activeId);
    expect(s).toEqual({ change24hPct: 1.23, high24h: 10_200, low24h: 9_900, volume24h: 15, firstPrice: 10_000 });
    // 与 SpotTable.tsx / market page 现有渲染兼容:百分数直接 toFixed(2) + "%"
    expect(`${s.change24hPct!.toFixed(2)}%`).toBe("1.23%");
  });

  it("传入 lastPrice 时不再查 Asset: 用调用方的值算; 传 null → change 为 null, 其余统计不变", async () => {
    const spy = vi.spyOn(prisma.asset, "findUnique");
    const given = await stats24h(activeId, 11_000);
    expect(given.change24hPct).toBe(10);
    expect(spy).not.toHaveBeenCalled();
    const nulled = await stats24h(activeId, null);
    expect(nulled).toMatchObject({ change24hPct: null, high24h: 10_200, low24h: 9_900, volume24h: 15, firstPrice: 10_000 });
    spy.mockRestore();
  });

  it("Asset.lastPrice 为 null 时 change 为 null, 首笔与量照常", async () => {
    await expect(stats24h(noLastId)).resolves.toEqual({ change24hPct: null, high24h: 7_000, low24h: 7_000, volume24h: 1, firstPrice: 7_000 });
  });

  it("窗口随 Date.now 滚动: 首笔滑出窗口后按下一笔算", async () => {
    vi.mocked(Date.now).mockReturnValue(NOW + 90 * 60_000); // 首笔(23 h 前)已出窗, 9_900 成为首笔
    const s = await stats24h(activeId);
    expect(s.firstPrice).toBe(9_900);
    expect(s.volume24h).toBe(11);
    expect(s.change24hPct).toBeCloseTo(((10_123 - 9_900) * 100) / 9_900, 12);
    vi.mocked(Date.now).mockReturnValue(NOW);
  });
});
