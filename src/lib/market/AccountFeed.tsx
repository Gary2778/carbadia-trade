"use client";
// 资产页 /trade/account 的行情层(计划 §6.2.3 P2-10):MarketProvider 里与标的无关的那一半,可单独挂载,无渲染输出。
//   - 订阅集:登录后 ticker:*(全部标的的最新价,持仓估值用)+ account;不订阅 book / trades / candles(ACCOUNT_FEED_TOPICS);
//   - 只给已登录用户开(P2-13,终审 UI-3):未登录时页面只有登录入口(AccountGate),用不上价格 —— 不连 /ws、不订 ticker:*、不轮询;
//     登录(含一键演示)之后 meId 有了才启动,登出即停,换人则按新身份重开(startAccountFeed);
//   - transport 生命周期与 account 订阅和终端同一份代码(MarketProvider.tsx 的 startFeed / subscribeAccountTopic);
//   - 轮询降级:pollTickers(只拉 /api/market/instruments,翻成 ticker 帧)2 s、pollAccount(持仓 / 余额 + 当前挂单;不取条件单,
//     资产页不显示它们 —— includeTriggers: false)5 s,
//     都只在 connection.transport === "poll" 时打 REST;未登录时不拉行情(页面只有登录入口,用不上价格);
//     第一次不看可见性(runFirstWhileHidden,P2-12):在后台标签页里打开的资产页在轮询降级下也有首屏数据,之后后台照旧暂停
//    (终端的 MarketProvider 不变:后台打开的终端回前台才取);
//   - 首屏:挂载后把服务端给的标的清单灌进 store(onlyIfEmpty),名称、分组元数据与最新价在 WS 快照之前就有;
//   - 账户 store 的 /trade* 规则不变:refreshOnNavigation 在 /trade 下不拉 /api/auth/me —— 这里的 account 推送 / 轮询在维护余额。
// transport 与 batcher 是 MarketProvider 的模块级单例(getMarketRuntime);终端与资产页是不同页面,两个组件不会同时挂载。
import { useEffect, useSyncExternalStore } from "react";
import type { InstrumentListItem, InstrumentsResponse, Topic } from "@/shared";
import { FIRST_RUN_WHILE_HIDDEN, usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/http/client";
import { readMeId, readServerMeId, subscribeAccount } from "./account-bridge";
import { getMarketRuntime, pollAccount, POLL_ACCOUNT_MS, POLL_MARKET_MS, startFeed, subscribeAccountTopic, type MarketRuntime } from "./MarketProvider";
import { framesFromInstruments } from "./poll-frames";
import { marketActions, useMarketStore } from "./store";
import type { TransportMode } from "./transport";

/** 资产页的行情订阅(登录后才有,另加 account):只有全部标的的最新价 */
export const ACCOUNT_FEED_TOPICS: readonly Topic[] = ["ticker:*"];

/**
 * 资产页的 transport 生命周期(与终端同一个 startFeed:ticker:* + 按服务端提示启动),只在已登录时开:meId 为 null(未登录、身份未知)
 * 时什么都不做,返回空的清理函数。effect 以 meId 为依赖:登录后开、登出时停(清理)、换人时先停再按新身份开。
 */
export function startAccountFeed(rt: MarketRuntime, meId: string | null, transportMode?: TransportMode): () => void {
  if (!meId) return () => {};
  return startFeed(rt, transportMode);
}

const isPolling = (): boolean => useMarketStore.getState().connection.transport === "poll";

/**
 * 轮询降级下的行情:只拉标的列表(每个标的一条 ticker 快照帧),不拉盘口 / 成交 / K 线。
 * 与 pollMarket 同样绕过浏览器缓存(cache: "no-store",原因见 MarketProvider 的 pollMarket),请求在途时切回了 WS 则丢弃响应;
 * 失败抛出让 usePolling 退避。标的元数据只在 store 还空着时灌。
 */
export async function pollTickers(rt: Pick<MarketRuntime, "batcher">): Promise<void> {
  if (!isPolling()) return;
  const instruments = await api<InstrumentsResponse>("/api/market/instruments", { cache: "no-store" });
  if (!isPolling()) return;
  rt.batcher.push(framesFromInstruments(instruments));
  marketActions.setInstruments(instruments.instruments, { onlyIfEmpty: true });
}

export type AccountFeedProps = {
  /** 服务端给的标的清单(listInstruments());挂载后灌入 store(onlyIfEmpty) */
  initialInstruments?: InstrumentListItem[];
  /** 服务端的运行期传输提示(transportModeForServer);"poll" = 首帧就轮询 */
  transportMode?: TransportMode;
};

export function AccountFeed({ initialInstruments, transportMode }: AccountFeedProps): null {
  const meId = useSyncExternalStore(subscribeAccount, readMeId, readServerMeId);

  useEffect(() => {
    if (initialInstruments) marketActions.setInstruments(initialInstruments, { onlyIfEmpty: true });
  }, [initialInstruments]);

  // 登录后:ticker:* + transport 生命周期(与终端同一个 startFeed;它订的就是 ACCOUNT_FEED_TOPICS)。未登录不连 /ws
  useEffect(() => {
    const rt = getMarketRuntime();
    if (!rt) return;
    return startAccountFeed(rt, meId, transportMode);
  }, [meId, transportMode]);

  useEffect(() => {
    if (!meId) return;
    const rt = getMarketRuntime();
    if (!rt) return;
    return subscribeAccountTopic(rt);
  }, [meId]);

  usePolling(
    () => {
      const rt = getMarketRuntime();
      if (!rt || !isPolling() || !meId) return;
      return pollTickers(rt);
    },
    POLL_MARKET_MS,
    meId,
    FIRST_RUN_WHILE_HIDDEN,
  );
  usePolling(
    () => {
      const rt = getMarketRuntime();
      if (!rt || !isPolling() || !meId) return;
      return pollAccount(meId, rt, { includeTriggers: false });
    },
    POLL_ACCOUNT_MS,
    meId,
    FIRST_RUN_WHILE_HIDDEN,
  );

  return null;
}
