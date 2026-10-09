// 连接状态的种类与「行情源已断」的判断(纯函数,零运行时依赖):从 selectors.ts 挪出来的(P3-05),selectors.ts 原样再导出,既有调用方不用改。
// 单独成模块是为了市场总览页 /trade/markets 不必为一个布尔值引入 selectors.ts —— 它会连带拖进盘口视图、下单草稿与标的筛选(book-view / order-draft /
// instrument-filter),总览页的自有 chunk 因此多约 7 KB(perf:chunks 的预算 ≤ 30 KB)。
import type { ConnectionState } from "@/shared";
import type { MarketState } from "./store";
import type { TransportMode } from "./transport";

export type ConnectionBadgeKind = "live" | "polling" | "offline" | "reconnecting";

/**
 * 纯函数:connection 切片 → 连接状态的种类(连接徽标的显示与面板的「行情源已断」同一条规则,都从这里来)。
 * pending = 传输层还没启动(SSR、水合首帧、MarketProvider 的 effect 之前:store 仍是创建时的 { transport: "none",
 * state: "offline" },且从未收过消息):这时按构建期模式 mode 给预期的种类(ws → live,poll → polling)作占位,
 * 不在首屏喊「离线」;一旦传输层报了状态就照实给。ConnectionBadge 以构建期内联的模式调用它。
 */
export function connectionKind(conn: ConnectionState, mode: TransportMode): { kind: ConnectionBadgeKind; pending: boolean } {
  if (conn.transport === "poll") return { kind: "polling", pending: false };
  if (conn.state === "open") return { kind: "live", pending: false };
  if (conn.state === "connecting" || conn.state === "degraded") return { kind: "reconnecting", pending: false };
  if (conn.transport === "none" && conn.lastMessageAt === null && conn.rttMs === null) {
    return { kind: mode === "poll" ? "polling" : "live", pending: true };
  }
  return { kind: "offline", pending: false };
}

/**
 * store selector(返回布尔原始值,只在它翻转时重渲染):行情源真的断了 —— 与 ConnectionBadge 显示「离线」同一口径。
 * 传输层还没启动的初始 store(SSR、水合首帧,徽标显示弱化的占位)不算:那时面板照常是骨架,不在首屏报错。
 * 盘口与成交面板在「还没有任何数据」时据此把骨架换成 ErrorState(§4.5 三态);已有数据时照常显示最后的数据。
 * 构建期模式只影响占位(pending)时的标签,不影响「离线」这个判断,所以这里传哪个模式都一样。
 */
export const selectFeedOffline = (s: MarketState): boolean => {
  const { kind, pending } = connectionKind(s.connection, "ws");
  return kind === "offline" && !pending;
};
