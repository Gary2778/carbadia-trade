import { redirect } from "next/navigation";
import { DEFAULT_TERMINAL_SYMBOL } from "@/shared";

// /trade 没有自己的页面:进终端就落到默认标的(计划 §3.1)。服务端读不到 localStorage 的 lastSymbol,
// 所以这里固定跳默认标的;站内再换标的走 switchSymbol 的 replaceState,不经过这里。
export default function TradeIndexPage(): never {
  redirect(`/trade/${DEFAULT_TERMINAL_SYMBOL}`);
}
