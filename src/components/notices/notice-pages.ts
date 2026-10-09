// 通知面板的翻页状态(纯 reducer,node 环境可测;NoticePanel 只负责发请求与派发)。
// 首页没回来是 loading、失败是 error(可重试);回来之后是 ready:items 新 → 旧,nextCursor 非空才有「加载更多」,more 是「加载更多」那一页的请求状态。
// 「加载更多」的三个动作都带着它所属的游标(moreCursor = 在途 / 失败的那一次请求的游标):同一个游标只有一个在途请求(moreStart 在 loading 时被拒),
// 迟到的、重复的结果(游标对不上、或请求已经结束)一律丢弃 —— 否则同一页会被追加两次,出现重复的行与 key、游标被改回去。
import type { Notice, NoticesResponse } from "@/shared";

export type NoticePagesState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; items: Notice[]; nextCursor: string | null; more: "idle" | "loading" | "error"; moreCursor: string | null };

export type NoticePagesAction =
  | { kind: "retry" }
  | { kind: "failed" }
  | { kind: "loaded"; page: NoticesResponse }
  | { kind: "moreStart"; cursor: string }
  | { kind: "moreLoaded"; cursor: string; page: NoticesResponse }
  | { kind: "moreFailed"; cursor: string };

export const INITIAL_NOTICE_PAGES: NoticePagesState = { phase: "loading" };

export function reduceNoticePages(state: NoticePagesState, action: NoticePagesAction): NoticePagesState {
  switch (action.kind) {
    case "retry":
      return state.phase === "error" ? { phase: "loading" } : state;
    case "failed":
      return state.phase === "loading" ? { phase: "error" } : state;
    case "loaded":
      return state.phase === "loading" ? { phase: "ready", items: action.page.items, nextCursor: action.page.nextCursor, more: "idle", moreCursor: null } : state;
    case "moreStart":
      return state.phase === "ready" && state.more !== "loading" && state.nextCursor !== null && state.nextCursor === action.cursor
        ? { ...state, more: "loading", moreCursor: action.cursor }
        : state;
    case "moreLoaded":
      return state.phase === "ready" && state.more === "loading" && state.moreCursor === action.cursor
        ? { ...state, items: [...state.items, ...action.page.items], nextCursor: action.page.nextCursor, more: "idle", moreCursor: null }
        : state;
    case "moreFailed":
      return state.phase === "ready" && state.more === "loading" && state.moreCursor === action.cursor ? { ...state, more: "error" } : state;
  }
}

/** 服务端一次最多标这么多条(POST /api/account/notices/read 的 ids 上限) */
export const MARK_READ_MAX_IDS = 100;

/**
 * 这一屏上还没标已读的未读条目的 id(readAt 为空、不在 marked 里),新 → 旧,最多 MARK_READ_MAX_IDS 个。
 * 面板只标「屏幕上真的有的」:第一页与每一页「加载更多」画出来之后各发一次,不标没看到的(更旧的页、面板打开之后才写进库的)。
 */
export function unreadIdsToMark(items: readonly Notice[], marked: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.readAt !== null || marked.has(item.id)) continue;
    ids.push(item.id);
    if (ids.length === MARK_READ_MAX_IDS) break;
  }
  return ids;
}
