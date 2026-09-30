// 自家挂单的来源接缝(与 account-bridge.ts 同一模式):useBookView 的 mine 从这里读 openOrders。
// 账户 store(account-store.ts,P1-15)在模块初始化时 registerOpenOrdersSource(useAccountStore) 接上。
//
// 本文件是零依赖叶子(只有类型导入):account-store 只引它、不引 selectors.ts。Nav 在根布局里 import account-store,
// 若经 selectors 就会把 store.ts / book-view / instrument-filter 拖进每个页面的 floor bundle(计划 §7.1 floor ≤ 200 KB)。
// selectors.ts 从这里导入并原样再导出,既有调用方(selectors.test.ts 等)不用改。
//
// 未注册时 openOrders 恒为同一个空 Map(没有自家档);注册时已挂载的订阅者会被通知并改订到新源。
import type { Order } from "@/shared";

/** 与 zustand StoreApi 结构兼容:useAccountStore 本身就满足 */
export type OpenOrdersSource = {
  subscribe: (listener: () => void) => () => void;
  getState: () => { openOrders: ReadonlyMap<string, Order> };
};

export const EMPTY_ORDERS: ReadonlyMap<string, Order> = new Map();
let openOrdersSource: OpenOrdersSource | null = null;
const openOrdersListeners = new Set<() => void>();
const sourceUnsubs = new Map<() => void, () => void>();

/** 注册 / 注销(传 null)自家挂单来源;已挂载的 useBookView 会立即重读并改订到新源 */
export function registerOpenOrdersSource(source: OpenOrdersSource | null): void {
  for (const unsub of sourceUnsubs.values()) unsub();
  sourceUnsubs.clear();
  openOrdersSource = source;
  for (const listener of openOrdersListeners) {
    if (source) sourceUnsubs.set(listener, source.subscribe(listener));
    listener();
  }
}

/** useSyncExternalStore 的 subscribe:同时挂到注册表(以便换源时通知)与当前源 */
export function subscribeOpenOrders(listener: () => void): () => void {
  openOrdersListeners.add(listener);
  if (openOrdersSource) sourceUnsubs.set(listener, openOrdersSource.subscribe(listener));
  return () => {
    openOrdersListeners.delete(listener);
    sourceUnsubs.get(listener)?.();
    sourceUnsubs.delete(listener);
  };
}

/** useSyncExternalStore 的 getSnapshot:未注册时恒为同一个空 Map */
export function readOpenOrders(): ReadonlyMap<string, Order> {
  return openOrdersSource ? openOrdersSource.getState().openOrders : EMPTY_ORDERS;
}

/** useSyncExternalStore 的 getServerSnapshot:服务端 / 水合快照恒为空(SSR 不画自家档) */
export const readServerOpenOrders = (): ReadonlyMap<string, Order> => EMPTY_ORDERS;
