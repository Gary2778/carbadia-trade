import { notFound } from "next/navigation";
import { TerminalShell } from "@/components/terminal/TerminalShell";
import { readFiltersFromUrl, readSideFromUrl } from "@/lib/market/navigation";
import { transportModeForServer } from "@/lib/market/transport";
import { listInstruments } from "@/lib/server/market-snapshots";
import { readWsStats } from "@/lib/server/ws-stats";

type TradePageProps = {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * 终端页(计划 §3.1、§3.2「SSR 首屏」、§6.1 SSR 首屏规则):server component,只服务深链与硬刷新 ——
 * 站内换标的走 switchSymbol 的 replaceState,不再请求这里(不走 RSC)。
 *   - listInstruments():全部标的 + ticker,进程缓存 2 s(globalThis.__carbadiaInstrumentsCache,跨 bundle 同一份);
 *   - symbol 不在列表 → notFound();
 *   - searchParams:?side= → initialSide,筛选键经 readFiltersFromUrl(与客户端同一纯函数)→ initialFilters;
 *   - 头部与左栏的首屏全部来自 initialInstruments props,store 只在挂载后由 MarketProvider 灌入;
 *   - 这台服务端接不了 /ws 时 transportMode="poll",终端首帧就轮询、不试 /ws(否则要等 3 次连接超时 ≈ 31–35 s 才降级,P1-23 发现 1):
 *     START_MODE(运行期变量,见 docker-entrypoint.sh)为 "next"(回滚),或本进程没有开着的 hub(readWsStats() 为 null 或
 *     enabled: false —— npm run start:plain / dev:plain、WS_DISABLED=1),规则见 transportModeForServer。读在 await searchParams 之后 ——
 *     本页因 searchParams 是动态渲染,环境变量与 hub 状态按请求时读,不在构建期固化(node_modules/next/dist/docs 的 environment-variables 指南)。
 */
export default async function TradePage({ params, searchParams }: TradePageProps) {
  const [{ symbol }, query, { instruments }] = await Promise.all([params, searchParams, listInstruments()]);
  if (!instruments.some((item) => item.instrument.symbol === symbol)) notFound();
  return (
    <TerminalShell
      symbol={symbol}
      initialInstruments={instruments}
      initialSide={readSideFromUrl(query)}
      initialFilters={readFiltersFromUrl(query)}
      transportMode={transportModeForServer({ startMode: process.env.START_MODE, hub: readWsStats(), wsUrlOverride: process.env.NEXT_PUBLIC_WS_URL })}
    />
  );
}
