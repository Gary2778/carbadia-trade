"use client";
// 注销流程的存放处(模块级,每个持仓一份,键是 assetId;计划 §6.2.2 C7)。RetireDialog 的状态不放在组件里,放在这里:
//   - 结果没定的那一份(提交在途,或结果不确定 —— 带着幂等键的复核)必须活过组件卸载。终端底部只挂当前页签,换页签、
//     在别的行点「注销」、持仓行消失都会卸载对话框;要是状态跟着没了,用户回来会拿到一个新的幂等键,一笔其实已经入库的
//     注销就可能再提交一次。留在这里,再打开同一持仓看到的还是那份复核:同一个键,「修改」仍然锁着;
//   - 提交的结果回来时组件可能已经不在:结果由这里落(submitRetireFlow),不靠组件的 state;
//   - 终端「持仓」页签与资产页(P2-10)挂的是同一个 RetireDialog,读的是同一份。
// 留多久:
//   - 有组件在看(watchRetireFlow,RetireDialog 挂着)→ 什么状态都留着(填到一半、复核中、被拒、回执),与原来放在组件里时一样;
//   - 没人看 → 只留结果没定的(holdsRetireOutcome);其余随最后一个组件卸载丢掉。结果在没人看的时候回来:成功、明确被拒
//     都就此了结(丢掉,由发起提交的那一方用 toast 告知),不确定的留下;
//   - 登出 / 换号 / 会话失效(onSignOut)→ 全部清掉,在途请求的结果也不再落(那是上一位用户的事)。
// 只在内存里:整页刷新后没有了(与旧 /retirement 页离开页面后的情形相同)。
import { useEffect, useSyncExternalStore } from "react";
import { submitRetirement } from "../exchange/retirement-form";
import type { RetirementRecord } from "../exchange/retirement";
import { onSignOut } from "./account-refresh";
import { canSubmitRetirement, INITIAL_RETIRE_FLOW, reduceRetireFlow, retirementFailureOutcome, type RetireAction, type RetireFlow, type RetireSubmitError } from "./retire-flow";

const flows = new Map<string, RetireFlow>();
/** assetId → 正在看这份流程的组件数 */
const viewers = new Map<string, number>();
const listeners = new Set<() => void>();
/** 每次整体清空 +1:在途请求回来时对不上就不落 */
let generation = 0;

const emit = (): void => {
  for (const listener of listeners) listener();
};

/** 这份流程的结果还没定:提交在途,或上一次提交的结果不确定(不能丢 —— 丢了就丢了幂等键) */
export const holdsRetireOutcome = (flow: RetireFlow): boolean => flow.busy || flow.uncertain;

/** 该持仓此刻的流程;没有 → 初始状态(同一个对象,可直接当 useSyncExternalStore 的快照) */
export function retireFlowOf(assetId: string): RetireFlow {
  return flows.get(assetId) ?? INITIAL_RETIRE_FLOW;
}

export function subscribeRetireFlows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function write(assetId: string, next: RetireFlow): void {
  const current = retireFlowOf(assetId);
  if (next === current) return;
  // 回到初始状态不占地方;没人看的时候只留结果没定的
  if (next === INITIAL_RETIRE_FLOW || (!viewers.has(assetId) && !holdsRetireOutcome(next))) flows.delete(assetId);
  else flows.set(assetId, next);
  emit();
}

/** 对该持仓的流程走一步(reduceRetireFlow),返回走完之后的状态 */
export function dispatchRetireFlow(assetId: string, action: RetireAction): RetireFlow {
  const next = reduceRetireFlow(retireFlowOf(assetId), action);
  write(assetId, next);
  return next;
}

/**
 * 登记「有组件在看这个持仓的流程」,返回解除函数(幂等)。最后一个解除时,结果已定的状态(填到一半、没提交的复核、
 * 被拒、回执)就此丢掉;在途与结果不确定的留着,下次挂上来接着用。
 */
export function watchRetireFlow(assetId: string): () => void {
  viewers.set(assetId, (viewers.get(assetId) ?? 0) + 1);
  let watching = true;
  return () => {
    if (!watching) return;
    watching = false;
    const left = (viewers.get(assetId) ?? 1) - 1;
    if (left > 0) {
      viewers.set(assetId, left);
      return;
    }
    viewers.delete(assetId);
    const flow = flows.get(assetId);
    if (flow && !holdsRetireOutcome(flow)) {
      flows.delete(assetId);
      emit();
    }
  };
}

/** 一次提交的结局(给发起方决定要不要弹 toast;状态已经由这里落好) */
export type RetireSettlement = { ok: true; retirement: RetirementRecord } | { ok: false; uncertain: boolean; error: RetireSubmitError };

/**
 * 提交该持仓复核中的请求(flow.request,含幂等键)。此刻不能提交(没勾确认、在途、不在复核)→ 返回 null,什么都不发。
 * 结果回来时落进这里的状态,不管发起的组件还在不在;返回的 Promise 从不 reject:
 *   - 成功 → 回执(没人看就直接了结);失败 → 按 retirementFailureOutcome 定「不确定 / 明确被拒 / 409 解锁」;
 *   - 期间被整体清空(登出、换号)→ null,状态不动,调用方也不该再提示什么。
 * submit 可注入(测试用假实现)。
 */
export function submitRetireFlow(assetId: string, submit: typeof submitRetirement = submitRetirement): Promise<RetireSettlement | null> | null {
  const flow = retireFlowOf(assetId);
  const request = flow.request;
  if (!request || !canSubmitRetirement(flow)) return null;
  const startedIn = generation;
  dispatchRetireFlow(assetId, { type: "submit" });
  return submit(request).then(
    (result): RetireSettlement | null => {
      if (startedIn !== generation) return null;
      dispatchRetireFlow(assetId, { type: "succeeded", retirement: result.retirement });
      return { ok: true, retirement: result.retirement };
    },
    (error: unknown): RetireSettlement | null => {
      if (startedIn !== generation) return null;
      // 结局与 reducer 用同一个判定(retirementFailureOutcome)现算,不回头读 store:没人看的时候明确被拒会被直接了结,读不到
      const outcome = retirementFailureOutcome(error, retireFlowOf(assetId).uncertain);
      dispatchRetireFlow(assetId, { type: "failed", error });
      return { ok: false, uncertain: outcome.uncertain, error: outcome.submitError };
    },
  );
}

/** 全部清掉(登出 / 换号 / 会话失效);在途请求的结果此后不再落 */
export function clearRetireFlows(): void {
  generation++;
  if (flows.size === 0) return;
  flows.clear();
  emit();
}

// 模块级订阅(对话框没挂着时也要生效);只在浏览器里挂,同 FillsTab / OrderHistoryTab 的分页缓存
if (typeof window !== "undefined") onSignOut(clearRetireFlows);

const initialRetireFlow = (): RetireFlow => INITIAL_RETIRE_FLOW;

/**
 * RetireDialog 用:读该持仓的流程并登记「在看」。服务端与水合首帧是初始状态(对话框本来就只在客户端挂载)。
 * 卸载时结果没定的那一份留在这里,下次挂上来(同一页签再点「注销」、从别的页签回来、资产页)原样取回。
 */
export function useRetireFlow(assetId: string): RetireFlow {
  useEffect(() => watchRetireFlow(assetId), [assetId]);
  return useSyncExternalStore(subscribeRetireFlows, () => retireFlowOf(assetId), initialRetireFlow);
}
