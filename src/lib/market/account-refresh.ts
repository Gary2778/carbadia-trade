"use client";
// 底部 Tab(P1-21)的「账户变了 → 重读第一页」信号。历史委托与成交记录是游标分页的 REST 列表,store 里没有它们的完整来源
// (account store 不保留终态单;fill 事件断线期间不会补发,account 订阅快照里也没有成交),所以靠这里把新行拉到顶上。
// 三路触发,合并成 ACCOUNT_REFRESH_DEBOUNCE_MS 一次:
//   1. 账户指纹(accountSignature)变了:成交、撤单、部分成交、余额 / 持仓变动 —— WS 与轮询都有效;轮询每 5 s 整体替换引用,
//      值没变时指纹不变,不触发;断线 / 背压推迟(D16)期间的成交会体现在随后的 account 快照里,指纹一变就补上;
//   2. WS 模式下 balance 引用变了:hub 对本人的每一次委托结果(下单、撤单、成交,market-publisher 的 accountEventsFor)都推一条
//      balance 事件,account store 每收到一条就换一个新对象;所以即使值没变 —— 一张零成交就被取消的市价单,指纹完全不动 ——
//      这里也能看到。轮询模式不看它(每次轮询都换引用);
//   3. 连接重新变为 open(断线重连、部署后 1012 重连、轮询切回 WS):重连前后错过的 fill 事件不会补发,重读一次第一页。
// 另有 onSignOut:上一位已登录用户不再是当前用户(登出、会话失效、换号)时回调 —— 分页缓存靠它丢弃上一位用户的数据;
// onOpenOrdersClosed:同一位用户的挂单离开 openOrders(成交完、被撤、快照收口)时回调 —— 历史委托靠它给「按旧 createdAt
// 进了历史、位置在第一页之后」的单记 markStale。这两个是模块级订阅(Tab 没挂载时也要生效),只在浏览器里挂。
// 依赖纪律:本文件引 store.ts(市场 store),只给终端组件用;account-store / Nav 不得引它(否则市场 store 进全站 bundle,§7.1)。
import { useEffect } from "react";
import type { Order } from "@/shared";
import { useAccountStore, type AccountState } from "./account-store";
import { useMarketStore } from "./store";

/**
 * 账户里「成交 / 撤单会改动」的部分的指纹:现金与冻结、每个持仓的数量 / 冻结 / 注销、每张挂单的已成交量。
 * 轮询每 5 s 会整体替换 positions / balance 的引用,但值不变时指纹不变 —— 只有真的发生了成交或撤单才变。
 */
export function accountSignature(state: Pick<AccountState, "balance" | "positions" | "openOrders">): string {
  const parts: string[] = [state.balance ? `${state.balance.cashBalance}/${state.balance.lockedCash}` : "-"];
  for (const p of state.positions.values()) parts.push(`${p.assetId}:${p.quantity}:${p.locked}:${p.retired}`);
  for (const o of state.openOrders.values()) parts.push(`${o.id}:${o.filledQuantity}`);
  return parts.sort().join("|");
}

export const ACCOUNT_REFRESH_DEBOUNCE_MS = 300;

/**
 * 订阅上面三路触发,合并后调 onChange;返回解除函数(连同未到点的定时器一起清掉)。
 * 纯订阅,不读 window,node 环境可测(account-refresh.test.ts);组件经 useRefreshOnAccountChange 在 effect 里调用。
 */
export function watchAccountActivity(onChange: () => void, debounceMs: number = ACCOUNT_REFRESH_DEBOUNCE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  const initial = useAccountStore.getState();
  let lastSignature = accountSignature(initial);
  let lastBalance = initial.balance;
  const unsubscribeAccount = useAccountStore.subscribe((state) => {
    const signature = accountSignature(state);
    const balanceEvent = state.balance !== lastBalance && state.balance !== null && useMarketStore.getState().connection.transport === "ws";
    lastBalance = state.balance;
    if (signature === lastSignature && !balanceEvent) return;
    lastSignature = signature;
    schedule();
  });
  const unsubscribeMarket = useMarketStore.subscribe((state, prev) => {
    if (state.connection.state === "open" && prev.connection.state !== "open") schedule();
  });

  return () => {
    unsubscribeAccount();
    unsubscribeMarket();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * 挂载期间账户有动静(见文件头三路触发)就在 ACCOUNT_REFRESH_DEBOUNCE_MS 后调一次 refresh(合并同一拍的多条事件);
 * refresh 为 null 时不订阅。行按 id 去重,所以 WS 模式下多出来的一次第一页请求只是补漏,不会重复。
 */
export function useRefreshOnAccountChange(refresh: (() => unknown) | null): void {
  useEffect(() => {
    if (!refresh) return;
    return watchAccountActivity(() => void refresh());
  }, [refresh]);
}

/**
 * 上一位已登录用户不再是当前用户(登出、401 / me 为空、换号)时调用 listener;返回解除函数。
 * idle → loading → ready 的首次登录不算(之前没有用户)。
 */
export function onSignOut(listener: () => void): () => void {
  return useAccountStore.subscribe((state, prev) => {
    const was = prev.me?.id;
    if (was && state.me?.id !== was) listener();
  });
}

/**
 * 同一位已登录用户的挂单离开 openOrders 时调用 listener(meId, 离开的单);返回解除函数。
 * 给的是它离开前 store 里的最后一版(状态可能仍是 OPEN / PARTIAL,终态以服务端为准):调用方只拿它的 id / createdAt 定位。
 * 登出 / 换号时挂单被整个清空不算(那由 onSignOut 处理);只 upsert 的截断快照不删单,也就不会误报。
 */
export function onOpenOrdersClosed(listener: (meId: string, orders: Order[]) => void): () => void {
  return useAccountStore.subscribe((state, prev) => {
    if (state.openOrders === prev.openOrders) return;
    const me = state.me?.id;
    if (!me || prev.me?.id !== me) return;
    const gone: Order[] = [];
    for (const [id, order] of prev.openOrders) if (!state.openOrders.has(id)) gone.push(order);
    if (gone.length > 0) listener(me, gone);
  });
}
