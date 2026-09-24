"use client";

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { fmtMoney, fmtQty } from "@/lib/format";
import { useT } from "@/i18n/LangProvider";

type Level = { price: number; quantity: number };
type CumLevel = { price: number; quantity: number; cum: number };

const W = 760;
const H = 300;
const PAD = 16;

export function DepthChart({ bids, asks, ariaLabel }: { bids: Level[]; asks: Level[]; ariaLabel?: string }) {
  const t = useT("depthChart");
  const reduced = useReducedMotion();
  const [hover, setHover] = useState<CumLevel | null>(null);

  const view = useMemo(() => {
    if (bids.length === 0 && asks.length === 0) return null;
    // 累计深度: bids 已按价格从高到低, asks 已按价格从低到高
    const accumulate = (levels: Level[]): CumLevel[] => {
      const out: CumLevel[] = [];
      let sum = 0;
      for (const l of levels) {
        sum += l.quantity;
        out.push({ ...l, cum: sum });
      }
      return out;
    };
    const cumBids = accumulate(bids);
    const cumAsks = accumulate(asks);
    // 键盘导航用:全部档位按价格从左到右排列(买盘反转为升序,接卖盘)
    const levels = [...cumBids].reverse().concat(cumAsks);
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of [...bids, ...asks]) {
      lo = Math.min(lo, l.price);
      hi = Math.max(hi, l.price);
    }
    const span = hi - lo || 1;
    const maxCum = Math.max(cumBids[cumBids.length - 1]?.cum ?? 0, cumAsks[cumAsks.length - 1]?.cum ?? 0, 1);
    return {
      cumBids,
      cumAsks,
      levels,
      x: (p: number) => PAD + ((p - lo) / span) * (W - PAD * 2),
      y: (c: number) => H - PAD - (c / maxCum) * (H - PAD * 2),
    };
  }, [bids, asks]);

  if (!view) {
    // 空数据(切换清空等):保留底轴骨架 + 居中占位,不抛错、无 NaN,尺寸与有数据时一致避免跳动
    return (
      <div className="relative" dir="ltr">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full select-none outline-none focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
        >
          <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="stroke-border" strokeDasharray="2 4" strokeWidth={0.5} />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-muted text-sm pointer-events-none">{t.noOrders}</div>
      </div>
    );
  }

  const { cumBids, cumAsks, levels, x, y } = view;

  function stepPath(levels: CumLevel[], edgeX: number) {
    if (levels.length === 0) return "";
    let d = `M${x(levels[0].price)},${H - PAD}`;
    let prevY = H - PAD;
    for (const l of levels) {
      d += ` L${x(l.price)},${prevY} L${x(l.price)},${y(l.cum)}`;
      prevY = y(l.cum);
    }
    d += ` L${edgeX},${prevY} L${edgeX},${H - PAD} Z`;
    return d;
  }

  // 鼠标/触屏/触控笔共用:PointerEvent 覆盖 mousemove 与 touch 拖动
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    // 触屏不 preventDefault:svg 上的 touch-pan-y 保留纵向页面滚动,横向拖动才移动检视线
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best: CumLevel | null = null;
    let bestD = Infinity;
    for (const l of levels) {
      const d = Math.abs(x(l.price) - px);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
    setHover(best);
  }

  // 键盘检视:←/→ 沿价格轴在档位间移动,Home/End 跳两端,Esc 清除,读数条随之播报
  function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    if (levels.length === 0) return;
    const last = levels.length - 1;
    const cur = hover ? levels.indexOf(hover) : -1;
    let next: number | null;
    switch (e.key) {
      case "ArrowLeft":
        next = cur === -1 ? last : Math.max(0, cur - 1);
        break;
      case "ArrowRight":
        next = cur === -1 ? last : Math.min(last, cur + 1);
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
    setHover(next == null ? null : levels[next]);
  }

  const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : null;

  return (
    // 图表坐标系恒为 LTR(价格轴从左到右),RTL 界面下也不翻转
    <div className="relative" dir="ltr">
      <div
        aria-live="polite"
        className="absolute top-0 left-2 z-10 text-[11px] tnum text-muted flex gap-3 bg-surface/80 backdrop-blur px-2 py-0.5 rounded"
      >
        {hover ? (
          <>
            <span>{t.price} {fmtMoney(hover.price)}</span>
            <span>{t.size} {fmtQty(hover.quantity)}</span>
            <span>{t.cumulative} {fmtQty(hover.cum)} {t.tonnes}</span>
          </>
        ) : spread != null ? (
          <span>{t.spread} {fmtMoney(spread)}</span>
        ) : (
          <span>{t.depth}</span>
        )}
      </div>
      <svg
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
        <motion.path
          d={stepPath(cumBids, PAD)}
          className="fill-up/15 stroke-up"
          strokeWidth={1.5}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6 }}
        />
        <motion.path
          d={stepPath(cumAsks, W - PAD)}
          className="fill-down/15 stroke-down"
          strokeWidth={1.5}
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: reduced ? 0 : 0.15 }}
        />
        {hover && (
          <line x1={x(hover.price)} y1={PAD} x2={x(hover.price)} y2={H - PAD} className="stroke-muted" strokeDasharray="3 3" strokeWidth={0.75} />
        )}
      </svg>
    </div>
  );
}
