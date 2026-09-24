// 相对路径而非 "@/" 别名: 运行时动态 import(如 real-sync 的延迟加载)与 tsx 脚本走 Node 原生解析, 不认 tsconfig 别名
import { PrismaClient } from "../../generated/prisma";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

globalForPrisma.prisma = prisma;
