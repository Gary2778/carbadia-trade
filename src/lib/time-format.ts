// 显示时间的唯一入口(计划 §6.3.2 C7):全站没有第二处为显示而建 Intl.DateTimeFormat。
// 输入 = 时刻(unix ms 或 Date)、界面 locale、时区偏好、一个具名样式;Intl 实例按 (locale, 时区, 样式) 缓存。
// 时区:"local" = 浏览器时区(不给 Intl 传 timeZone,与引入本模块之前逐字节相同);"Asia/Shanghai" / "UTC" 是偏好的另两个值;
// 函数一般接受任何 IANA 区名(测试用带夏令时的区验证),界面只会传 TimeZonePref。
// 纯模块:不读存储、不碰 React。偏好的读写与订阅在 src/providers/useTimeZone.ts;本模块不得被根布局可达的代码引入
//(Nav 在每页都带的 floor 包里,lib/format.ts 因此不能引这里)。
import type { TimeZonePref } from "@/providers/timeZoneState";

/** "local" 或 IANA 区名;TimeZonePref 的三个值都是合法的 */
export type ZoneId = TimeZonePref | (string & {});

// 样式表。前五个是各处原先各自写的选项,逐项照搬(local 下输出不变);
//   tape      HH:mm:ss(成交 tape,24 小时制)
//   tab       MM/DD HH:mm:ss(委托 / 成交 / 条件单 / 流水页签、成交详情、通知)
//   short     MM/DD HH:mm(资产页 24 小时变化的基准时刻)
//   clock     只有时分秒(连接徽标;等于 toLocaleTimeString(locale, { hour12: false }))
//   datetime  年月日时分秒(旧 /orders、/transactions;等于 toLocaleString(locale, { hour12: false }))
//   full      「Oct 1, 2026, 6:00 PM」式的日期 + 时间(注销回执、旧 /retirement)
// axis* 与 crosshair* 给图表(chart-adapter.ts):刻度按 UTC 格式化「平移后的墙上时间」,十字线与读数按所选时区。
const OPTIONS = {
  tape: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  tab: { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  short: { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false },
  clock: { hour: "numeric", minute: "numeric", second: "numeric", hour12: false },
  datetime: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hour12: false },
  full: { dateStyle: "medium", timeStyle: "short" },
  axisYear: { year: "numeric" },
  axisMonth: { month: "short" },
  axisDay: { day: "numeric" },
  axisTime: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  axisSeconds: { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
  crosshair: { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  crosshairDate: { year: "numeric", month: "2-digit", day: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

export type TimeStyle = keyof typeof OPTIONS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(locale: string, zone: ZoneId, style: TimeStyle): Intl.DateTimeFormat {
  const key = `${locale}|${zone}|${style}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    const options: Intl.DateTimeFormatOptions = zone === "local" ? OPTIONS[style] : { ...OPTIONS[style], timeZone: zone };
    try {
      fmt = new Intl.DateTimeFormat(locale, options);
    } catch {
      fmt = new Intl.DateTimeFormat("en-US", options); // locale 不被识别(RangeError)时退回 en-US
    }
    formatters.set(key, fmt);
  }
  return fmt;
}

/** Date 能表示的最大毫秒数;超出或不是有限数的时刻 Intl 会抛 RangeError */
const MAX_MS = 8.64e15;

/** 时刻 → 字符串;时刻无效(NaN、无穷、超出 Date 范围)显示「—」 */
export function formatTime(instant: number | Date, locale: string, zone: ZoneId, style: TimeStyle): string {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_MS ? formatterFor(locale, zone, style).format(ms) : "—";
}

// ------------------------------------------------------------------ 偏移与日界

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

/** 某个 IANA 区在 atMs 这一刻的墙上日期与时间(月从 1 起) */
function wallParts(zone: string, atMs: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let fmt = wallFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    wallFormatters.set(zone, fmt);
  }
  const out = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of fmt.formatToParts(atMs)) {
    if (part.type === "year" || part.type === "month" || part.type === "day" || part.type === "hour" || part.type === "minute" || part.type === "second") out[part.type] = Number(part.value);
  }
  return out;
}

/** 所选时区在 atMs 这一刻相对 UTC 的偏移(秒,东正西负);local = 浏览器在这一刻的偏移(含夏令时) */
export function zoneOffsetSeconds(zone: ZoneId, atMs: number): number {
  if (zone === "UTC") return 0;
  if (zone === "local") {
    const minutes = new Date(atMs).getTimezoneOffset();
    return minutes === 0 ? 0 : Math.round(-minutes * 60);
  }
  const p = wallParts(zone, atMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return Math.round((wallAsUtc - Math.floor(atMs / 1000) * 1000) / 1000);
}

const DAY_MS = 86_400_000;

/** atMs 所在日历日的 0 点:local 用浏览器自己的日历(setHours),夏令时切换日也对 */
function midnightOf(zone: ZoneId, atMs: number): number {
  if (zone === "UTC") return Math.floor(atMs / DAY_MS) * DAY_MS;
  if (zone === "local") {
    const d = new Date(atMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const p = wallParts(zone, atMs);
  const wallMidnight = Date.UTC(p.year, p.month - 1, p.day);
  // 先按 atMs 处的偏移估一个 0 点,再按估值处的偏移修一次:当天内切换夏令时的话,两处偏移不同
  const guess = wallMidnight - zoneOffsetSeconds(zone, atMs) * 1000;
  return wallMidnight - zoneOffsetSeconds(zone, guess) * 1000;
}

/**
 * 所选时区里 atMs 所在日历日(daysBack = 0)或它之前第 daysBack 个日历日的 0 点(unix ms)。
 * 往前数不是减 daysBack × 24 小时:有夏令时的时区里那天可能是 23 或 25 小时。这里先取今天 0 点,往前 daysBack 天再加半天,
 * 落到目标那一天的正中,再取它的 0 点(正中离两头都远,切换那一小时碰不到)。一天的毫秒数只在本模块里有一份。
 */
export function startOfDayMs(zone: ZoneId, atMs: number, daysBack = 0): number {
  const today = midnightOf(zone, atMs);
  return daysBack === 0 ? today : midnightOf(zone, today - daysBack * DAY_MS + DAY_MS / 2);
}

/** 时区的短标签(显示用):UTC、UTC+8、UTC-5、UTC+5:30;偏移取 atMs 这一刻的(local 是浏览器当时的) */
export function zoneLabel(zone: ZoneId, atMs: number): string {
  const offset = zoneOffsetSeconds(zone, atMs);
  if (offset === 0) return "UTC";
  const abs = Math.abs(offset);
  const minutes = Math.floor((abs % 3600) / 60);
  return `UTC${offset > 0 ? "+" : "-"}${Math.floor(abs / 3600)}${minutes > 0 ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}
