// 看门狗写入探针(设计 §3.1):对 Heartbeat 表唯一一行做 upsert,走 Prisma → SQLite WAL → 数据卷,与下单同一条路。
// 每 5 分钟才被调一次(看门狗带密钥时),不会撑大库;connection_limit=1 下它和其他写入一样排队。
import { prisma } from "./db";

export function touchHeartbeat(now: Date = new Date()) {
  return prisma.heartbeat.upsert({ where: { id: 1 }, update: { at: now }, create: { id: 1, at: now } });
}
