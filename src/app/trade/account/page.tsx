import type { Metadata } from "next";
import { connection } from "next/server";
import { AccountPage } from "@/components/account/AccountPage";
import { transportModeForServer } from "@/lib/market/transport";
import { listInstruments } from "@/lib/server/market-snapshots";
import { readWsStats } from "@/lib/server/ws-stats";

/** 经根布局模板 "%s · Carbadia Trade" 渲染为「Portfolio · Carbadia Trade」(SSR 恒英文,与 Nav 的「Portfolio」同名) */
export const metadata: Metadata = {
  title: "Portfolio",
  description: "Cash, holdings, allocation and OTC listings of your simulated Carbadia Trade account. Demo funds only.",
};

/**
 * 资产页(计划 §6.2.3 P2-10):server component,只准备与账户无关的首屏 props ——
 *   - listInstruments():全部标的 + ticker(进程缓存 2 s),名称、分组元数据与最新价在 WS 快照之前就有;
 *   - transportModeForServer:这台服务端接不了 /ws(START_MODE=next、本进程没有 hub、WS_DISABLED=1)时首帧就轮询(同终端页)。
 * 账户数据不在服务端取:会话判断与数据都在客户端,首屏是页头 + 骨架,私有数据不进可缓存的 HTML。
 * 页面没有 params / searchParams,所以显式 await connection():环境变量与 hub 状态按请求时读,不在构建期把标的清单与传输模式固化进静态 HTML
 *(node_modules/next/dist/docs 的 connection 指南)。
 */
export default async function TradeAccountPage() {
  await connection();
  const { instruments } = await listInstruments();
  return (
    <AccountPage
      initialInstruments={instruments}
      transportMode={transportModeForServer({ startMode: process.env.START_MODE, hub: readWsStats(), wsUrlOverride: process.env.NEXT_PUBLIC_WS_URL })}
    />
  );
}
