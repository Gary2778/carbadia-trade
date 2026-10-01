"use client";

import { useShallow } from "zustand/react/shallow";
import type { Balance } from "@/shared";
import { useBalance, usePositions } from "@/lib/market/account-store";
import { heldPrices, liveTotals } from "@/lib/market/account-view";
import { positionMetaOf } from "@/lib/market/position-groups";
import { useMarketStore } from "@/lib/market/store";
import { AllocationSection } from "./Allocation";
import { HoldingsSection } from "./Holdings";
import { OtcListingsSection } from "./OtcListings";
import { AccountSummary } from "./Summary";
import type { OverviewExtras } from "./useAccountOverview";

const NO_BALANCE: Balance = { cashBalance: 0, lockedCash: 0 };

/**
 * 就绪后的页面主体(容器):持仓与余额取账户 store(与终端「持仓」页签同一个 usePositions,WS 的 position 事件 ≤ 1 帧、轮询 ≤ 5 s),
 * 价格取行情 store 里持有标的的最新价(浅比较:只有持有的标的价格变了才重渲染),合计按最新价重算(liveTotals = computeAccountTotals,
 * 取价规则与各行相同,所以页头与各行相加逐分一致)。分组元数据经 positionMetaOf(内容不变引用就不变)。
 * 24 小时变化与 OTC 挂牌来自总览接口(extras),stale = 最近一次重取失败、显示的是上一份。
 */
export function AccountContent({
  extras,
  stale,
  onListingCancelled,
  onRefresh,
}: {
  extras: OverviewExtras;
  stale: boolean;
  onListingCancelled: (id: string) => void;
  onRefresh: () => Promise<void>;
}) {
  const positions = usePositions();
  const balance = useBalance() ?? NO_BALANCE;
  const meta = useMarketStore((s) => positionMetaOf(s.instruments));
  const prices = useMarketStore(useShallow((s) => heldPrices(s, positions)));
  // 合计与各行共用同一组价格(prices;没有的退回行上的,liveTotals 与 positionValue 同一规则)
  const totals = liveTotals(balance, positions, prices);
  return (
    <>
      <AccountSummary totals={totals} balance={balance} change24h={extras.change24h} stale={stale} />
      <HoldingsSection positions={positions} meta={meta} prices={prices} />
      <AllocationSection positions={positions} meta={meta} prices={prices} />
      {extras.otcListings.length > 0 ? <OtcListingsSection listings={extras.otcListings} meta={meta} onCancelled={onListingCancelled} onRefresh={onRefresh} /> : null}
    </>
  );
}
