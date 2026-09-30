// 键集分页游标(计划 §3.4 路由表):/api/account/orders 与 /api/account/fills 按 createdAt desc, id desc 翻页,
// cursor = base64url(JSON{ createdAt, id }),指向上一页最后一行;下一页取 (createdAt, id) 严格小于游标的行。
// 只在服务端用(Buffer),不进 src/shared。

export type Cursor = { createdAt: number; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }), "utf8").toString("base64url");
}

/** Date 能表示的最大毫秒数(±8.64e15);更大的 createdAt 会变成 Invalid Date,Prisma 抛校验错,路由回 500(P1-25b) */
const MAX_DATE_MS = 8.64e15;

/** 非法输入(不是 base64url JSON、缺字段、类型不对、createdAt 不是 0..8.64e15 的整数)一律 null,路由映射为 400 */
export function decodeCursor(raw: string): Cursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > MAX_DATE_MS) return null;
  if (typeof id !== "string" || id.length === 0) return null;
  return { createdAt, id };
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export type PageQuery = { limit: number; cursor: Cursor | null };

/**
 * 读 ?cursor=&limit=:limit 缺省 50、非数字 → 错误、数字夹到 1..100;cursor 缺省 null、非法 → 错误。
 * 返回 { error } 时路由回 400。
 */
export function readPageQuery(params: URLSearchParams): PageQuery | { error: string } {
  let limit = DEFAULT_PAGE_LIMIT;
  const rawLimit = params.get("limit");
  if (rawLimit != null && rawLimit !== "") {
    const n = Number(rawLimit);
    if (!Number.isFinite(n)) return { error: "Invalid limit" };
    limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(n)));
  }
  let cursor: Cursor | null = null;
  const rawCursor = params.get("cursor");
  if (rawCursor != null && rawCursor !== "") {
    cursor = decodeCursor(rawCursor);
    if (!cursor) return { error: "Invalid cursor" };
  }
  return { limit, cursor };
}
