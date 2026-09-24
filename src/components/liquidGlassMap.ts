// 液态玻璃的边缘折射:给 SVG feDisplacementMap 用的位移贴图(纯函数,无 DOM)。
// 玻璃中央完全不动;只有沿边一圈(band 像素宽)把背景「向外」抽样——像透过一块厚玻璃板的圆边看东西,
// 边上的景物被压缩、弯折。贴图编码:R = 横向位移、G = 纵向位移,128 为不动;滤镜的 scale 决定最大位移的像素数。
// 贴图必须按元素尺寸生成(边缘带是固定像素宽,不随元素拉伸),所以由 LiquidGlassRefraction 逐元素调用。

export type GlassShape = { width: number; height: number; radius: number; band: number };
export type DisplacementMap = { width: number; height: number; data: Uint8ClampedArray };

export const NEUTRAL = 128;

/** 圆角矩形的有符号距离(内负外正)与朝外的法线;radius 超过短边一半时按胶囊算 */
export function roundedRectField(x: number, y: number, { width, height, radius }: GlassShape): { d: number; nx: number; ny: number } {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const px = x - width / 2;
  const py = y - height / 2;
  const qx = Math.abs(px) - (width / 2 - r);
  const qy = Math.abs(py) - (height / 2 - r);
  const sx = px < 0 ? -1 : 1;
  const sy = py < 0 ? -1 : 1;
  if (qx > 0 && qy > 0) {
    const len = Math.hypot(qx, qy); // 圆角区:法线指向离圆心的方向
    return { d: len - r, nx: (qx / len) * sx, ny: (qy / len) * sy };
  }
  if (qx > qy) return { d: qx - r, nx: sx, ny: 0 };
  return { d: qy - r, nx: 0, ny: sy };
}

/** 弯折随离边距离的分布:t = 1 在边上、0 在带的内缘。四分之一圆的轮廓——越贴边越陡,像磨圆的玻璃边 */
export function rimProfile(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.sqrt(1 - c * c);
}

/** 按 CSS 像素尺寸生成贴图;resolution < 1 时贴图更小(位移场很平滑,拉伸回去看不出),数据量按平方下降 */
export function renderDisplacementMap(shape: GlassShape, resolution = 1): DisplacementMap {
  const width = Math.max(0, Math.ceil(shape.width * resolution));
  const height = Math.max(0, Math.ceil(shape.height * resolution));
  const data = new Uint8ClampedArray(width * height * 4);
  let i = 0;
  for (let my = 0; my < height; my++) {
    const y = (my + 0.5) / resolution;
    for (let mx = 0; mx < width; mx++) {
      const x = (mx + 0.5) / resolution;
      const { d, nx, ny } = roundedRectField(x, y, shape);
      let bend = 0;
      if (d < 0) bend = rimProfile(1 + d / shape.band); // 带外 t ≤ 0 → 0
      data[i++] = Math.round(NEUTRAL + 127 * nx * bend);
      data[i++] = Math.round(NEUTRAL + 127 * ny * bend);
      data[i++] = 0;
      data[i++] = 255;
    }
  }
  return { width, height, data };
}
