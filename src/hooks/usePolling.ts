"use client";

import { useEffect, useRef } from "react";

/** 可见性来源:document 里轮询用到的那一小块(测试传假的) */
export type VisibilitySource = {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
};

export type PollingOptions = {
  /**
   * 首次执行(挂载、restartKey 变化)不看可见性:页面在后台也立即取一次,之后的定时重取照旧在后台暂停、回前台立即取。
   * 给「首屏数据只有这一个来源」的调用点用(资产页的总览与轮询降级):在后台标签页里打开时不会一直是骨架。默认 false。
   */
  runFirstWhileHidden?: boolean;
};

/** 资产页的几处轮询共用:第一次不看可见性 */
export const FIRST_RUN_WHILE_HIDDEN: PollingOptions = { runFirstWhileHidden: true };

/**
 * usePolling 的调度本体(与 React 无关,测试直接调;返回停止函数,即 effect 的清理):
 *   - 开始时页面在前台(或 runFirstWhileHidden)→ 立即执行一次;之后每次执行完、页面仍在前台才排下一次;
 *   - 切到后台 → 停掉定时器;回到前台 → 立即执行一次并恢复;
 *   - 失败退避:run 返回的 Promise reject → 下一次间隔翻倍(上限 4×ms),成功复位;
 *   - 停止之后,在途的那一次结束时不再排下一次。
 */
export function startPolling(run: () => void | Promise<unknown>, ms: number, doc: VisibilitySource, options: PollingOptions = {}): () => void {
  let id: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let backoff = 1; // 失败翻倍(上限 4×),成功复位 —— 服务端故障时别用 2s 轮询继续锤它
  const stop = () => {
    if (id !== null) {
      clearTimeout(id);
      id = null;
    }
  };
  const tick = () => {
    Promise.resolve()
      .then(() => run())
      .then(() => {
        backoff = 1;
      })
      .catch(() => {
        backoff = Math.min(backoff * 2, 4);
      })
      .finally(() => {
        if (!stopped && !doc.hidden) {
          stop();
          id = setTimeout(tick, ms * backoff);
        }
      });
  };
  const start = () => {
    stop();
    tick();
  };
  const onVis = () => {
    if (doc.hidden) stop();
    else start();
  };
  if (!doc.hidden || options.runFirstWhileHidden) start();
  doc.addEventListener("visibilitychange", onVis);
  return () => {
    stopped = true;
    stop();
    doc.removeEventListener("visibilitychange", onVis);
  };
}

/**
 * 可见性感知的轮询:页面在前台时每 `ms` 执行一次 `fn`;切到后台(document.hidden)时
 * 完全停掉定时器,回到前台时立即执行一次并恢复 → 后台不空跑省电/省流量,回前台数据即时刷新。
 * 默认页面在后台时连第一次都不执行;`options.runFirstWhileHidden` 让第一次不看可见性(见 PollingOptions)。
 *
 * `fn` 存进 ref 并在每次渲染后更新,所以闭包始终新鲜,无需把它放进依赖。
 * `restartKey` 变化时立即重启轮询(先执行一次)——用于标的/周期切换后不等下一个 tick。
 *
 * 失败退避:`fn` 返回的 Promise reject 时,下一次间隔翻倍(上限 4×ms),成功即复位 ——
 * 服务端故障/网络抖动时别用固定间隔继续锤它。调用点约定:catch 里设置错误状态后 `throw e`
 * 重新抛出,让这里能感知到失败。
 */
export function usePolling(fn: () => void | Promise<unknown>, ms: number, restartKey?: unknown, options?: PollingOptions) {
  const saved = useRef(fn);
  const runFirstWhileHidden = options?.runFirstWhileHidden ?? false;

  useEffect(() => {
    saved.current = fn;
  });

  useEffect(() => startPolling(() => saved.current(), ms, document, { runFirstWhileHidden }), [ms, restartKey, runFirstWhileHidden]);
}
