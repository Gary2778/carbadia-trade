// 一条实时通知 → Toast(NoticeToaster 在第一条通知到达时才 import 本文件,所以通知句子与它们的两种语言文案不进终端 / 资产页的首屏 chunk,
// 与懒加载的通知面板各自成 chunk)。弹不弹、弹哪种见 noticeToastType;文案按当前界面语言。
import type { PushToast } from "@/components/anim/Toast";
import { LANG_META, type Lang } from "@/i18n/config";
import type { Notice } from "@/shared";
import { isOwnOrder } from "@/lib/market/own-orders";
import { NOTICE_COPY } from "./notice-copy";
import { noticeLines, noticeSentence, noticeToastType } from "./notice-text";

/** Toast 是整句话,留这么久(比默认 3.2 s 长:一句话带标的、数量、价格,被拒时还带原因) */
export const NOTICE_TOAST_MS = 6000;

/** 弹出这条通知的 Toast(或按 noticeToastType 不弹);dedupeKey = 通知 id,同一条不会叠两个 */
export function toastNotice(notice: Notice, lang: Lang, push: PushToast, isOwn: (orderId: string) => boolean = isOwnOrder): void {
  const type = noticeToastType(notice, isOwn);
  if (!type) return;
  push(type, noticeSentence(noticeLines(NOTICE_COPY[lang], notice, LANG_META[lang].htmlLang)), { dedupeKey: notice.id, ttlMs: NOTICE_TOAST_MS });
}
