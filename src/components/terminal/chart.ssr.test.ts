import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/i18n/messages/en";
import { candlesUrl } from "@/lib/market/MarketProvider";
import { ChartPanel, selectChartTab } from "./ChartPanel";
import { IndicatorToggles } from "./IndicatorToggles";
import { CHART_TABS, IntervalTabs, chartTabOf, chartViewOf } from "./IntervalTabs";

// K 线面板的服务端标记(计划 §3.1、§9.1 第 7 条:node 环境,不引 jsdom;交互靠内置浏览器手工验收)。
// 图表库只能经 next/dynamic({ ssr: false }) 在浏览器里加载:测试进程一旦 import 它,这个工厂就会抛错让测试失败。
const loaded = vi.hoisted(() => ({ chartLib: false }));
vi.mock("lightweight-charts", () => {
  loaded.chartLib = true;
  throw new Error("lightweight-charts must not be imported by the chart panel's server render");
});

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("ChartPanel SSR", () => {
  const html = renderToStaticMarkup(createElement(ChartPanel, { symbol: "VCS-FOR-2021" }));

  it("图表位置是面板骨架(next/dynamic 的 loading),测试进程没有 import 图表库", () => {
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("t-shimmer");
    expect(html).toContain(en.ui.loading);
    expect(loaded.chartLib).toBe(false);
    // 没有图表库的画布或键盘容器
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain(en.terminal.a11y.chartRegion);
  });

  it("工具条随首屏输出:七个周期页签(服务端快照默认 1m)与三个指标开关(默认 MA、VOL 开)", () => {
    for (const tab of CHART_TABS) expect(html).toContain(`data-interval="${tab}"`);
    expect(count(html, "data-interval=")).toBe(7);
    expect(html).toMatch(/data-interval="1m" aria-pressed="true"/);
    expect(count(html, 'aria-pressed="true"')).toBe(3); // 1m + MA + VOL
    expect(html).toMatch(/data-indicator="ma" aria-pressed="true"/);
    expect(html).toMatch(/data-indicator="ema" aria-pressed="false"/);
    expect(html).toMatch(/data-indicator="vol" aria-pressed="true"/);
    expect(html).toContain(`>${en.terminal.chart.intervals.time}<`);
  });

  it("1m 下不显示 7 天留存提示(只在 4h / 1d)", () => {
    expect(html).not.toContain(en.terminal.chart.retention);
  });

  it("服务端标记恒为默认:客户端切到分时(模块级会话状态)也不影响 SSR 与水合首帧", () => {
    const writes: string[] = [];
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: (_k: string, v: string) => writes.push(v) });
    try {
      selectChartTab("time");
      const again = renderToStaticMarkup(createElement(ChartPanel, { symbol: "VCS-FOR-2021" }));
      expect(again).toMatch(/data-interval="1m" aria-pressed="true"/);
      expect(again).toMatch(/data-interval="time" aria-pressed="false"/);
      expect(JSON.parse(writes[0]).interval).toBe("1m"); // 分时 = interval 1m,经 writePrefs 持久化
    } finally {
      selectChartTab("1m");
      vi.unstubAllGlobals();
    }
  });
});

describe("IntervalTabs / IndicatorToggles", () => {
  it("选中项 aria-pressed,文案取 terminal.chart.intervals.*", () => {
    const html = renderToStaticMarkup(createElement(IntervalTabs, { value: "time", onChange: () => {} }));
    expect(html).toMatch(/data-interval="time" aria-pressed="true"/);
    expect(count(html, 'aria-pressed="true"')).toBe(1);
    for (const tab of CHART_TABS) expect(html).toContain(`>${en.terminal.chart.intervals[tab]}<`);
  });

  it("三个开关各自反映 value", () => {
    const html = renderToStaticMarkup(createElement(IndicatorToggles, { value: { ma: false, ema: true, vol: false }, onChange: () => {} }));
    expect(html).toMatch(/data-indicator="ma" aria-pressed="false"/);
    expect(html).toMatch(/data-indicator="ema" aria-pressed="true"/);
    expect(html).toMatch(/data-indicator="vol" aria-pressed="false"/);
    for (const label of [en.terminal.chart.ma, en.terminal.chart.ema, en.terminal.chart.vol]) expect(html).toContain(`>${label}<`);
  });
});

// P1-25d 终审修复:两组按钮并排在同一条工具栏上,没有名字时读屏只念「组」,分不清哪组是周期、哪组是指标
describe("IntervalTabs / IndicatorToggles 的可访问名", () => {
  it("周期组与指标组各有名字(terminal.chart.intervalLabel / indicatorsLabel),且不相同", () => {
    const intervals = renderToStaticMarkup(createElement(IntervalTabs, { value: "1m", onChange: () => {} }));
    const indicators = renderToStaticMarkup(createElement(IndicatorToggles, { value: { ma: true, ema: false, vol: true }, onChange: () => {} }));
    expect(intervals).toMatch(new RegExp(`^<div role="group" aria-label="${en.terminal.chart.intervalLabel}"`));
    expect(indicators).toMatch(new RegExp(`^<div role="group" aria-label="${en.terminal.chart.indicatorsLabel}"`));
    expect(en.terminal.chart.intervalLabel).not.toBe(en.terminal.chart.indicatorsLabel);
  });
});

describe("图表页签与历史请求", () => {
  it("七个页签按快捷键 1–7 的顺序:分时 / 1m / 5m / 15m / 1h / 4h / 1d", () => {
    expect(CHART_TABS).toEqual(["time", "1m", "5m", "15m", "1h", "4h", "1d"]);
  });

  it("分时 = interval 1m 的 line 模式;其它 interval 一律 candle", () => {
    expect(chartViewOf("time")).toEqual({ interval: "1m", mode: "line" });
    expect(chartViewOf("1m")).toEqual({ interval: "1m", mode: "candle" });
    expect(chartViewOf("4h")).toEqual({ interval: "4h", mode: "candle" });
    for (const tab of CHART_TABS) {
      const view = chartViewOf(tab);
      expect(chartTabOf(view.interval, view.mode)).toBe(tab);
    }
    expect(chartTabOf("5m", "line")).toBe("5m");
  });

  it("图表历史与 MarketProvider.calibrateCandles 用同一个 URL(candlesUrl):分时 / 1m 取最近 24 h(1440 根),其它 500 根", () => {
    expect(candlesUrl("VCS-FOR-2021", "1m")).toBe("/api/market/VCS-FOR-2021/candles?interval=1m&limit=1440");
    expect(candlesUrl("VCS-FOR-2021", "5m")).toBe("/api/market/VCS-FOR-2021/candles?interval=5m&limit=500");
    expect(candlesUrl("A B", "1d")).toBe("/api/market/A%20B/candles?interval=1d&limit=500");
  });
});
