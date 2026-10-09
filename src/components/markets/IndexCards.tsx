"use client";

import type { ReactNode } from "react";
import type { IndexRow } from "@/shared";
import { PANEL, PANEL_TITLE } from "@/components/account/styles";
import { changeTone, formatChangePct } from "@/components/terminal/change-format";
import { EmptyState } from "@/components/ui/EmptyState";
import { tProjectType, tRegistry } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { formatLevel } from "./format";

// 指数卡:名称 + 「模拟指数」标记、点位(24 小时前 = 100)、24h 涨跌(方向色 + 正负号)、成员数、涨跌家数。
// 每张卡都自己写「模拟指数」,不靠页头那一句 —— 卡片可能被单独截图;涨跌为 null(组里没有一个成员有 24h 成交)时点位与涨跌都是「—」,
// 并说明原因:看得见的一行灰字,加给读屏的「—」替代文字(NoValue,复用 markets.noTrades)。

/** 没有值的「—」:视觉上是破折号,读屏读「24h 内还没有成交」(裸的「—」读屏要么跳过要么念成标点) */
function NoValue() {
  const t = useT("terminal");
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t.markets.noTrades}</span>
    </>
  );
}

/**
 * 一张指数卡(纯展示):title 已按界面语言取好;large = 「全部」那张,点位用大一号的字;
 * headingLevel:「全部」那张本身就是页面里的一个分区,标题是 h2;分组里的卡在分区标题(h2)之下,标题是 h3。
 */
export function IndexCard({ id, title, row, large = false, headingLevel = 3 }: { id: string; title: string; row: IndexRow; large?: boolean; headingLevel?: 2 | 3 }) {
  const t = useT("terminal");
  const { lang } = useLang();
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article data-index={id} className={`flex min-w-0 flex-col gap-gap p-panel ${PANEL}`}>
      <header className="flex items-start justify-between gap-gap">
        <Heading className="min-w-0 text-t-sm font-medium text-foreground">{title}</Heading>
        <span className="shrink-0 rounded-chip border border-(--terminal-border) px-1 text-t-2xs text-muted">{t.markets.simulatedIndex}</span>
      </header>
      <dl className="grid grid-cols-2 gap-gap">
        <div className="flex min-w-0 flex-col">
          <dt className="text-t-xs text-muted">{t.markets.level}</dt>
          <dd data-level="" className={`tnum font-semibold text-foreground ${large ? "text-t-2xl" : "text-t-lg"}`}>
            {row.level === null ? <NoValue /> : formatLevel(row.level, lang)}
          </dd>
        </div>
        <div className="flex min-w-0 flex-col">
          <dt className="text-t-xs text-muted">{t.header.change24h}</dt>
          <dd data-change="" className={`tnum font-semibold ${large ? "text-t-2xl" : "text-t-lg"} ${changeTone(row.change24h)}`}>
            {row.change24h === null ? <NoValue /> : formatChangePct(row.change24h)}
          </dd>
        </div>
      </dl>
      <p data-breadth="" className="text-t-xs text-muted">
        {t.markets.members(row.members)} · {t.markets.breadth(row.advancers, row.decliners)}
      </p>
      {row.counted === 0 && row.members > 0 ? (
        <p className="text-t-xs text-muted-2">{t.markets.noTrades}</p>
      ) : row.counted < row.members ? (
        <p className="text-t-xs text-muted-2">{t.markets.partial(row.counted, row.members)}</p>
      ) : null}
    </article>
  );
}

/** 一组指数卡的分区:标题 + 卡片网格(< 48rem 一列、≥ 48rem 两列、≥ 64rem 四列);没有成员时给空态 */
function IndexGroup({ id, title, children, empty }: { id: string; title: string; children: ReactNode; empty: boolean }) {
  const t = useT("terminal");
  return (
    <section aria-labelledby={`markets-${id}`} className="flex flex-col gap-gap">
      <h2 id={`markets-${id}`} className={PANEL_TITLE}>
        {title}
      </h2>
      {empty ? (
        <div className={PANEL}>
          <EmptyState title={t.markets.noProjects} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-gap md:grid-cols-2 lg:grid-cols-4">{children}</div>
      )}
    </section>
  );
}

/** 「全部项目」一张大卡:卡片自己的标题就是这一块的 h2(不再另放一个只给读屏的同名标题) */
export function OverallIndex({ row }: { row: IndexRow }) {
  const t = useT("terminal");
  return <IndexCard id="all" title={t.markets.allTitle} row={row} large headingLevel={2} />;
}

/** 按登记簿 / 按项目类型两个分区;卡片标题经 tRegistry / tProjectType 取显示名(key 是库里的原始串) */
export function GroupedIndices({ byRegistry, byProjectType }: { byRegistry: IndexRow[]; byProjectType: IndexRow[] }) {
  const t = useT("terminal");
  const { lang } = useLang();
  return (
    <>
      <IndexGroup id="registry" title={t.markets.byRegistry} empty={byRegistry.length === 0}>
        {byRegistry.map((row) => (
          <IndexCard key={row.key} id={`registry:${row.key}`} title={tRegistry(row.key, lang)} row={row} />
        ))}
      </IndexGroup>
      <IndexGroup id="project-type" title={t.markets.byProjectType} empty={byProjectType.length === 0}>
        {byProjectType.map((row) => (
          <IndexCard key={row.key} id={`project-type:${row.key}`} title={tProjectType(row.key, lang)} row={row} />
        ))}
      </IndexGroup>
    </>
  );
}
