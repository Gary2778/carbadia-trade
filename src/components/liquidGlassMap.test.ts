import { describe, expect, it } from "vitest";
import { NEUTRAL, renderDisplacementMap, rimProfile, roundedRectField } from "./liquidGlassMap";

const CARD = { width: 300, height: 200, radius: 16, band: 24 };

function pixel(map: { width: number; data: Uint8ClampedArray }, x: number, y: number) {
  const i = (y * map.width + x) * 4;
  return { r: map.data[i], g: map.data[i + 1], b: map.data[i + 2], a: map.data[i + 3] };
}

describe("liquid glass displacement map", () => {
  it("measures signed distance to a rounded rectangle with an outward normal", () => {
    // 圆心处:深在内部,法线随便指但距离要对
    expect(roundedRectField(150, 100, CARD).d).toBeCloseTo(-100, 6);
    // 左边中点:距离 0,法线朝左
    const left = roundedRectField(0, 100, CARD);
    expect(left.d).toBeCloseTo(0, 6);
    expect(left.nx).toBeCloseTo(-1, 6);
    expect(left.ny).toBeCloseTo(0, 6);
    // 上边:法线朝上
    const top = roundedRectField(150, 5, CARD);
    expect(top.d).toBeCloseTo(-5, 6);
    expect(top.nx).toBeCloseTo(0, 6);
    expect(top.ny).toBeCloseTo(-1, 6);
    // 左上圆角 45° 处:距离 0,法线朝左上
    const c = 16 - 16 / Math.SQRT2;
    const corner = roundedRectField(c, c, CARD);
    expect(corner.d).toBeCloseTo(0, 6);
    expect(corner.nx).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(corner.ny).toBeCloseTo(-Math.SQRT1_2, 6);
    // 圆角外面的那块(方角处):在形状之外
    expect(roundedRectField(1, 1, CARD).d).toBeGreaterThan(0);
  });

  it("clamps the radius to half the shorter side", () => {
    const pill = { width: 120, height: 40, radius: 9999, band: 12 };
    // 半圆端点:距离 0
    expect(roundedRectField(0, 20, pill).d).toBeCloseTo(0, 6);
    // 端点上方 45°:圆心 (20, 20),半径 20
    const p = roundedRectField(20 - 20 / Math.SQRT2, 20 - 20 / Math.SQRT2, pill);
    expect(p.d).toBeCloseTo(0, 6);
    expect(p.nx).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it("concentrates the bend at the very edge, like a rounded glass rim", () => {
    expect(rimProfile(0)).toBe(0);
    expect(rimProfile(1)).toBe(1);
    expect(rimProfile(0.5)).toBeLessThan(0.2);
    expect(rimProfile(0.9)).toBeGreaterThan(0.5);
    // 单调
    let prev = 0;
    for (let t = 0; t <= 1; t += 0.05) {
      expect(rimProfile(t)).toBeGreaterThanOrEqual(prev);
      prev = rimProfile(t);
    }
  });

  it("is neutral deep inside and fully opaque everywhere", () => {
    const map = renderDisplacementMap(CARD);
    expect(map.width).toBe(300);
    expect(map.height).toBe(200);
    expect(map.data).toHaveLength(300 * 200 * 4);
    expect(pixel(map, 150, 100)).toEqual({ r: NEUTRAL, g: NEUTRAL, b: 0, a: 255 });
    // 离边 band + 1 px:已在带外
    expect(pixel(map, 25, 100).r).toBe(NEUTRAL);
    for (let i = 3; i < map.data.length; i += 4) expect(map.data[i]).toBe(255);
  });

  it("bends outward: left edge samples further left, top edge further up", () => {
    const map = renderDisplacementMap(CARD);
    expect(pixel(map, 0, 100).r).toBeLessThan(NEUTRAL - 100);
    expect(pixel(map, 0, 100).g).toBe(NEUTRAL);
    expect(pixel(map, 299, 100).r).toBeGreaterThan(NEUTRAL + 100);
    expect(pixel(map, 150, 0).g).toBeLessThan(NEUTRAL - 100);
    expect(pixel(map, 150, 0).r).toBe(NEUTRAL);
    expect(pixel(map, 150, 199).g).toBeGreaterThan(NEUTRAL + 100);
    // 越往里越弱
    expect(NEUTRAL - pixel(map, 0, 100).r).toBeGreaterThan(NEUTRAL - pixel(map, 6, 100).r);
    expect(NEUTRAL - pixel(map, 6, 100).r).toBeGreaterThan(NEUTRAL - pixel(map, 18, 100).r);
  });

  it("is mirror-symmetric about both axes", () => {
    const map = renderDisplacementMap(CARD);
    for (const [x, y] of [[3, 50], [10, 190], [40, 2], [2, 2], [5, 5]] as const) {
      const a = pixel(map, x, y);
      const b = pixel(map, 299 - x, y);
      const c = pixel(map, x, 199 - y);
      expect(Math.abs(a.r - NEUTRAL)).toBeCloseTo(Math.abs(b.r - NEUTRAL), 0);
      expect(a.g).toBe(b.g);
      expect(Math.abs(a.g - NEUTRAL)).toBeCloseTo(Math.abs(c.g - NEUTRAL), 0);
      expect(a.r).toBe(c.r);
    }
  });

  it("bends diagonally at the rounded corners and stays neutral outside the arc", () => {
    const map = renderDisplacementMap(CARD);
    const c = Math.round(16 - 16 / Math.SQRT2);
    const p = pixel(map, c, c);
    expect(p.r).toBeLessThan(NEUTRAL - 60);
    expect(p.g).toBeLessThan(NEUTRAL - 60);
    expect(Math.abs(p.r - p.g)).toBeLessThanOrEqual(1);
    expect(pixel(map, 0, 0)).toEqual({ r: NEUTRAL, g: NEUTRAL, b: 0, a: 255 });
  });

  it("renders at a lower resolution when asked, keeping the same picture", () => {
    const half = renderDisplacementMap(CARD, 0.5);
    expect(half.width).toBe(150);
    expect(half.height).toBe(100);
    expect(pixel(half, 75, 50).r).toBe(NEUTRAL);
    expect(pixel(half, 0, 50).r).toBeLessThan(NEUTRAL - 80);
    expect(pixel(half, 149, 50).r).toBeGreaterThan(NEUTRAL + 80);
  });

  it("copes with degenerate sizes", () => {
    expect(renderDisplacementMap({ width: 0, height: 0, radius: 8, band: 10 }).data).toHaveLength(0);
    const tiny = renderDisplacementMap({ width: 3, height: 3, radius: 8, band: 10 });
    expect(tiny.data).toHaveLength(36);
    for (let i = 0; i < tiny.data.length; i++) expect(Number.isFinite(tiny.data[i])).toBe(true);
  });
});
