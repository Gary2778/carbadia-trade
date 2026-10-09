"use client";
// 时区偏好的客户端存储与订阅(计划 §6.3.2 C7):useSyncExternalStore,服务端快照与水合首帧恒为 local,挂载后才切到存储值
// (服务端不渲染任何时间,所以这里不需要内联脚本,<html> 上也没有属性)。读写都经外观的存取函数(appearance-storage.ts 导出的那两个,实现在 appearance-key-storage.ts):
// 禁用站点数据 / 配额满时,选择留在内存里,本次会话照样生效。
// 不从根布局可达:只有显示时间的页面与组件引它(floor 包的预算见 docs/trade-upgrade-plan.md §6.3)。
//
// 快照是模块级的缓存值:每个 tape / 页签 / 流水行都调这个 hook,getSnapshot 每次渲染都会被调,每次都去读存储就是同步读几百次。
// 缓存在三处刷新 —— 第一个订阅者挂上时、setTimeZone 之后、storage 事件(别的标签页改了这个键或清空了存储)—— 最后一个订阅者走掉后作废
// (没人听 storage 事件时缓存可能过期,下次第一次读重新取)。所以挂着订阅者的时候,getSnapshot 是 O(1),不碰存储。
import { useSyncExternalStore } from "react";
import { readAppearanceKey, writeAppearanceKey } from "./appearance-key-storage";
import { TZ_KEY, readTz, type TimeZonePref } from "./timeZoneState";

const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((fn) => fn());

/** null = 没有可信的缓存(还没读过,或最后一个订阅者已走) */
let cached: TimeZonePref | null = null;
/** 从存储(或存储写不进时的内存兜底)重读一次并更新缓存 */
const refresh = (): TimeZonePref => (cached = readTz(readAppearanceKey(TZ_KEY)));

/** 别的标签页改了这个键(或清空了存储)时重读并通知;订阅者从 0 → 1 时才挂 storage 监听,1 → 0 时摘掉(表格每行都订阅,不能每行一个监听器) */
const onStorage = (e: StorageEvent): void => {
  if (e.key !== null && e.key !== TZ_KEY) return;
  refresh();
  emit();
};

/** useTimeZone 的 subscribe(导出供测试):同标签页的 setTimeZone 与其它标签页的 storage 事件都通知 */
export const subscribeTimeZone = (listener: () => void): (() => void) => {
  if (listeners.size === 0) {
    refresh(); // 渲染时取过的缓存可能已落后于挂监听之前发生的改动;React 订阅后会再比一次快照
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      cached = null;
    }
  };
};

/** useTimeZone 的客户端快照(导出供测试):有缓存直接返回,不碰存储;返回字符串,同一内容天然同一值 */
export const readTimeZone = (): TimeZonePref => cached ?? refresh();

const getServerSnapshot = (): TimeZonePref => "local";

/** 写偏好、更新缓存并通知同标签页里的订阅者(其它标签页靠 storage 事件) */
export function setTimeZone(pref: TimeZonePref): void {
  writeAppearanceKey(TZ_KEY, pref);
  refresh();
  emit();
}

/** 当前的时区偏好;服务端与水合首帧是 local */
export function useTimeZone(): TimeZonePref {
  return useSyncExternalStore(subscribeTimeZone, readTimeZone, getServerSnapshot);
}
