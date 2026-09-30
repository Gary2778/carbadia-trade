// 相对路径而非 "@/" 别名: 运行时动态 import(如 real-sync 的延迟加载)与 tsx 脚本走 Node 原生解析, 不认 tsconfig 别名
import { availableParallelism } from "node:os";
import { PrismaClient } from "../../generated/prisma";

/**
 * SQLite 连接池上限(P1-25b)。Prisma 的默认池是 2 × CPU + 1,比查询引擎的工作线程(约每核一个)多;
 * 事务以 BEGIN IMMEDIATE 开始,拿不到写锁的连接在 SQLite 的忙等里同步阻塞一个工作线程。阻塞的写事务比工作线程多时,
 * 持锁的那个事务拿不到线程执行下一条语句,全部写入一起卡到约 5 s 的忙等超时(P1008):下单 503、撤单 500、机器人报价失败。
 * 复核实测(10 核):池 12 时 20 个并发下单 106/200 失败、每轮 5.7 s;池 9 时 0 失败;池 1 时 0 失败、每轮 28 ms。
 * 取 1:写事务在 Prisma 的池里排队(交互式事务 maxWait 2 s,超时 P2028 → BusyError → 503),读也串行,
 * 但单连接在任何核数的容器上都低于线程数。1 与 2 的对照数据见 P1-25b 报告。
 */
export const SQLITE_CONNECTION_LIMIT = 1;

/**
 * 给 SQLite 的 file: URL 追加 connection_limit;URL 里已经写了 connection_limit 就尊重它(排障 / 压测时可以在 DATABASE_URL 里临时覆盖),
 * 非 file: 或空值原样返回。
 */
export function withConnectionLimit(url: string | undefined, limit = SQLITE_CONNECTION_LIMIT): string | undefined {
  if (!url || !url.startsWith("file:")) return url;
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=${limit}`;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const datasourceUrl = withConnectionLimit(process.env.DATABASE_URL);
  const client = new PrismaClient({
    // 没有 DATABASE_URL(next build 加载路由模块时)就不传,交给 schema 的 env("DATABASE_URL"),与改动前一致
    ...(datasourceUrl ? { datasourceUrl } : {}),
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
  // 单例挂在 globalThis 上,整个进程只建一次(instrumentation 与路由两个 bundle 共用),所以这行只出现一次;
  // 生产的核数阈值无从得知时看这一行(复核建议 5)
  if (process.env.NODE_ENV !== "test") {
    console.log(`[db] sqlite connection_limit=${datasourceUrl?.match(/[?&]connection_limit=(\d+)/)?.[1] ?? "default"} availableParallelism=${availableParallelism()}`);
  }
  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
