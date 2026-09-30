"use client";

import { useState } from "react";

type Flash = { key: number; dir: "up" | "down" | null };

/**
 * 价格闪烁:props 不变({ value; children; className? })。
 * 实现改为「记住上一次渲染的 value」(react.dev 的 storing-information-from-previous-renders 模式):
 * 渲染期比较新旧值,变化时只把 key 加一,让一层铺满外层的底色 <span> 重挂载,.flash-up / .flash-down 的 CSS 动画
 * (globals.css,时长 var(--motion-flash),底色 --up-soft / --down-soft,随涨跌轴翻转)自己跑完自己停——
 * 没有计时器、没有 effect,高频更新时每次变化只是一次重挂载,不会积压待清理的定时任务。
 * 重挂载的只有那层底色,children 留在不带 key 的外层里、位置不变:旧 /market 标的页头部的 NumberTicker 不被卸载,
 * 照常从旧价补间到新价(之前 key 挂在外层,每次变价连 NumberTicker 一起重挂载,直接跳到新价)。
 * 底色层在外层自成的层叠上下文(isolate)里垫在文字下面(z-index --z-below),不拦指针事件。
 */
export function FlashCell({
  value,
  children,
  className = "",
}: {
  value: number | null | undefined;
  children: React.ReactNode;
  className?: string;
}) {
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState<Flash>({ key: 0, dir: null });

  // Object.is 而不是 !==:NaN !== NaN 恒真,渲染期 setState 会一直重跑直到 React 抛 "Too many re-renders";
  // 一个坏值不该把整棵树打进错误边界。只有两边都是有限数才判涨跌,NaN / Infinity 只更新 prev、不闪。
  if (!Object.is(value, prev)) {
    setPrev(value);
    if (prev != null && value != null && Number.isFinite(prev) && Number.isFinite(value)) {
      setFlash({ key: flash.key + 1, dir: value > prev ? "up" : "down" });
    } else if (flash.dir !== null) {
      setFlash({ key: flash.key, dir: null });
    }
  }

  const tone = flash.dir === "up" ? "flash-up" : flash.dir === "down" ? "flash-down" : null;
  return (
    <span className={`${className} relative isolate rounded-chip`}>
      {tone ? <span key={flash.key} aria-hidden="true" className={`pointer-events-none absolute inset-0 z-(--z-below) rounded-chip ${tone}`} /> : null}
      {children}
    </span>
  );
}
