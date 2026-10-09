"use client";

import Link from "next/link";
import { useT } from "@/i18n/LangProvider";
import type { SubmitFailure } from "./trigger-ticket";
import { showTriggersTab } from "./useConditionalTicket";

// 止盈止损与价格提醒两个对话框共用的小件(两个对话框各自懒加载,共用的部分放这里,谁先打开谁带上)。
// 对话框不在终端网格里,样式只用全站 token(终端里由 data-glass="off" 映射成不透明面板色),同 RetireDialog。

export const DIALOG_INPUT =
  "tnum min-h-touch w-full rounded-control border border-border bg-surface-2 px-2 text-t-base text-foreground placeholder:text-muted-2 focus-visible:outline-none focus-visible:shadow-focus aria-invalid:border-danger lg:min-h-0 lg:py-1.5";
export const DIALOG_BUTTON =
  "inline-flex min-h-touch items-center justify-center rounded-control px-3 text-t-sm focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 lg:py-2";
export const DIALOG_PRIMARY = `${DIALOG_BUTTON} bg-accent-strong font-semibold text-background`;
export const DIALOG_SECONDARY = `${DIALOG_BUTTON} border border-border font-medium text-foreground`;

/**
 * 提交失败的说明:role=alert;401 另给登录入口。结果未确认时的「重试」由调用方的提交按钮承担(同一个幂等键),
 * 另给「打开条件单页签」:切过去、关掉对话框(onCheckTab;模态对话框开着时焦点进不了后面的页签),再把页签滚进视野并聚焦
 */
export function FailureNotice({ failure, onCheckTab }: { failure: SubmitFailure; onCheckTab: () => void }) {
  const t = useT("terminal");
  return (
    <div role="alert" data-trigger-failure={failure.uncertain ? "uncertain" : "rejected"} className="flex flex-col gap-1 rounded-control border border-danger/25 bg-danger-soft p-panel text-t-sm text-danger">
      <p>{failure.message}</p>
      {failure.uncertain ? (
        <button
          type="button"
          data-check-tab=""
          onClick={() => {
            showTriggersTab();
            onCheckTab();
          }}
          className="self-start rounded-chip font-medium underline focus-visible:outline-none focus-visible:shadow-focus"
        >
          {t.triggers.checkTab}
        </button>
      ) : null}
      {failure.loginHref ? (
        <Link href={failure.loginHref} className="self-start rounded-chip font-medium underline focus-visible:outline-none focus-visible:shadow-focus">
          {t.order.login}
        </Link>
      ) : null}
    </div>
  );
}
