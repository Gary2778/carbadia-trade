"use client";
// 市场总览页 /trade/markets 的行情层:没有渲染输出。与资产页的 AccountFeed 同一套 transport 生命周期(startFeed:订阅 ticker:*、按服务端提示启动),
// 区别有两处:
//   - 不看登录:总览页是公开页面,未登录也要连 /ws、订 ticker:*(AccountFeed 只给已登录用户开);
//   - 不订阅 account:页面上没有任何账户数据,所以 Nav 的现金不靠推送,而是按导航刷新(account-store.ts 的 refreshOnNavigation 对本页不跳过)。
// 轮询降级:transport 为 poll(服务端没有 /ws,或 WS 连不上降级)时 pollTickers 每 2 s 拉一次 /api/market/instruments、翻成 ticker 帧喂同一个 batcher
//(pollTickers 自己只在 poll 下打 REST;第一次不看可见性,在后台标签页打开也有首屏之后的数据)。
// 首屏:挂载后把服务端的标的清单灌进 store(onlyIfEmpty);页面读 store 的快照见 useMarketOverview。
// transport 与 batcher 是 MarketProvider 的模块级单例;终端、资产页、总览页是不同页面,不会同时挂载。
import { useEffect } from "react";
import type { InstrumentListItem } from "@/shared";
import { FIRST_RUN_WHILE_HIDDEN, usePolling } from "@/hooks/usePolling";
import { pollTickers } from "@/lib/market/AccountFeed";
import { getMarketRuntime, POLL_MARKET_MS, startFeed } from "@/lib/market/MarketProvider";
import { marketActions } from "@/lib/market/store";
import type { TransportMode } from "@/lib/market/transport";

export type MarketsFeedProps = {
  /** 服务端的标的清单(listInstruments());挂载后灌入 store(onlyIfEmpty) */
  initialInstruments: InstrumentListItem[];
  /** 服务端的运行期传输提示(transportModeForServer);"poll" = 首帧就轮询 */
  transportMode?: TransportMode;
};

export function MarketsFeed({ initialInstruments, transportMode }: MarketsFeedProps): null {
  useEffect(() => {
    marketActions.setInstruments(initialInstruments, { onlyIfEmpty: true });
  }, [initialInstruments]);

  useEffect(() => {
    const rt = getMarketRuntime();
    if (!rt) return;
    return startFeed(rt, transportMode);
  }, [transportMode]);

  usePolling(
    () => {
      const rt = getMarketRuntime();
      if (!rt) return;
      return pollTickers(rt);
    },
    POLL_MARKET_MS,
    undefined,
    FIRST_RUN_WHILE_HIDDEN,
  );

  return null;
}
