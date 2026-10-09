// 下单提交后钩子(计划 §6.3.2 C5):placeOrder / cancelOrder 在 publishOrderResult 之后调 afterOrderCommit(result)。
// 它只做一件事:给「人类」用户写成交通知(fill)—— 一次下单结果里,taker 的单与每张被成交的 maker 单各一条
// (dedupeKey = fill:<orderId>:<该单此刻的累计成交量>,重放同一结果落不进第二条)。离线用户也要有,所以落库,不走 account 事件
// (hub 对没有连接的用户直接丢事件);在线用户的 notice 事件由 notifyUser 顺带发。
//
// 不拖慢、不弄坏下单:afterOrderCommit 同步返回、绝不抛。撤单、重放、没有成交、以及机器人名单已知且参与者全是机器人的结果当场返回 ——
// 机器人对机器人的成交(每 ~2.5 s 一笔)既不入队也不查库;其余把「写通知」排进挂在 globalThis 上的串行队列(下单应答不等它)。
// 机器人名单与发布器共用(market-publisher 的 loadBotUserIds / knownBotUserIds,首次需要时查一次库、挂在 globalThis 上);
// 名单还没查到的第一笔成交由队列任务去查,查库失败(不知道谁是机器人)就丢这一批:宁可少一条提醒,也不给机器人写通知。
// 写入与成交不是同一个事务:进程在两者之间崩溃会丢这条提醒,账不受影响(C5)。
//
// 本文件对 matching 只做类型导入(matching 在顶层 import 本文件,值导入会成环);notices.ts 同样不引 matching。
// 队列挂 globalThis.__carbadiaOrderHooks:REST 下单与机器人下单在两个 bundle 里,共用一条队列,写通知一次一条、顺序 = 提交顺序。
// 里面是一条 Promise 链与在途计数,不是纯数据 —— 「globalThis 只放纯数据」的又一处例外(与触发引擎同理,见 trigger-engine.ts 文件头)。
import type { CancelOrderResult, PlaceOrderResult } from "../exchange/matching";
import type { NoticePayload } from "@/shared/types";
import { narrowOrderStatus, narrowSide } from "./account-mappers";
import { knownBotUserIds, loadBotUserIds } from "./market-publisher";
import { notifyUser } from "./notices";

type HookQueue = {
  /** 队尾:最后一个排进去的任务跑完(含它的 catch / finally)才 resolve */
  tail: Promise<void>;
  /** 排着或在跑的任务数 */
  pending: number;
};

declare global {
  /** 提交后钩子的串行队列(见文件头);测试经 drainOrderHooks 等它跑完 */
  var __carbadiaOrderHooks: HookQueue | undefined;
}

function logError(ev: string, err: unknown, extra: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ src: "order-hooks", ev, ...extra, error: err instanceof Error ? err.message : String(err) }));
}

function enqueue(task: () => Promise<void>): void {
  const queue = (globalThis.__carbadiaOrderHooks ??= { tail: Promise.resolve(), pending: 0 });
  queue.pending += 1;
  queue.tail = queue.tail
    .then(task)
    .catch((err) => logError("hook_failed", err))
    .finally(() => {
      queue.pending -= 1;
    });
}

/** 等队列里已排的任务(含等待期间新排进来的)全部跑完;只给测试用,生产代码不等它 */
export async function drainOrderHooks(): Promise<void> {
  const queue = globalThis.__carbadiaOrderHooks;
  while (queue && queue.pending > 0) await queue.tail;
}

type Draft = { userId: string; payload: NoticePayload; dedupeKey: string };

/** 一张被动方订单在这次结果里的成交合计(分 × 吨) */
type Tally = { userId: string; quantity: number; cost: number };

const averagePrice = (cost: number, quantity: number): number => Math.round(cost / quantity);

/**
 * 这次下单结果要写的成交通知(纯函数,不碰库):taker 一条(本次下单成交了才有)、每张被成交的 maker 单一条;机器人的单跳过。
 * quantity / price = 该单在这次结果里成交的吨数与均价(分),不是累计值;orderStatus = 这次结果之后该单的状态。
 * 自成交防护撤掉的本人挂单(makerOrders 里 CANCELLED、没有成交)不产生通知。
 */
function fillNoticesOf(result: PlaceOrderResult, bots: ReadonlySet<string>): Draft[] {
  const { order, trades, makerOrders } = result;
  const symbol = order.asset.symbol;
  const drafts: Draft[] = [];

  const takerSide = narrowSide(order.side);
  const takerStatus = narrowOrderStatus(order.status);
  if (result.filledQty > 0 && takerSide && takerStatus && !bots.has(order.userId)) {
    drafts.push({
      userId: order.userId,
      payload: { kind: "fill", orderId: order.id, symbol, side: takerSide, role: "TAKER", quantity: result.filledQty, price: averagePrice(result.filledCost, result.filledQty), orderStatus: takerStatus },
      dedupeKey: `fill:${order.id}:${order.filledQuantity}`,
    });
  }

  // 每张被动方订单成交了多少、什么价:成交行里下单方是买方 → 被动方是卖单,反之亦然
  const tallies = new Map<string, Tally>();
  for (const trade of trades) {
    const makerIsBuyer = trade.sellOrder.id === order.id;
    const orderId = makerIsBuyer ? trade.buyOrder.id : trade.sellOrder.id;
    const tally = tallies.get(orderId) ?? { userId: makerIsBuyer ? trade.buyerId : trade.sellerId, quantity: 0, cost: 0 };
    tally.quantity += trade.quantity;
    tally.cost += trade.price * trade.quantity;
    tallies.set(orderId, tally);
  }
  const makers = new Map(makerOrders.map((row) => [row.id, row]));
  for (const [orderId, tally] of tallies) {
    const row = makers.get(orderId);
    const side = row ? narrowSide(row.side) : null;
    const status = row ? narrowOrderStatus(row.status) : null;
    if (!row || !side || !status || bots.has(tally.userId)) continue;
    drafts.push({
      userId: tally.userId,
      payload: { kind: "fill", orderId, symbol, side, role: "MAKER", quantity: tally.quantity, price: averagePrice(tally.cost, tally.quantity), orderStatus: status },
      dedupeKey: `fill:${orderId}:${row.filledQuantity}`,
    });
  }
  return drafts;
}

async function writeFillNotices(result: PlaceOrderResult): Promise<void> {
  const bots = await loadBotUserIds();
  if (!bots) return; // 不知道谁是机器人(查库失败,发布器已记日志):这一批不写
  for (const draft of fillNoticesOf(result, bots)) await notifyUser(draft.userId, draft.payload, draft.dedupeKey);
}

/**
 * 订单事务提交、publishOrderResult 之后调用(placeOrder / cancelOrder),调用方不 await。同步返回、不抛。
 * 只有「本次真的成交了」的下单结果(非重放)才可能写通知;撤单结果什么都不做。
 */
export function afterOrderCommit(result: PlaceOrderResult | CancelOrderResult): void {
  try {
    if (!("replayed" in result) || result.replayed || result.trades.length === 0) return;
    // 名单已知且买卖双方全是机器人:当场返回(机器人对机器人的成交走这条路,零入队零查库)
    const bots = knownBotUserIds();
    if (bots && result.trades.every((t) => bots.includes(t.buyerId) && bots.includes(t.sellerId))) return;
    enqueue(() => writeFillNotices(result));
  } catch (err) {
    logError("enqueue_failed", err);
  }
}
