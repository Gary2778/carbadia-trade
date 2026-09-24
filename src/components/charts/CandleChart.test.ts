import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Candle } from "@/lib/exchange/candles";
import * as candleChartModule from "./CandleChart";

type MiniCandleChartProps = {
  candles: Candle[];
  ariaLabel: string;
  emptyLabel?: string;
};

function miniCandleChart() {
  return (candleChartModule as unknown as { MiniCandleChart?: ComponentType<MiniCandleChartProps> }).MiniCandleChart;
}

describe("MiniCandleChart", () => {
  it("renders one real candle body and wick for every OHLC bucket", () => {
    const Chart = miniCandleChart();
    expect(Chart, "MiniCandleChart export is missing").toBeTypeOf("function");
    if (!Chart) return;

    const candles: Candle[] = [
      { t: "2026-08-27T00:00:00.000Z", o: 10, h: 14, l: 9, c: 13, v: 20 },
      { t: "2026-08-27T00:05:00.000Z", o: 13, h: 15, l: 11, c: 12, v: 16 },
    ];
    const html = renderToStaticMarkup(createElement(Chart, { candles, ariaLabel: "GS-MANG-2022 · 5m candlestick" }));

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="GS-MANG-2022 · 5m candlestick"');
    const bodyTags = html.match(/<rect[^>]*data-candle-body[^>]*>/g) ?? [];
    const wickTags = html.match(/<line[^>]*data-candle-wick[^>]*>/g) ?? [];
    const directions = html.match(/data-direction="(?:up|down)"/g) ?? [];
    const numberAttribute = (tag: string, attribute: string) => Number(tag.match(new RegExp(`${attribute}="([^"]+)"`))?.[1]);

    expect(bodyTags).toHaveLength(2);
    expect(wickTags).toHaveLength(2);
    expect(directions).toEqual(['data-direction="up"', 'data-direction="down"']);
    expect(numberAttribute(bodyTags[0]!, "height")).toBeGreaterThan(numberAttribute(bodyTags[1]!, "height"));
    expect(numberAttribute(wickTags[0]!, "y2") - numberAttribute(wickTags[0]!, "y1")).toBeGreaterThan(
      numberAttribute(wickTags[1]!, "y2") - numberAttribute(wickTags[1]!, "y1")
    );
  });

  it("shows an honest empty state instead of drawing fabricated candles", () => {
    const Chart = miniCandleChart();
    expect(Chart, "MiniCandleChart export is missing").toBeTypeOf("function");
    if (!Chart) return;

    const html = renderToStaticMarkup(
      createElement(Chart, {
        candles: [],
        ariaLabel: "GS-MANG-2022 · 5m candlestick",
        emptyLabel: "GS-MANG-2022: no simulated 5-minute trades",
      })
    );

    expect(html).toContain('data-kline-empty="true"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="GS-MANG-2022: no simulated 5-minute trades"');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-candle-body");
  });
});
