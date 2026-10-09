import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandleBar } from "@/shared";
import { MAX_BARS } from "@/shared";
import { ema, sma } from "@/shared/indicators";
import {
  CHART_TOKEN_VARS,
  INDICATOR_LINES,
  INDICATOR_SPEC,
  DRAWN_REDRAW_AT,
  MAX_DRAWN_BARS,
  VOLUME_SCALE_ID,
  areaSeriesOptions,
  barIndexAt,
  TAIL_LIMIT,
  buildChartOptions,
  candleSeriesOptions,
  chartShiftFor,
  chartTime,
  formatChartTime,
  historyCutoff,
  indicatorCursor,
  indicatorLineOptions,
  indicatorSeries,
  indicatorTail,
  mainScaleMargins,
  mergeHistory,
  planDraw,
  priceFormatOf,
  readChartTokens,
  readoutValues,
  redrawBars,
  toChartBar,
  toLinePoint,
  toVolumeBar,
  volumeColors,
  volumeSeriesOptions,
  withAlpha,
  type ChartTokens,
} from "./chart-adapter";

// 图表适配层的纯函数测试(计划 §3.6「图表适配」、P1-19 测试项):node 环境,不 import lightweight-charts(适配层只有 type import)。

const T0 = 1_790_000_040_000; // 某个整分钟的 unix ms
const MIN = 60_000;
const bar = (i: number, c: number, o = c - 1, v = 10 + i): CandleBar => ({ t: T0 + i * MIN, o, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, c, v });
/** 一段有涨有跌的 K 线(close 按正弦摆动,避免指标恒等) */
const series = (n: number, from = 0): CandleBar[] => Array.from({ length: n }, (_, k) => bar(from + k, 7000 + Math.round(50 * Math.sin((from + k) / 3)) + (from + k)));

const TOKENS: ChartTokens = {
  panel: "#101010",
  foreground: "#fafafa",
  muted: "#909090",
  border: "#303030",
  up: "#00aa00",
  down: "#cc0000",
  series: "#16a34a",
  series2: "#6685ac",
  series3: "#b98b37",
  series4: "#89709b",
  fontMono: "ui-monospace, monospace",
};

describe("toChartBar / toLinePoint / chartTime", () => {
  it("毫秒 → UTC 秒,价格整数分 → 元", () => {
    expect(toChartBar({ t: T0, o: 7001, h: 7050, l: 6990, c: 7025, v: 3 })).toEqual({ time: T0 / 1000, open: 70.01, high: 70.5, low: 69.9, close: 70.25 });
    expect(toLinePoint({ t: T0 + MIN, o: 1, h: 2, l: 1, c: 1234, v: 1 })).toEqual({ time: T0 / 1000 + 60, value: 12.34 });
  });

  it("非整秒的毫秒向下取整(图表时间轴只收整秒)", () => {
    expect(chartTime(T0 + 999)).toBe(T0 / 1000);
    expect(Number.isInteger(chartTime(1_790_000_000_123))).toBe(true);
  });

  it("shift(本地时区平移,秒)加在每个时间上;价格不受影响", () => {
    const b = { t: T0, o: 7001, h: 7050, l: 6990, c: 7025, v: 3 };
    expect(chartTime(T0, 36_000)).toBe(T0 / 1000 + 36_000);
    expect(toChartBar(b, -25_200)).toEqual({ ...toChartBar(b), time: T0 / 1000 - 25_200 });
    expect(toLinePoint(b, 19_800)).toEqual({ time: T0 / 1000 + 19_800, value: 70.25 });
    expect(toVolumeBar(b, { up: "UP", down: "DOWN" }, 3600).time).toBe(T0 / 1000 + 3600);
  });
});

describe("chartShiftFor(日内时间平移到本地时区)", () => {
  // 按运行时区断言(门禁在本机时区跑,另在 TZ=America/Los_Angeles / Asia/Kolkata / Asia/Shanghai / UTC 下各跑一遍)
  it("日内 interval = 本地时区在该时刻相对 UTC 的偏移(秒);日线 = 0", () => {
    const at = new Date(2026, 8, 28, 12).getTime();
    // 0 - x 而不是 -x:UTC 机器上偏移是 0,写成 -0 * 60 会得到 -0,toBe 用 Object.is 认为它不等于 +0
    for (const interval of ["1m", "5m", "15m", "1h", "4h"] as const) expect(chartShiftFor(interval, at, "local")).toBe(0 - new Date(at).getTimezoneOffset() * 60);
    expect(chartShiftFor("1d", at, "local")).toBe(0);
  });

  it("平移后本地零点落在 UTC 日界、本地整点落在 UTC 整点(图表库按 UTC 日历选日 / 小时刻度的位置),半小时时区也一样", () => {
    const midnight = new Date(2026, 8, 28).getTime(); // 本地 28 日零点
    const sec = chartTime(midnight, chartShiftFor("1m", midnight, "local"));
    expect(sec % 86_400).toBe(0);
    const d = new Date(sec * 1000);
    expect([d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]).toEqual([2026, 8, 28]);
    for (const hour of [1, 9, 15, 23]) {
      const at = new Date(2026, 8, 28, hour).getTime();
      const shifted = chartTime(at, chartShiftFor("1h", at, "local"));
      expect(shifted % 3600).toBe(0);
      expect(new Date(shifted * 1000).getUTCHours()).toBe(hour);
    }
  });
});

describe("chartShiftFor 与时区偏好(P3-09)", () => {
  // 区名走函数自己的参数,不靠机器的时区
  const at = Date.UTC(2026, 8, 28, 12);

  it("日内 interval 按所选时区的偏移:北京 +28800、UTC 0;日线恒为 0,与偏好无关", () => {
    for (const interval of ["1m", "5m", "15m", "1h", "4h"] as const) {
      expect(chartShiftFor(interval, at, "Asia/Shanghai")).toBe(28_800);
      expect(chartShiftFor(interval, at, "UTC")).toBe(0);
    }
    for (const zone of ["local", "Asia/Shanghai", "UTC", "America/Los_Angeles"]) expect(chartShiftFor("1d", at, zone)).toBe(0);
  });

  it("local 是浏览器时区(原来的行为);带夏令时的区取 at 这一刻的偏移", () => {
    expect(chartShiftFor("1m", at, "local")).toBe(0 - new Date(at).getTimezoneOffset() * 60);
    expect(chartShiftFor("1m", Date.UTC(2026, 6, 1), "America/Los_Angeles")).toBe(-25_200);
    expect(chartShiftFor("1m", Date.UTC(2026, 0, 1), "America/Los_Angeles")).toBe(-28_800);
    expect(chartShiftFor("1h", at, "Asia/Kolkata")).toBe(19_800);
  });
});

describe("tz 是必传参数(忘了传就编译不过,不会悄悄按浏览器时区算)", () => {
  it("chartShiftFor 与 formatChartTime 都要求 tz(tsc 守着;下面两行的 @ts-expect-error 一旦不再报错,tsc 会反过来报它多余)", () => {
    const at = Date.UTC(2026, 8, 28, 12);
    // @ts-expect-error tz 必传:少一个参数
    const shift: unknown = () => chartShiftFor("1m", at);
    // @ts-expect-error tz 必传:少一个参数
    const label: unknown = () => formatChartTime(at, "en-US", false);
    expect(typeof shift).toBe("function");
    expect(typeof label).toBe("function");
  });
});

describe("时区偏好下 K 线、刻度与十字线读同一个墙上时刻(P3-09)", () => {
  type Options = ReturnType<typeof buildChartOptions>;
  const tickMarkFormatter = (o: Options) => o.timeScale?.tickMarkFormatter as unknown as (time: unknown, type: number, locale: string) => string | null;
  const timeFormatter = (o: Options) => o.localization?.timeFormatter as unknown as (time: unknown) => string;
  /** 不经本模块的独立算法:这个时区里 at 的「时:分」 */
  const wallHm = (zone: string, ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(ms);
  const wallDate = (zone: string, ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);

  // 2026-09-28 20:30 UTC:北京是 09-29 04:30,洛杉矶 13:30,加尔各答 09-29 02:00,Lord Howe 09-29 07:00(半小时夏令时的区)
  const instants = [Date.UTC(2026, 8, 28, 20, 30), Date.UTC(2026, 0, 5, 3, 45), Date.UTC(2026, 6, 14, 23, 59)];

  it.each(["UTC", "Asia/Shanghai", "America/Los_Angeles", "Asia/Kolkata", "Australia/Lord_Howe"])("%s", (zone) => {
    for (const at of instants) {
      const shift = chartShiftFor("1m", at, zone);
      const o = buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 2, timeVisible: true, shift, tz: zone });
      const sec = chartTime(at, shift);
      const hm = wallHm(zone, at);
      // 1. K 线的位置:平移后的秒按 UTC 读,就是这个时区的墙上时刻
      const d = new Date(sec * 1000);
      expect(`${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`, `candle ${zone} ${at}`).toBe(hm);
      // 2. 时间轴刻度
      expect(tickMarkFormatter(o)(sec, 3, "en-US"), `tick ${zone} ${at}`).toBe(hm);
      // 3. 十字线标签 = 读数(formatChartTime):同一个日期、同一个「时:分」
      expect(timeFormatter(o)(sec), `crosshair ${zone} ${at}`).toBe(formatChartTime(at, "en-US", false, zone));
      expect(timeFormatter(o)(sec), `crosshair ${zone} ${at}`).toBe(`${wallDate(zone, at)}, ${hm}`);
    }
  });

  it("日线只显示日期、按 UTC:不随时区偏好变(桶从 UTC 零点起)", () => {
    const utcMidnight = Date.UTC(2026, 8, 28);
    for (const zone of ["local", "UTC", "Asia/Shanghai", "America/Los_Angeles"]) {
      const o = buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 2, timeVisible: false, shift: chartShiftFor("1d", utcMidnight, zone), tz: zone });
      expect(timeFormatter(o)(utcMidnight / 1000), zone).toBe("09/28/2026");
      expect(tickMarkFormatter(o)(utcMidnight / 1000, 2, "en-US"), zone).toBe("28");
      expect(formatChartTime(utcMidnight, "en-US", true, zone), zone).toBe("09/28/2026");
    }
  });

  it("换时区偏好 = 同一批 bar 换一个 shift:时间平移的差就是两个时区的偏移差,价格与 bar 的相对位置不变", () => {
    const b = { t: Date.UTC(2026, 8, 28, 20, 30), o: 7001, h: 7050, l: 6990, c: 7025, v: 3 };
    const utc = toChartBar(b, chartShiftFor("1m", b.t, "UTC"));
    const beijing = toChartBar(b, chartShiftFor("1m", b.t, "Asia/Shanghai"));
    expect(beijing.time - utc.time).toBe(8 * 3600);
    expect({ ...beijing, time: 0 }).toEqual({ ...utc, time: 0 });
  });
});

describe("toVolumeBar", () => {
  const colors = { up: "UP", down: "DOWN" };

  it("量 = v(吨,不换算),颜色随涨跌取 upDown 里的一种", () => {
    expect(toVolumeBar({ t: T0, o: 100, h: 120, l: 90, c: 110, v: 42 }, colors)).toEqual({ time: T0 / 1000, value: 42, color: "UP" });
    expect(toVolumeBar({ t: T0, o: 110, h: 120, l: 90, c: 100, v: 7 }, colors).color).toBe("DOWN");
  });

  it("平盘(c === o)算涨;换一组 upDown(涨跌翻转后重读的 token)颜色跟着换", () => {
    const flat = { t: T0, o: 100, h: 100, l: 100, c: 100, v: 1 };
    expect(toVolumeBar(flat, colors).color).toBe("UP");
    const flipped = { up: "DOWN", down: "UP" };
    expect(toVolumeBar({ t: T0, o: 100, h: 120, l: 90, c: 110, v: 1 }, flipped).color).toBe("DOWN");
  });

  it("volumeColors 由 --up / --down 派生半透明色;非十六进制 token 原样用", () => {
    expect(volumeColors(TOKENS)).toEqual({ up: withAlpha(TOKENS.up, 0.5), down: withAlpha(TOKENS.down, 0.5) });
    expect(volumeColors({ ...TOKENS, up: "currentColor" }).up).toBe("currentColor");
  });
});

describe("mergeHistory", () => {
  it("缓冲里与 REST 末根同 t 的 bar 覆盖末根,更新的追加在后", () => {
    const rest = [bar(0, 100), bar(1, 101), bar(2, 102)];
    const liveLast = { ...bar(2, 150), v: 99 };
    const merged = mergeHistory(rest, [liveLast, bar(3, 103)]);
    expect(merged.map((b) => b.t)).toEqual([0, 1, 2, 3].map((i) => T0 + i * MIN));
    expect(merged[2]).toBe(liveLast);
    expect(merged[3].c).toBe(103);
  });

  it("比 REST 末根旧的缓冲一律丢弃(REST 是历史的权威)", () => {
    const rest = [bar(0, 100), bar(1, 101), bar(2, 102)];
    const staleMid = { ...bar(1, 999), v: 1 };
    const merged = mergeHistory(rest, [bar(0, 555), staleMid]);
    expect(merged).toEqual(rest);
    expect(merged).not.toBe(rest); // 返回新数组,不改入参
  });

  it("按 t 去重、保序:乱序输入排成升序,同 t 留后出现的那根", () => {
    const rest = [bar(2, 102), bar(0, 100), bar(1, 101), { ...bar(1, 111) }];
    const merged = mergeHistory(rest, [bar(4, 104), bar(3, 103), bar(4, 144)]);
    expect(merged.map((b) => b.t)).toEqual([0, 1, 2, 3, 4].map((i) => T0 + i * MIN));
    expect(merged[1].c).toBe(111);
    expect(merged[4].c).toBe(144);
  });

  it("REST 为空 → 只有缓冲(同样升序去重);缓冲为空 → REST 的副本", () => {
    expect(mergeHistory([], [bar(1, 1), bar(0, 0)]).map((b) => b.c)).toEqual([0, 1]);
    const rest = [bar(0, 100)];
    expect(mergeHistory(rest, [])).toEqual(rest);
    expect(mergeHistory([], [])).toEqual([]);
  });

  it("不改入参", () => {
    const rest = [bar(1, 101), bar(0, 100)];
    const buffered = [bar(2, 102)];
    const before = JSON.stringify([rest, buffered]);
    mergeHistory(rest, buffered);
    expect(JSON.stringify([rest, buffered])).toBe(before);
  });
});

describe("historyCutoff", () => {
  it("REST 历史的最大 t;没有历史(null / 空)为 null", () => {
    expect(historyCutoff([bar(0, 1), bar(5, 1), bar(3, 1)])).toBe(T0 + 5 * MIN);
    expect(historyCutoff([])).toBeNull();
    expect(historyCutoff(null)).toBeNull();
  });
});

describe("planDraw(增量 / 重画的决定)", () => {
  /** 一根 bar 的新版本(同 t,值变了) */
  const bump = (b: CandleBar, dc = 3, dv = 1): CandleBar => ({ ...b, c: b.c + dc, h: Math.max(b.h, b.c + dc), v: b.v + dv });
  /** 按计划把 live 应用到图上(与 CandleChartLW 同一规则):tail 逐根 upsert 末端,redraw = redrawBars(REST, 图上, live) */
  const apply = (drawn: CandleBar[], live: CandleBar[], rest: CandleBar[] | null): CandleBar[] => {
    const plan = planDraw(drawn, live, historyCutoff(rest));
    if (plan.kind === "redraw") return redrawBars(rest, drawn, live);
    if (plan.kind === "none") return drawn;
    const out = drawn.slice();
    for (const b of live.slice(plan.from)) {
      if (out[out.length - 1].t === b.t) out[out.length - 1] = b;
      else out.push(b);
    }
    return out;
  };

  it("图上还没有 bar:store 也空 → none;store 有 bar → redraw", () => {
    expect(planDraw([], [], null)).toEqual({ kind: "none" });
    expect(planDraw([], [bar(0, 100)], null)).toEqual({ kind: "redraw" });
    expect(planDraw([], [bar(0, 100)], T0 + 5 * MIN)).toEqual({ kind: "redraw" });
  });

  it("普通一跳:只有末根变了 → tail,从末根起", () => {
    const rest = series(100);
    const store = rest.slice(90); // 订阅后缓冲 + 校准写进 store 的一段
    const drawn = mergeHistory(rest, store);
    const next = store.slice();
    next[next.length - 1] = bump(next[next.length - 1]);
    expect(planDraw(drawn, next, historyCutoff(rest))).toEqual({ kind: "tail", from: next.length - 1 });
  });

  it("新开一根:末根的最终值 + 新桶两根 → tail,从末根起", () => {
    const rest = series(100);
    const store = rest.slice(90);
    const drawn = mergeHistory(rest, store);
    const next = [...store.slice(0, -1), bump(store[store.length - 1]), bar(100, 7100)];
    expect(planDraw(drawn, next, historyCutoff(rest))).toEqual({ kind: "tail", from: next.length - 2 });
  });

  it("后台积压:尾巴超过 tailLimit 根 → redraw;正好 tailLimit 根仍逐根 update", () => {
    const rest = series(100);
    const drawn = rest.slice();
    const within = [...rest.slice(-1), ...series(TAIL_LIMIT - 1, 100)];
    expect(planDraw(drawn, within, historyCutoff(rest))).toEqual({ kind: "tail", from: 0 });
    const over = [...rest.slice(-1), ...series(TAIL_LIMIT, 100)];
    expect(planDraw(drawn, over, historyCutoff(rest))).toEqual({ kind: "redraw" });
    expect(planDraw(drawn, over, historyCutoff(rest), over.length)).toEqual({ kind: "tail", from: 0 });
  });

  it("断线 / 休眠恢复:新桶的事件先画上,校准补进来的空档都比图上末根早 → redraw;重画后空档在图上,之后恢复只推尾巴", () => {
    const rest = series(100); // 图上的 REST 历史,截止第 99 根
    let drawn = mergeHistory(rest, rest.slice(95));
    // 两小时后重连:hub 只推当前桶(第 220 根),store 里还没有中间的 120 根
    const reconnect = [...rest.slice(95), bar(220, 7300)];
    expect(planDraw(drawn, reconnect, historyCutoff(rest))).toEqual({ kind: "tail", from: reconnect.length - 2 });
    drawn = apply(drawn, reconnect, rest);
    expect(drawn.map((b) => b.t).slice(-2)).toEqual([T0 + 99 * MIN, T0 + 220 * MIN]); // 两根相隔两小时的 bar 挨着
    // 最多 60 s 后校准:REST 最近一段按 t upsert 进 store,空档补齐
    const calibrated = [...series(120, 100), bump(bar(220, 7300))].sort((a, b) => a.t - b.t);
    const store = [...rest.slice(95), ...calibrated];
    expect(planDraw(drawn, store, historyCutoff(rest))).toEqual({ kind: "redraw" });
    drawn = apply(drawn, store, rest);
    expect(drawn).toHaveLength(221);
    expect(drawn.map((b) => b.t)).toEqual(Array.from({ length: 221 }, (_, i) => T0 + i * MIN));
    // 重画之后对账一致:下一跳只推末根,不会每跳都重画
    const tick = [...store.slice(0, -1), bump(store[store.length - 1])];
    expect(planDraw(drawn, tick, historyCutoff(rest))).toEqual({ kind: "tail", from: tick.length - 1 });
  });

  it("轮询校准改写了截止点之后已收盘的 bar → redraw 一次;重画后对账一致", () => {
    const rest = series(100);
    let drawn = mergeHistory(rest, []);
    const live = series(20, 100); // 订阅后本地折算出的 20 根(第 100–119 根)
    drawn = apply(drawn, [...rest.slice(-1), ...live], rest);
    expect(drawn).toHaveLength(120);
    const corrected = live.slice();
    corrected[5] = bump(corrected[5], -9, 2); // 60 s 校准:REST 把本地多算 / 少算的已收盘 bar 改回来
    expect(planDraw(drawn, corrected, historyCutoff(rest))).toEqual({ kind: "redraw" });
    drawn = apply(drawn, corrected, rest);
    expect(drawn[105]).toBe(corrected[5]);
    expect(planDraw(drawn, corrected, historyCutoff(rest))).toEqual({ kind: "tail", from: corrected.length - 1 });
  });

  it("比 REST 截止点早的 store bar 不比(归 REST 管,mergeHistory 也不收):值不同也不重画,不会连环重画", () => {
    const rest = series(100);
    const drawn = mergeHistory(rest, []);
    const store = [bump(rest[50], 20), bump(rest[98], 20), rest[99]];
    expect(planDraw(drawn, store, historyCutoff(rest))).toEqual({ kind: "tail", from: 2 });
    // 反例:不给截止点就会判重画,而 mergeHistory(rest, store) 重画后仍不含这两根 —— 每跳都会再重画
    expect(planDraw(drawn, store, null)).toEqual({ kind: "redraw" });
    expect(mergeHistory(rest, store)[50]).toBe(rest[50]);
  });

  it("值相同的不同对象(REST 与校准各自解析出的同一根)不算变化", () => {
    const rest = series(100);
    const drawn = mergeHistory(rest, series(10, 100));
    const store = series(10, 100).map((b) => ({ ...b }));
    expect(planDraw(drawn, store, historyCutoff(rest))).toEqual({ kind: "tail", from: 9 });
  });

  it("没有 REST 历史(请求失败,图上只有 store 的 bar):校准补进来的整段历史 → redraw,之后一致", () => {
    let drawn = [bar(200, 7000), bar(201, 7001)];
    const store = [...series(200), bar(200, 7000), bar(201, 7001)];
    expect(planDraw(drawn, store, null)).toEqual({ kind: "redraw" });
    drawn = apply(drawn, store, null);
    expect(drawn).toHaveLength(202);
    expect(planDraw(drawn, store, null)).toEqual({ kind: "tail", from: 201 });
  });

  it("store 全比图上末根旧(图上是更新的 REST)→ none", () => {
    const rest = series(100);
    expect(planDraw(rest, rest.slice(0, 50), historyCutoff(rest))).toEqual({ kind: "none" });
    expect(planDraw(rest, [], historyCutoff(rest))).toEqual({ kind: "none" });
  });

  it("审查复现:store 只留最新 MAX_BARS 根、已够不到截止点时重画,截止点与 store 首根之间的 bar 不丢", () => {
    const rest = series(100); // REST 历史,截止第 99 根
    // 挂了很久:图上 = REST + 逐根推上去的第 100–1699 根;store 只剩最新 1500 根(第 200–1699 根)
    let drawn = series(1700);
    const store = series(MAX_BARS, 200);
    expect(store[0].t).toBeGreaterThan(historyCutoff(rest)!);
    // 轮询校准改写了一根已收盘的 bar → redraw
    const corrected = store.slice();
    corrected[1450] = bump(corrected[1450]);
    expect(planDraw(drawn, corrected, historyCutoff(rest))).toEqual({ kind: "redraw" });
    // 旧规则 mergeHistory(REST, store) 在第 99 根之后直接接第 200 根:图表库按下标排 bar,这 100 根的缺口看不出来
    expect(mergeHistory(rest, corrected)).toHaveLength(100 + MAX_BARS);
    drawn = apply(drawn, corrected, rest);
    expect(drawn.map((b) => b.t)).toEqual(Array.from({ length: 1700 }, (_, i) => T0 + i * MIN));
    expect(drawn[1650]).toBe(corrected[1450]);
    // 重画之后对账一致:不会连环重画(同一份 store 再跑一次只是末根原地 update),下一跳只推末根
    expect(planDraw(drawn, corrected, historyCutoff(rest))).toEqual({ kind: "tail", from: corrected.length - 1 });
    const tick = [...corrected.slice(0, -1), bump(corrected[corrected.length - 1])];
    expect(planDraw(drawn, tick, historyCutoff(rest))).toEqual({ kind: "tail", from: tick.length - 1 });
  });

  it("同一情形下的积压(休眠醒来,尾巴超过 tailLimit)重画同样保留 store 之前已画的 bar", () => {
    const rest = series(100);
    const drawn = series(1700);
    const store = [...series(MAX_BARS - 100, 300), ...series(100, 1700)]; // store 窗口前移 + 醒来补进的 100 根新 bar
    expect(planDraw(drawn, store, historyCutoff(rest))).toEqual({ kind: "redraw" });
    const out = apply(drawn, store, rest);
    expect(out.map((b) => b.t)).toEqual(Array.from({ length: 1800 }, (_, i) => T0 + i * MIN));
  });

  it(`图上的 bar 不无限增长:超过 DRAWN_REDRAW_AT 根时下一跳整段重画,裁到 MAX_DRAWN_BARS 根(只裁 store 之前的旧 bar)`, () => {
    const rest = series(100);
    const drawn = series(DRAWN_REDRAW_AT); // 正好到上限
    // 末根原地更新不加根:照常推尾巴
    const same = series(MAX_BARS, DRAWN_REDRAW_AT - MAX_BARS);
    same[same.length - 1] = bump(same[same.length - 1]);
    expect(planDraw(drawn, same, historyCutoff(rest))).toEqual({ kind: "tail", from: MAX_BARS - 1 });
    // 新开一根就超了 → 整段重画并裁剪
    const store = series(MAX_BARS, DRAWN_REDRAW_AT - MAX_BARS + 1);
    expect(planDraw(drawn, store, historyCutoff(rest))).toEqual({ kind: "redraw" });
    const out = apply(drawn, store, rest);
    expect(out).toHaveLength(MAX_DRAWN_BARS);
    expect(out[out.length - 1]).toBe(store[store.length - 1]);
    expect(out.slice(-MAX_BARS)).toEqual(store); // store 那一段整段保留
    for (let i = 1; i < out.length; i++) expect(out[i].t - out[i - 1].t).toBe(MIN);
    expect(planDraw(out, store, historyCutoff(rest))).toEqual({ kind: "tail", from: store.length - 1 });
  });
});

describe("redrawBars(同一键内重画用的数据)", () => {
  it("store 仍够到截止点:与 mergeHistory(REST, store) 相同(截止点之前归 REST)", () => {
    const rest = series(100);
    const store = [{ ...rest[50], c: 1 }, ...series(20, 99)];
    const drawn = mergeHistory(rest, series(10, 99));
    expect(redrawBars(rest, drawn, store)).toEqual(mergeHistory(rest, store));
  });

  it("没有 REST 历史:store 之前已画的 bar 保留,其后以 store 为准", () => {
    const drawn = series(50);
    const store = [{ ...bar(40, 1) }, ...series(20, 41)];
    const out = redrawBars(null, drawn, store);
    expect(out.slice(0, 40)).toEqual(drawn.slice(0, 40));
    expect(out.slice(40)).toEqual(store);
    expect(redrawBars(null, [], store)).toEqual(store);
  });

  it("裁剪只动 store 首根之前的 bar:store 本身比上限还长也整段保留", () => {
    const store = series(MAX_BARS, 10);
    expect(redrawBars(null, series(10), store, 100)).toEqual(store);
    expect(redrawBars(null, series(10), store, MAX_BARS + 4)).toEqual([...series(4, 6), ...store]);
  });

  it("不改入参", () => {
    const rest = series(10);
    const drawn = series(30);
    const store = series(5, 25);
    const snapshot = [rest.slice(), drawn.slice(), store.slice()];
    redrawBars(rest, drawn, store, 12);
    expect([rest, drawn, store]).toEqual(snapshot);
  });
});

describe("indicatorSeries", () => {
  const bars = series(130);
  const closes = bars.map((b) => b.c);
  const out = indicatorSeries(bars, INDICATOR_SPEC);

  it("MA 7/25/99、EMA 12/26 五条线,键名固定", () => {
    expect(Object.keys(out).sort()).toEqual(["EMA12", "EMA26", "MA25", "MA7", "MA99"]);
    expect(INDICATOR_LINES.map((l) => l.key)).toEqual(["MA7", "MA25", "MA99", "EMA12", "EMA26"]);
  });

  it("长度与 sma / ema 的非空值个数一致,数值 = sma / ema(分)÷ 100,时间对齐到各自的 bar", () => {
    const check = (key: string, values: (number | null)[]) => {
      const expected = values.flatMap((v, i) => (v === null ? [] : [{ time: chartTime(bars[i].t), value: v / 100 }]));
      expect(out[key]).toHaveLength(expected.length);
      out[key].forEach((p, i) => {
        expect(p.time).toBe(expected[i].time);
        expect(p.value).toBeCloseTo(expected[i].value, 10);
      });
    };
    for (const p of INDICATOR_SPEC.ma) check(`MA${p}`, sma(closes, p));
    for (const p of INDICATOR_SPEC.ema) check(`EMA${p}`, ema(closes, p));
    expect(out.MA7).toHaveLength(130 - 6);
    expect(out.MA99).toHaveLength(130 - 98);
  });

  it("shift 平移每个点的时间,值不变", () => {
    const shifted = indicatorSeries(bars, INDICATOR_SPEC, 3600);
    for (const key of Object.keys(out)) {
      expect(shifted[key].map((p) => p.time)).toEqual(out[key].map((p) => p.time + 3600));
      expect(shifted[key].map((p) => p.value)).toEqual(out[key].map((p) => p.value));
    }
    const tail = indicatorTail(bars, 120, INDICATOR_SPEC, indicatorCursor(bars.slice(0, 120), INDICATOR_SPEC), 3600);
    expect(tail.points.MA7.map((p) => p.time)).toEqual(bars.slice(120).map((b) => chartTime(b.t, 3600)));
  });

  it("根数不足周期时该线为空数组,不产出 NaN", () => {
    const few = indicatorSeries(series(5), INDICATOR_SPEC);
    expect(few.MA7).toEqual([]);
    expect(few.EMA12).toEqual([]);
    expect(indicatorSeries([], INDICATOR_SPEC).MA7).toEqual([]);
  });
});

describe("indicatorCursor / indicatorTail(实时只推末根)", () => {
  const spec = { ma: [7, 25], ema: [12, 26] };
  /** 以整段重算为准:bars[i] 上每条线的值(元),无值为 null */
  const fullAt = (bars: CandleBar[], i: number) => {
    const closes = bars.map((b) => b.c);
    const pick = (values: (number | null)[]) => (values[i] === null ? null : (values[i] as number) / 100);
    return {
      MA7: pick(sma(closes, 7)),
      MA25: pick(sma(closes, 25)),
      EMA12: pick(ema(closes, 12)),
      EMA26: pick(ema(closes, 26)),
    };
  };
  const tailAt = (points: Record<string, { time: number; value: number }[]>, time: number) =>
    Object.fromEntries(["MA7", "MA25", "EMA12", "EMA26"].map((k) => [k, points[k]?.find((p) => p.time === time)?.value ?? null]));

  it("末根原地变化:从倒数第二根的 EMA 重推一步,与整段重算一致", () => {
    const bars = series(60);
    let cursor = indicatorCursor(bars, spec);
    const changed = bars.slice();
    changed[59] = { ...changed[59], c: changed[59].c + 37, h: changed[59].h + 40 };
    const { points, cursor: next } = indicatorTail(changed, 59, spec, cursor);
    const got = tailAt(points, chartTime(changed[59].t));
    const want = fullAt(changed, 59);
    for (const k of Object.keys(want) as (keyof typeof want)[]) expect(got[k]).toBeCloseTo(want[k] as number, 9);
    cursor = next;
    expect(cursor.t).toBe(changed[59].t);
  });

  it("一次追加多根(含后台积压):逐根推进,每根都与整段重算一致", () => {
    const all = series(50);
    const cursor = indicatorCursor(all.slice(0, 40), spec);
    const updated = all.slice();
    updated[39] = { ...updated[39], c: updated[39].c - 11 }; // 已画的末根先又变了一次
    const { points } = indicatorTail(updated, 39, spec, cursor);
    for (let i = 39; i < 50; i++) {
      const got = tailAt(points, chartTime(updated[i].t));
      const want = fullAt(updated, i);
      for (const k of Object.keys(want) as (keyof typeof want)[]) expect(got[k]).toBeCloseTo(want[k] as number, 9);
    }
  });

  it("跨过 EMA 起算点(第 period 根)时以前 period 根的 SMA 起算", () => {
    const all = series(30);
    const cursor = indicatorCursor(all.slice(0, 20), spec); // EMA26 此时还没有值
    expect(cursor.ema.EMA26.last).toBeNull();
    const { points } = indicatorTail(all, 20, spec, cursor);
    expect(points.EMA26?.[0].time).toBe(chartTime(all[25].t));
    for (let i = 25; i < 30; i++) expect(tailAt(points, chartTime(all[i].t)).EMA26).toBeCloseTo(fullAt(all, i).EMA26 as number, 9);
    expect(points.MA25?.[0].time).toBe(chartTime(all[24].t));
  });

  it("空游标(图上还没有 bar)从头推,等价于整段计算", () => {
    const bars = series(30);
    const { points } = indicatorTail(bars, 0, spec, indicatorCursor([], spec));
    const full = indicatorSeries(bars, spec);
    for (const k of ["MA7", "MA25", "EMA12", "EMA26"]) {
      expect(points[k] ?? []).toHaveLength(full[k].length);
      (points[k] ?? []).forEach((p, i) => expect(p.value).toBeCloseTo(full[k][i].value, 9));
    }
  });

  it("不改入参游标", () => {
    const bars = series(40);
    const cursor = indicatorCursor(bars.slice(0, 30), spec);
    const snapshot = JSON.stringify(cursor);
    indicatorTail(bars, 29, spec, cursor);
    expect(JSON.stringify(cursor)).toBe(snapshot);
  });
});

describe("buildChartOptions", () => {
  // DeepPartial 把函数型选项变成了不可调用的类型,测试里按图表库的真实签名取出来调用
  type Options = ReturnType<typeof buildChartOptions>;
  const priceFormatter = (o: Options) => o.localization?.priceFormatter as unknown as (price: number) => string;
  const tickMarkFormatter = (o: Options) => o.timeScale?.tickMarkFormatter as unknown as (time: unknown, type: number, locale: string) => string | null;
  const timeFormatter = (o: Options) => o.localization?.timeFormatter as unknown as (time: unknown) => string;

  it("颜色与字体全部来自传入的 token", () => {
    const o = buildChartOptions(TOKENS);
    expect(o.layout?.background).toEqual({ type: "solid", color: TOKENS.panel });
    expect(o.layout?.textColor).toBe(TOKENS.muted);
    expect(o.layout?.fontFamily).toBe(TOKENS.fontMono);
    expect(o.grid?.vertLines?.color).toBe(TOKENS.border);
    expect(o.grid?.horzLines?.color).toBe(TOKENS.border);
    expect(o.rightPriceScale?.borderColor).toBe(TOKENS.border);
    expect(o.timeScale?.borderColor).toBe(TOKENS.border);
    expect(o.crosshair?.vertLine?.color).toBe(TOKENS.muted);
    expect(o.crosshair?.horzLine?.labelBackgroundColor).toBe(TOKENS.muted);
    expect(o.autoSize).toBe(true);
    expect(o.handleScroll).toEqual({ vertTouchDrag: false }); // 触屏竖向拖动留给页面滚动
    // 换一组 token(外观切换后重读)→ 输出跟着换
    const other = buildChartOptions({ ...TOKENS, panel: "#ffffff", muted: "#111111" });
    expect(other.layout?.background).toEqual({ type: "solid", color: "#ffffff" });
    expect(other.layout?.textColor).toBe("#111111");
  });

  it("价格轴按标的精度与语言格式化(图表值是元,formatPrice 收分)", () => {
    const en = buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 2, timeVisible: true, shift: 0, tz: "local" });
    expect(priceFormatter(en)(1234.5)).toBe("1,234.50");
    const zero = buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 0, timeVisible: true, shift: 0, tz: "local" });
    expect(priceFormatter(zero)(70.4)).toBe("70");
    expect(en.localization?.locale).toBe("en-US");
  });

  it("日线不显示时刻", () => {
    expect(buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 2, timeVisible: false, shift: 0, tz: "local" }).timeScale?.timeVisible).toBe(false);
    expect(buildChartOptions(TOKENS).timeScale?.timeVisible).toBe(true);
  });

  it("日内:刻度收平移后的秒、读作本地时刻;十字线标签减回平移,与读数(formatChartTime)一致", () => {
    const at = new Date(2026, 8, 28, 14, 5).getTime(); // 本地 2026-09-28 14:05
    const shift = chartShiftFor("1m", at, "local");
    const o = buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 2, timeVisible: true, shift, tz: "local" });
    const sec = chartTime(at, shift);
    expect(tickMarkFormatter(o)(sec, 3, "en-US")).toBe("14:05");
    expect(tickMarkFormatter(o)(sec, 0, "en-US")).toBe("2026");
    expect(tickMarkFormatter(o)("2026-09-28", 3, "en-US")).toBeNull();
    expect(timeFormatter(o)(sec)).toBe(formatChartTime(at, "en-US", false, "local"));
    expect(formatChartTime(at, "en-US", false, "local")).toContain("14:05");
    // 日刻度落在本地零点那根上,标签是本地日期(不再是 UTC 日界上的前一天 / 后一天)
    const midnight = new Date(2026, 8, 28).getTime();
    expect(tickMarkFormatter(o)(chartTime(midnight, chartShiftFor("1m", midnight, "local")), 2, "en-US")).toBe("28");
    expect(tickMarkFormatter(o)(chartTime(midnight, chartShiftFor("1m", midnight, "local")), 1, "en-US")).toBe("Sep");
  });

  it("日线只显示日期,按 UTC(桶从 UTC 零点起,本地时区在西半球会差一天)", () => {
    const o = buildChartOptions(TOKENS, { locale: "en-US", pricePrecision: 2, timeVisible: false, shift: chartShiftFor("1d", Date.now(), "local"), tz: "local" });
    const utcMidnight = Date.UTC(2026, 8, 28);
    expect(formatChartTime(utcMidnight, "en-US", true, "local")).toBe("09/28/2026");
    expect(timeFormatter(o)(utcMidnight / 1000)).toBe("09/28/2026");
    expect(tickMarkFormatter(o)(utcMidnight / 1000, 2, "en-US")).toBe("28");
    expect(tickMarkFormatter(o)(Date.UTC(2026, 0, 1) / 1000, 0, "en-US")).toBe("2026");
  });
});

describe("series options", () => {
  it("K 线本体用 --up / --down", () => {
    const o = candleSeriesOptions(TOKENS);
    expect([o.upColor, o.borderUpColor, o.wickUpColor]).toEqual([TOKENS.up, TOKENS.up, TOKENS.up]);
    expect([o.downColor, o.borderDownColor, o.wickDownColor]).toEqual([TOKENS.down, TOKENS.down, TOKENS.down]);
  });

  it("分时 Area:线用 --series,填充由 --series 派生半透明渐变", () => {
    const o = areaSeriesOptions(TOKENS);
    expect(o.lineColor).toBe(TOKENS.series);
    expect(o.topColor).toBe(withAlpha(TOKENS.series, 0.28));
    expect(o.bottomColor).toBe(withAlpha(TOKENS.series, 0));
    expect(areaSeriesOptions({ ...TOKENS, series: "currentColor" }).topColor).toBe("transparent");
  });

  it("MA7 / MA25 / MA99 = --series-2 / -3 / -4 实线;EMA12 / EMA26 同色虚线;指标线不占价格标签", () => {
    const opts = Object.fromEntries(INDICATOR_LINES.map((l) => [l.key, indicatorLineOptions(l, TOKENS)]));
    expect([opts.MA7.color, opts.MA25.color, opts.MA99.color]).toEqual([TOKENS.series2, TOKENS.series3, TOKENS.series4]);
    expect([opts.EMA12.color, opts.EMA26.color]).toEqual([TOKENS.series2, TOKENS.series3]);
    expect(opts.MA7.lineStyle).toBe(0);
    expect(opts.EMA12.lineStyle).toBe(2);
    for (const o of Object.values(opts)) {
      expect(o.lastValueVisible).toBe(false);
      expect(o.priceLineVisible).toBe(false);
    }
  });

  it("VOL 在独立的 vol 价格轴(底部 20%),开关 VOL 时主轴让出底部", () => {
    const v = volumeSeriesOptions();
    expect(v.priceScaleId).toBe(VOLUME_SCALE_ID);
    expect(v.priceFormat).toEqual({ type: "volume" });
    expect(v.lastValueVisible).toBe(false);
    expect(mainScaleMargins(true).bottom).toBeGreaterThan(mainScaleMargins(false).bottom);
  });

  it("priceFormat:精度钳到 0..2,minMove = tickSize / 100(图表值是元)", () => {
    expect(priceFormatOf(2, 1)).toEqual({ type: "price", precision: 2, minMove: 0.01 });
    expect(priceFormatOf(2, 5)).toEqual({ type: "price", precision: 2, minMove: 0.05 });
    expect(priceFormatOf(4, 1).precision).toBe(2);
    expect(priceFormatOf(0, 0)).toEqual({ type: "price", precision: 0, minMove: 1 });
  });
});

describe("withAlpha", () => {
  it("六位 / 三位十六进制 → 八位十六进制;其它写法返回 null", () => {
    expect(withAlpha("#16a34a", 0.5)).toBe("#16a34a80");
    expect(withAlpha("#abc", 1)).toBe("#aabbccff");
    expect(withAlpha(" #16A34A ", 0)).toBe("#16A34A00");
    expect(withAlpha("currentColor", 0.5)).toBeNull();
    expect(withAlpha("", 0.5)).toBeNull();
  });
});

describe("readChartTokens", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("在传入的元素上读计算值(终端 token 挂在 [data-terminal] 上),去掉首尾空白", () => {
    const values: Record<string, string> = Object.fromEntries(
      Object.entries(CHART_TOKEN_VARS).map(([k, v]) => [v, ` ${TOKENS[k as keyof ChartTokens]} `]),
    );
    const root = { nodeName: "DIV" } as unknown as HTMLElement;
    const getComputedStyle = vi.fn((el: Element) => {
      expect(el).toBe(root);
      return { getPropertyValue: (name: string) => values[name] ?? "" } as CSSStyleDeclaration;
    });
    vi.stubGlobal("getComputedStyle", getComputedStyle);
    expect(readChartTokens(root)).toEqual(TOKENS);
    expect(getComputedStyle).toHaveBeenCalledTimes(1);
  });

  it("读不到的 token 退到相近的 token,不留空串(空串会让图表库解析失败)", () => {
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => (name === "--foreground" ? "#eeeeee" : "") }) as unknown as CSSStyleDeclaration);
    const t = readChartTokens({} as HTMLElement);
    expect(t.panel).toBe("transparent");
    expect(t.muted).toBe("#eeeeee");
    expect(t.up).toBe("#eeeeee");
    expect(t.series2).toBe("#eeeeee");
    expect(t.fontMono).toBe("monospace");
    for (const v of Object.values(t)) expect(v).not.toBe("");
  });
});

describe("barIndexAt", () => {
  it("按图表时间(UTC 秒)二分查找 bar;不在序列里返回 -1", () => {
    const bars = series(200);
    expect(barIndexAt(bars, chartTime(bars[0].t))).toBe(0);
    expect(barIndexAt(bars, chartTime(bars[137].t))).toBe(137);
    expect(barIndexAt(bars, chartTime(bars[199].t))).toBe(199);
    expect(barIndexAt(bars, chartTime(bars[10].t) + 1)).toBe(-1);
    expect(barIndexAt([], 123)).toBe(-1);
  });

  it("十字线给的是平移后的时间:按同一个 shift 找", () => {
    const bars = series(50);
    const shift = 19_800;
    expect(barIndexAt(bars, chartTime(bars[42].t, shift), shift)).toBe(42);
    expect(barIndexAt(bars, chartTime(bars[42].t, shift))).toBe(-1);
  });
});

describe("readoutValues", () => {
  it("OHLC 按标的精度、V 按 qtyStep,带千分位", () => {
    const values = readoutValues({ t: T0, o: 123456, h: 123999, l: 120000, c: 123400, v: 12500 }, { pricePrecision: 2, qtyStep: 1, locale: "en-US" });
    expect(values).toEqual({ o: "1,234.56", h: "1,239.99", l: "1,200.00", c: "1,234.00", v: "12,500" });
  });
});
