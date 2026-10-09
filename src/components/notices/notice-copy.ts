// 通知句子与面板文案的取词:两种语言的 notices 模块一起在这里引入(不进核心包,见 src/i18n/messages/notices/en.ts 的说明),
// 只有懒加载的面板(NoticeList / NoticePanel)与实时 Toast(notice-toast.ts)引用本文件;铃铛(NoticeBell,floor 包)不引。
import type { Lang } from "@/i18n/config";
import { useLang } from "@/i18n/LangProvider";
import en, { type NoticeCopy } from "@/i18n/messages/notices/en";
import zhCN from "@/i18n/messages/notices/zh-CN";

export type { NoticeCopy };

export const NOTICE_COPY: Record<Lang, NoticeCopy> = { en, "zh-CN": zhCN };

/** 当前界面语言的通知文案(同 useT 的取法:跟 LangProvider 的语言走) */
export function useNoticeCopy(): NoticeCopy {
  return NOTICE_COPY[useLang().lang];
}
