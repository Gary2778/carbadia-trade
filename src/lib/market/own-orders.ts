// 本页(这个标签页)自己刚提交的订单 id:OrderPanel 下单成功(order-submit 的 submitOrder 收到形状校验通过的响应,含重放)时登记,
// 通知 Toast 据此跳过这些单的 taker 成交通知 —— 下单 Toast 已经说过了。条件单触发后引擎下的单不是这个标签页提交的,不在这里,它的成交照常弹。
// 只登记最近 OWN_ORDERS_MAX 个(插入序,满了丢最早的):Toast 只在成交通知到达的那一刻查,不需要长记性。
// 属于当前用户:账户 store 的身份变了(登出、换人 —— 也就是账户重置)就清空。这条订阅放在本文件、不放在 account-store 里:
// account-store 在每页的 floor 包里,而本文件只随终端(order-submit)与懒加载的 Toast 文案走。
import { useAccountStore } from "./account-store";

export const OWN_ORDERS_MAX = 64;
const own = new Set<string>();

export function rememberOwnOrder(orderId: string): void {
  own.delete(orderId);
  own.add(orderId);
  for (const oldest of own) {
    if (own.size <= OWN_ORDERS_MAX) break;
    own.delete(oldest);
  }
}

export const isOwnOrder = (orderId: string): boolean => own.has(orderId);

useAccountStore.subscribe((state, prev) => {
  if (state.me?.id !== prev.me?.id) own.clear();
});

/** 测试用:清空 */
export function clearOwnOrders(): void {
  own.clear();
}
