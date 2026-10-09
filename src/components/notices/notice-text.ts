// 通知 → 文字与去向(纯函数,node 环境可测)。通知面板的列表行与实时 Toast 共用 noticeLines,措辞只在 src/i18n/messages/notices/ 里;
// 价格一律两位小数(面板在 Nav 里,手上没有标的的价格精度)、带 $ 与界面语言的千分位,数量整数吨。
// 本文件只由懒加载的面板(NoticeList)与实时 Toast(notice-toast.ts)引用,不在每页的 floor 包里;铃铛(NoticeBell)不引它与通知文案
// (notices.ssr.test.ts 守着目录的依赖,bundle-boundary.test.ts 与 scripts/perf/chunk-report.mjs 守着产物)。
import type { ToastType } from "@/components/anim/toast-queue";
import { formatTime } from "@/lib/time-format";
import type { TimeZonePref } from "@/providers/timeZoneState";
import type { Notice, TriggerReason } from "@/shared";
import { formatPrice, formatQty } from "@/shared/precision";
import type { NoticeCopy } from "./notice-copy";

/** headline = 发生了什么(哪个标的、买还是卖、多少吨、什么价);detail = 原因(只有被拒 / 被撤才有) */
export type NoticeLines = { headline: string; detail: string | null };

const money = (cents: number, locale: string): string => `$${formatPrice(cents, 2, locale)}`;

/** 被拒 / 被撤的原因(NO_FILL 另有按方向的说法,不经这里);USER(本人撤单)不产生通知,脏数据里出现时也当没有 */
function reasonText(copy: NoticeCopy, reason: TriggerReason | null): string | null {
  return reason === null || reason === "USER" || reason === "NO_FILL" ? null : copy.reason[reason];
}

export function noticeLines(copy: NoticeCopy, notice: Notice, locale: string): NoticeLines {
  switch (notice.kind) {
    case "fill":
      return {
        headline: copy.fill({ buy: notice.side === "BUY", qty: formatQty(notice.quantity, 1, locale), symbol: notice.symbol, price: money(notice.price, locale) }),
        detail: null,
      };
    case "trigger": {
      // 方向或数量缺失(只可能是手工改库)时「做什么」退回成只写标的,不编一个方向
      const act =
        notice.side !== null && notice.quantity !== null
          ? copy.act({ buy: notice.side === "BUY", qty: formatQty(notice.quantity, 1, locale), symbol: notice.symbol })
          : notice.symbol;
      const args = { act, price: money(notice.triggerPrice, locale) };
      // 市价单触发后一吨没成交:委托交上去了,所以不说「下单失败」;原因按方向说(没有方向就不编原因)
      if (notice.outcome === "REJECTED" && notice.reason === "NO_FILL") {
        return { headline: copy.trigger.NO_FILL(args), detail: notice.side === null ? null : notice.side === "BUY" ? copy.noFillReason.buy : copy.noFillReason.sell };
      }
      return { headline: copy.trigger[notice.outcome](args), detail: notice.outcome === "TRIGGERED" ? null : reasonText(copy, notice.reason) };
    }
    case "price_alert":
      return {
        headline: copy.alert({ symbol: notice.symbol, up: notice.direction === "ABOVE", price: money(notice.firedPrice, locale), alertPrice: money(notice.triggerPrice, locale) }),
        detail: null,
      };
    default:
      // 认不得的 kind(还开着的旧标签页遇上新版服务端写的通知):通用的一句,面板与 Toast 都不出错
      return { headline: copy.fallback, detail: null };
  }
}

/** Toast 的一句话:headline,有原因时后面接 " · 原因"(两种语言通用的分隔) */
export const noticeSentence = ({ headline, detail }: NoticeLines): string => (detail ? `${headline} · ${detail}` : headline);

/**
 * 这条实时通知弹不弹 Toast、弹哪种:null = 不弹。
 * 本页刚提交的单的 taker 成交(isOwnOrder)已经有下单 Toast,不重复;别的 taker 成交(条件单触发后下的市价单,「已触发 · 委托已提交」之后
 * 用户只听到这一条)照弹。被拒的条件单是 warning,其余 info。
 * 通知可能比下单的 POST 响应先到(WS 比 HTTP 快),那时这张单还没登记,用户会同时看到下单 Toast 和这条:一次,可以接受。
 */
export function noticeToastType(notice: Notice, isOwnOrder: (orderId: string) => boolean): Extract<ToastType, "info" | "warning"> | null {
  if (notice.kind === "fill" && notice.role === "TAKER" && isOwnOrder(notice.orderId)) return null;
  return notice.kind === "trigger" && notice.outcome === "REJECTED" ? "warning" : "info";
}

/** 点一条通知去哪:该标的的终端页 */
export const noticeHref = (notice: Notice): string => `/trade/${encodeURIComponent(notice.symbol)}`;

/**
 * unix ms → 「MM/DD HH:mm:ss」(按 locale 与时区偏好,24 小时制):与终端各 Tab 的时间列同一格式(lib/time-format.ts 的 tab 样式)。
 * 通知的时间只经这一个函数。
 */
export const formatNoticeTime = (ms: number, locale: string, tz: TimeZonePref): string => formatTime(ms, locale, tz, "tab");
