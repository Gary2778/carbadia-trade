"use client";

import { useSyncExternalStore } from "react";
import { useT } from "@/i18n/LangProvider";
import { zoneLabel } from "@/lib/time-format";
import { TZ_PREFS, readTz, type TimeZonePref } from "@/providers/timeZoneState";
import { setTimeZone, useTimeZone } from "@/providers/useTimeZone";

const noopSubscribe = () => () => {};
/**
 * 所选时区此刻的短标签(UTC+8、UTC-5、UTC):local 的偏移只有浏览器知道,服务端与水合首帧是空串(不让 title 在水合时对不上),
 * 挂载后才有。只放进 title:选项文字是固定的三个。
 */
function useZoneLabel(tz: TimeZonePref): string {
  return useSyncExternalStore(
    noopSubscribe,
    () => zoneLabel(tz, Date.now()),
    () => "",
  );
}

/**
 * 时间显示的时区(计划 §6.3.2 C7):本地(浏览器)/ UTC+8 北京 / UTC,三选一的原生 <select>(键盘、读屏、触屏都现成)。
 * 偏好存 carbadia-tz(useTimeZone):tape、各页签、流水的「今天」边界、图表时间轴与十字线、资产页的基准时刻、通知、注销回执与旧的订单 / 流水 / 注销页都跟着换。
 * 终端页头(涨跌颜色切换旁)与资产页页头共用本组件。触控目标:< 64rem(手机、平板)min-h-touch,≥ 64rem 收回紧凑高度(计划 §4.7)。
 */
export function TimeZoneSelect() {
  const t = useT("terminal");
  const tz = useTimeZone();
  const now = useZoneLabel(tz);
  const names: Record<TimeZonePref, string> = { local: t.tz.local, "Asia/Shanghai": t.tz.beijing, UTC: t.tz.utc };
  return (
    <select
      aria-label={t.tz.label}
      title={now ? `${t.tz.label} · ${now}` : t.tz.label}
      value={tz}
      onChange={(e) => setTimeZone(readTz(e.target.value))}
      data-tz-select={tz}
      className="min-h-touch shrink-0 rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) px-1 py-0.5 text-t-xs leading-4 text-muted transition-colors duration-(--motion-fast) hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0"
    >
      {TZ_PREFS.map((pref) => (
        <option key={pref} value={pref}>
          {names[pref]}
        </option>
      ))}
    </select>
  );
}
