import type { Metadata } from "next";
import { connection } from "next/server";
import { MarketsPage } from "@/components/markets/MarketsPage";
import { transportModeForServer } from "@/lib/market/transport";
import { listInstruments } from "@/lib/server/market-snapshots";
import { readWsStats } from "@/lib/server/ws-stats";

/** 经根布局模板 "%s · Carbadia Trade" 渲染为「Market overview · Carbadia Trade」(SSR 恒英文,说明里写明是模拟指数) */
export const metadata: Metadata = {
  title: "Market overview",
  description: "Simulated indices by registry and project type, plus the top gainers, losers and trading volume on Carbadia Trade. Demo data only.",
  alternates: { canonical: "/trade/markets" },
};

/**
 * 市场总览页(计划 §6.3.3 P3-05):server component,公开页面,首屏数据都来自服务端 ——
 *   - listInstruments():全部标的 + ticker(进程缓存 2 s):指数卡、三张榜与情景标的在 WS 快照之前就有内容;serverTime 是首屏指数的计算时刻;
 *   - transportModeForServer:这台服务端接不了 /ws 时首帧就轮询(同终端页与资产页)。
 * 页面没有 params / searchParams,所以显式 await connection():标的清单与传输模式按请求时读,不在构建期固化进静态 HTML
 *(node_modules/next/dist/docs 的 connection 指南)。
 */
export default async function MarketsRoute() {
  await connection();
  const { instruments, serverTime } = await listInstruments();
  return (
    <MarketsPage
      initialInstruments={instruments}
      serverTime={serverTime}
      transportMode={transportModeForServer({ startMode: process.env.START_MODE, hub: readWsStats(), wsUrlOverride: process.env.NEXT_PUBLIC_WS_URL })}
    />
  );
}
