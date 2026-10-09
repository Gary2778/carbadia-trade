"use client";

import type { ConnectionState } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { connectionKind, useConnection, type ConnectionBadgeKind } from "@/lib/market/selectors";
import { transportModeFromEnv, type TransportMode } from "@/lib/market/transport";
import { formatTime } from "@/lib/time-format";
import type { TimeZonePref } from "@/providers/timeZoneState";
import { useTimeZone } from "@/providers/useTimeZone";

export type { ConnectionBadgeKind };

/** 构建期内联的传输模式(NEXT_PUBLIC_MARKET_TRANSPORT;未设 = ws) */
const BUILD_MODE: TransportMode = transportModeFromEnv(process.env.NEXT_PUBLIC_MARKET_TRANSPORT);

/**
 * connection 切片 → 徽标种类(规则本体是 selectors.ts 的 connectionKind,盘口 / 成交面板的离线判断用同一条)。
 * pending(传输层还没启动)时显示按构建期模式预期的标签作为占位,弱化样式并 aria-busy,不在首屏喊「离线」。
 */
export function connectionBadgeKind(conn: ConnectionState, mode: TransportMode = BUILD_MODE): { kind: ConnectionBadgeKind; pending: boolean } {
  return connectionKind(conn, mode);
}

/** 悬停说明里的「最后一条消息」时间:按界面语言格式化(计划 §4.8:数字与日期经 Intl 按当前 lang),不跟浏览器默认 locale;时区按偏好(lib/time-format.ts 的 clock 样式) */
export function lastMessageTime(lastMessageAt: number | null, lang: string, tz: TimeZonePref): string | null {
  if (lastMessageAt === null) return null;
  return formatTime(lastMessageAt, lang === "zh-CN" ? "zh-CN" : "en-US", tz, "clock");
}

// 语义色,不随涨跌轴翻转
const DOT: Record<ConnectionBadgeKind, string> = {
  live: "bg-success",
  polling: "bg-warning",
  reconnecting: "bg-info",
  offline: "bg-danger",
};

/**
 * 连接徽标(计划 §3.1、§4.8):terminal.connection.{live,polling,offline,reconnecting} + RTT。
 * mode:TerminalShell 转来的运行期传输提示("poll" = 回滚模式,只影响传输层还没启动时的占位标签)。
 * live 的文案是「已连接 · 模拟行情」,不写 Live / 实时(launch-checklist:不暗示真实活跃度);与 DemoBadge 相邻。
 * 降级为轮询时额外给 role="status" 的 degradedBody(读屏即时播报,宽屏上可见)。只随 connection 切片重渲染。
 * 布局稳定(P1-25f):服务端提示 "poll"(或构建期就是轮询)时占位即「轮询」,degradedBody 也在服务端 HTML 里 ——
 * 不等传输层报告才出现,宽屏头部不在水合后被撑高(回滚模式桌面 CLS 0.494 的来源);
 * 手机(< 48rem)上徽标在价格组里独占一行:首次连接时「重连中…」→「已连接」的换字与 20 s 后才出现的 RTT
 * 只改徽标自己的宽度,不再让下面的 24h 统计在两行之间跳。
 */
export function ConnectionBadge({ mode }: { mode?: TransportMode } = {}) {
  const t = useT("terminal");
  const { lang } = useLang();
  const conn = useConnection();
  const tz = useTimeZone();
  // mode "poll" = 服务端没有 /ws(transportModeForServer:START_MODE=next、本进程没有 hub、或 WS_DISABLED=1):占位也显示「轮询」,服务端 HTML 里就不出现「已连接」。
  // 占位(pending)时 kind 为 polling 只可能是轮询模式,所以 kind === "polling" 时降级说明照常输出(SSR 与水合首帧一致)
  const { kind, pending } = connectionBadgeKind(conn, mode === "poll" ? "poll" : BUILD_MODE);
  const label = t.connection[kind];
  const lastMessage = lastMessageTime(conn.lastMessageAt, lang, tz);
  return (
    <span className="inline-flex min-w-0 items-center gap-gap max-md:basis-full">
      <span
        data-connection={kind}
        data-pending={pending ? "" : undefined}
        aria-busy={pending || undefined}
        title={lastMessage ? `${t.a11y.connection(label)} · ${lastMessage}` : undefined}
        className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-chip border border-(--terminal-border) px-2 py-0.5 text-t-xs leading-4 ${
          pending ? "text-muted-2" : "text-muted"
        }`}
      >
        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-pill ${pending ? "bg-muted-2" : DOT[kind]}`} />
        <span className="sr-only">{t.a11y.connection(label)}</span>
        <span aria-hidden="true">{label}</span>
        {conn.rttMs !== null ? <span className="tnum text-muted-2">{t.connection.rtt(conn.rttMs)}</span> : null}
      </span>
      {/* 活动区域常驻(先在 DOM 里,内容变化才会被读屏播报);只在轮询时有内容(服务端已知轮询时 SSR 就有) */}
      <span role="status" className="sr-only text-t-xs text-warning xl:not-sr-only xl:truncate">
        {kind === "polling" ? t.connection.degradedBody : null}
      </span>
    </span>
  );
}
