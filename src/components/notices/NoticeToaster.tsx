"use client";

import { useEffect } from "react";
import { useToast } from "@/components/anim/Toast";
import { useLang } from "@/i18n/LangProvider";
import { subscribeNotices } from "@/lib/market/account-store";
import { watchNoticeRefresh } from "@/lib/market/notice-refresh";

// 实时通知的 Toast(无渲染输出):挂在有 account 推送的两处 —— 终端(TerminalShell)与资产页(AccountPage);其它页面没有 WS,通知只在铃铛里。
// 经 subscribeNotices 逐条收 notice 事件(store 里不放通知:同一批里的几条通知渲染只看得到最后一条,会丢 Toast)。
// 句子与两种语言的文案在 notice-toast.ts,第一条通知到达时才 import(不进这两页的首屏 chunk);import 失败(断网、部署换代后的旧标签页)只丢这条
// Toast —— 通知本身在铃铛的列表里。同一个 import 的回调按注册顺序执行,所以一批里的几条通知仍按到达顺序弹。
// 订阅只管之后到的事件:换页面(终端 ↔ 资产页)重新挂载不会把旧通知再弹一遍。
// 顺带挂两件同样只属于这两页的事:标签页回到前台就重读一次未读数(watchNoticeRefresh);引入 notice-refresh.ts 时它把重读登记给 account-bridge,
// WS 订阅快照到了 / 轮询的一轮经 requestNoticeRefresh 来到这里 —— 终端与资产页上没有别的东西校正断线期间错过的未读数。
export function NoticeToaster(): null {
  const push = useToast();
  const { lang } = useLang();

  useEffect(() => watchNoticeRefresh(), []);

  useEffect(
    () =>
      subscribeNotices((notice) => {
        import("./notice-toast").then(
          (m) => m.toastNotice(notice, lang, push),
          () => {},
        );
      }),
    [push, lang],
  );

  return null;
}
