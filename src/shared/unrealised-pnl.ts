// 一行持仓按给定价格的未实现盈亏(计划 §6.2.2 C6)。从 ./account-totals.ts 拆出来的单独模块(P2-10):
// 账户合计 computeAccountTotals 与终端 / 资产页逐行的 positionValue 共用它;终端首屏只引这一个小模块,不必带上合计。
// 金额整数分,数量整数吨。只引本目录的类型(purity.test.ts)。
import type { Position } from "./types";

/**
 * 一行持仓按给定价格的未实现盈亏(整数分);成本不完整、或行上没有成本数据时为 null。
 * 成本取服务端映射时算好的那一份:toPosition 里 unrealisedPnl = lastPrice × quantity − 剩余成本(取整到分),反过来
 * lastPrice × quantity − unrealisedPnl 就是剩余成本,不受均价四舍五入影响(3 吨成本 1000 分,均价记 333,乘回去只有 999)。
 * 所以价格等于行上的 lastPrice 时结果就是行上的 unrealisedPnl,价格变了按同一份成本重算。
 * 前提:行上的 lastPrice 与 unrealisedPnl 出自同一次映射,都是服务端给的原值。store 里的 Position 行不要用行情去改
 * lastPrice / marketValue / unrealisedPnl(哪怕三个一起改);要按实时价算,就把价格作为第二个参数传进来。
 * 行上没有这两个数(映射时标的还没有价格)时退回 均价 × 数量。
 * 账户合计(./account-totals.ts 的 computeAccountTotals)与客户端逐行的市值与盈亏(src/lib/market/position-groups.ts 的 positionValue)
 * 调的都是这一个函数,两处不会各算各的。
 */
export function unrealisedPnlAt(
  position: Pick<Position, "quantity" | "lastPrice" | "averagePurchasePrice" | "unrealisedPnl" | "costBasisStatus">,
  price: number,
): number | null {
  if (position.costBasisStatus !== "complete") return null;
  const cost =
    position.lastPrice != null && position.unrealisedPnl != null
      ? position.lastPrice * position.quantity - position.unrealisedPnl
      : position.averagePurchasePrice != null
        ? position.averagePurchasePrice * position.quantity
        : null;
  return cost == null ? null : price * position.quantity - cost;
}

