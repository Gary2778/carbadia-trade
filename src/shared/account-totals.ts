// 账户合计(计划 §6.2.2 C6):服务端(GET /api/account/overview)与客户端(资产页按行情重算)共用的纯函数。
// 口径与旧 /api/portfolio 的合计相同,同一份数据上数字相等(P2-05 时 overview-route.integration.test.ts 逐户对照过;
// 旧接口随旧 /portfolio 页在 P2-10 删除,对照随之去掉):
//   - 只有「持有」的行(quantity > 0)参与估值与成本是否完整的判断;整仓注销的行(quantity 0、retired > 0)只进 retiredCredits;
//   - 持有而没有价格的标的不计入 holdingsValue,并令 valuationComplete = false —— 不把缺的价格当成 0;
//   - heldCredits 不含情景标的(情景单位不是信用);retiredCredits = 各行 retired 之和(情景标的不可注销,恒为 0);
//   - unrealisedPnl 只在成本与估值都完整时给数,否则 null。
// 已确认的口径(2026-10-01,计划 §6.2.2 C6 同步写明;不要按旧简报的字面「改回去」):
//   (a) heldCredits 不含情景标的,与旧 /api/portfolio 相同,不是全部 quantity 之和;
//   (b) 未实现盈亏的成本取持仓行上服务端取整后的那一份(见 unrealisedPnlAt),不是 均价 × 数量。所以调用方不得改写已存
//       Position 行上的 lastPrice / marketValue / unrealisedPnl(三个数出自同一次映射,改掉一个成本就反推错了);
//       实时价只经 priceOf 传入。逐行的实时浮盈用 unrealisedPnlAt(position, price);
//   (c) 成本完整而估值不完整(有持有的标的没有价格)时 unrealisedPnl 同样是 null。
// 金额整数分,数量整数吨。只引本目录的类型(purity.test.ts)。
import type { AccountTotals } from "./api-shapes";
import type { Balance, Position } from "./types";
import { unrealisedPnlAt } from "./unrealised-pnl";

// 逐行的盈亏在 ./unrealised-pnl.ts(P2-10 拆出:终端的持仓页签逐行要用它,却用不着这里的合计;单独一个模块,终端首屏不必带上合计)
export { unrealisedPnlAt };

/**
 * @param positions 服务端给的持仓行原样传入(REST / WS 快照 / 事件里的那一份),不要先用行情改过再传。
 * @param priceOf 一行持仓的最新价(整数分),没有就返回 null。服务端传 `(p) => p.lastPrice`;
 *   客户端传行情里的最新价(没有再退回行上的 lastPrice),合计于是跟着行情走 —— 实时价只有这一个入口。
 */
export function computeAccountTotals(balance: Balance, positions: readonly Position[], priceOf: (position: Position) => number | null): AccountTotals {
  let holdingsValue = 0;
  let heldCredits = 0;
  let retiredCredits = 0;
  let unrealisedPnl: number | null = 0;
  let valuationComplete = true;
  let costBasisComplete = true;

  for (const position of positions) {
    retiredCredits += position.retired;
    if (position.quantity <= 0) continue; // 整仓注销的行:不持有,不估值
    if (!position.isScenario) heldCredits += position.quantity;
    if (position.costBasisStatus !== "complete") costBasisComplete = false;

    const price = priceOf(position);
    if (price == null || !Number.isFinite(price)) {
      valuationComplete = false;
      unrealisedPnl = null;
      continue;
    }
    holdingsValue += price * position.quantity;
    const pnl = unrealisedPnlAt(position, price);
    unrealisedPnl = unrealisedPnl == null || pnl == null ? null : unrealisedPnl + pnl;
  }

  return {
    holdingsValue,
    totalAssets: balance.cashBalance + balance.lockedCash + holdingsValue,
    heldCredits,
    retiredCredits,
    unrealisedPnl,
    valuationComplete,
    costBasisComplete,
  };
}
