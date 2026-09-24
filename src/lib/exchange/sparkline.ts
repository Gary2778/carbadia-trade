import type { PrismaClient } from "../../generated/prisma";

/** 火花线最多取多少个点 */
export const SPARK_POINTS = 48;

/** 首尾成交时间之间 points 个等距时刻(毫秒整数),首尾必在 */
export function sampleTimes(t0: number, t1: number, points = SPARK_POINTS): number[] {
  if (points <= 1) return [t1];
  return Array.from({ length: points }, (_, k) => Math.round(t0 + (k * (t1 - t0)) / (points - 1)));
}

/**
 * 一个标的在 since 之后的火花线(成交价序列)。
 * - 不超过 SPARK_POINTS 笔:全取(新开的市场所有成交挤在几分钟里,不能分桶抹平)。
 * - 超过:在首尾成交时间之间取 SPARK_POINTS 个等距时刻,每个时刻取其前的最后一笔成交价。首尾两笔必取。
 * 全程只走 (assetId, createdAt) 索引定位:最多 49 行 + 一次 MAX + 48 次 seek,成本与一天成交多少无关。
 * 2026-09 前的做法是把窗口内全部成交读进 Node 再按下标均匀抽 48 个(机器人一天几万笔时每 2 秒读几万行);
 * 本地对照(每次计算):8 标的 × 30k 笔时旧法 250 ms、本法 2 ms;8 × 1k 笔(≈ 2026-09-25 的生产量)时 8 ms → 2 ms。
 * createdAt 用毫秒整数比较与返回:Prisma 在 SQLite 里就是这样存 DateTime 的;直接绑定 Date 会变成文本,和整数列比较永远为假。
 */
export async function sparkline(db: PrismaClient, assetId: string, since: Date, points = SPARK_POINTS): Promise<number[]> {
  const sinceMs = since.getTime();
  const head = await db.$queryRaw<{ price: number; t: number | bigint }[]>`
    SELECT "price", CAST("createdAt" AS INTEGER) AS t FROM "Trade"
    WHERE "assetId" = ${assetId} AND "createdAt" >= ${sinceMs}
    ORDER BY "createdAt" LIMIT ${points + 1}`;
  if (head.length <= points) return head.map((r) => r.price);
  const [{ t1 }] = await db.$queryRaw<{ t1: number | bigint }[]>`
    SELECT CAST(MAX("createdAt") AS INTEGER) AS t1 FROM "Trade" WHERE "assetId" = ${assetId} AND "createdAt" >= ${sinceMs}`;
  const times = sampleTimes(Number(head[0].t), Number(t1), points);
  // 48 个时刻用一个 JSON 参数经 json_each 展开成表,不用 Prisma.sql 嵌套片段:
  // 2026-09-24 线上事故——instrumentation(机器人)与路由是不同的打包产物,各带一份 Prisma 运行时,
  // 机器人先建了 PrismaClient 单例,路由里 Prisma.sql 生成的片段在那份运行时里 instanceof 失败,被当成普通参数,
  // SQL 变成 VALUES ?,? 而报 near "?": syntax error;本地 BOT_DISABLED=1 时单例由路由自己建,复现不出来。
  const rows = await db.$queryRaw<{ price: number }[]>`
    WITH ts(t) AS (SELECT CAST(value AS INTEGER) FROM json_each(${JSON.stringify(times)}))
    SELECT (
      SELECT "price" FROM "Trade"
      WHERE "assetId" = ${assetId} AND "createdAt" >= ${sinceMs} AND "createdAt" <= ts.t
      ORDER BY "createdAt" DESC LIMIT 1
    ) AS price FROM ts`;
  return rows.map((r) => r.price);
}
