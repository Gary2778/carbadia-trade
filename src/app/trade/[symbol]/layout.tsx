import type { Metadata } from "next";
import { symbolFromPath, terminalMetaTitle } from "@/lib/market/navigation";

/** 路径段不是标的代码的形状时的通用标题(经根模板渲染为 `Terminal · Carbadia Trade`),不带插值描述 */
const GENERIC_METADATA: Metadata = { title: "Terminal" };

// 终端路由的布局(计划 §3.1、§4.8):只按 symbol 生成标题与描述(terminal.css 与终端文案由上一级的
// src/app/trade/layout.tsx 引入,/trade 下所有页面共用)。标题 `${symbol} · Terminal` 经根布局模板 "%s · Carbadia Trade" 渲染为
// `<symbol> · Terminal · Carbadia Trade`,与 switchSymbol 手写的 document.title(terminalTitle)一致;
// 描述镜像 /market/[symbol] 的写法,新路由不丢「模拟」说明。SSR 恒英文。不查库:symbol 是否存在由 page.tsx 的 notFound() 决定。
// 但先校验形状(与 symbolFromPath 同一条规则:大写字母数字段以连字符相连):Next 会解码路径参数,
// /trade/Send%20funds%20to%20example.com 这类任意文本不能被插进本站 404 页的 <title> 与描述里(内容仿冒)。
export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  if (symbolFromPath(`/trade/${symbol}`) !== symbol) return GENERIC_METADATA;
  return {
    title: terminalMetaTitle(symbol),
    description: `Simulated order book, candles and orders for ${symbol} on Carbadia Trade.`,
    alternates: { canonical: `/trade/${symbol}` },
  };
}

export default function TerminalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
