"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import type { Notice } from "@/shared";
import { htmlLang, useLang } from "@/i18n/LangProvider";
import { useTimeZone } from "@/providers/useTimeZone";
import { useNoticeCopy } from "./notice-copy";
import { formatNoticeTime, noticeHref, noticeLines } from "./notice-text";

/** 普通的左键点击(没有 Ctrl / Cmd / Shift / Alt、不是中键):Link 会在本标签页导航,面板跟着收起;带修饰键的是在新标签 / 窗口里打开,面板留着 */
export const isPlainLeftClick = (e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/** 句子里的标的代码不在连字符处断行(「VCS-」「FOR-2021」断开读起来像两个词);找不到代码就原样 */
export function Headline({ text, symbol }: { text: string; symbol: string }) {
  const at = text.indexOf(symbol);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="whitespace-nowrap">{symbol}</span>
      {text.slice(at + symbol.length)}
    </>
  );
}

/**
 * 通知列表(纯展示,SSR 测试直接渲染):一条通知 = 一个去 /trade/<标的> 的链接,两行 ——
 * 第一行讲发生了什么(标的、买卖、数量、价格),第二行是原因(被拒 / 被撤才有)与时间。
 * 未读的(readAt 为空)底色更深、前面带一个点,读屏另读「未读」:面板打开时拿到的是「还没读」的快照,标已读之后这一屏里也不变。
 */
export function NoticeList({ items, onNavigate }: { items: readonly Notice[]; onNavigate?: () => void }) {
  const copy = useNoticeCopy();
  const { lang } = useLang();
  const locale = htmlLang(lang);
  const tz = useTimeZone();
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((notice) => {
        const { headline, detail } = noticeLines(copy, notice, locale);
        const unread = notice.readAt === null;
        const time = formatNoticeTime(notice.createdAt, locale, tz);
        return (
          <li key={notice.id}>
            <Link
              href={noticeHref(notice)}
              prefetch={false}
              onClick={(e) => {
                if (isPlainLeftClick(e)) onNavigate?.();
              }}
              data-notice={notice.kind}
              data-unread={unread ? "" : undefined}
              className={`flex items-start gap-2.5 rounded-control px-3 py-2 text-start transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:shadow-focus ${unread ? "bg-surface-2" : ""}`}
            >
              <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-pill ${unread ? "bg-accent" : ""}`} />
              <span className="min-w-0">
                {unread ? <span className="sr-only">{copy.unread} </span> : null}
                <span className={`block text-sm leading-snug text-foreground ${unread ? "font-medium" : ""}`}>
                  <Headline text={headline} symbol={notice.symbol} />
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  {detail ? `${detail} · ` : null}
                  <span className="whitespace-nowrap">{time}</span>
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
