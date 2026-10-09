// 站内通知的唯一写入口(计划 §6.3.2 C5 末句):notifyUser 落库(撞 dedupeKey 即跳过)→ 对在线用户发 notice 账户事件(带最新未读数)。
// 触发引擎(条件单触发 / 被拒 / OCO 撤销、价格提醒)与提交后钩子(order-hooks.ts 的成交通知)都经这里;机器人不该收通知,由调用方保证
//(引擎只处理条件单主人,机器人不能登录、建不了条件单;成交通知的钩子自己跳过机器人)。
// 读的一侧(P3-04,C3):listNotices(键集分页,新的在前,同 account-pages 的游标;顺手把读不回来的行标已读)、markNoticesRead、countUnread —— GET /api/account/notices、
// POST /api/account/notices/read 与 /api/auth/me 的 unreadNotices 用它们;这三个只读 / 改本人的行,出错照常抛,由路由映射。
// pruneOldNotices 由触发引擎的定时器每 6 小时调一次(删 30 天以前的,分批,写法同 bot.ts 的 cleanupHistory)。
// 写入一侧失败一律只记一行结构化日志、不抛:通知是附带的,不能让触发或下单因为它失败。
import type { MarkNoticesReadRequest, MarkNoticesReadResponse, NoticesResponse } from "@/shared/api-shapes";
import type { Notice, NoticePayload } from "@/shared/types";
import { toNotice } from "./account-mappers";
import { beforeCursor } from "./account-pages";
import { getBus } from "./bus";
import { encodeCursor, type Cursor } from "./cursor";
import { prisma } from "./db";
import { hasUser } from "./presence";
import { prismaErrorCode } from "./prisma-errors";

/** 通知保留期:30 天 */
export const NOTICE_RETENTION_MS = 30 * 86_400_000;
const PRUNE_BATCH = 5_000;
const PRUNE_MAX_BATCHES = 200; // 单轮上限 100 万行,防止无限循环

function logError(ev: string, err: unknown, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ src: "notices", ev, ...extra, error: err instanceof Error ? err.message : String(err) }));
}

/**
 * 给一个用户写一条通知。同一 (userId, dedupeKey) 已有 → 什么都不做,返回 null;写入失败也返回 null(记日志,不抛)。
 * 写入之后用户在线(hub 上有他的 account 订阅)才数未读、发 { t: "notice", notice, unread };不在线时 hub 本来就会丢掉这条事件,
 * 不为它多查一次库(与发布器的门控 ② 同一写法;行本身就是记录,上线后经 REST 取)。
 */
export async function notifyUser(userId: string, payload: NoticePayload, dedupeKey: string): Promise<Notice | null> {
  try {
    // 写之前按读取的同一套核对(toNotice)过一遍:读不回来的载荷(负数、缺字段)不落库,免得通知列表里留一行永远显示不出来的
    const json = JSON.stringify(payload);
    if (!toNotice({ id: "draft", userId, kind: payload.kind, payload: json, dedupeKey, createdAt: new Date(0), readAt: null })) {
      logError("bad_payload", new Error(`${payload.kind} payload does not round-trip`), { userId, dedupeKey });
      return null;
    }
    // 先查再写:撞唯一键的 create 会让 Prisma 记一行 error 日志,重放(恢复、重复事件)时不该刷日志
    const existing = await prisma.notification.findUnique({ where: { userId_dedupeKey: { userId, dedupeKey } }, select: { id: true } });
    if (existing) return null;
    const row = await prisma.notification.create({ data: { userId, kind: payload.kind, payload: json, dedupeKey } });
    const notice = toNotice(row);
    if (!notice) return null; // 上面核对过,不会发生
    if (hasUser(userId)) {
      const unread = await countUnread(userId);
      getBus().publish({ kind: "account", userId, event: { t: "notice", notice, unread } });
    }
    return notice;
  } catch (err) {
    if (prismaErrorCode(err) === "P2002") return null; // 查与写之间另一次写入抢先:同一条已经在了
    logError("notify_failed", err, { userId, dedupeKey });
    return null;
  }
}

/** 本人未读条数:一次 count,走以 userId 开头的索引按用户定位,再筛 readAt 为空(通知只留 30 天,单个用户的行数有限) */
export function countUnread(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

/**
 * 本人通知的一页,新的在前(createdAt desc, id desc),游标同 /api/account/orders(cursor 由 readPageQuery 解出)。
 * 多取一行只为判断有没有下一页;nextCursor 指向本页最后一「行」—— payload 读不回来的行(toNotice 返回 null)不进 items,但游标照样越过它们。
 * 这种行未读的顺手标成已读(尽力而为,失败只记日志):面板按 id 标已读,永远够不着它,不标的话它会一直算在未读数里。
 * unread = 本人全部未读(不只本页);与本页在同一个批量事务里读,看到同一个提交点,再减去这次顺手标掉的条数。
 */
export async function listNotices(userId: string, page: { cursor: Cursor | null; limit: number }): Promise<NoticesResponse> {
  const [rows, unread] = await prisma.$transaction([
    prisma.notification.findMany({
      where: { userId, ...(page.cursor ? beforeCursor(page.cursor) : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: page.limit + 1,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  const pageRows = rows.slice(0, page.limit);
  const last = rows.length > page.limit ? pageRows[pageRows.length - 1] : null;
  const items: Notice[] = [];
  const unreadable: string[] = [];
  for (const row of pageRows) {
    const notice = toNotice(row);
    if (notice) items.push(notice);
    else if (row.readAt === null) unreadable.push(row.id);
  }
  let marked = 0;
  if (unreadable.length > 0) {
    try {
      ({ count: marked } = await prisma.notification.updateMany({ where: { userId, id: { in: unreadable }, readAt: null }, data: { readAt: new Date() } }));
    } catch (err) {
      logError("mark_unreadable_failed", err, { userId, rows: unreadable.length });
    }
  }
  return {
    items,
    nextCursor: last ? encodeCursor({ createdAt: last.createdAt.getTime(), id: last.id }) : null,
    unread: Math.max(0, unread - marked),
  };
}

/**
 * 把本人的通知标成已读:{ ids } 只标这几条,{ all: true } 标全部;只改 readAt 为空的行(已读的保持原来的读取时刻),
 * 别人的 id、不存在的 id 都按「没有这一行」忽略。返回标完之后的未读数。
 */
export async function markNoticesRead(userId: string, target: MarkNoticesReadRequest): Promise<MarkNoticesReadResponse> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null, ...("ids" in target ? { id: { in: target.ids } } : {}) },
    data: { readAt: new Date() },
  });
  return { unread: await countUnread(userId) };
}

/**
 * 删掉 createdAt 早于 olderThanMs 之前的通知(默认 30 天),返回删掉的条数。分小批、批间让出写锁(与 cleanupHistory 同理:
 * 一条大 DELETE 会长时间持锁,期间下单全部超时)。失败只记日志,返回已经删掉的条数。
 */
export async function pruneOldNotices(olderThanMs = NOTICE_RETENTION_MS): Promise<number> {
  const cutoffMs = Date.now() - olderThanMs;
  let deleted = 0;
  try {
    for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
      const n = await prisma.$executeRaw`
        DELETE FROM "Notification" WHERE rowid IN (
          SELECT rowid FROM "Notification" WHERE "createdAt" < ${cutoffMs} LIMIT ${PRUNE_BATCH}
        )`;
      deleted += n;
      if (n < PRUNE_BATCH) break;
      await new Promise((r) => setTimeout(r, 300)); // 让出写锁, 用户下单可插队
    }
    if (deleted > 0) console.log(JSON.stringify({ src: "notices", ev: "prune", deleted }));
  } catch (err) {
    logError("prune_failed", err, { deleted });
  }
  return deleted;
}
