// 看门狗探针辅助(设计 docs/superpowers/specs/2026-10-09-watchdog-alerts-design.md §3.1,主仓同名文件是同一份逻辑)。
// 健康路由只在请求头 x-watchdog-secret 与 WATCHDOG_SECRET 定长相等时做深探:写一次 Heartbeat 表、读数据卷用量。
// 这里不碰 Prisma:写什么由调用方以函数传入,方便单测。
import { timingSafeEqual } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import type { DiskUsage } from "@/shared/api-shapes";

export const WATCHDOG_HEADER = "x-watchdog-secret";

export type DeepProbe =
  | { write: true; disk: DiskUsage | null }
  | { write: false; writeError: string; disk: DiskUsage | null };

/** 请求头与密钥定长比较;密钥未设、不带头、长度不等都不算(fail closed,不泄露长度以外的信息) */
export function isWatchdogRequest(req: Request, secret: string | undefined = process.env.WATCHDOG_SECRET): boolean {
  const given = req.headers.get(WATCHDOG_HEADER);
  if (!secret || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** DATABASE_URL 的 file: 绝对路径 → 所在目录(生产是 /data);相对路径(本地 dev)或缺失 → 进程工作目录,同一文件系统即可 */
export function databaseDirectory(url: string | undefined = process.env.DATABASE_URL): string {
  const raw = url?.startsWith("file:") ? url.slice("file:".length).split("?")[0] : "";
  return raw.startsWith("/") ? dirname(raw) : process.cwd();
}

/** 近似 df:已用 = blocks - bfree,可用 = bavail,百分比 = 已用 / (已用 + 可用)(df 的 Use% 向上取整,这里四舍五入,阈值可能晚一个百分点) */
export async function readDiskUsage(dir: string = databaseDirectory()): Promise<DiskUsage | null> {
  try {
    const s = await statfs(dir);
    const MB = 1024 * 1024;
    const used = (s.blocks - s.bfree) * s.bsize;
    const avail = s.bavail * s.bsize;
    const denominator = used + avail;
    return {
      totalMb: Math.round((s.blocks * s.bsize) / MB),
      freeMb: Math.round(avail / MB),
      usedPct: denominator === 0 ? 0 : Math.round((used / denominator) * 100),
    };
  } catch {
    return null;
  }
}

/** Prisma 的错误消息以「Invalid `prisma.x.y()` invocation:」开头,真正原因在 200 字符之后;去掉这个头、空白压成单个空格,再取前 300 字符 */
export function compactErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^\s*Invalid `[^`]*` invocation:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** 跑一次写入,再读卷用量;写入失败只记压缩后的消息(compactErrorMessage),HTTP 状态由路由决定(设计里仍是 200) */
export async function deepProbe(write: () => Promise<unknown>): Promise<DeepProbe> {
  let writeError: string | undefined;
  try {
    await write();
  } catch (e) {
    writeError = compactErrorMessage(e);
  }
  const disk = await readDiskUsage();
  return writeError === undefined ? { write: true, disk } : { write: false, writeError, disk };
}
