"use client";

import { motion, useReducedMotion } from "motion/react";

export function Sparkline({ data, width = 96, height = 28, ariaLabel = "Trend" }: { data: number[]; width?: number; height?: number; ariaLabel?: string }) {
  const reduced = useReducedMotion();
  if (data.length < 2) return <span className="text-muted text-xs">—</span>;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [
    (i / (data.length - 1)) * width,
    height - 2 - ((v - min) / span) * (height - 4),
  ]);
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const up = data[data.length - 1] >= data[0];

  return (
    <svg width={width} height={height} className="overflow-visible" role="img" aria-label={ariaLabel}>
      <motion.path
        d={d}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        className={up ? "stroke-up" : "stroke-down"}
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
    </svg>
  );
}
