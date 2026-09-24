import { describe, expect, it } from "vitest";
import { COOL_RGB, WARM_RGB, fitField, paintField, resetStar, starCount, type PaintStar, type Star } from "./starfield";

const DESKTOP = { vw: 1440, vh: 900 }; // scale = 900 × 0.75 = 675,圆心 (720, 450)

// 稳定伪随机(mulberry32):同一 seed 每次产生相同序列
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 按顺序吐出给定的数(resetStar 依次取 x、y、z、闪烁相位、冷暖)
function scripted(...values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

function collector() {
  const dots: { px: number; py: number; r: number; alpha: number; warm: boolean }[] = [];
  const paint: PaintStar = (px, py, r, alpha, warm) => dots.push({ px, py, r, alpha, warm });
  return { dots, paint };
}

const star = (x: number, y: number, z: number, tw = 0, warm = false): Star => ({ x, y, z, tw, warm });

describe("carbadia.co starfield", () => {
  it("scales the star count with the viewport area, between 140 and 400", () => {
    expect(starCount({ vw: 390, vh: 844 })).toBe(140); // 60 → 下限
    expect(starCount(DESKTOP)).toBe(236); // 1296000 / 5500 = 235.6
    expect(starCount({ vw: 2560, vh: 1440 })).toBe(400); // 670 → 上限
  });

  it("respawns a star anywhere in the field, at any depth, mostly cool", () => {
    const rnd = seeded(7);
    const stars = Array.from({ length: 2000 }, () => resetStar(star(0, 0, 1), rnd));
    const range = (pick: (s: Star) => number) => [Math.min(...stars.map(pick)), Math.max(...stars.map(pick))];
    for (const [min, max] of [range((s) => s.x), range((s) => s.y)]) {
      expect(min).toBeGreaterThanOrEqual(-1);
      expect(min).toBeLessThan(-0.95);
      expect(max).toBeLessThan(1);
      expect(max).toBeGreaterThan(0.95);
    }
    const [zMin, zMax] = range((s) => s.z);
    expect(zMin).toBeGreaterThanOrEqual(0.15);
    expect(zMin).toBeLessThan(0.17);
    expect(zMax).toBeLessThan(1);
    expect(zMax).toBeGreaterThan(0.97);
    const [twMin, twMax] = range((s) => s.tw);
    expect(twMin).toBeGreaterThanOrEqual(0);
    expect(twMax).toBeLessThan(6.28);
    expect(twMax).toBeGreaterThan(6.1);
    const warmShare = stars.filter((s) => s.warm).length / stars.length;
    expect(warmShare).toBeGreaterThan(0.08);
    expect(warmShare).toBeLessThan(0.16);
    // 冷暖阈值 12%
    expect(resetStar(star(0, 0, 1), scripted(0.5, 0.5, 0, 0, 0.1199)).warm).toBe(true);
    expect(resetStar(star(0, 0, 1), scripted(0.5, 0.5, 0, 0, 0.12)).warm).toBe(false);
    expect(COOL_RGB).toBe("205,218,255");
    expect(WARM_RGB).toBe("255,238,214");
  });

  it("projects a star in perspective: nearer is bigger, brighter, and further from the centre", () => {
    const field = [star(0.2, -0.1, 0.5)];
    const { dots, paint } = collector();
    expect(paintField(field, DESKTOP, 0, 0, true, paint)).toBe(1);
    expect(dots[0].px).toBeCloseTo(720 + (0.2 / 0.5) * 675, 6); // 990
    expect(dots[0].py).toBeCloseTo(450 + (-0.1 / 0.5) * 675, 6); // 315
    expect(dots[0].r).toBeCloseTo(0.3 + 0.5 * 1.5, 9); // depth = 1 − z = 0.5
    expect(dots[0].alpha).toBeCloseTo(0.15 + 0.5 * 0.7, 9);
    expect(dots[0].warm).toBe(false);
    expect(field[0].z).toBe(0.5); // dt = 0:不漂移
    // 竖屏:scale 取短边(390 × 0.75 = 292.5),不是高度
    const portrait = collector();
    paintField([star(0.2, -0.1, 0.5)], { vw: 390, vh: 844 }, 0, 0, true, portrait.paint);
    expect(portrait.dots[0].px).toBeCloseTo(195 + (0.2 / 0.5) * 292.5, 6); // 312
    expect(portrait.dots[0].py).toBeCloseTo(422 + (-0.1 / 0.5) * 292.5, 6); // 363.5
  });

  it("drifts stars towards the viewer by 0.0000264 per millisecond", () => {
    const field = [star(0, 0, 0.5)];
    paintField(field, DESKTOP, 1000, 50, false, () => {});
    expect(field[0].z).toBeCloseTo(0.5 - 0.0000264 * 50, 12);
  });

  it("respawns a star that drifts closer than 0.14, and still paints it that frame", () => {
    const field = [star(0.01, 0.01, 0.1401, 3, true)];
    const { dots, paint } = collector();
    paintField(field, DESKTOP, 0, 100, false, paint, scripted(0.5, 0.5, 0.5, 0, 0.5));
    expect(field[0].x).toBe(0);
    expect(field[0].y).toBe(0);
    expect(field[0].z).toBeCloseTo(0.575, 12); // 0.15 + 0.5 × 0.85
    expect(field[0].warm).toBe(false);
    expect(dots).toHaveLength(1);
    expect(dots[0].px).toBeCloseTo(720, 6);
    expect(dots[0].py).toBeCloseTo(450, 6);
  });

  it("keeps a star that is still just beyond 0.14", () => {
    const field = [star(0, 0, 0.143)];
    paintField(field, DESKTOP, 0, 100, false, () => {}, scripted(0.5, 0.5, 0.5, 0, 0.5));
    expect(field[0].z).toBeCloseTo(0.143 - 0.00264, 12); // 0.14036:还没到 0.14,不重生
  });

  it("respawns a star that leaves the viewport (4px margin) and skips it that frame", () => {
    const inside = star((0.5 * 723) / 675, 0, 0.5); // px = 1443:还在 4px 余量内
    const outside = star((0.5 * 725) / 675, 0, 0.5); // px = 1445:出画
    const { dots, paint } = collector();
    const painted = paintField([inside, outside], DESKTOP, 0, 0, true, paint, scripted(0.5, 0.5, 0.5, 0, 0.5));
    expect(painted).toBe(1);
    expect(dots).toHaveLength(1);
    expect(dots[0].px).toBeCloseTo(1443, 6);
    expect(outside.x).toBe(0); // 已重生到圆心,下一帧才画
    expect(outside.z).toBeCloseTo(0.575, 12);
    // 四条边同一个余量:画内 3px 照画,画外 5px 重生
    const edges: [number, number, number, number][] = [
      [723 / 675, 0, 725 / 675, 0], // 右
      [-723 / 675, 0, -725 / 675, 0], // 左
      [0, 453 / 675, 0, 455 / 675], // 下
      [0, -453 / 675, 0, -455 / 675], // 上
    ];
    for (const [ix, iy, ox, oy] of edges) {
      const pair = [star(ix * 0.5, iy * 0.5, 0.5), star(ox * 0.5, oy * 0.5, 0.5)];
      expect(paintField(pair, DESKTOP, 0, 0, true, () => {}, scripted(0.5, 0.5, 0.5, 0, 0.5))).toBe(1);
      expect(pair[0].z).toBe(0.5);
      expect(pair[1].z).toBeCloseTo(0.575, 12);
    }
  });

  it("twinkles between 56% and 100% of the base brightness", () => {
    const field = [star(0, 0, 0.5, 1.3)];
    const base = 0.15 + 0.5 * 0.7;
    const factors: number[] = [];
    for (let t = 0; t < 4000; t += 25) {
      paintField(field, DESKTOP, t, 0, false, (_px, _py, _r, alpha) => factors.push(alpha / base));
    }
    expect(Math.min(...factors)).toBeGreaterThanOrEqual(0.56 - 1e-9);
    expect(Math.min(...factors)).toBeLessThan(0.58);
    expect(Math.max(...factors)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.max(...factors)).toBeGreaterThan(0.98);
    // t = 0、相位 0:系数恰为 0.78
    const { dots, paint } = collector();
    paintField([star(0, 0, 0.5)], DESKTOP, 0, 0, false, paint);
    expect(dots[0].alpha).toBeCloseTo(base * 0.78, 9);
    // 速率 0.0018 rad/ms:t = 1000 时相位 1.8
    const later = collector();
    paintField([star(0, 0, 0.5)], DESKTOP, 1000, 0, false, later.paint);
    expect(later.dots[0].alpha).toBeCloseTo(base * (0.78 + 0.22 * Math.sin(1.8)), 9);
  });

  it("holds still under reduced motion: no drift, no twinkle", () => {
    const field = [star(0.1, 0.1, 0.5, 2)];
    const { dots, paint } = collector();
    paintField(field, DESKTOP, 1234, 50, true, paint);
    expect(field[0].z).toBe(0.5);
    expect(dots[0].alpha).toBeCloseTo(0.15 + 0.5 * 0.7, 9);
  });

  it("fills the field to the star count with every star already in view", () => {
    const field = fitField([], DESKTOP, seeded(11));
    expect(field).toHaveLength(236);
    // 静帧就是满密度:没有一颗落在画外等下一帧重生
    expect(paintField(field, DESKTOP, 0, 0, true, () => {}, seeded(12))).toBe(236);
  });

  it("survives a canvas that has no size yet", () => {
    const field = fitField([], { vw: 0, vh: 0 }, seeded(5));
    expect(field).toHaveLength(140);
    const { dots, paint } = collector();
    paintField(field, { vw: 0, vh: 0 }, 16, 16, false, paint, seeded(6));
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) expect(Object.values(dot).every((v) => typeof v === "boolean" || Number.isFinite(v))).toBe(true);
  });

  it("keeps existing stars in place when the viewport changes, and only tops up or trims", () => {
    const rnd = seeded(21);
    const field = fitField([], DESKTOP, rnd);
    const before = field.map((s) => ({ ...s }));
    // 同一视口再 fit 一次:什么都不变
    fitField(field, DESKTOP, rnd);
    expect(field).toEqual(before);
    // 视口变宽(高度不变 → 投影比例不变):原有的星一颗不动,只在末尾补新星
    fitField(field, { vw: 1600, vh: 900 }, rnd);
    expect(field).toHaveLength(262); // 1440000 / 5500 = 261.8
    expect(field.slice(0, 236)).toEqual(before);
    // 变回去:裁掉末尾,留下的还是原来那些星对象
    const kept = field.slice(0, 236);
    fitField(field, DESKTOP, rnd);
    expect(field).toHaveLength(236);
    field.forEach((s, i) => expect(s).toBe(kept[i]));
    expect(field).toEqual(before);
  });
});
