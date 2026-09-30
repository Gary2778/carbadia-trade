// hub 统计的只读入口(计划 §3.4、§3.7):server/ws-hub.mjs 在 server.mjs 的 realm 里原地累加 globalThis.__carbadiaWsStats,
// /api/health(route handler realm)经这里读同一份对象。next start(START_MODE=next)下没有 hub,返回 null,health 据此报 startMode: "next"。
import type { WsStats } from "../../shared/bus";

export function readWsStats(): WsStats | null {
  return globalThis.__carbadiaWsStats ?? null;
}
