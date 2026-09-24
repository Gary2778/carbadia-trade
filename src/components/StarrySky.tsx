"use client";

import { useTheme } from "@/providers/ThemeProvider";
import { useLowPower } from "@/hooks/useLowPower";

// 手绘风格的星空(无山丘)。手绘感来自:
//   1) 一张 SVG 滤镜(分形噪声 + 位移贴图)整体抖动线条,边缘像钢笔/铅笔手绘;
//   2) 描边的"涂鸦"五角星(顶点烘焙抖动、起收笔留开口)、十字闪光、墨点;
//   3) 几道极淡的虚线"星座连线";
//   4) 一颗会周期性划过夜空的流星(CSS 动画,reduced-motion 时静止)。
// 弯月用墨线勾勒(浅填 + 陨石坑 + 放射光泽短线),并带一张 Peppa 风小笑脸。
// 这是第一版 dark 的夜空,现在属于「儿童护眼模式」:只在它开着时渲染,固定铺满视口、置于内容之后、不可交互。
// 所有随机量都在模块加载时烘焙,渲染期不再取随机 → 避免 SSR/CSR 水合不一致。

// 稳定伪随机:同一 seed 在服务端/客户端产生相同序列。
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 本组件唯一的随机来源(模块加载时求值)。
const rnd = mulberry32(0x5a17a);

const INK_COLORS = ["#fff7e6", "#ffffff", "#ffe9a8", "#cfe3ff"];

type Ray = { x1: number; y1: number; x2: number; y2: number; w: number };
type Kind = "star" | "spark" | "dot";
type StarItem = {
  kind: Kind;
  x: number;
  y: number;
  r: number;
  rot: number; // 轻微旋转,避免每颗都正立
  sw: number; // 描边宽度,随尺寸缩放
  color: string;
  d?: string; // 描边五角星的手绘路径(已烘焙抖动)
  rays?: Ray[]; // 十字闪光的射线(已烘焙抖动)
  dur: number;
  delay: number;
};

// 描边"涂鸦五角星":十个外/内顶点各叠加确定性抖动,起收笔留开口,像手绘没收住。
function doodleStarPath(r: number): string {
  const inner = r * 0.42;
  const pts: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2; // 从正上方起笔
    const jx = (rnd() - 0.5) * r * 0.16; // 顶点抖动(烘焙)
    const jy = (rnd() - 0.5) * r * 0.16;
    pts.push([Math.cos(a) * rad + jx, Math.sin(a) * rad + jy]);
  }
  const head = pts[0];
  const start: [number, number] = [head[0] + (rnd() - 0.5) * r * 0.2, head[1] - r * 0.12];
  let d = `M${start[0].toFixed(1)},${start[1].toFixed(1)}`;
  for (let i = 0; i < pts.length; i++) d += ` L${pts[i][0].toFixed(1)},${pts[i][1].toFixed(1)}`;
  d += ` L${head[0].toFixed(1)},${head[1].toFixed(1)}`; // 绕回近起点但不闭合,保留手绘开口
  return d;
}

// 十字闪光:4 长 + 4 短射线,端点抖动已在模块加载时烘焙进数据。
function bakeRays(r: number): Ray[] {
  const long = r;
  const dShort = r * 0.42 * 0.72;
  const j = () => (rnd() - 0.5) * 2;
  return [
    { x1: 0, y1: -long + j(), x2: 0, y2: long + j(), w: 1 },
    { x1: -long + j(), y1: 0, x2: long + j(), y2: 0, w: 1 },
    { x1: -dShort, y1: -dShort, x2: dShort, y2: dShort, w: 0.7 },
    { x1: -dShort, y1: dShort, x2: dShort, y2: -dShort, w: 0.7 },
  ];
}

// 星场(更密一些:上方 ~2/3 天空,以墨点与小星为主,辅以大涂鸦星与十字闪光)。
const STARS: StarItem[] = Array.from({ length: 64 }, () => {
  const roll = rnd();
  const kind: Kind = roll < 0.42 ? "star" : roll < 0.66 ? "spark" : "dot";
  const x = rnd() * 1440;
  const y = 24 + Math.pow(rnd(), 1.3) * 660; // 越往下越稀疏
  let r: number;
  if (kind === "star") r = 6 + rnd() * 10;
  else if (kind === "spark") r = 8 + rnd() * 11;
  else r = 1.5 + rnd() * 2.5;

  return {
    kind,
    x,
    y,
    r,
    rot: (rnd() - 0.5) * 36, // ±18°
    sw: kind === "dot" ? 0 : 1.5 + (r / 22) * 1.1, // 1.5~2.5
    color: INK_COLORS[Math.floor(rnd() * INK_COLORS.length)],
    d: kind === "star" ? doodleStarPath(r) : undefined,
    rays: kind === "spark" ? bakeRays(r) : undefined,
    dur: 2.4 + rnd() * 3.2,
    delay: rnd() * 4.5,
  };
});

// 极淡的"星座连线":挑几颗五角星与其最近邻相连,像随手把星点连成图案。
const STAR_ONLY = STARS.filter((s) => s.kind === "star");
const CONSTELLATIONS: { x1: number; y1: number; x2: number; y2: number }[] = [];
{
  const seen = new Set<string>();
  for (let k = 0; k < 9 && STAR_ONLY.length > 1; k++) {
    const a = STAR_ONLY[Math.floor(rnd() * STAR_ONLY.length)];
    let best: StarItem | null = null;
    let bd = Infinity;
    for (const b of STAR_ONLY) {
      if (b === a) continue;
      const dd = Math.hypot(a.x - b.x, a.y - b.y);
      if (dd < bd) {
        bd = dd;
        best = b;
      }
    }
    if (best && bd < 240) {
      const key = [Math.min(a.x, best.x), Math.min(a.y, best.y), Math.max(a.x, best.x)].map((n) => n.toFixed(0)).join("_");
      if (!seen.has(key)) {
        seen.add(key);
        CONSTELLATIONS.push({ x1: a.x, y1: a.y, x2: best.x, y2: best.y });
      }
    }
  }
}

// 弯月 + 放射光泽短线(角度/长度烘焙)。
const MOON = { cx: 1190, cy: 150, r: 64 };
const SHINE = Array.from({ length: 9 }, (_, i) => {
  const a = -Math.PI * 0.55 + (i / 8) * Math.PI * 1.1 + (rnd() - 0.5) * 0.12; // 朝月牙开口外侧
  const gap = MOON.r + 14 + rnd() * 6;
  const len = 10 + rnd() * 12;
  return {
    x1: MOON.cx + Math.cos(a) * gap,
    y1: MOON.cy + Math.sin(a) * gap,
    x2: MOON.cx + Math.cos(a) * (gap + len),
    y2: MOON.cy + Math.sin(a) * (gap + len),
  };
});

export function StarrySky() {
  const { kids } = useTheme();
  const low = useLowPower();
  if (!kids) return null;

  // 手机/触屏:位移滤镜(feTurbulence+feDisplacementMap)在移动端 GPU 上极贵,且其内 64 颗
  // 眨眼星每帧强制重栅格化整屏 → 卡顿主因。低功耗下:不套滤镜、星数减半、星星静止、去掉流星。
  const stars = low ? STARS.slice(0, 24) : STARS;
  const skyFilter = low ? undefined : "url(#sketchSky)";

  return (
    <div className="fixed inset-0 -z-10 overflow-hidden pointer-events-none" aria-hidden>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
        <defs>
          {/* 粗墨抖动:分形噪声 + 位移贴图,整组应用 → 每条边缘获得有机手绘抖动 */}
          <filter id="sketchSky" x="-20%" y="-20%" width="140%" height="140%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="5" result="noiseSky" />
            <feDisplacementMap in="SourceGraphic" in2="noiseSky" scale="4" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <radialGradient id="moonGlowSky" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffe9a8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#ffe9a8" stopOpacity="0" />
          </radialGradient>
          {/* 月牙浅填:大圆挖小圆 */}
          <mask id="crescentSky">
            <circle cx={MOON.cx} cy={MOON.cy} r={MOON.r} fill="#fff" />
            <circle cx={MOON.cx + 26} cy={MOON.cy - 16} r={MOON.r - 6} fill="#000" />
          </mask>
        </defs>

        {/* 极淡月晕(滤镜外,保持柔和) */}
        <circle cx={MOON.cx} cy={MOON.cy} r={150} fill="url(#moonGlowSky)" />

        {/* 整组套用粗墨抖动滤镜(低功耗下省略,抖动已烘焙进路径,视觉差异极小) */}
        <g filter={skyFilter}>
          {/* ── 星座连线(最底层,极淡虚线) ── */}
          <g stroke="#cfe3ff" strokeWidth={1} strokeLinecap="round" fill="none" opacity="0.2" strokeDasharray="2 7">
            {CONSTELLATIONS.map((c, i) => (
              <line key={i} x1={c.x1.toFixed(1)} y1={c.y1.toFixed(1)} x2={c.x2.toFixed(1)} y2={c.y2.toFixed(1)} />
            ))}
          </g>

          {/* ── 弯月:浅填 + 墨线描边 ── */}
          <circle cx={MOON.cx} cy={MOON.cy} r={MOON.r} fill="#fff7e6" fillOpacity="0.14" mask="url(#crescentSky)" />
          <path
            d={`M${MOON.cx - 2},${MOON.cy - MOON.r + 4}
                A${MOON.r},${MOON.r} 0 1 0 ${MOON.cx - 6},${MOON.cy + MOON.r - 2}
                A${MOON.r - 8},${MOON.r - 8} 0 1 1 ${MOON.cx - 2},${MOON.cy - MOON.r + 4} Z`}
            fill="none"
            stroke="#fff7e6"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <g fill="none" stroke="#ffe9a8" strokeWidth={1.4} strokeLinecap="round" opacity="0.9">
            <circle cx={MOON.cx - 18} cy={MOON.cy + 10} r={6} />
            <circle cx={MOON.cx - 30} cy={MOON.cy - 14} r={4} />
          </g>
          <g stroke="#ffe9a8" strokeWidth={1.6} strokeLinecap="round" opacity="0.75">
            {SHINE.map((s, i) => (
              <line key={i} x1={s.x1.toFixed(1)} y1={s.y1.toFixed(1)} x2={s.x2.toFixed(1)} y2={s.y2.toFixed(1)} />
            ))}
          </g>
          {/* ── 月亮的 Peppa 风小笑脸:点眼 + 微笑 + 腮红(画在月牙下方饱满处) ── */}
          <g>
            <circle cx={MOON.cx - 24} cy={MOON.cy + 34} r={2.6} fill="#fff7e6" />
            <circle cx={MOON.cx - 6} cy={MOON.cy + 36} r={2.6} fill="#fff7e6" />
            <path
              d={`M${MOON.cx - 28},${MOON.cy + 43} Q${MOON.cx - 15},${MOON.cy + 52} ${MOON.cx - 2},${MOON.cy + 44}`}
              fill="none"
              stroke="#fff7e6"
              strokeWidth={1.8}
              strokeLinecap="round"
            />
            <circle cx={MOON.cx - 36} cy={MOON.cy + 42} r={3.4} fill="#ff9ec4" opacity={0.5} />
            <circle cx={MOON.cx + 4} cy={MOON.cy + 44} r={3.4} fill="#ff9ec4" opacity={0.5} />
          </g>

          {/* ── 星场:CSS 眨眼,错峰;reduced-motion 由 globals.css 关闭;低功耗下静止 ── */}
          {stars.map((s, i) => (
            <g
              key={i}
              className="carbadia-star"
              transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)}) rotate(${s.rot.toFixed(1)})`}
              style={low ? undefined : { animation: `carbadia-twinkle ${s.dur.toFixed(2)}s ease-in-out ${s.delay.toFixed(2)}s infinite` }}
            >
              {s.kind === "star" && (
                <path d={s.d} fill={s.color} fillOpacity={0.08} stroke={s.color} strokeWidth={s.sw} strokeLinecap="round" strokeLinejoin="round" />
              )}
              {s.kind === "spark" && (
                <g stroke={s.color} strokeLinecap="round" fill="none">
                  {s.rays!.map((ray, j) => (
                    <line key={j} x1={ray.x1.toFixed(1)} y1={ray.y1.toFixed(1)} x2={ray.x2.toFixed(1)} y2={ray.y2.toFixed(1)} strokeWidth={s.sw * ray.w} />
                  ))}
                </g>
              )}
              {s.kind === "dot" && <circle r={s.r} fill={s.color} />}
            </g>
          ))}
        </g>

        {/* ── 流星:周期性掠过(低功耗下省略,持续动画无谓耗电) ── */}
        {!low && (
        <g transform="translate(300 138)">
          <g className="carbadia-shoot">
            <line x1="0" y1="0" x2="-52" y2="-24" stroke="#fff7e6" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="1 6" opacity="0.85" />
            <circle r="2.4" fill="#fff7e6" />
            <g stroke="#fff7e6" strokeWidth="1.2" strokeLinecap="round" opacity="0.9">
              <line x1="-6" y1="0" x2="6" y2="0" />
              <line x1="0" y1="-6" x2="0" y2="6" />
            </g>
          </g>
        </g>
        )}
      </svg>
    </div>
  );
}
