"use client";

import Link from "next/link";
import type { InstrumentListItem } from "@/shared";
import { PANEL, PANEL_TITLE } from "@/components/account/styles";
import { changeTone, formatChangePct } from "@/components/terminal/change-format";
import { EmptyState } from "@/components/ui/EmptyState";
import { tName } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import { terminalHref } from "@/lib/market/navigation";
import { formatTonnes } from "./format";
import type { MarketRankings } from "./ranking";

// 榜单与情景标的的行:代码 + 项目名 | 最新价 | 24h 涨跌(| 24h 成交吨数),整行是指向 /trade/<symbol> 的链接。
// 数据全来自页面传下来的快照(一帧一份),行自己不订阅行情 store。涨跌用终端量过对比度的方向色(changeTone),
// 文字都落在面板底上(页面底色只做间隙,浅色下 --muted 在它上面不到 4.5:1)。
// 读屏:整行链接的可访问名是 markets.rowLabel(代码、项目名、最新价、24h 涨跌、成交量榜另加成交量,各带标签),不是几段无标签的数字
// 连着读;名次是视觉标记(aria-hidden),次序由 <ol> 表达。

const ROW_LINK =
  "flex min-h-touch items-center gap-gap px-panel py-1 text-t-sm transition-colors duration-(--motion-fast) hover:bg-(--terminal-row-hover) focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1.5";

type MarketRowProps = {
  item: InstrumentListItem;
  /** 榜单里的名次(从 1 起);情景标的分区不排名 */
  rank?: number;
  /** 成交量榜多一列 24h 成交吨数 */
  showVolume?: boolean;
  /** 情景标的:名字后面带「情景」标记 */
  scenario?: boolean;
};

function MarketRow({ item, rank, showVolume = false, scenario = false }: MarketRowProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const { instrument, ticker } = item;
  const name = tName(instrument.symbol, instrument.name, lang);
  const price = fmtPrice(ticker.lastPrice, instrument, lang);
  const change = formatChangePct(ticker.change24h);
  const volume = `${formatTonnes(ticker.volume24h, lang)} t`;
  const label = t.markets.rowLabel({
    symbol: instrument.symbol,
    name,
    // 没有值的格子在可访问名里写原因,不念「—」:从没成交过没有最新价,24h 内没成交没有涨跌
    price: ticker.lastPrice === null ? ui.notProvided : price,
    change: ticker.change24h === null ? t.markets.noTrades : change,
    volume: showVolume ? volume : null,
    scenario,
  });
  return (
    <li data-symbol={instrument.symbol} className="border-t border-(--terminal-border) first:border-t-0">
      <Link href={terminalHref(instrument.symbol)} prefetch={false} aria-label={label} className={ROW_LINK}>
        {rank !== undefined ? (
          <span aria-hidden="true" className="tnum w-4 shrink-0 text-end text-t-xs text-muted">
            {rank}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-gap">
            <span className="font-medium text-foreground">{instrument.symbol}</span>
            {scenario ? <span className="rounded-chip bg-warning-soft px-1 text-t-2xs text-warning">{t.tabs.scenarioTag}</span> : null}
          </span>
          <span className="truncate text-t-2xs text-muted">{name}</span>
        </span>
        <span data-price="" className="tnum shrink-0 text-foreground">
          {price}
        </span>
        <span data-change="" className={`tnum w-16 shrink-0 text-end ${changeTone(ticker.change24h)}`}>
          {change}
        </span>
        {showVolume ? (
          <span data-volume="" className="tnum w-20 shrink-0 text-end text-muted">
            {volume}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** 一张榜(面板):标题 + 名次行;没有可排的项目时给空态,而不是一块空白 */
function RankedList({ id, title, items, empty, showVolume }: { id: string; title: string; items: InstrumentListItem[]; empty: string; showVolume?: boolean }) {
  return (
    <section aria-labelledby={`markets-${id}`} data-ranking={id} className={`flex min-w-0 flex-col ${PANEL}`}>
      <h2 id={`markets-${id}`} className={`${PANEL_TITLE} p-panel pb-gap`}>
        {title}
      </h2>
      {items.length === 0 ? (
        <EmptyState title={empty} />
      ) : (
        <ol>
          {items.map((item, i) => (
            <MarketRow key={item.instrument.symbol} item={item} rank={i + 1} showVolume={showVolume} />
          ))}
        </ol>
      )}
    </section>
  );
}

/** 涨幅榜、跌幅榜、成交量榜:< 64rem 竖着排,≥ 64rem 并成三列 */
export function RankingLists({ rankings }: { rankings: MarketRankings }) {
  const t = useT("terminal");
  return (
    <div className="grid grid-cols-1 gap-gap lg:grid-cols-3">
      <RankedList id="gainers" title={t.markets.gainers} items={rankings.gainers} empty={t.markets.emptyGainers} />
      <RankedList id="losers" title={t.markets.losers} items={rankings.losers} empty={t.markets.emptyLosers} />
      <RankedList id="volume" title={t.markets.topVolume} items={rankings.volume} empty={t.markets.emptyVolume} showVolume />
    </div>
  );
}

/** 情景标的分区:单独一栏、写明不是真实信用也不进任何指数;没有情景标的时整个分区不画 */
export function ScenarioSection({ items }: { items: InstrumentListItem[] }) {
  const t = useT("terminal");
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="markets-scenarios" data-scenarios="" className={`flex min-w-0 flex-col ${PANEL}`}>
      <div className="flex flex-col gap-1 p-panel pb-gap">
        <h2 id="markets-scenarios" className={PANEL_TITLE}>
          {t.markets.scenarios}
        </h2>
        <p className="text-t-xs text-muted">{t.markets.scenariosNote}</p>
      </div>
      <ul>
        {items.map((item) => (
          <MarketRow key={item.instrument.symbol} item={item} scenario />
        ))}
      </ul>
    </section>
  );
}
