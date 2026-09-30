import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/i18n/messages/en";
import CandleChartLW from "./CandleChartLW";

// 图表宿主的可达性(P1-25d 终审修复):宿主可聚焦、自己处理 ← → Home End Esc,就不能是 role="img" ——
// NVDA / JAWS 在非交互角色上停在浏览模式,方向键被虚拟光标吃掉,handleKeyDown 永远收不到,aria-live 读数也不会出现。
// 这里只渲染服务端标记(effect 不跑,图表实例不会创建);图表库换成空桩,测试进程不加载真实的 lightweight-charts。
vi.mock("lightweight-charts", () => ({
  AreaSeries: {},
  CandlestickSeries: {},
  HistogramSeries: {},
  LineSeries: {},
  createChart: () => {
    throw new Error("createChart must not run during a server render");
  },
}));

const T = en.terminal;

function render(): string {
  return renderToStaticMarkup(
    createElement(CandleChartLW, {
      symbol: "VCS-FOR-2021",
      interval: "1m",
      mode: "candle",
      indicators: { ma: true, ema: false, vol: true },
      history: { status: "loading" },
    }),
  );
}

/** 可聚焦的宿主(tabindex="0" 的那个元素)的开标签 */
function hostTag(html: string): string {
  const tag = html.match(/<div[^>]*tabindex="0"[^>]*>/)?.[0];
  if (!tag) throw new Error("no focusable chart host in the markup");
  return tag;
}

describe("CandleChartLW host semantics", () => {
  it("exposes the keyboard-operable host as an application, not an image", () => {
    const tag = hostTag(render());
    expect(tag).toContain('role="application"');
    expect(tag).not.toContain('role="img"');
    expect(render()).not.toContain('role="img"');
  });

  it("keeps the accessible name and points the description at the key hint", () => {
    const html = render();
    const tag = hostTag(html);
    expect(tag).toContain(`aria-label="${T.a11y.chartRegion}"`);
    const describedBy = tag.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}" class="sr-only">${T.chart.a11yHint.replace(/&/g, "&amp;")}<`);
  });

  it("names the role for screen readers in the page language (aria-roledescription)", () => {
    expect(hostTag(render())).toContain(`aria-roledescription="${T.a11y.chartRole}"`);
  });

  it("keeps a polite live region for the keyboard readout", () => {
    expect(render()).toContain('aria-live="polite"');
  });
});
