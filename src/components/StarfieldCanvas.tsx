"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "@/providers/ThemeProvider";
import { COOL_RGB, WARM_RGB, fitField, paintField, type PaintStar, type Star } from "./starfield";

// 深色模式的背景:carbadia.co 同款视差星空(数学在 starfield.ts)。
// 一张铺满视口的画布,固定在内容之后、不可交互;只在 dark 挂载(儿童护眼模式用的是手绘夜空 StarrySky)。
// 纪律与 useAsciiFrames 相同:标签页隐藏不画,reduce-motion 只画一张静帧。

const FULL_TURN = 6.2832;
const COOL = `rgb(${COOL_RGB})`;
const WARM = `rgb(${WARM_RGB})`;
// 30 帧:星漂得慢、闪得慢,看不出和 60 帧的差别;而星空每画一帧,页面上每块液态玻璃的 backdrop-filter 都要整块重算一遍,
// 帧率减半 = GPU 那份工作减半。减 2ms 是让 60Hz 的第二拍(33.3ms 上下)稳稳落在这一边,不会偶尔滑到第三拍
const FRAME_MS = 1000 / 30 - 2;

function Sky() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const field: Star[] = [];
    const view = { vw: 0, vh: 0 };
    let dpr = 0;
    let frameId = 0;
    let previousTime: number | undefined;

    // 不透明度走 globalAlpha,颜色只有两个常量:每颗星不用再拼一次 rgba() 字符串
    const paintStar: PaintStar = (px, py, r, alpha, warm) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = warm ? WARM : COOL;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, FULL_TURN);
      ctx.fill();
    };

    const draw = (time: number, dt: number) => {
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, view.vw, view.vh);
      paintField(field, view, time, dt, reducedMotion.matches, paintStar);
    };

    // 位图尺寸跟 CSS 盒子走;尺寸与像素比都没变就什么也不做
    const measure = () => {
      const vw = canvas.clientWidth;
      const vh = canvas.clientHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (vw === view.vw && vh === view.vh && ratio === dpr) return;
      view.vw = vw;
      view.vh = vh;
      dpr = ratio;
      canvas.width = Math.floor(vw * dpr);
      canvas.height = Math.floor(vh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fitField(field, view);
      draw(previousTime ?? 0, 0); // 改位图尺寸会清空画布:立刻补一帧
    };

    const animate = (time: number) => {
      frameId = window.requestAnimationFrame(animate);
      if (previousTime !== undefined && time - previousTime < FRAME_MS) return;
      const dt = previousTime === undefined ? 0 : Math.min(100, time - previousTime); // 挂起恢复不跳帧
      previousTime = time;
      draw(time, dt);
    };

    const syncPlayback = () => {
      window.cancelAnimationFrame(frameId);
      previousTime = undefined;
      if (reducedMotion.matches) draw(0, 0);
      else if (!document.hidden) frameId = window.requestAnimationFrame(animate);
    };

    measure();
    syncPlayback();
    // 盯画布自己的盒子,不盯窗口:出现滚动条这类不触发 resize 事件的宽度变化也能跟上
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(canvas);
    reducedMotion.addEventListener("change", syncPlayback);
    document.addEventListener("visibilitychange", syncPlayback);
    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      reducedMotion.removeEventListener("change", syncPlayback);
      document.removeEventListener("visibilitychange", syncPlayback);
    };
  }, []);

  // 高度由 globals.css 的 .starfield-canvas 定:手机地址栏收放时画布尺寸不变,星星不跟着挪
  return <canvas ref={canvasRef} aria-hidden="true" className="starfield-canvas pointer-events-none fixed left-0 top-0 -z-10 w-full" />;
}

export function StarfieldCanvas() {
  const { theme, kids } = useTheme();
  return theme === "dark" && !kids ? <Sky /> : null;
}
