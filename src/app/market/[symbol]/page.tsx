import { Suspense } from "react";
import { redirect } from "next/navigation";
import { marketTerminalRedirect } from "@/lib/market/navigation";
import { prisma } from "@/lib/server/db";
import { MarketContent } from "./MarketContent";

type MarketPageProps = {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** 情景标的(配额 / 指数情景)只在终端交易;查不到的 symbol 不算,旧页面照常报「找不到」 */
async function isScenario(symbol: string): Promise<boolean> {
  const asset = await prisma.asset.findUnique({ where: { symbol }, select: { isScenario: true } });
  return asset?.isScenario === true;
}

/**
 * 旧标的页(计划 §3.1 末段、§9.1 第 23 条):server component,只做一件事 —— 高级交易与情景标的的交易都在终端,
 * tab=trade 且(mode=advanced 或情景标的)的请求在渲染之前跳到 /trade/<symbol>?side=<side>(规则在 marketTerminalRedirect;
 * 整页加载是 HTTP 307,站内导航由路由器跟随),不再先把旧页面发下去、由客户端 router.replace(P2-08)。
 * 其余照旧交给客户端的 MarketContent:总览 + 简易交易,数据在客户端轮询。
 * 读 searchParams → 本页按请求动态渲染(本来就是:动态段 + 布局的 generateMetadata 查库);只有 tab=trade 且不是
 * mode=advanced 时才多一次按 symbol 唯一索引的查询。redirect() 不能放进 try / catch。
 */
export default async function MarketPage({ params, searchParams }: MarketPageProps) {
  const [{ symbol }, query] = await Promise.all([params, searchParams]);
  const terminal = await marketTerminalRedirect(symbol, query, isScenario);
  if (terminal) redirect(terminal);
  return (
    <Suspense
      fallback={
        <div className="p-8 text-center text-muted">Loading market…</div>
      }
    >
      <MarketContent key={symbol} symbol={symbol} />
    </Suspense>
  );
}
