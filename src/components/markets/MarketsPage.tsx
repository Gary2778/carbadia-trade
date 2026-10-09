"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import type { InstrumentListItem, MarketIndices } from "@/shared";
import { PANEL } from "@/components/account/styles";
import { DemoBadge } from "@/components/terminal/DemoBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";
import { useT } from "@/i18n/LangProvider";
import { requestTransportReconnect } from "@/lib/market/account-bridge";
import { selectFeedOffline } from "@/lib/market/connection-kind";
import { useMarketStore } from "@/lib/market/store";
import type { TransportMode } from "@/lib/market/transport";
import { GroupedIndices, OverallIndex } from "./IndexCards";
import { MarketsFeed } from "./MarketsFeed";
import { RankingLists, ScenarioSection } from "./RankedLists";
import { rankMarkets } from "./ranking";
import { useMarketOverview } from "./useMarketOverview";

// 市场总览页 /trade/markets(计划 §6.3.3 P3-05):资产页的做法 —— 终端的设计语言(token、等宽数字、统一反馈件),文档式单列。
//   - 根 <div data-terminal data-glass="off" data-account>:与资产页同一组根属性(--terminal-* token 在子树里有值;dark 下面板不透明;
//     文档式单列由 terminal.css 的 [data-terminal][data-account] 给);内容列最大宽度 max-w-7xl 由这里给;
//   - 服务端渲染:页头 + 指数卡 + 三张榜 + 情景标的,全部来自 props(listInstruments()),水合首帧同样来自 props,渲染期不读写行情 store;
//   - 公开页面,没有任何账户数据:不订阅 account,未登录照常工作(行情层见 MarketsFeed);
//   - 三态(§4.5):标的清单还没到 → Skeleton;没有任何标的 → EmptyState;没有数据且行情源已断(selectFeedOffline)→ ErrorState,重试 = 让传输层重连;
//     已经有数据时行情源断了 → 数字照旧显示,上面多一行说明「可能不是最新的」(StaleNote,warning 语义色),连回来就消失。

export type MarketsPageProps = {
  /** 服务端的标的清单(listInstruments()):首屏由它渲染,挂载后灌入行情 store */
  initialInstruments: InstrumentListItem[];
  /** listInstruments() 的 serverTime:首屏指数按这个时刻算(服务端与水合首帧同值) */
  serverTime: number;
  /** 服务端的传输提示(transportModeForServer):"poll" = 服务端没有 /ws,首帧就轮询 */
  transportMode?: TransportMode;
};

/** 页面的外框与页头(纯展示):标题 + Demo 徽标 + 一句说明(这些都是模拟指数,24 小时前 = 100) */
export function MarketsFrame({ children }: { children: ReactNode }) {
  const t = useT("terminal");
  return (
    <div data-terminal="" data-glass="off" data-account="">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-panel">
        <header className={`flex flex-col gap-gap p-panel ${PANEL}`}>
          <div className="flex flex-wrap items-center gap-x-panel gap-y-gap">
            <h1 className="text-t-2xl font-semibold text-foreground">{t.markets.title}</h1>
            <DemoBadge />
          </div>
          <p data-markets-intro="" className="max-w-3xl text-t-md text-muted">
            {t.markets.intro}
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}

/** 加载骨架:与就绪后的版面同一骨架(一张大卡、一排小卡、三张榜),替换时不跳 */
export function MarketsSkeleton() {
  return (
    <div data-markets-skeleton="" className="flex flex-col gap-panel">
      <div className={`p-panel ${PANEL}`}>
        <Skeleton rows={2} />
      </div>
      <div className="grid grid-cols-1 gap-gap md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className={`p-panel ${PANEL}`}>
            <Skeleton rows={2} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-gap lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className={`p-panel ${PANEL}`}>
            <Skeleton rows={5} />
          </div>
        ))}
      </div>
    </div>
  );
}

export type MarketsBodyProps = {
  items: InstrumentListItem[];
  indices: MarketIndices;
  /** 标的清单已经落地(props 里有,或 store 已灌入) */
  loaded: boolean;
  /** 行情源已断(与连接徽标「离线」同一口径) */
  offline: boolean;
  onRetry: () => void;
};

/**
 * 行情源断开、页面上还留着最后一次的数字时的说明:一行小字(warning 语义色,落在面板底上),role="status" 让读屏在出现时播报;
 * 不用终端的连接徽标 —— 它连带 selectors.ts,页面自有 chunk 会超预算。由 offline 派生,连回来就消失。
 */
function StaleNote() {
  const t = useT("terminal");
  return (
    <p role="status" data-markets-stale="" className={`px-panel py-gap text-t-xs text-warning ${PANEL}`}>
      {t.markets.stale}
    </p>
  );
}

/** 页面主体按状态切换(纯展示):有数据 → 指数与榜单(行情源断了另有一行「可能不是最新」);没有数据时 离线 → 出错可重试、没到 → 骨架、到了是空的 → 空态 */
export function MarketsBody({ items, indices, loaded, offline, onRetry }: MarketsBodyProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const rankings = useMemo(() => rankMarkets(items), [items]);
  if (items.length === 0) {
    if (offline) {
      return (
        <div className={`p-panel ${PANEL}`}>
          <ErrorState message={ui.error} onRetry={onRetry} />
        </div>
      );
    }
    return loaded ? (
      <div className={PANEL}>
        <EmptyState title={t.markets.noProjects} />
      </div>
    ) : (
      <MarketsSkeleton />
    );
  }
  return (
    <>
      {offline ? <StaleNote /> : null}
      <OverallIndex row={indices.all} />
      <GroupedIndices byRegistry={indices.byRegistry} byProjectType={indices.byProjectType} />
      <RankingLists rankings={rankings} />
      <ScenarioSection items={rankings.scenarios} />
    </>
  );
}

/**
 * 总览页(容器)。快照来自 useMarketOverview:首屏是 props、之后是行情 store 按帧合并的快照;渲染期不读写 store
 * (只读一个「行情源已断」的布尔,服务端与水合首帧是初始状态 → 不离线,与 HTML 一致)。
 * 星空:与终端、资产页一样挂载时写 html[data-starfield="static"](页面整块不透明,背后的 30 fps 星空白跑),卸载删掉。
 */
export function MarketsPage({ initialInstruments, serverTime, transportMode }: MarketsPageProps) {
  const overview = useMarketOverview(initialInstruments, serverTime);
  const offline = useMarketStore(selectFeedOffline);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.starfield = "static";
    return () => {
      delete root.dataset.starfield;
    };
  }, []);

  return (
    <MarketsFrame>
      <MarketsFeed initialInstruments={initialInstruments} transportMode={transportMode} />
      <MarketsBody items={overview.items} indices={overview.indices} loaded={overview.loaded} offline={offline} onRetry={requestTransportReconnect} />
    </MarketsFrame>
  );
}
