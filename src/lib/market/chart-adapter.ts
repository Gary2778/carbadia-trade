// 图表适配层(计划 §3.6「图表适配」、§4.1.1、§4.4、§5.1):终端数据 / CSS token 与 lightweight-charts 5 之间的纯函数桥。
//
// - 只有懒加载的 CandleChartLW 在运行时引用本模块(首屏的 ChartPanel / IntervalTabs 只 import type),所以本模块连同指标、
//   格式化代码都落在图表 chunk 里,首屏脚本里也就没有 lastValueVisible 这类图表选项名(chunk 门禁按它认图表库)。
//   对 lightweight-charts 同样只有 type import:枚举值(ColorType / CrosshairMode / LineStyle / TickMarkType)按 d.ts 里的
//   字面量写,类型上断言成对应的枚举成员。
// - 单位:store 与 REST 是整数分 / 整数吨 / unix ms。喂图表时价格转成元(与 priceFormat 的 minMove = tickSize / 100 一致)、
//   时间转成 UTC 秒 —— 全终端只有这里做这两个换算;量(吨)原样。
// - 颜色只来自 CSS token(tokens-only.test.ts 扫描本文件):readChartTokens 在图表容器上读计算值 —— 终端 token 定义在
//   [data-terminal] 上,documentElement 上读不到;buildChartOptions 与各 *SeriesOptions 只引用传入的 token,
//   半透明色由 token 的十六进制值派生(withAlpha)。<html> 的 data-theme / data-updown 变化后,调用方重读 token 再 applyOptions。
// - 时间显示按用户的时区偏好(浏览器时区 / 北京 / UTC,计划 §6.3.2 C7;格式化全在 lib/time-format.ts)。图表库只认 UTC:刻度位置
//   (哪根算「新的一天」、整点刻度落在哪)按 UTC 日历算,只换格式化函数的话,刻度标签是所选时区的时刻、位置却是 UTC 边界
//   (UTC+10 的「28 日」落在 10:00,半小时时区的整点刻度读作 :30)。所以日内 interval 喂给图表的时间整体平移所选时区的偏移
//   (chartShiftFor,「墙上时间」秒),刻度按 UTC 格式化即所选时区的墙上时间;偏移在每次整段 setData 时取一次、整段共用
//   (夏令时切换那一小时逐根取偏移会让时间倒退,图表库直接抛错),十字线标签与读数则把平移减回去、按所选时区格式化
//   (北京与 UTC 没有夏令时,三处恒一致;local 在跨夏令时切换的一段里,刻度用的是整段共用的那一个偏移,十字线是该时刻真实的偏移,会差一小时)。
//   日线不平移、只显示日期且按 UTC(服务端按 UTC 零点切日线桶),与时区偏好无关。
import type {
  AreaSeriesPartialOptions,
  CandlestickSeriesPartialOptions,
  ChartOptions,
  ColorType,
  CrosshairMode,
  DeepPartial,
  HistogramSeriesPartialOptions,
  LineSeriesPartialOptions,
  LineStyle,
  PriceFormatBuiltIn,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { CandleBar, CandleInterval } from "@/shared";
import { MAX_BARS } from "@/shared/constants";
import { formatTime, type TimeStyle, type ZoneId, zoneOffsetSeconds } from "@/lib/time-format";
import { ema, emaNext, sma, smaLast } from "@/shared/indicators";
import { clampPricePrecision, formatPrice, formatQty } from "@/shared/precision";

// ------------------------------------------------------------------ 共用类型(首屏组件只 import type,运行时不引本模块)

/** candle = K 线;line = 分时(interval 1m 的 Area,§9.1 第 22 条) */
export type ChartMode = "candle" | "line";
/** 图表页签:分时(time)+ 六个 interval;运行时的列表与换算在 IntervalTabs.tsx */
export type ChartTab = "time" | CandleInterval;
/** ChartPanel 为当前 (symbol, interval) 取的 REST 历史;error 带重试 */
export type ChartHistory = { status: "loading" } | { status: "ready"; bars: CandleBar[] } | { status: "error"; retry: () => void };

// ------------------------------------------------------------------ 数据换算

export type ChartBar = { time: UTCTimestamp; open: number; high: number; low: number; close: number };
export type ChartPoint = { time: UTCTimestamp; value: number };
export type VolumeBar = ChartPoint & { color: string };
/** 量柱的涨 / 跌两种颜色(由当前 --up / --down 派生;涨跌翻转后重读 token 即换色) */
export type UpDownColors = { up: string; down: string };

/**
 * unix ms → 图表时间轴的秒(整秒)。shift = 所选时区的平移(秒,见 chartShiftFor);默认 0 即 UTC 秒。
 * 同一段数据的所有换算(主序列、量柱、指标、十字线定位)必须用同一个 shift。
 */
export const chartTime = (ms: number, shift = 0): UTCTimestamp => (Math.floor(ms / 1000) + shift) as UTCTimestamp;
/** 整数分 → 元 */
const toUnits = (cents: number): number => cents / 100;

/**
 * 喂图表的时间平移(秒):日内 interval = 所选时区(tz,时区偏好;必传,忘了传就编译不过)在 at 时刻相对 UTC 的偏移(东八区 +28800),
 * 图表按 UTC 排的刻度因此落在该时区的整点 / 零点上;日线 = 0(桶从 UTC 零点起,按 UTC 日期显示)。调用方每次整段 setData 取一次、整段共用。
 */
export function chartShiftFor(interval: CandleInterval, at: number, tz: ZoneId): number {
  return interval === "1d" ? 0 : zoneOffsetSeconds(tz, at);
}

export function toChartBar(b: CandleBar, shift = 0): ChartBar {
  return { time: chartTime(b.t, shift), open: toUnits(b.o), high: toUnits(b.h), low: toUnits(b.l), close: toUnits(b.c) };
}

/** 分时(Area)的一个点:收盘价 */
export function toLinePoint(b: CandleBar, shift = 0): ChartPoint {
  return { time: chartTime(b.t, shift), value: toUnits(b.c) };
}

/** 量柱:值是吨,颜色随这根 bar 的涨跌(平盘算涨) */
export function toVolumeBar(b: CandleBar, upDown: UpDownColors, shift = 0): VolumeBar {
  return { time: chartTime(b.t, shift), value: b.v, color: b.c >= b.o ? upDown.up : upDown.down };
}

/** 按图表时间(秒,与数据同一个 shift)在升序的 bars 里二分查找;找不到返回 -1(十字线 → bar,键盘读数定位) */
export function barIndexAt(bars: readonly CandleBar[], time: number, shift = 0): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const at = chartTime(bars[mid].t, shift);
    if (at === time) return mid;
    if (at < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** 升序 + 同 t 去重(留后出现的那根);REST 与 store 本来就按 t 升序,这里只做防御 */
function sortedUnique(bars: readonly CandleBar[]): CandleBar[] {
  let ascending = true;
  for (let i = 1; i < bars.length && ascending; i++) if (bars[i].t < bars[i - 1].t) ascending = false;
  const ordered = ascending ? bars.slice() : bars.slice().sort((a, b) => a.t - b.t); // sort 稳定:同 t 保持原先后
  const out: CandleBar[] = [];
  for (const bar of ordered) {
    if (out.length > 0 && out[out.length - 1].t === bar.t) out[out.length - 1] = bar;
    else out.push(bar);
  }
  return out;
}

/**
 * REST 历史 + 订阅后缓冲的实时 bar(§3.3:candles 不发历史,客户端先订阅缓冲、再取 REST):
 * REST 是历史的权威;缓冲里 t ≥ REST 末根 t 的 bar 覆盖末根(同 t)或追加在后,更早的丢弃。
 * 按 t 去重、升序;返回新数组,不改入参。
 */
export function mergeHistory(rest: readonly CandleBar[], buffered: readonly CandleBar[]): CandleBar[] {
  const out = sortedUnique(rest);
  const live = sortedUnique(buffered);
  if (out.length === 0) return live;
  const cutoff = out[out.length - 1].t;
  for (const bar of live) {
    if (bar.t < cutoff) continue;
    if (bar.t === out[out.length - 1].t) out[out.length - 1] = bar;
    else out.push(bar);
  }
  return out;
}

/** REST 历史的截止点 = 最大的 t(mergeHistory 以它为界:更早的归 REST,不看缓冲);没有历史(null / 空)返回 null */
export function historyCutoff(rest: readonly CandleBar[] | null): number | null {
  if (!rest || rest.length === 0) return null;
  let max = rest[0].t;
  for (const bar of rest) if (bar.t > max) max = bar.t;
  return max;
}

// ------------------------------------------------------------------ 增量 / 重画的决定

/** 一次增量超过这么多根(后台积压、断线恢复)就整段重画,不逐根 update */
export const TAIL_LIMIT = 64;
/** 重画后图上最多留这么多根(store 的两倍;裁掉的只会是 store 首根之前的旧 bar) */
export const MAX_DRAWN_BARS = 2 * MAX_BARS;
/** 逐根推尾巴使图上超过这么多根时,下一跳改为整段重画(裁回 MAX_DRAWN_BARS);留 MAX_BARS / 3 根余量,不每开一根就重画 */
export const DRAWN_REDRAW_AT = MAX_DRAWN_BARS + MAX_BARS / 3;

/**
 * store 里当前键的 bar 变了之后图表怎么画:
 * none = 不用动;tail = live[from..] 逐根 series.update(t 都 ≥ 图上末根的 t);redraw = 整段 setData。
 */
export type DrawPlan = { kind: "none" } | { kind: "tail"; from: number } | { kind: "redraw" };

const PLAN_NONE: DrawPlan = { kind: "none" };
const PLAN_REDRAW: DrawPlan = { kind: "redraw" };

const sameBar = (a: CandleBar, b: CandleBar): boolean =>
  a === b || (a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v);

/**
 * CandleChartLW 的增量 / 重画决定(纯函数)。drawn = 图上的 bar(升序),live = store 里的 bar(升序),
 * cutoff = 图上所用 REST 历史的截止点(historyCutoff;没用 REST 时 null)。
 *   - 图上还没有 bar:live 也空 → none,否则 redraw;
 *   - live 里 t ≥ 图上末根 t 的是尾巴(通常就是末根一根);
 *   - 尾巴之前、t ≥ cutoff 的 live bar 必须在图上且值相同。缺一根(断线 / 休眠恢复后,新桶的 candle 事件先画上了,
 *     校准随后补进来的空档 bar 都比图上末根早)或值不同(轮询模式校准改写了已收盘的 bar)→ redraw。
 *     t < cutoff 的不比:那段归 REST 管,mergeHistory 重画时也丢它们,比了会每跳都重画。
 *     重画用 mergeHistory(REST, live),t ≥ cutoff 的 live bar 原样(同一引用)进图,所以重画之后这里必然一致,不会连环重画;
 *   - 尾巴超过 tailLimit 根(后台积压)→ redraw;推完尾巴图上会超过 maxDrawn 根 → redraw(redrawBars 裁掉最旧的,图上不无限增长);
 *     否则尾巴为空 → none,不空 → tail。
 * 每次实时更新都跑:从尾往前比到 cutoff 为止,平时图上的 bar 与 store 是同一引用,比较只是一次 ===。
 */
export function planDraw(
  drawn: readonly CandleBar[],
  live: readonly CandleBar[],
  cutoff: number | null,
  tailLimit = TAIL_LIMIT,
  maxDrawn = DRAWN_REDRAW_AT,
): DrawPlan {
  if (drawn.length === 0) return live.length === 0 ? PLAN_NONE : PLAN_REDRAW;
  const lastT = drawn[drawn.length - 1].t;
  let from = live.length;
  while (from > 0 && live[from - 1].t >= lastT) from--;
  let j = drawn.length - 1;
  for (let i = from - 1; i >= 0; i--) {
    const bar = live[i];
    if (cutoff !== null && bar.t < cutoff) break;
    while (j >= 0 && drawn[j].t > bar.t) j--;
    if (j < 0 || !sameBar(drawn[j], bar)) return PLAN_REDRAW;
  }
  if (live.length - from > tailLimit) return PLAN_REDRAW;
  if (from === live.length) return PLAN_NONE;
  // 尾巴里与图上末根同 t 的那根是原地更新,不加根
  const added = live.length - from - (live[from].t === lastT ? 1 : 0);
  return drawn.length + added > maxDrawn ? PLAN_REDRAW : { kind: "tail", from };
}

/**
 * 同一键内整段重画用的数据(planDraw 判 redraw 之后;换键 / REST 历史到达的首画仍是 mergeHistory(REST, store))。
 * history = 图上所用的 REST 历史,drawn = 图上现有的 bar,live = store 里当前键的 bar(均按 t 升序)。
 *   - store 首根不晚于 REST 截止点:与首画同一规则 mergeHistory(history, live) —— 截止点之前归 REST,之后以 store 为准;
 *   - 否则(store 只留最新 MAX_BARS 根,挂得够久就够不到截止点;或者根本没有 REST 历史):图上早于 store 首根的 bar 原样保留,
 *     其后接 store。只用 mergeHistory 的话,截止点与 store 首根之间那几个小时只在图上、不在 store 里,重画一次就没了,
 *     而图表库按下标排 bar,缺口在图上看不出来;
 *   - 超过 maxBars 根时从最旧的一端裁,但只裁 store 首根之前的 bar:store 里的每一根都留在图上,planDraw 对账必然一致,
 *     不会连环重画。
 * 返回新数组,不改入参。
 */
export function redrawBars(history: readonly CandleBar[] | null, drawn: readonly CandleBar[], live: readonly CandleBar[], maxBars = MAX_DRAWN_BARS): CandleBar[] {
  const fresh = sortedUnique(live);
  if (fresh.length === 0) return drawn.slice(); // planDraw 不会对空 store 判重画;防御
  const start = fresh[0].t;
  const cutoff = historyCutoff(history);
  let out: CandleBar[];
  if (history && cutoff !== null && start <= cutoff) out = mergeHistory(history, fresh);
  else {
    let n = 0;
    while (n < drawn.length && drawn[n].t < start) n++;
    out = drawn.slice(0, n).concat(fresh);
  }
  let older = 0;
  while (older < out.length && out[older].t < start) older++;
  const cut = Math.min(older, out.length - maxBars);
  return cut > 0 ? out.slice(cut) : out;
}

// ------------------------------------------------------------------ 指标:MA 7/25/99、EMA 12/26

export type IndicatorSpec = { ma: readonly number[]; ema: readonly number[] };
export const INDICATOR_SPEC: IndicatorSpec = { ma: [7, 25, 99], ema: [12, 26] };

type SeriesToken = "series2" | "series3" | "series4";
export type IndicatorLine = { key: string; kind: "ma" | "ema"; period: number; color: SeriesToken; dashed: boolean };

const maKey = (period: number): string => `MA${period}`;
const emaKey = (period: number): string => `EMA${period}`;
const LINE_COLORS: readonly SeriesToken[] = ["series2", "series3", "series4"];

/** 五条指标线:MA7 / MA25 / MA99 = --series-2 / -3 / -4 实线,EMA12 / EMA26 与前两条 MA 同色的虚线 */
export const INDICATOR_LINES: readonly IndicatorLine[] = [
  ...INDICATOR_SPEC.ma.map((period, i) => ({ key: maKey(period), kind: "ma" as const, period, color: LINE_COLORS[i % LINE_COLORS.length], dashed: false })),
  ...INDICATOR_SPEC.ema.map((period, i) => ({ key: emaKey(period), kind: "ema" as const, period, color: LINE_COLORS[i % LINE_COLORS.length], dashed: true })),
];

const closesOf = (bars: readonly CandleBar[]): number[] => bars.map((b) => b.c);

function pointsOf(bars: readonly CandleBar[], values: (number | null)[], shift: number): ChartPoint[] {
  const out: ChartPoint[] = [];
  values.forEach((v, i) => {
    if (v !== null) out.push({ time: chartTime(bars[i].t, shift), value: toUnits(v) });
  });
  return out;
}

/** 整段指标(全量 setData 用):每条线只含有值的点(前 period − 1 根没有),键 MA<n> / EMA<n>;shift 同主序列 */
export function indicatorSeries(bars: readonly CandleBar[], spec: IndicatorSpec, shift = 0): Record<string, ChartPoint[]> {
  const closes = closesOf(bars);
  const out: Record<string, ChartPoint[]> = {};
  for (const period of spec.ma) out[maKey(period)] = pointsOf(bars, sma(closes, period), shift);
  for (const period of spec.ema) out[emaKey(period)] = pointsOf(bars, ema(closes, period), shift);
  return out;
}

/**
 * 实时增量的游标:图上末根的 t,以及每条 EMA 在末根(last)与倒数第二根(prev)上的值(分)。
 * 末根原地变化时从 prev 重推一步,新开一根时从 last 推一步 —— 不用整段重算。
 */
export type IndicatorCursor = { t: number | null; ema: Record<string, { prev: number | null; last: number | null }> };

export function indicatorCursor(bars: readonly CandleBar[], spec: IndicatorSpec): IndicatorCursor {
  const n = bars.length;
  const closes = closesOf(bars);
  const state: IndicatorCursor["ema"] = {};
  for (const period of spec.ema) {
    const values = ema(closes, period);
    state[emaKey(period)] = { prev: n >= 2 ? values[n - 2] : null, last: n >= 1 ? values[n - 1] : null };
  }
  return { t: n > 0 ? bars[n - 1].t : null, ema: state };
}

/** bars[i] 结尾、长度 ≤ period 的收盘价窗口(不足 period 时 smaLast 返回 null) */
const windowCloses = (bars: readonly CandleBar[], i: number, period: number): number[] =>
  closesOf(bars.slice(Math.max(0, i - period + 1), i + 1));

/**
 * 从 bars[from] 起的指标点(实时增量):MA 用 smaLast 取尾窗,EMA 用 emaNext 从游标逐根推进(第 period 根以 SMA 起算,
 * 与 shared/indicators 的 ema 一致)。约定 bars[from].t ≥ cursor.t(调用方从图上末根的 t 起算)。
 * 返回每条线的点(无值的根不出点,时间按 shift 平移,同主序列)与推进后的新游标(游标里的 t 是 unix ms);不改入参。
 */
export function indicatorTail(
  bars: readonly CandleBar[],
  from: number,
  spec: IndicatorSpec,
  cursor: IndicatorCursor,
  shift = 0,
): { points: Record<string, ChartPoint[]>; cursor: IndicatorCursor } {
  const points: Record<string, ChartPoint[]> = {};
  const push = (key: string, point: ChartPoint) => (points[key] ??= []).push(point);
  const next: IndicatorCursor = { t: cursor.t, ema: {} };
  for (const [key, rec] of Object.entries(cursor.ema)) next.ema[key] = { ...rec };

  for (let i = Math.max(0, from); i < bars.length; i++) {
    const bar = bars[i];
    const time = chartTime(bar.t, shift);
    for (const period of spec.ma) {
      const value = smaLast(windowCloses(bars, i, period), period);
      if (value !== null) push(maKey(period), { time, value: toUnits(value) });
    }
    for (const period of spec.ema) {
      const key = emaKey(period);
      const rec = next.ema[key] ?? { prev: null, last: null };
      // 同一根(末根原地变化)从倒数第二根的值重推;新的一根从上一根的值推
      const base = next.t !== null && bar.t === next.t ? rec.prev : rec.last;
      const value = base === null ? (i >= period - 1 ? smaLast(windowCloses(bars, i, period), period) : null) : emaNext(base, bar.c, period);
      next.ema[key] = { prev: base, last: value };
      if (value !== null) push(key, { time, value: toUnits(value) });
    }
    next.t = bar.t;
  }
  return { points, cursor: next };
}

// ------------------------------------------------------------------ token 桥

export type ChartTokens = {
  panel: string;
  foreground: string;
  muted: string;
  border: string;
  up: string;
  down: string;
  series: string;
  series2: string;
  series3: string;
  series4: string;
  fontMono: string;
};

export const CHART_TOKEN_VARS: Readonly<Record<keyof ChartTokens, `--${string}`>> = {
  panel: "--terminal-panel",
  foreground: "--foreground",
  muted: "--muted",
  border: "--terminal-border",
  up: "--up",
  down: "--down",
  series: "--series",
  series2: "--series-2",
  series3: "--series-3",
  series4: "--series-4",
  fontMono: "--font-mono",
};

/**
 * 在 root(图表容器,位于 [data-terminal] 之内)上读 token 的计算值。读不到的退到相近的 token(面板 → transparent、
 * 字体 → monospace、其余 → --foreground),永不返回空串 —— 空串会让图表库的颜色解析抛错。
 */
export function readChartTokens(root: HTMLElement): ChartTokens {
  const style = getComputedStyle(root);
  const read = (key: keyof ChartTokens): string => style.getPropertyValue(CHART_TOKEN_VARS[key]).trim();
  const foreground = read("foreground") || "currentColor";
  const or = (key: keyof ChartTokens, fallback: string): string => read(key) || fallback;
  const muted = or("muted", foreground);
  return {
    panel: or("panel", "transparent"),
    foreground,
    muted,
    border: or("border", muted),
    up: or("up", foreground),
    down: or("down", foreground),
    series: or("series", foreground),
    series2: or("series2", foreground),
    series3: or("series3", foreground),
    series4: or("series4", foreground),
    fontMono: or("fontMono", "monospace"),
  };
}

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * token 的十六进制值加透明度(八位十六进制);token 不是三位 / 六位十六进制时返回 null,由调用方决定退路。
 * 相当于 CSS 的 color-mix(in srgb, var(--x) N%, transparent):图表画在 canvas 上,颜色串要交给图表库解析,不能写 var() / color-mix()。
 */
export function withAlpha(color: string, alpha: number): string | null {
  const m = HEX_COLOR.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? Array.from(m[1], (ch) => ch + ch).join("") : m[1];
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${hex}${a}`;
}

const VOLUME_ALPHA = 0.5;
const AREA_TOP_ALPHA = 0.28;

export function volumeColors(tokens: ChartTokens): UpDownColors {
  return { up: withAlpha(tokens.up, VOLUME_ALPHA) ?? tokens.up, down: withAlpha(tokens.down, VOLUME_ALPHA) ?? tokens.down };
}

// ------------------------------------------------------------------ 图表与序列选项

/**
 * 格式化参数:语言(Intl locale)、价格精度、时间轴是否显示时刻(日线不显示;日线的日期按 UTC,与服务端按 UTC 零点切桶一致)、
 * shift = 当前这段数据的时间平移(秒,chartShiftFor;十字线标签减回去再按所选时区格式化)、tz = 时区偏好(十字线标签的时区,与 shift 取自同一个)
 */
export type ChartFormat = { locale: string; pricePrecision: number; timeVisible: boolean; shift: number; tz: ZoneId };
const DEFAULT_FORMAT: ChartFormat = { locale: "en-US", pricePrecision: 2, timeVisible: true, shift: 0, tz: "local" };

// d.ts 里的枚举字面量(本模块不 import 图表库的运行时值)
const COLOR_SOLID = "solid" as ColorType.Solid;
const CROSSHAIR_NORMAL = 0 as CrosshairMode.Normal;
const LINE_SOLID = 0 as LineStyle.Solid;
const LINE_DASHED = 2 as LineStyle.Dashed;
/** 图表库的刻度类型 → lib/time-format.ts 的样式;下标 = TickMarkType:Year 0 / Month 1 / DayOfMonth 2 / Time 3 / TimeWithSeconds 4 */
const TICK_STYLES: readonly TimeStyle[] = ["axisYear", "axisMonth", "axisDay", "axisTime", "axisSeconds"];

/**
 * unix ms → 十字线时间标签与读数的时间:日内 interval 按所选时区(tz)「年-月-日 时:分」;
 * dateOnly(日线)只有日期,按 UTC —— 日线桶从 UTC 零点起,与时区偏好无关
 */
export function formatChartTime(ms: number, locale: string, dateOnly: boolean, tz: ZoneId): string {
  return dateOnly ? formatTime(ms, locale, "UTC", "crosshairDate") : formatTime(ms, locale, tz, "crosshair");
}

/**
 * 图表整体选项:背景 --terminal-panel、文字 --muted、网格与边框 --terminal-border、十字线 --muted、字体 --font-mono;
 * 价格标签按标的精度与语言经 formatPrice(图表值是元,换回分再格式化)。
 * 时间:刻度收到的是已平移的「墙上时间」秒,按 UTC 格式化即所选时区的时刻(日线 shift 0 即 UTC 日期),与图表库按 UTC 日历
 * 选的刻度位置一致;十字线标签减去 shift 还原成真实时刻,按所选时区格式化(与读数同一个函数)。
 */
export function buildChartOptions(tokens: ChartTokens, format: ChartFormat = DEFAULT_FORMAT): DeepPartial<ChartOptions> {
  const { locale, pricePrecision, timeVisible, shift, tz } = format;
  const crosshairLine = { color: tokens.muted, labelBackgroundColor: tokens.muted };
  return {
    autoSize: true,
    layout: {
      background: { type: COLOR_SOLID, color: tokens.panel },
      textColor: tokens.muted,
      fontFamily: tokens.fontMono,
      // 图表库许可要求署名;保留它自带的 TradingView 标识
      attributionLogo: true,
    },
    grid: { vertLines: { color: tokens.border }, horzLines: { color: tokens.border } },
    crosshair: { mode: CROSSHAIR_NORMAL, vertLine: crosshairLine, horzLine: crosshairLine },
    // 触屏上竖向拖动留给页面滚动(手机版图表在页签里,不能把页面卡住);横向拖动照常平移时间轴
    handleScroll: { vertTouchDrag: false },
    rightPriceScale: { borderColor: tokens.border },
    timeScale: {
      borderColor: tokens.border,
      timeVisible,
      secondsVisible: false,
      tickMarkFormatter: (time: Time, tickMarkType: number) => {
        const style = TICK_STYLES[tickMarkType];
        if (typeof time !== "number" || style === undefined) return null;
        return formatTime(time * 1000, locale, "UTC", style);
      },
    },
    localization: {
      locale,
      priceFormatter: (price: number) => formatPrice(price * 100, pricePrecision, locale),
      timeFormatter: (time: Time) => (typeof time === "number" ? formatChartTime((time - shift) * 1000, locale, !timeVisible, tz) : String(time)),
    },
  };
}

/** 主序列的价格格式:精度钳到 0..2,minMove = tickSize(分)/ 100 */
export function priceFormatOf(pricePrecision: number, tickSize: number): PriceFormatBuiltIn {
  const precision = clampPricePrecision(pricePrecision);
  const minMove = Number.isFinite(tickSize) && tickSize > 0 ? tickSize / 100 : 10 ** -precision;
  return { type: "price", precision, minMove };
}

/** K 线本体用方向色 --up / --down(涨跌翻转由 CSS 换别名,重读 token 即跟随) */
export function candleSeriesOptions(tokens: ChartTokens): CandlestickSeriesPartialOptions {
  return {
    upColor: tokens.up,
    downColor: tokens.down,
    borderUpColor: tokens.up,
    borderDownColor: tokens.down,
    wickUpColor: tokens.up,
    wickDownColor: tokens.down,
  };
}

/** 分时:--series 的线 + 由它派生的半透明渐变填充(token 不是十六进制时不填充) */
export function areaSeriesOptions(tokens: ChartTokens): AreaSeriesPartialOptions {
  return {
    lineColor: tokens.series,
    topColor: withAlpha(tokens.series, AREA_TOP_ALPHA) ?? "transparent",
    bottomColor: withAlpha(tokens.series, 0) ?? "transparent",
    lineWidth: 2,
  };
}

export function indicatorLineOptions(line: IndicatorLine, tokens: ChartTokens): LineSeriesPartialOptions {
  return {
    color: tokens[line.color],
    lineWidth: 1,
    lineStyle: line.dashed ? LINE_DASHED : LINE_SOLID,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
  };
}

/** VOL 在独立的 "vol" 价格轴上,占底部 20% */
export const VOLUME_SCALE_ID = "vol";
export const VOLUME_SCALE_MARGINS = { top: 0.8, bottom: 0 };

export function volumeSeriesOptions(): HistogramSeriesPartialOptions {
  return { priceScaleId: VOLUME_SCALE_ID, priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false };
}

/** 主价格轴的上下留白:开 VOL 时让出底部给量柱 */
export function mainScaleMargins(volume: boolean): { top: number; bottom: number } {
  return volume ? { top: 0.1, bottom: 0.25 } : { top: 0.1, bottom: 0.08 };
}

// ------------------------------------------------------------------ 读数

export type ReadoutValues = { o: string; h: string; l: string; c: string; v: string };

/** 十字线读数(terminal.chart.readout 的参数):OHLC 按标的精度,V 按 qtyStep,都按语言带千分位 */
export function readoutValues(bar: CandleBar, fmt: { pricePrecision: number; qtyStep: number; locale: string }): ReadoutValues {
  const price = (cents: number) => formatPrice(cents, fmt.pricePrecision, fmt.locale);
  return { o: price(bar.o), h: price(bar.h), l: price(bar.l), c: price(bar.c), v: formatQty(bar.v, fmt.qtyStep, fmt.locale) };
}
