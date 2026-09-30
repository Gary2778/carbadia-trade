"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useT } from "@/i18n/LangProvider";
import { getMarketRuntime } from "@/lib/market/MarketProvider";
import { useMarketStore } from "@/lib/market/store";

/** rAF 相邻回调间隔超过这个值算一帧「慢」(60 fps 的一帧是 16.7 ms) */
const SLOW_FRAME_MS = 20;
/** 超过这个值的帧单独计数(长帧;计划 §7.3「> 50 ms 计数」) */
const LONG_FRAME_MS = 50;
/** 慢帧比例按最近 60 个一秒桶滚动计算(= 每分钟) */
const WINDOW_SECONDS = 60;
/** 交互延迟样本上限(INP 近似:keydown / pointerdown / click 的 event timing duration) */
const MAX_INTERACTIONS = 200;
const INTERACTION_EVENTS = new Set(["keydown", "pointerdown", "click"]);

type PerfReading = {
  slowFramePct: number;
  longFrames: number;
  flushesPerSec: number;
  eventsPerFlush: number | null;
  fallbackFlushes: number;
  lagP50: number | null;
  lagP95: number | null;
  interactionP95: number | null;
  interactionMax: number | null;
};

/** 纯函数:p 分位(最近秩法);空样本 null */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

type FrameBucket = { frames: number; slow: number; long: number };

/**
 * 纯逻辑(便于在 node 里测):把 rAF 回调的时间戳累进当前一秒的桶 —— 相邻间隔 > SLOW_FRAME_MS 记慢帧、
 * > LONG_FRAME_MS 记长帧;take() 交出当前桶并开新桶;reset() 丢掉上一帧的时间戳,下一次回调只起算、不计间隔
 * (标签页可见性变化时调用:隐藏期间 rAF 停摆,回来后的第一个间隔是隐藏时长,不是卡顿)。
 */
export function createFrameMeter() {
  let last: number | null = null;
  let current: FrameBucket = { frames: 0, slow: 0, long: 0 };
  return {
    frame(stamp: number): void {
      if (last !== null) {
        current.frames++;
        if (stamp - last > SLOW_FRAME_MS) current.slow++;
        if (stamp - last > LONG_FRAME_MS) current.long++;
      }
      last = stamp;
    },
    reset(): void {
      last = null;
    },
    take(): FrameBucket {
      const bucket = current;
      current = { frames: 0, slow: 0, long: 0 };
      return bucket;
    },
  };
}

// 度量名用英文技术缩写(rAF / flush / ev / INP 这类开发度量术语,两种语言通用),不走 i18n、不设 terminal.perf.* 键:
// ?perf=1 的浮层是开发者工具,不是用户界面 —— 已声明的偏离,见计划 §9.2 D18。
const METRIC = {
  slowFrames: `rAF > ${SLOW_FRAME_MS} ms`,
  longFrames: `rAF > ${LONG_FRAME_MS} ms / min`,
  flushes: "flush / s",
  eventsPerFlush: "ev / flush",
  fallback: "fallback",
  lag: "recv→flush p50 / p95",
  interaction: "INP p95 / max",
} as const;

const ms = (value: number | null) => (value === null ? "—" : `${Math.round(value)} ms`);
/** 收到→flush 通常在一帧之内,保留一位小数才看得出差别 */
const ms1 = (value: number | null) => (value === null ? "—" : `${value.toFixed(1)} ms`);

/**
 * ?perf=1 的开关(计划 §4.7、§7.3):TerminalShell 把它挂成终端根的直接子节点 —— 不放进头部,因为头部是
 * sticky + z-sticky 的层叠上下文,HUD 的 z-popover 在里面只算头部那一层,手机底部买卖条与抽屉会盖住它。
 * 只有这个小组件订阅 useSearchParams:筛选写回 query 时不连带重渲染外壳或头部。
 */
export function PerfHudGate() {
  const perf = useSearchParams()?.get("perf") === "1";
  return perf ? <PerfHud /> : null;
}

/**
 * 性能读数面板(计划 §7.3),仅 ?perf=1 时经 PerfHudGate 挂载,各断点都可开(手机上抬到底部买卖条之上,见 terminal.css):
 *   - 帧:自己跑一条 rAF 链,统计最近一分钟相邻回调间隔 > 20 ms 的比例(目标 < 1%)与 > 50 ms 的帧数;
 *     可见性一变就丢掉上一帧的时间戳:隐藏期间 rAF 停摆,回到标签页后的第一个间隔是隐藏时长,不是卡顿;
 *   - flush:batcher 每秒 flush 次数(≤ 60)、每次合并的事件数(> 1 即合帧生效)、走兜底定时器的累计次数(隐藏时的兜底与可见时抢在 rAF 之前的都算);
 *   - 延迟:batcher 每次 rAF flush 的(flush 时刻 − 本批最早一帧的客户端收到时刻)样本的 p50 / p95(同一个客户端单调时钟,
 *     不读服务端时间;标签页隐藏期间的批次只计入上面的 fallback 次数、不进样本,可见时兜底定时器抢在 rAF 之前的 flush 照记);WS RTT(20 s 应用层 ping)。旧版显示的「距最后一条消息」在机器人 2.5 s 节奏下只是锯齿,已换掉;
 *   - 交互:PerformanceObserver({ type: "event", durationThreshold: 16 }) 的 p95 与最大值。
 * 每秒刷新一次显示;不挂载时零开销(默认页面没有这条 rAF 链)。
 */
export function PerfHud() {
  const t = useT("terminal");
  // 只订阅 RTT(原始值):lastMessageAt 每条消息都变,订阅整个 connection 切片会让 HUD 自己每帧重渲染、干扰读数
  const rttMs = useMarketStore((s) => s.connection.rttMs);
  const [reading, setReading] = useState<PerfReading | null>(null);

  useEffect(() => {
    // ---- 帧:每秒一个桶 { frames, slow, long } ----
    const buckets: FrameBucket[] = [];
    const meter = createFrameMeter();
    let rafId = 0;
    const onFrame = (stamp: number) => {
      meter.frame(stamp);
      rafId = requestAnimationFrame(onFrame);
    };
    rafId = requestAnimationFrame(onFrame);
    // 隐藏 / 回到前台都重新起算:否则回来后的第一帧间隔 = 隐藏时长,会在一分钟里显示成一次 > 50 ms 的长帧
    const onVisibility = () => meter.reset();
    document.addEventListener("visibilitychange", onVisibility);

    // ---- 交互:event timing ----
    const durations: number[] = [];
    let observer: PerformanceObserver | null = null;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!INTERACTION_EVENTS.has(entry.name)) continue;
          durations.push(entry.duration);
          if (durations.length > MAX_INTERACTIONS) durations.shift();
        }
      });
      observer.observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
    } catch {
      observer = null; // 不支持 event timing 的浏览器:交互一栏显示「—」
    }

    // ---- flush:与上一秒的 batcher 计数做差 ----
    let prev = getMarketRuntime()?.batcher.stats() ?? null;
    const timer = setInterval(() => {
      buckets.push(meter.take());
      if (buckets.length > WINDOW_SECONDS) buckets.shift();
      const frames = buckets.reduce((sum, b) => sum + b.frames, 0);
      const slow = buckets.reduce((sum, b) => sum + b.slow, 0);
      const long = buckets.reduce((sum, b) => sum + b.long, 0);

      const batcher = getMarketRuntime()?.batcher ?? null;
      const stats = batcher?.stats() ?? null;
      const lag = batcher?.latencySamples() ?? [];
      const flushes = stats && prev ? stats.flushes - prev.flushes : 0;
      const events = stats && prev ? stats.events - prev.events : 0;
      prev = stats;

      setReading({
        slowFramePct: frames === 0 ? 0 : (slow / frames) * 100,
        longFrames: long,
        flushesPerSec: flushes,
        eventsPerFlush: flushes === 0 ? null : events / flushes,
        fallbackFlushes: stats?.fallbackFlushes ?? 0,
        lagP50: percentile(lag, 0.5),
        lagP95: percentile(lag, 0.95),
        interactionP95: percentile(durations, 0.95),
        interactionMax: durations.length ? Math.max(...durations) : null,
      });
    }, 1000);

    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener("visibilitychange", onVisibility);
      clearInterval(timer);
      observer?.disconnect();
    };
  }, []);

  const rows: [string, string][] = [
    [METRIC.slowFrames, reading ? `${reading.slowFramePct.toFixed(2)}%` : "—"],
    [METRIC.longFrames, reading ? String(reading.longFrames) : "—"],
    [METRIC.flushes, reading ? String(reading.flushesPerSec) : "—"],
    [METRIC.eventsPerFlush, reading?.eventsPerFlush != null ? reading.eventsPerFlush.toFixed(1) : "—"],
    [METRIC.fallback, reading ? String(reading.fallbackFlushes) : "—"],
    [METRIC.lag, reading ? `${ms1(reading.lagP50)} / ${ms1(reading.lagP95)}` : "—"],
    [METRIC.interaction, reading ? `${ms(reading.interactionP95)} / ${ms(reading.interactionMax)}` : "—"],
  ];

  return (
    <aside
      data-perf-hud=""
      aria-label={t.header.perf}
      className="fixed end-gutter bottom-gutter z-(--z-popover) w-56 rounded-panel border border-(--terminal-border) bg-surface-overlay p-panel text-t-2xs text-foreground shadow-overlay"
    >
      <p className="mb-gap font-semibold">{t.header.perf}</p>
      <dl className="grid grid-cols-2 gap-x-panel gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd className="tnum text-end">{value}</dd>
          </div>
        ))}
      </dl>
      {rttMs !== null ? <p className="tnum mt-gap text-muted">{t.connection.rtt(rttMs)}</p> : null}
    </aside>
  );
}
