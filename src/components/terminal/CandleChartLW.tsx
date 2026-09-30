"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type PriceFormatBuiltIn,
  type Time,
} from "lightweight-charts";
import type { CandleBar, CandleInterval } from "@/shared";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useLowPower } from "@/hooks/useLowPower";
import { htmlLang, useLang, useT } from "@/i18n/LangProvider";
import {
  INDICATOR_LINES,
  INDICATOR_SPEC,
  VOLUME_SCALE_ID,
  VOLUME_SCALE_MARGINS,
  areaSeriesOptions,
  barIndexAt,
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
  type ChartFormat,
  type ChartHistory,
  type ChartMode,
  type ChartTokens,
  type IndicatorCursor,
} from "@/lib/market/chart-adapter";
import type { IndicatorPrefs } from "@/lib/market/prefs";
import { useCandles, useInstrument } from "@/lib/market/selectors";

export type CandleChartLWProps = {
  symbol: string;
  interval: CandleInterval;
  /** candle = K 线;line = 分时(interval 1m 的 Area) */
  mode: ChartMode;
  indicators: IndicatorPrefs;
  /** ChartPanel 为当前 (symbol, interval) 取的 REST 历史;loading 期间先画 store 里已有的实时 bar */
  history: ChartHistory;
  /** 十字线读数变化(指针或键盘);null = 清除 */
  onReadout?: (bar: CandleBar | null) => void;
};

/** useLowPower 时实时更新的最小间隔 */
const LOW_POWER_THROTTLE_MS = 500;
const EMPTY: CandleBar[] = [];
/** 图表库 timeScale.barSpacing 的默认值 */
const CANDLE_BAR_SPACING = 6;
const LEGEND_CLASS = { series2: "text-series-2", series3: "text-series-3", series4: "text-series-4" } as const;

type Main = { mode: "candle"; api: ISeriesApi<"Candlestick"> } | { mode: "line"; api: ISeriesApi<"Area"> };

/** 图表实例与它上面画着什么;只在 effect 与事件处理器里读写(渲染期不碰) */
type Handles = {
  chart: IChartApi;
  volume: ISeriesApi<"Histogram">;
  lines: Map<string, ISeriesApi<"Line">>;
  main: Main | null;
  tokens: ChartTokens;
  /** format.shift = 图上这段数据的时间平移(秒);整段 setData 时取一次,增量、十字线、换色都用它 */
  format: ChartFormat;
  priceFormat: PriceFormatBuiltIn;
  /** 最近一次全量 setData 的 `${symbol}:${interval}:${mode}`、interval、所用的 REST 历史与它的截止点 */
  drawnKey: string | null;
  interval: CandleInterval;
  drawnHistory: readonly CandleBar[] | null;
  cutoff: number | null;
  /** 图上当前的 bar(按 t 升序;键盘读数、量柱重着色、指标增量、planDraw 对账都以它为准) */
  bars: CandleBar[];
  cursor: IndicatorCursor;
  timer: ReturnType<typeof setTimeout> | null;
  lastTailAt: number;
};

type Readout = { bar: CandleBar; via: "pointer" | "keyboard" };

const mainStyle = (mode: ChartMode, tokens: ChartTokens) => (mode === "line" ? areaSeriesOptions(tokens) : candleSeriesOptions(tokens));

/** 主序列按 mode 取用:换 mode 时删掉旧的再建(图表本身不重建);序号 1 = 量柱之上、指标线之下,右侧价格轴从它取格式 */
function ensureMain(h: Handles, mode: ChartMode): Main {
  if (h.main?.mode === mode) return h.main;
  if (h.main) h.chart.removeSeries(h.main.api);
  const main: Main =
    mode === "line"
      ? { mode, api: h.chart.addSeries(AreaSeries, { ...areaSeriesOptions(h.tokens), priceFormat: h.priceFormat }) }
      : { mode, api: h.chart.addSeries(CandlestickSeries, { ...candleSeriesOptions(h.tokens), priceFormat: h.priceFormat }) };
  main.api.setSeriesOrder(1);
  h.main = main;
  return main;
}

function updateMain(main: Main, bar: CandleBar, shift: number): void {
  if (main.mode === "line") main.api.update(toLinePoint(bar, shift));
  else main.api.update(toChartBar(bar, shift));
}

/**
 * 全量 setData。reset = 换了键或该键的 REST 历史到达:K 线回到最新、分时 fitContent;
 * 同一键内的重画(planDraw 判出空档 / 已收盘 bar 被校准改写 / 积压)保留用户当前的平移与缩放(图表库按右侧偏移锚定),
 * 分时只在重画前整段可见时再 fitContent。时间平移(chartShiftFor)在这里取一次,整段数据共用。
 */
function drawAll(h: Handles, bars: readonly CandleBar[], mode: ChartMode, interval: CandleInterval, reset: boolean): void {
  const timeScale = h.chart.timeScale();
  const fresh = reset || h.bars.length === 0;
  const range = !fresh && mode === "line" ? timeScale.getVisibleLogicalRange() : null;
  const wasFit = range !== null && range.from < 1 && range.to > h.bars.length - 2;
  const fromLine = h.main?.mode === "line";
  const main = ensureMain(h, mode);
  const shift = chartShiftFor(interval);
  h.interval = interval;
  if (shift !== h.format.shift) {
    h.format = { ...h.format, shift };
    h.chart.applyOptions(buildChartOptions(h.tokens, h.format));
  }
  // 分时 fitContent 会把 1440 根挤进一屏(柱距不到一个像素);回到 K 线时恢复图表库默认柱距,其余情况保留用户的缩放
  if (mode === "candle" && fromLine) timeScale.applyOptions({ barSpacing: CANDLE_BAR_SPACING });
  if (main.mode === "line") main.api.setData(bars.map((b) => toLinePoint(b, shift)));
  else main.api.setData(bars.map((b) => toChartBar(b, shift)));
  const colors = volumeColors(h.tokens);
  h.volume.setData(bars.map((b) => toVolumeBar(b, colors, shift)));
  const lines = indicatorSeries(bars, INDICATOR_SPEC, shift);
  for (const [key, series] of h.lines) series.setData(lines[key] ?? []);
  h.cursor = indicatorCursor(bars, INDICATOR_SPEC);
  h.bars = bars.slice();
  if (fresh) {
    if (mode === "line") timeScale.fitContent();
    else timeScale.scrollToRealTime();
  } else if (wasFit) timeScale.fitContent();
}

/**
 * 增量:live[from..](t 都 ≥ 图上末根的 t,planDraw 给出的尾巴,通常就是末根一根)逐根 series.update,
 * 指标只推这些根(indicatorTail)。
 */
function drawTail(h: Handles, live: readonly CandleBar[], from: number): void {
  const main = h.main;
  if (!main || h.bars.length === 0) return;
  const shift = h.format.shift;
  const colors = volumeColors(h.tokens);
  let fromDrawn = h.bars.length;
  for (let i = from; i < live.length; i++) {
    const bar = live[i];
    const n = h.bars.length;
    if (h.bars[n - 1].t === bar.t) {
      h.bars[n - 1] = bar;
      fromDrawn = Math.min(fromDrawn, n - 1);
    } else {
      h.bars.push(bar);
      fromDrawn = Math.min(fromDrawn, n);
    }
    updateMain(main, bar, shift);
    h.volume.update(toVolumeBar(bar, colors, shift));
  }
  // 指标窗口取图上的 bar(含 REST 历史),不取 store:store 里可能只有订阅之后的几根
  const { points, cursor } = indicatorTail(h.bars, fromDrawn, INDICATOR_SPEC, h.cursor, shift);
  for (const [key, list] of Object.entries(points)) {
    const series = h.lines.get(key);
    if (series) for (const point of list) series.update(point);
  }
  h.cursor = cursor;
}

/**
 * store 里当前键的 bar 变了:planDraw 决定不动 / 只推尾巴 / 整段重画。重画用 redrawBars(已画的 REST 历史, 图上的 bar, store):
 * 截止点之后的 store bar(含断线恢复后校准补进来的空档)全部进图;store 已够不到截止点时(只留最新 MAX_BARS 根),
 * 图上早于 store 首根的 bar 原样保留,不丢那几个小时;图上超过上限时只裁最旧的、store 之前的 bar。
 */
function applyLive(h: Handles, live: readonly CandleBar[]): void {
  const plan = planDraw(h.bars, live, h.cutoff);
  if (plan.kind === "tail") drawTail(h, live, plan.from);
  else if (plan.kind === "redraw") drawAll(h, redrawBars(h.drawnHistory, h.bars, live), h.main?.mode ?? "candle", h.interval, false);
}

/** 键盘移动十字线时,目标 bar 不在可视范围就平移时间轴把它露出来 */
function revealIndex(chart: IChartApi, index: number): void {
  const timeScale = chart.timeScale();
  const range = timeScale.getVisibleLogicalRange();
  if (!range || (index >= range.from && index <= range.to)) return;
  const span = range.to - range.from;
  const from = index < range.from ? index - 1 : index + 1 - span;
  timeScale.setVisibleLogicalRange({ from, to: from + span });
}

/**
 * K 线图本体(计划 §3.1、§3.6「图表适配」、§5.1):lightweight-charts 5 的薄包装,只经 ChartPanel 的
 * next/dynamic({ ssr: false }) 加载 —— 图表库落在独立 chunk,首屏不下载。
 *   - 图表只创建一次;全量 setData 在 (symbol, interval, mode) 变化、该键的 REST 历史到达时发生
 *     (mergeHistory 合并订阅后缓冲在 store 里的实时 bar);其余时候 store 变化交给 planDraw:平时只 series.update 尾巴,
 *     尾巴之前的 bar 被补进 / 改写(断线恢复后校准补的空档、轮询校准修正已收盘的 bar)或积压过多时整段重画一次,保留视图;
 *   - 日内 interval 的时间平移到本地时区(chartShiftFor),刻度落在本地整点 / 零点;日线按 UTC;
 *   - 指标 MA 7/25/99、EMA 12/26 全量用 indicatorSeries,实时只推新根(smaLast / emaNext);VOL 是 "vol" 价格轴上的直方图;
 *   - 主题:MutationObserver 盯 <html> 的 data-theme / data-updown,变了就重读 token → applyOptions,不重建;
 *     量柱颜色逐根写在数据里,所以换色时量柱整列重设一次;
 *   - 键盘:图表容器可聚焦,← → 逐根移动十字线、Home / End 到两端、Esc 清除,读数经 sr-only 的 aria-live 播报
 *     (移植旧 CandleChart);指针悬停只更新可见读数,不播报;
 *   - useLowPower(触屏 / 窄屏 / 减弱动效)时实时更新节流到 500 ms;dir="ltr":RTL 界面下时间轴也从左到右。
 */
export default function CandleChartLW({ symbol, interval, mode, indicators, history, onReadout }: CandleChartLWProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const locale = htmlLang(lang);
  const hintId = useId();
  const live = useCandles(symbol, interval);
  const instrument = useInstrument(symbol);
  const pricePrecision = instrument?.pricePrecision ?? 2;
  const tickSize = instrument?.tickSize ?? 1;
  const qtyStep = instrument?.qtyStep ?? 1;
  const lowPower = useLowPower();
  const drawKey = `${symbol}:${interval}:${mode}`;

  const hostRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<Handles | null>(null);
  const liveRef = useRef<CandleBar[]>(EMPTY);
  const onReadoutRef = useRef(onReadout);
  const [readout, setReadout] = useState<Readout | null>(null);
  // 换了 (symbol, interval, mode) 就丢掉读数(渲染期按上一次的键调整 state,不走 effect;十字线在全量重画时清除)
  const [readoutKey, setReadoutKey] = useState(drawKey);
  if (readoutKey !== drawKey) {
    setReadoutKey(drawKey);
    setReadout(null);
  }

  useEffect(() => {
    onReadoutRef.current = onReadout;
  }, [onReadout]);

  // 创建图表(一次)+ 指针读数 + 外观跟随
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tokens = readChartTokens(host);
    const chart = createChart(host, buildChartOptions(tokens));
    const volume = chart.addSeries(HistogramSeries, volumeSeriesOptions());
    chart.priceScale(VOLUME_SCALE_ID).applyOptions({ scaleMargins: VOLUME_SCALE_MARGINS });
    const lines = new Map<string, ISeriesApi<"Line">>();
    for (const line of INDICATOR_LINES) lines.set(line.key, chart.addSeries(LineSeries, indicatorLineOptions(line, tokens)));
    const h: Handles = {
      chart,
      volume,
      lines,
      main: null,
      tokens,
      format: { locale: "en-US", pricePrecision: 2, timeVisible: true, shift: 0 },
      priceFormat: priceFormatOf(2, 1),
      drawnKey: null,
      interval: "1m",
      drawnHistory: null,
      cutoff: null,
      bars: [],
      cursor: indicatorCursor([], INDICATOR_SPEC),
      timer: null,
      lastTailAt: 0,
    };
    handlesRef.current = h;

    let reported: CandleBar | null = null;
    const onCrosshairMove = (param: MouseEventParams<Time>) => {
      // 有坐标却没有 sourceEvent 的是图表库自己重算十字线(数据更新、平移)时补发的事件:键盘定下的读数不被它改写,
      // 否则末根每跳一次,aria-live 就会再播报一遍。没有坐标 = 指针离开图表
      if (param.point && !param.sourceEvent) return;
      // param.time 是平移过的图表时间:按图上数据同一个 shift 找 bar
      const index = param.point && typeof param.time === "number" ? barIndexAt(h.bars, param.time, h.format.shift) : -1;
      const bar = index >= 0 ? h.bars[index] : null;
      setReadout((prev) => {
        if (!bar) return prev?.via === "pointer" ? null : prev;
        return prev?.via === "pointer" && prev.bar.t === bar.t ? prev : { bar, via: "pointer" };
      });
      if (bar?.t !== reported?.t) {
        reported = bar;
        onReadoutRef.current?.(bar);
      }
    };
    chart.subscribeCrosshairMove(onCrosshairMove);

    // 外观 / 涨跌翻转:只重读 token 再 applyOptions;量柱颜色在数据里,整列重设一次
    const observer = new MutationObserver(() => {
      h.tokens = readChartTokens(host);
      chart.applyOptions(buildChartOptions(h.tokens, h.format));
      h.main?.api.applyOptions(mainStyle(h.main.mode, h.tokens));
      for (const line of INDICATOR_LINES) lines.get(line.key)?.applyOptions(indicatorLineOptions(line, h.tokens));
      const colors = volumeColors(h.tokens);
      volume.setData(h.bars.map((b) => toVolumeBar(b, colors, h.format.shift)));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-updown"] });

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      if (h.timer !== null) clearTimeout(h.timer);
      chart.remove();
      handlesRef.current = null;
    };
  }, []);

  // 语言 / 精度 / 日线:价格与时间的格式(时间平移 shift 跟着数据走,由 drawAll 更新)
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    h.format = { locale, pricePrecision, timeVisible: interval !== "1d", shift: h.format.shift };
    h.priceFormat = priceFormatOf(pricePrecision, tickSize);
    h.chart.applyOptions(buildChartOptions(h.tokens, h.format));
    h.main?.api.applyOptions({ priceFormat: h.priceFormat });
  }, [locale, pricePrecision, tickSize, interval]);

  // 指标开关:只切 visible(隐藏的线照常增量更新,再打开不用重画);开 VOL 时主价格轴让出底部
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    h.volume.applyOptions({ visible: indicators.vol });
    for (const line of INDICATOR_LINES) h.lines.get(line.key)?.applyOptions({ visible: line.kind === "ma" ? indicators.ma : indicators.ema });
    h.chart.priceScale("right").applyOptions({ scaleMargins: mainScaleMargins(indicators.vol) });
  }, [indicators]);

  // 数据:键或历史变了 → 全量;否则交给 planDraw(平时只推尾巴;低功耗时 500 ms 节流)
  const restBars = history.status === "ready" ? history.bars : null;
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    const bars = live ?? EMPTY;
    liveRef.current = bars;
    if (h.drawnKey !== drawKey || h.drawnHistory !== restBars) {
      if (h.timer !== null) {
        clearTimeout(h.timer);
        h.timer = null;
      }
      if (h.drawnKey !== drawKey) h.chart.clearCrosshairPosition();
      h.drawnHistory = restBars;
      h.cutoff = historyCutoff(restBars);
      drawAll(h, restBars ? mergeHistory(restBars, bars) : bars, mode, interval, true);
      h.drawnKey = drawKey;
      return;
    }
    if (!lowPower) {
      h.lastTailAt = Date.now();
      applyLive(h, bars);
      return;
    }
    if (h.timer !== null) return;
    h.timer = setTimeout(
      () => {
        h.timer = null;
        if (handlesRef.current !== h) return;
        h.lastTailAt = Date.now();
        applyLive(h, liveRef.current);
      },
      Math.max(0, h.lastTailAt + LOW_POWER_THROTTLE_MS - Date.now()),
    );
  }, [drawKey, mode, interval, restBars, live, lowPower]);

  // 键盘十字线:← → 逐根、Home / End 两端、Esc 清除;读数进 aria-live
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const h = handlesRef.current;
      if (!h || !h.main || h.bars.length === 0) return;
      const last = h.bars.length - 1;
      const current = readout ? barIndexAt(h.bars, chartTime(readout.bar.t)) : -1;
      let next: number | null;
      switch (e.key) {
        case "ArrowLeft":
          next = current < 0 ? last : Math.max(0, current - 1);
          break;
        case "ArrowRight":
          next = current < 0 ? last : Math.min(last, current + 1);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = last;
          break;
        case "Escape":
          if (current < 0) return; // 没有十字线时不吞 Esc(留给对话框 / 抽屉)
          next = null;
          break;
        default:
          return;
      }
      e.preventDefault();
      if (next === null) {
        h.chart.clearCrosshairPosition();
        setReadout(null);
        onReadoutRef.current?.(null);
        return;
      }
      const bar = h.bars[next];
      revealIndex(h.chart, next);
      // 收盘价与时间都经适配层换算(分 → 元、ms → 平移后的秒,与图上数据同一个 shift);本组件不自己换单位
      const point = toLinePoint(bar, h.format.shift);
      h.chart.setCrosshairPosition(point.value, point.time, h.main.api);
      setReadout({ bar, via: "keyboard" });
      onReadoutRef.current?.(bar);
    },
    [readout],
  );

  const liveBars = live ?? EMPTY;
  const liveLast = liveBars.length > 0 ? liveBars[liveBars.length - 1] : null;
  const restLast = restBars && restBars.length > 0 ? restBars[restBars.length - 1] : null;
  const latest = liveLast && (!restLast || liveLast.t >= restLast.t) ? liveLast : restLast;
  const hasBars = latest !== null;
  // 可见读数:选中的那根取 store 里的最新值(末根还在跳);没有选中时显示最新一根。播报只用选中那一刻的值
  const selectedIndex = readout ? barIndexAt(liveBars, chartTime(readout.bar.t)) : -1;
  const shown = readout ? (selectedIndex >= 0 ? liveBars[selectedIndex] : readout.bar) : latest;
  const fmt = { pricePrecision, qtyStep, locale };
  const describe = (bar: CandleBar) => `${formatChartTime(bar.t, locale, interval === "1d")} ${t.chart.readout(readoutValues(bar, fmt))}`;
  const text = shown ? describe(shown) : "";
  const announcement = readout?.via === "keyboard" ? describe(readout.bar) : "";

  return (
    <div className="relative min-h-0 flex-1" dir="ltr">
      {/* 宿主可聚焦、自己处理 ← → Home End Esc:角色是 application(不是 img)——读屏在非交互角色上停在浏览模式,
          方向键会被虚拟光标吃掉,十字线与下面的 aria-live 读数都不会出现;roledescription 把「应用程序」换成「交互式图表」 */}
      <div
        ref={hostRef}
        tabIndex={0}
        role="application"
        aria-roledescription={t.a11y.chartRole}
        aria-label={t.a11y.chartRegion}
        aria-describedby={hintId}
        onKeyDown={handleKeyDown}
        className="absolute inset-0 rounded-control focus-visible:outline-none focus-visible:shadow-focus"
      />
      {/* 可见读数:右侧让出价格轴的宽度,窄屏换行也不压住价格标签 */}
      <div className="pointer-events-none absolute left-panel right-16 top-gap z-(--z-readout) flex flex-col items-start gap-gap">
        <div aria-hidden="true" className="flex flex-wrap items-center gap-x-2 text-t-xs text-muted tnum">
          {shown ? <span>{text}</span> : null}
          {indicators.ma || indicators.ema
            ? INDICATOR_LINES.filter((line) => (line.kind === "ma" ? indicators.ma : indicators.ema)).map((line) => (
                <span key={line.key} className={LEGEND_CLASS[line.color]}>
                  {`${line.kind === "ma" ? t.chart.ma : t.chart.ema}${line.period}`}
                </span>
              ))
            : null}
        </div>
        {/* 历史请求失败但图上已有 bar(store 里的实时 / 校准数据):错误与重试缩在读数下面,不挡图表 */}
        {history.status === "error" && hasBars ? (
          <div className="pointer-events-auto">
            <ErrorState message={ui.error} onRetry={history.retry} />
          </div>
        ) : null}
      </div>
      <p id={hintId} className="sr-only">
        {t.chart.a11yHint}
      </p>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {/* 三态(§4.5 只用 Skeleton / EmptyState / ErrorState):只在图上还没有 bar 时占满图表区 */}
      {hasBars ? null : history.status === "error" ? (
        <div className="absolute inset-0 z-(--z-readout) flex items-center justify-center p-panel">
          <ErrorState message={ui.error} onRetry={history.retry} />
        </div>
      ) : history.status === "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <EmptyState title={t.chart.noData} />
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0">
          <Skeleton height="panel" />
        </div>
      )}
    </div>
  );
}
