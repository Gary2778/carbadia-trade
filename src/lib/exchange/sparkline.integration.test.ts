import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma";
import { SPARK_POINTS, sampleTimes, sparkline } from "./sparkline";

// 对一批不同的 n 各建一个标的,成交每秒一笔、价格 = 1000 + 序号,和纯 JS 参照逐点比对。
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const SIZES = [1, 2, 3, 5, 47, 48, 49, 50, 97, 100, 101, 250, 1000];
const T0 = NOW - DAY + 1000; // 每个标的第一笔成交的时间

let directory = "";
let prisma: PrismaClient;
const assetIds = new Map<number, string>();
let staleOnlyId = "";
let burstId = "";

// 纯 JS 参照:n ≤ 48 全取;否则 48 个等距时刻,各取其前最后一笔(这里每秒一笔,所以是 floor)
function reference(n: number): number[] {
  if (n <= SPARK_POINTS) return Array.from({ length: n }, (_, i) => 1000 + i);
  return sampleTimes(T0, T0 + (n - 1) * 1000).map((t) => 1000 + Math.floor((t - T0) / 1000));
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "carbadia-sparkline-"));
  const path = join(directory, "spark.db");
  execFileSync("node_modules/.bin/prisma", ["migrate", "deploy"], {
    cwd: ROOT,
    env: { ...process.env, RUST_LOG: "info", DATABASE_URL: `file:${path}` },
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasourceUrl: `file:${path}` });
  const buyer = await prisma.user.create({ data: { email: "b@spark.test", name: "B", passwordHash: "t" } });
  const seller = await prisma.user.create({ data: { email: "s@spark.test", name: "S", passwordHash: "t" } });

  const makeAsset = async (symbol: string) => {
    const asset = await prisma.asset.create({
      data: { symbol, name: symbol, standard: "VCS", projectType: "Forestry", vintage: 2022, country: "Kenya", registry: "Verra" },
    });
    const buy = await prisma.order.create({ data: { userId: buyer.id, assetId: asset.id, side: "BUY", type: "LIMIT", price: 1, quantity: 1 } });
    const sell = await prisma.order.create({ data: { userId: seller.id, assetId: asset.id, side: "SELL", type: "LIMIT", price: 1, quantity: 1 } });
    return { id: asset.id, base: { assetId: asset.id, buyOrderId: buy.id, sellOrderId: sell.id, buyerId: buyer.id, sellerId: seller.id, quantity: 1 } };
  };

  for (const n of SIZES) {
    const { id, base } = await makeAsset(`N${n}`);
    assetIds.set(n, id);
    await prisma.trade.createMany({
      data: [
        // 窗口外一条旧成交,必须被忽略
        { ...base, price: 9_999, createdAt: new Date(NOW - DAY - 60_000) },
        ...Array.from({ length: n }, (_, i) => ({ ...base, price: 1000 + i, createdAt: new Date(T0 + i * 1000) })),
      ],
    });
  }
  const stale = await makeAsset("STALE");
  staleOnlyId = stale.id;
  await prisma.trade.create({ data: { ...stale.base, price: 5, createdAt: new Date(NOW - DAY - 1) } });

  // 不均匀分布:4 笔,时刻 0s / 10s / 100s / 200s,价 1..4
  const burst = await makeAsset("BURST");
  burstId = burst.id;
  await prisma.trade.createMany({
    data: [0, 10, 100, 200].map((s, i) => ({ ...burst.base, price: i + 1, createdAt: new Date(T0 + s * 1000) })),
  });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("sparkline", () => {
  it("每个 n 都与 JS 参照逐点一致:不超过 48 笔全取,超过则按时间等距取其前最后一笔,首尾必取", async () => {
    for (const n of SIZES) {
      const spark = await sparkline(prisma, assetIds.get(n)!, new Date(NOW - DAY));
      expect(spark, `n=${n}`).toEqual(reference(n));
      expect(spark[0]).toBe(1000);
      expect(spark.at(-1)).toBe(1000 + n - 1);
      expect(spark).toHaveLength(Math.min(n, SPARK_POINTS));
    }
  });

  it("窗口内没有成交的标的得到空序列", async () => {
    expect(await sparkline(prisma, staleOnlyId, new Date(NOW - DAY))).toEqual([]);
  });

  it("按时间而非按笔数抽样:时刻落在两笔之间时取前一笔", async () => {
    // 4 笔、只要 3 个点:时刻 0s / 100s / 200s → 价 1、3、4(10s 那笔被 100s 时刻的"前最后一笔"规则跳过)
    expect(await sparkline(prisma, burstId, new Date(NOW - DAY), 3)).toEqual([1, 3, 4]);
    // 点数不少于笔数时全取
    expect(await sparkline(prisma, burstId, new Date(NOW - DAY), 4)).toEqual([1, 2, 3, 4]);
  });
});
