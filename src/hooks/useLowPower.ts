"use client";

import { useEffect, useState } from "react";

/**
 * 低功耗 / 移动端检测:触屏(pointer: coarse)、窄屏(<768px)、或用户开启了 reduce-motion。
 * 用于在手机上关闭重型全屏装饰动画(星空位移滤镜、足球物理、像素入口 rAF 等)。
 *
 * SSR/首帧返回 false(与服务端渲染一致),挂载后用 matchMedia 纠正 → 避免水合不匹配;
 * 监听媒体查询变化,旋转屏幕/改偏好时实时更新。
 */
export function useLowPower(): boolean {
  const [low, setLow] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const queries = [
      window.matchMedia("(pointer: coarse)"),
      window.matchMedia("(max-width: 767px)"),
      window.matchMedia("(prefers-reduced-motion: reduce)"),
    ];
    const update = () => setLow(queries.some((q) => q.matches));
    update();
    queries.forEach((q) => q.addEventListener("change", update));
    return () => queries.forEach((q) => q.removeEventListener("change", update));
  }, []);

  return low;
}
