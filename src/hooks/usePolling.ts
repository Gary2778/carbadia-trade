"use client";

import { useEffect, useRef } from "react";

/**
 * 可见性感知的轮询:页面在前台时每 `ms` 执行一次 `fn`;切到后台(document.hidden)时
 * 完全停掉定时器,回到前台时立即执行一次并恢复 → 后台不空跑省电/省流量,回前台数据即时刷新。
 *
 * `fn` 存进 ref 并在每次渲染后更新,所以闭包始终新鲜,无需把它放进依赖。
 * `restartKey` 变化时立即重启轮询(先执行一次)——用于标的/周期切换后不等下一个 tick。
 *
 * 失败退避:`fn` 返回的 Promise reject 时,下一次间隔翻倍(上限 4×ms),成功即复位 ——
 * 服务端故障/网络抖动时别用固定间隔继续锤它。调用点约定:catch 里设置错误状态后 `throw e`
 * 重新抛出,让这里能感知到失败。
 */
export function usePolling(fn: () => void | Promise<unknown>, ms: number, restartKey?: unknown) {
  const saved = useRef(fn);

  useEffect(() => {
    saved.current = fn;
  });

  useEffect(() => {
    let id: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let backoff = 1; // 失败翻倍(上限 4×),成功复位 —— 服务端故障时别用 2s 轮询继续锤它
    const stop = () => {
      if (id !== null) {
        clearTimeout(id);
        id = null;
      }
    };
    const run = () => {
      Promise.resolve()
        .then(() => saved.current())
        .then(() => {
          backoff = 1;
        })
        .catch(() => {
          backoff = Math.min(backoff * 2, 4);
        })
        .finally(() => {
          if (!stopped && !document.hidden) {
            stop();
            id = setTimeout(run, ms * backoff);
          }
        });
    };
    const start = () => {
      stop();
      run();
    };
    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ms, restartKey]);
}
