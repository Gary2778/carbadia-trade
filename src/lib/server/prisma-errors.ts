// Prisma 已知错误的 code 字段(P3-03 从 matching.ts 移来)。叶子模块,不导入任何东西:通知的写入口 notices.ts 要用它,
// 而 P3-04 会从 matching 调到的代码(提交后钩子)里调 notifyUser —— 从 matching 导入就成环。matching 的争用判定也用它。

/**
 * Prisma 已知错误的 code 字段;只认字段,不认类:instrumentation 与 route handler 是两个 bundle,各带一份 Prisma 运行时
 *(计划 §1.4、§3.2 三个 realm),生产下 globalThis.prisma 由 instrumentation 那份创建,请求路径里抛出的错误对本 bundle 的
 * Prisma.PrismaClientKnownRequestError 做 instanceof 恒为 false(2026-09-24 Prisma.sql 跨 bundle 事故的镜像)。
 * 判据:Error 实例(同一 V8 realm,Error 是同一个全局)+ 字符串 code(P 开头的 code 是 Prisma 的命名空间;
 * err.name 也是自有属性 "PrismaClientKnownRequestError",但不再多加一个可能写错的字符串条件)。不是 Error 或没有字符串 code → null。
 * matching.ts 的争用判定、retirement.ts 的 P2002 重放分支与 notices.ts 的去重都用它。
 */
export function prismaErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && typeof code === "string" ? code : null;
}
