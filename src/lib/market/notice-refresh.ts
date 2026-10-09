// 未读通知数的重读(P3-08 复审修复)。
// 实时的未读数只靠 WS 的 notice 事件;WS 断开期间写进库的通知不会补发,终端与资产页上 refreshOnNavigation 又不拉 /api/auth/me,
// 角标会一直停在断线前的数。所以在这些时刻主动读一次(GET /api/account/notices?limit=1 的 unread,现成的最轻接口,不加服务端代码):
//   - "subscribed":WS 模式下 account 订阅(含重连后重订阅)的快照到了(MarketProvider 的 reconcileAccountSnapshot,经 account-bridge);
//   - "visible":标签页从后台回到前台(watchNoticeRefresh,由 NoticeToaster 挂着,即只在终端与资产页);
//   - "poll":轮询模式下每一轮 pollAccount 都会请求,最多每 NOTICE_POLL_MIN_MS 真正读一次;
//   - "stale":面板的写回因为更新的 notice 事件(或换了人)被丢弃了 —— 角标还停在事件那一刻的数,再读一次校正。
// 读回来的数带着发请求时的戳(account-store 的 noticeStamp)写回,期间换了人 / 又来了 notice 事件就丢。
// 单飞,且带期限(同 hydrate 的 HYDRATE_TIMEOUT_MS):一个挂住的请求不能挡住之后所有的重读 —— 到点 abort、释放单飞,之后的照常发;
// 请求与期限用 Promise.race 收口,各只收尾一次,所以到点之后才回来的旧应答不会再写角标、也动不了后来的请求。
// 本文件不在每页的 floor 包里:只由 NoticeToaster 引入,引入时把 refreshUnreadNotices 登记给 account-bridge(requestNoticeRefresh 经它到这里)。
import type { NoticesResponse } from "@/shared";
import { api } from "@/lib/http/client";
import { accountActions, noticeStamp, useAccountStore, type FetchJson } from "./account-store";
import { registerNoticeRefresher, type NoticeRefreshReason } from "./account-bridge";

export const NOTICE_POLL_MIN_MS = 30_000;
/** 一次重读的期限:到点 abort 并放弃这次(单飞随之释放) */
export const NOTICE_REFRESH_TIMEOUT_MS = 10_000;
const NOTICES_ONE_URL = "/api/account/notices?limit=1";

/** 纯判定:这次重读要不要真的发。在途的不重复发;轮询的距上一次发出不足 NOTICE_POLL_MIN_MS 不发(时钟被往回调过时放行);其余原因随到随读 */
export function noticeRefreshDue(reason: NoticeRefreshReason, now: number, lastSentAt: number, inFlight: boolean): boolean {
  if (inFlight) return false;
  if (reason !== "poll") return true;
  const since = now - lastSentAt;
  return since < 0 || since >= NOTICE_POLL_MIN_MS;
}

let lastSentAt = Number.NEGATIVE_INFINITY;
let inFlight = false;
/** 在途时来了 "stale" 请求:这次结束后再读一次(在途的那次发出得比更新的 notice 事件早,它的应答会被戳挡掉) */
let rerun = false;

/** 读一次服务端的未读数并写回角标(带戳)。只对 ready 的用户;不需要读(在途、轮询未到点)返回 null,否则返回这次请求;失败 / 超时静默,下一个时刻再读 */
export function refreshUnreadNotices(reason: NoticeRefreshReason, fetchJson: FetchJson = api): Promise<void> | null {
  const { status, me } = useAccountStore.getState();
  if (status !== "ready" || !me) return null;
  if (inFlight && reason === "stale") rerun = true;
  const now = Date.now();
  if (!noticeRefreshDue(reason, now, lastSentAt, inFlight)) return null;
  lastSentAt = now;
  inFlight = true;
  const stamp = noticeStamp();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Notice refresh timed out"));
    }, NOTICE_REFRESH_TIMEOUT_MS);
  });
  const finish = (): void => {
    clearTimeout(timer);
    inFlight = false;
    if (rerun) {
      rerun = false;
      void refreshUnreadNotices("stale", fetchJson);
    }
  };
  return Promise.race([fetchJson<NoticesResponse>(NOTICES_ONE_URL, { signal: controller.signal }), deadline]).then(
    (page) => {
      // 先写回再收尾:写回会推进戳的序号(setUnreadNotices),排着的 "stale" 重读要在这之后取戳,否则它自己的应答会被挡掉;
      // 写回抛错也要收尾(finally),否则单飞永远不释放
      try {
        accountActions.setUnreadNotices(page.unread, stamp);
      } finally {
        finish();
      }
    },
    finish,
  );
}

/** 标签页回到前台就重读一次(返回解除函数);无 document(服务端)时空操作。document 可注入(测试用) */
export function watchNoticeRefresh(
  opts: { document?: Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState }; fetchJson?: FetchJson } = {},
): () => void {
  const doc = opts.document ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return () => {};
  const onVisibility = (): void => {
    if (doc.visibilityState === "visible") void refreshUnreadNotices("visible", opts.fetchJson);
  };
  doc.addEventListener("visibilitychange", onVisibility);
  return () => doc.removeEventListener("visibilitychange", onVisibility);
}

registerNoticeRefresher((reason) => void refreshUnreadNotices(reason));
