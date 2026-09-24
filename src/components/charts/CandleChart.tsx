"use client";

import { useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Candle } from "@/lib/exchange/candles";
import { fmtMoney, fmtQty } from "@/lib/format";
import { useT, useLang, htmlLang } from "@/i18n/LangProvider";

const W = 760;
const H = 360;
const VOL_H = 56;
const PAD_R = 56;
const PAD_T = 26;
const PAD_B = 8;

const MINI_W = 96;
const MINI_H = 28;
const MINI_PAD = 2;

export function MiniCandleChart({
  candles,
  ariaLabel,
  emptyLabel = `${ariaLabel}: no candle data`,
}: {
  candles: Candle[];
  ariaLabel: string;
  emptyLabel?: string;
}) {
  if (candles.length === 0) {
    return (
      <span data-kline-empty="true" className="block text-center text-xs text-muted" role="img" aria-label={emptyLabel}>
        —
      </span>
    );
  }

  let lo = Math.min(...candles.map((c) => c.l));
  let hi = Math.max(...candles.map((c) => c.h));
  const rawSpan = hi - lo;
  const domainPad = rawSpan === 0 ? Math.max(Math.abs(hi) * 0.005, 0.5) : rawSpan * 0.08;
  lo -= domainPad;
  hi += domainPad;

  const span = hi - lo;
  const step = MINI_W / candles.length;
  const bodyWidth = Math.max(1.5, Math.min(4.5, step * 0.56));
  const x = (index: number) => index * step + step / 2;
  const y = (price: number) => MINI_PAD + (1 - (price - lo) / span) * (MINI_H - MINI_PAD * 2);

  return (
    <svg
      viewBox={`0 0 ${MINI_W} ${MINI_H}`}
      className="block h-7 w-full min-w-12 max-w-24 overflow-visible"
      role="img"
      aria-label={ariaLabel}
    >
      {candles.map((candle, index) => {
        const isUp = candle.c >= candle.o;
        const className = isUp ? "fill-up stroke-up" : "fill-down stroke-down";
        const bodyTop = y(Math.max(candle.o, candle.c));
        const bodyHeight = Math.max(1.5, Math.abs(y(candle.o) - y(candle.c)));

        return (
          <g key={`${candle.t}-${index}`} className={className} data-direction={isUp ? "up" : "down"}>
            <line
              data-candle-wick="true"
              x1={x(index)}
              y1={y(candle.h)}
              x2={x(index)}
              y2={y(candle.l)}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              data-candle-body="true"
              x={x(index) - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={bodyHeight}
              rx={0.65}
            />
          </g>
        );
      })}
    </svg>
  );
}

export function CandleChart({
  candles,
  lastPrice,
  ariaLabel,
}: {
  candles: Candle[];
  lastPrice: number | null;
  ariaLabel?: string;
}) {
  const t = useT("candleChart");
  const { lang } = useLang();
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const view = useMemo(() => {
    if (candles.length === 0) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let maxV = 1;
    for (const c of candles) {
      lo = Math.min(lo, c.l);
      hi = Math.max(hi, c.h);
      maxV = Math.max(maxV, c.v);
    }
    const span = hi - lo || hi * 0.01 || 1;
    const plotW = W - PAD_R;
    const plotH = H - VOL_H - PAD_T - PAD_B;
    const step = plotW / candles.length;
    const bw = Math.max(2, Math.min(12, step * 0.6));
    return {
      lo,
      hi,
      plotH,
      step,
      bw,
      x: (i: number) => i * step + step / 2,
      y: (p: number) => PAD_T + (1 - (p - lo) / span) * plotH,
      vy: (v: number) => (v / maxV) * (VOL_H - 6),
    };
  }, [candles]);

  if (!view) {
    // 空数据(周期切换清空等):保留网格骨架 + 居中占位,不抛错、无 NaN,尺寸与有数据时一致避免跳动
    const plotH = H - VOL_H - PAD_T - PAD_B;
    return (
      <div className="relative" dir="ltr">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full select-none outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
        >
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <line
              key={f}
              x1={0}
              y1={PAD_T + f * plotH}
              x2={W - PAD_R}
              y2={PAD_T + f * plotH}
              className="stroke-border"
              strokeDasharray="2 4"
              strokeWidth={0.5}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm pointer-events-none">{t.waiting}</div>
      </div>
    );
  }

  const { x, y, vy, bw } = view;
  // 数据切换后 hover 索引可能越界,取不到就当无悬停,避免崩溃
  const hc = hover != null ? (candles[hover] ?? null) : null;

  // 鼠标/触屏/触控笔共用:PointerEvent 覆盖 mousemove 与 touch 拖动
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    // 触屏不 preventDefault:svg 上的 touch-pan-y 保留纵向页面滚动,横向拖动才移动十字线
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round((px - view!.step / 2) / view!.step);
    setHover(Math.max(0, Math.min(candles.length - 1, i)));
  }

  // 键盘检视:←/→ 移动现有 hover 索引,Home/End 跳首尾,Esc 清除,读数条随之播报
  function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    const last = candles.length - 1;
    let next: number | null;
    switch (e.key) {
      case "ArrowLeft":
        next = hover == null ? last : Math.max(0, hover - 1);
        break;
      case "ArrowRight":
        next = hover == null ? last : Math.min(last, hover + 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "Escape":
        next = null;
        break;
      default:
        return;
    }
    e.preventDefault();
    setHover(next);
  }

  return (
    // 图表坐标系恒为 LTR(时间从左到右),RTL 界面下也不翻转
    <div className="relative" dir="ltr">
      <div
        aria-live="polite"
        className="absolute top-0 left-2 z-10 text-[11px] tnum text-muted flex flex-wrap gap-x-3 bg-surface/80 backdrop-blur px-2 py-0.5 rounded"
      >
        {hc ? (
          <>
            <span>{new Date(hc.t).toLocaleString(htmlLang(lang), { hour12: false })}</span>
            <span>{t.open} {fmtMoney(hc.o)}</span>
            <span className="text-up">{t.high} {fmtMoney(hc.h)}</span>
            <span className="text-down">{t.low} {fmtMoney(hc.l)}</span>
            <span>{t.close} {fmtMoney(hc.c)}</span>
            <span>{t.vol} {fmtQty(hc.v)}</span>
          </>
        ) : (
          <span>{t.candles(candles.length)}</span>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none touch-pan-y outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const price = view.lo + (view.hi - view.lo) * (1 - f);
          const gy = PAD_T + f * view.plotH;
          return (
            <g key={f}>
              <line x1={0} y1={gy} x2={W - PAD_R} y2={gy} className="stroke-border" strokeDasharray="2 4" strokeWidth={0.5} />
              <text x={W - PAD_R + 6} y={gy + 3.5} className="fill-muted" fontSize={10}>
                {fmtMoney(price)}
              </text>
            </g>
          );
        })}
        {candles.map((c, i) => {
          const up = c.c >= c.o;
          const cls = up ? "fill-up stroke-up" : "fill-down stroke-down";
          const bodyTop = y(Math.max(c.o, c.c));
          const bodyH = Math.max(1, Math.abs(y(c.o) - y(c.c)));
          return (
            <motion.g
              key={c.t}
              className={cls}
              initial={reduced ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: reduced ? 0 : Math.min(i * 0.004, 0.5) }}
            >
              <line x1={x(i)} y1={y(c.h)} x2={x(i)} y2={y(c.l)} strokeWidth={1} />
              <rect x={x(i) - bw / 2} y={bodyTop} width={bw} height={bodyH} rx={1} />
              <rect x={x(i) - bw / 2} y={H - PAD_B - vy(c.v)} width={bw} height={vy(c.v)} opacity={0.35} />
            </motion.g>
          );
        })}
        {lastPrice != null && lastPrice >= view.lo && lastPrice <= view.hi && (
          <g>
            <line x1={0} y1={y(lastPrice)} x2={W - PAD_R} y2={y(lastPrice)} className="stroke-accent" strokeDasharray="4 4" strokeWidth={1} />
            <motion.circle
              cx={x(candles.length - 1)}
              cy={y(lastPrice)}
              r={3}
              className="fill-accent"
              animate={reduced ? undefined : { scale: [1, 1.8, 1], opacity: [1, 0.4, 1] }}
              transition={{ repeat: Infinity, duration: 1.6 }}
            />
          </g>
        )}
        {hover != null && (
          <line
            x1={x(hover)}
            y1={PAD_T}
            x2={x(hover)}
            y2={H - PAD_B}
            className="stroke-muted pointer-events-none"
            strokeDasharray="3 3"
            strokeWidth={0.75}
          />
        )}
      </svg>
    </div>
  );
}
