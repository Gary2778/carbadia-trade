"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { MarkNoticesReadResponse, NoticesResponse } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
import { api } from "@/lib/http/client";
import { requestNoticeRefresh } from "@/lib/market/account-bridge";
import { accountActions, noticeStamp, type NoticeStamp } from "@/lib/market/account-store";
import { NoticeList } from "./NoticeList";
import { PanelBoundary } from "./PanelBoundary";
import { useNoticeCopy } from "./notice-copy";
import { INITIAL_NOTICE_PAGES, reduceNoticePages, unreadIdsToMark } from "./notice-pages";

// 通知面板的内容(铃铛弹出层里的那一块,由 NoticeBell 在第一次打开时才 import())。
// 打开即取第一页(新 → 旧,每页 PAGE_SIZE 条);第一页与之后每一页「加载更多」画出来之后,只把屏幕上真有的未读条目标已读
// (POST { ids },不发 { all: true }:没看到的 —— 更旧的页、面板打开之后才写进库的 —— 不能替用户标掉),角标写回应答里的未读数。
// 写回带着发请求那一刻的戳(noticeStamp):期间换了人、或又来了一条 notice 事件(它带的未读数更新),这份应答就不写,并请求再读一次(writeBack)。
// 之后的页只在点「加载更多」时取。通知列表只走 REST:面板不订阅任何 WS 事件(实时的只有 Toast)。
const PAGE_SIZE = 20;
const NOTICES_URL = "/api/account/notices";
const READ_URL = "/api/account/notices/read";

/** 把读到的未读数写回角标(带戳);戳对不上被丢弃(更新的 notice 事件 / 换了人)时再读一次服务端,角标不会停在事件那一刻偏高的数上 */
function writeBack(count: number, stamp: NoticeStamp): void {
  if (!accountActions.setUnreadNotices(count, stamp)) requestNoticeRefresh("stale");
}

const pageUrl = (cursor: string | null): string => `${NOTICES_URL}?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;

/** 面板:内容外面套一层错误边界(渲染出错显示错误态与重试,不卸掉整页) */
export function NoticePanel({ onClose }: { onClose: () => void }) {
  return (
    <PanelBoundary>
      <NoticePanelContent onClose={onClose} />
    </PanelBoundary>
  );
}

function NoticePanelContent({ onClose }: { onClose: () => void }) {
  const t = useT("notices");
  const ui = useT("ui");
  const copy = useNoticeCopy();
  const [state, dispatch] = useReducer(reduceNoticePages, INITIAL_NOTICE_PAGES);
  const [attempt, setAttempt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** 已经发出去标已读的 id:同一条不重复发(失败的下次打开再标) */
  const markedRef = useRef(new Set<string>());
  /** 点「加载更多」时按钮拿着焦点 → 记下新一页第一条的下标;最后一页之后按钮消失,焦点落到这一条上而不是丢掉 */
  const refocusAtRef = useRef<number | null>(null);
  /** 「加载更多」在途请求的游标(同步的第二道闸:两次点击落在同一次渲染之前时,state 还是旧的) */
  const moreInFlightRef = useRef<string | null>(null);

  // 第一页(重试时 attempt 变,重新取)。卸载后到的应答丢弃。没有未读条目要标时,直接拿应答里的未读数校正角标
  useEffect(() => {
    let live = true;
    const stamp = noticeStamp();
    api<NoticesResponse>(pageUrl(null)).then(
      (page) => {
        if (!live) return;
        dispatch({ kind: "loaded", page });
        if (unreadIdsToMark(page.items, markedRef.current).length === 0) writeBack(page.unread, stamp);
      },
      () => live && dispatch({ kind: "failed" }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  // 屏幕上出现的未读条目标已读(第一页、每一页加载更多各一次)。不随面板卸载取消 —— 请求发出去了,角标照样要写回(戳挡着过期的)。
  // 失败什么都不做:这些条目在库里仍是未读,下次打开再标
  const items = state.phase === "ready" ? state.items : null;
  useEffect(() => {
    if (!items) return;
    const ids = unreadIdsToMark(items, markedRef.current);
    if (ids.length === 0) return;
    for (const id of ids) markedRef.current.add(id);
    const stamp = noticeStamp();
    api<MarkNoticesReadResponse>(READ_URL, { method: "POST", body: JSON.stringify({ ids }) }).then(
      (res) => writeBack(res.unread, stamp),
      () => {},
    );
  }, [items]);

  // 最后一页之后「加载更多」消失:按钮拿着焦点的话,焦点落到新一页的第一条上
  const itemCount = items?.length ?? 0;
  const lastPage = state.phase === "ready" && state.nextCursor === null;
  useEffect(() => {
    const at = refocusAtRef.current;
    if (at === null || itemCount <= at) return;
    refocusAtRef.current = null;
    if (lastPage) listRef.current?.querySelectorAll("a")[at]?.focus();
  }, [itemCount, lastPage]);

  // 「加载更多」:有下一页且没有请求在途才发(点击 / Enter 重复触发也不会发第二次);三个动作带着游标,迟到的结果由 reducer 丢掉
  const loadMore = (hadFocus: boolean) => {
    if (state.phase !== "ready" || state.nextCursor === null || state.more === "loading" || moreInFlightRef.current !== null) return;
    const cursor = state.nextCursor;
    moreInFlightRef.current = cursor;
    refocusAtRef.current = hadFocus ? itemCount : null;
    dispatch({ kind: "moreStart", cursor });
    api<NoticesResponse>(pageUrl(cursor)).then(
      (page) => {
        moreInFlightRef.current = null;
        dispatch({ kind: "moreLoaded", cursor, page });
      },
      () => {
        moreInFlightRef.current = null;
        dispatch({ kind: "moreFailed", cursor });
      },
    );
  };

  if (state.phase === "loading") return <Skeleton rows={3} />;
  if (state.phase === "error") {
    return (
      <ErrorState
        message={t.error}
        onRetry={() => {
          dispatch({ kind: "retry" });
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  if (state.items.length === 0) return <EmptyState title={copy.empty} hint={copy.emptyHint} />;
  return (
    <>
      <div ref={listRef}>
        <NoticeList items={state.items} onNavigate={onClose} />
      </div>
      {state.nextCursor === null ? null : state.more === "error" ? (
        <ErrorState message={t.error} onRetry={() => loadMore(false)} />
      ) : (
        // aria-disabled 而不是 disabled:取页期间按钮保持可聚焦(disabled 的按钮在有的浏览器里会丢焦点);重复点击由 loadMore 开头的检查挡掉,reducer 再按游标兜底
        <button
          type="button"
          onClick={(e) => loadMore(document.activeElement === e.currentTarget)}
          aria-disabled={state.more === "loading"}
          aria-busy={state.more === "loading"}
          className="mt-1 w-full rounded-control px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus aria-disabled:cursor-default aria-disabled:opacity-60 pointer-coarse:min-h-touch"
        >
          {state.more === "loading" ? ui.loading : ui.loadMore}
        </button>
      )}
    </>
  );
}
