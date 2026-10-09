"use client";
// 两步撤销的武装状态(当前委托与条件单两个页签共用,P3-07 复审时从 OpenOrdersTab 抽出来):第一次点「撤单」武装、同一个按钮变「确认撤单」,
// 再点才由调用方发请求;武装期间 Esc 取消(对话框里的 Esc 不抢)、在别处按下指针也取消;武装的行离开可撤的列表(被吃完、在别处撤掉、
// 条件单开始触发)视同取消,焦点若随那一行掉到 body 就交还给面板容器。请求在途的防重(busy)各页签自己管。
import { useCallback, useEffect, useRef, useState } from "react";

/** 武装期间一下 Esc 的处理方式(见 armedEscapeAction) */
export type ArmedEscapeAction = "ignore" | "disarm" | "disarm-and-focus";

/**
 * 两步撤单武装期间按下 Esc 该做什么(纯函数:tabs.ssr.test.ts 用假元素测;active = document.activeElement,root = 本面板容器):
 *   - "ignore":焦点在打开的 <dialog> 里(OrderConfirmDialog、FillDetailDialog 自己处理 Esc,不能被这里 preventDefault 截掉),
 *     或本面板在 inert 子树里(左栏抽屉是模态,Esc 归抽屉);武装保持,下一次 Esc 再取消;
 *   - "disarm-and-focus":焦点在本面板里,或掉在 body 上 —— 取消武装、preventDefault,焦点还给触发按钮;
 *   - "disarm":焦点在面板外的别处(例如搜索框)—— 取消武装、preventDefault,但不去抢焦点。
 */
export function armedEscapeAction(active: Element | null, root: Element | null, body: Element | null): ArmedEscapeAction {
  if (active?.closest("dialog[open]")) return "ignore";
  if (root?.closest("[inert]")) return "ignore";
  if (!active || active === body || root?.contains(active)) return "disarm-and-focus";
  return "disarm";
}

/**
 * 武装的行还在列表里才算武装(只要求行有 id):它被机器人吃完、在别处撤掉、切到「仅当前标的」后看不到了,或条件单已经在触发(不在可撤的行里了),
 * 都视同取消武装 —— 否则 window 上的 Esc 监听一直挂着,下一次随便在哪按 Esc 都会被它 preventDefault 吞掉。
 * useArmedCancel 发现它不成立时还会把 armedId 本身清掉(渲染期调整 state):同一 id 再回到列表 —— D16 订阅快照与终态事件赛跑后
 * upsert 回来、截断快照的 upsert —— 也不会悄悄重新武装。
 */
export function liveArmedId(armedId: string | null, orders: readonly { id: string }[]): string | null {
  return armedId !== null && orders.some((o) => o.id === armedId) ? armedId : null;
}

/**
 * 纯函数:渲染期对武装 state 的调整(useArmedCancel 按 React「随输入调整 state」的写法调用)。
 * 武装的单不在列表里了 → 返回 armedId null、vanished true(调用方写回 state,并记一次「消失」好还原焦点);否则原样、vanished false。
 * 因为清的是 state 本身而不只是派生值,同一 id 之后再回到列表也不会悄悄重新武装。
 */
export function reconcileArmed(armedId: string | null, orders: readonly { id: string }[]): { armedId: string | null; vanished: boolean } {
  if (armedId !== null && liveArmedId(armedId, orders) === null) return { armedId: null, vanished: true };
  return { armedId, vanished: false };
}

/**
 * 两步撤销的武装状态。armable = 此刻能撤的行(当前委托 = 列表里的挂单;条件单 = PENDING 的行,正在触发的撤不了)。
 * 返回:armed(武装着的 id,不在 armable 里即为 null)、rootRef(挂在页签容器上:Esc 判定与焦点还原用,容器要 tabIndex -1)、
 * press(id)(第一次点:武装并返回 false;已武装的同一行再点:解除武装并返回 true,调用方接着发撤销请求)、disarm()(切换范围等)。
 */
export function useArmedCancel(armable: readonly { id: string }[]) {
  const [armedId, setArmedId] = useState<string | null>(null);
  /** 武装的行离开列表的次数:下面的 effect 据此还原焦点 */
  const [vanished, setVanished] = useState(0);
  // 武装的行离开了可撤的列表:武装就此作废。渲染期按 React「随输入调整 state」的写法清掉 armedId(条件只成立一次,不会循环)——
  // 同一 id 之后再回到列表(订阅快照与终态事件赛跑后 upsert 回来)也不会悄悄重新武装、重新挂上吞 Esc 的监听
  if (reconcileArmed(armedId, armable).vanished) {
    setArmedId(null);
    setVanished((n) => n + 1);
  }
  // 派生值仍保留(liveArmedId):监听、视图与 press 都只看 armed
  const armed = liveArmedId(armedId, armable);
  const rootRef = useRef<HTMLDivElement>(null);
  // press 经 ref 读武装状态,自身引用保持稳定(它是每个 memo 行的 onCancel 的一部分,武装一次不该让整张表重渲染)
  const armedRef = useRef<string | null>(null);
  useEffect(() => {
    armedRef.current = armed;
  }, [armed]);

  // 武装的那一行消失时,它的「确认撤单」按钮若有焦点,焦点会掉到 body:交还本面板容器(焦点在别处就不动)
  useEffect(() => {
    if (vanished === 0) return;
    if (document.activeElement === null || document.activeElement === document.body) rootRef.current?.focus();
  }, [vanished]);

  // 武装期间:Esc 取消(Safari 点击不聚焦按钮,所以挂在 window 上而不是按钮的 onKeyDown);在别处按下指针也取消。
  // 捕获阶段:先于 TerminalShell 与全局快捷键(P1-22)的冒泡阶段监听器运行,preventDefault 之后它们看 defaultPrevented 就知道这一下已被处理
  useEffect(() => {
    if (armed === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const action = armedEscapeAction(document.activeElement, rootRef.current, document.body);
      if (action === "ignore") return;
      e.preventDefault();
      armedRef.current = null;
      setArmedId(null);
      if (action === "disarm-and-focus") rootRef.current?.querySelector<HTMLButtonElement>(`[data-cancel-for="${CSS.escape(armed)}"]`)?.focus();
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target.closest("[data-cancel-for]") : null;
      if (target?.getAttribute("data-cancel-for") === armed) return;
      armedRef.current = null;
      setArmedId(null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [armed]);

  const press = useCallback((id: string): boolean => {
    if (armedRef.current !== id) {
      armedRef.current = id;
      setArmedId(id);
      return false;
    }
    armedRef.current = null;
    setArmedId(null);
    return true;
  }, []);
  const disarm = useCallback(() => {
    armedRef.current = null;
    setArmedId(null);
  }, []);

  return { armed, rootRef, press, disarm };
}
