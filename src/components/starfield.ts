// carbadia.co 深色模式的视差星空,移植自 sites/co-landing/worker.js 的「视差星空」一节,常量逐字相同:
// 星按深度分布,透视投影,向观者缓漂 + 闪烁。这里只有数学,没有 DOM;画布与循环在 StarfieldCanvas.tsx。

export type Star = { x: number; y: number; z: number; tw: number; warm: boolean };
export type Viewport = { vw: number; vh: number };
/** 画一颗星:圆心与半径(CSS px)、不透明度、是否暖色 */
export type PaintStar = (px: number, py: number, r: number, alpha: number, warm: boolean) => void;

export const COOL_RGB = "205,218,255";
export const WARM_RGB = "255,238,214"; // 少量暖色星

const DRIFT_PER_MS = 0.0000264; // 向观者缓漂:近星快、远星慢,产生纵深
const NEAREST = 0.14; // 漂到这么近就重生
const TWINKLE_PER_MS = 0.0018;
const OFFSCREEN_MARGIN = 4;
const SETTLE_PASSES = 32;

/** 星数跟视口面积走,夹在 140 与 400 之间 */
export function starCount({ vw, vh }: Viewport): number {
  return Math.max(140, Math.min(400, Math.round((vw * vh) / 5500)));
}

/** 就地重生一颗星:位置、深度、闪烁相位、冷暖全部重掷 */
export function resetStar(star: Star, rnd: () => number = Math.random): Star {
  star.x = rnd() * 2 - 1;
  star.y = rnd() * 2 - 1;
  star.z = 0.15 + rnd() * 0.85;
  star.tw = rnd() * 6.28;
  star.warm = rnd() < 0.12;
  return star;
}

/**
 * 推进并画一帧(即 .co 的 drawStars)。t 是时钟、dt 是距上一帧的毫秒数,静帧传 0;
 * still=true(reduce-motion)时不漂移、不闪烁。漂到眼前的星就地重生;出画的星也就地重生,但当帧不画。
 * 返回这一帧画出的星数。
 */
export function paintField(
  field: Star[],
  { vw, vh }: Viewport,
  t: number,
  dt: number,
  still: boolean,
  paint: PaintStar,
  rnd: () => number = Math.random,
): number {
  const cx = vw / 2;
  const cy = vh / 2;
  const scale = Math.min(vw, vh) * 0.75;
  let painted = 0;
  for (const star of field) {
    if (!still && dt > 0) {
      star.z -= DRIFT_PER_MS * dt;
      if (star.z < NEAREST) resetStar(star, rnd);
    }
    const px = cx + (star.x / star.z) * scale;
    const py = cy + (star.y / star.z) * scale;
    if (px < -OFFSCREEN_MARGIN || px > vw + OFFSCREEN_MARGIN || py < -OFFSCREEN_MARGIN || py > vh + OFFSCREEN_MARGIN) {
      resetStar(star, rnd);
      continue;
    }
    const depth = 1 - star.z; // 0 远 → 1 近
    const twinkle = still ? 1 : 0.78 + 0.22 * Math.sin(t * TWINKLE_PER_MS + star.tw);
    paint(px, py, 0.3 + depth * 1.5, (0.15 + depth * 0.7) * twinkle, star.warm);
    painted++;
  }
  return painted;
}

const skipPaint: PaintStar = () => {};

/**
 * 把星场补到 / 裁到视口对应的星数。已有的星原位保留(坐标是归一化的,换了视口自然重新投影),
 * 所以 resize 不会整场重洗。随机撒出的星只有约三成落在画内:这里先把画外的重掷进来,
 * 第一帧(也是 reduce-motion 下唯一的一帧)就是满密度。
 */
export function fitField(field: Star[], view: Viewport, rnd: () => number = Math.random): Star[] {
  const count = starCount(view);
  while (field.length < count) field.push(resetStar({ x: 0, y: 0, z: 1, tw: 0, warm: false }, rnd));
  field.length = count;
  for (let pass = 0; pass < SETTLE_PASSES; pass++) {
    if (paintField(field, view, 0, 0, true, skipPaint, rnd) === count) break;
  }
  return field;
}
