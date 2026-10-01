"use client";

import { useMemo, useState } from "react";
import type { Position } from "@/shared";
import { isChinese, type Lang } from "@/i18n/config";
import { tCountry } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { getCreditProfile } from "@/lib/exchange/carbon";
import { allocationOf, type Allocation } from "@/lib/market/account-view";
import type { PositionMeta } from "@/lib/market/position-groups";
import { localeOf, share, tonnes, usd } from "./format";
import { PANEL, PANEL_TITLE } from "./styles";

/** 三种分组:项目类型(碳信用的大类,如林业、蓝碳、太阳能)/ 地域 / 类别(移除 / 避免排放) */
export type AllocationBy = "type" | "country" | "approach";
export const ALLOCATION_GROUPS: readonly AllocationBy[] = ["type", "country", "approach"];

/**
 * 分段的颜色:四个数据标记 token 依次用(--series … --series-4,按外观取值,不写死颜色);第五段起都归到「其余」的一个中性色,
 * 图例里每一行的色块与它在条上的那一段一致(排在后面的几段颜色相同、在条上连成一段)。
 */
export const ALLOCATION_TONES = ["var(--series)", "var(--series-2)", "var(--series-3)", "var(--series-4)"] as const;
export const ALLOCATION_REST_TONE = "var(--muted-2)";
export const allocationTone = (index: number): string => ALLOCATION_TONES[index] ?? ALLOCATION_REST_TONE;

export type AllocationViewProps = {
  allocation: Allocation;
  by: AllocationBy;
  onBy: (by: AllocationBy) => void;
};

/**
 * 持仓分布(纯展示;SSR 测试直接渲染):分组切换(三个按钮,aria-pressed)+ 堆叠条 + 图例。
 * 条只是图形(aria-hidden);图例是读屏可读的列表,每行:色块、分组名、占比、市值、吨数 —— 文字等价物。
 * 占比按市值,情景标的除外;没有价格的持仓不进占比,另说明一句;一个可算的持仓都没有 → 一句说明。
 */
export function AllocationView({ allocation, by, onBy }: AllocationViewProps) {
  const a = useT("account");
  const { lang } = useLang();
  const locale = localeOf(lang);
  const labels: Record<AllocationBy, string> = { type: a.allocation.byType, country: a.allocation.byCountry, approach: a.allocation.byApproach };
  return (
    <section aria-labelledby="allocation-title" data-allocation="" className={`flex flex-col gap-panel p-panel ${PANEL}`}>
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <div className="flex flex-col">
          <h2 id="allocation-title" className={PANEL_TITLE}>
            {a.allocation.title}
          </h2>
          <p className="text-t-xs text-muted">{a.allocation.note}</p>
        </div>
        <div role="group" aria-label={a.allocation.groupBy} className="flex flex-wrap gap-gap">
          {ALLOCATION_GROUPS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={by === key}
              onClick={() => onBy(key)}
              className={`inline-flex min-h-touch items-center rounded-chip px-2 text-t-xs font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus lg:min-h-0 lg:py-1 ${
                by === key ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {labels[key]}
            </button>
          ))}
        </div>
      </div>
      {allocation.slices.length === 0 ? (
        <p className="text-t-sm text-muted">{a.allocation.empty}</p>
      ) : (
        <>
          <div aria-hidden="true" className="flex h-3 w-full overflow-hidden rounded-pill bg-(--terminal-panel-2)">
            {allocation.slices.map((slice, i) => (
              <span key={slice.label} className="h-full" style={{ width: `${slice.share * 100}%`, background: allocationTone(i) }} />
            ))}
          </div>
          <ul aria-label={`${a.allocation.title} · ${labels[by]}`} className="grid gap-x-panel gap-y-1 sm:grid-cols-2">
            {allocation.slices.map((slice, i) => (
              <li key={slice.label} data-slice={slice.label} className="flex min-w-0 items-center gap-gap text-t-sm">
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-chip" style={{ background: allocationTone(i) }} />
                <span className="min-w-0 flex-1 truncate">{slice.label}</span>
                <span className="tnum font-medium">{share(slice.share, locale)}</span>
                <span className="tnum w-28 text-end text-muted">{usd(slice.value, locale)}</span>
                <span className="tnum w-16 text-end text-t-xs text-muted">{`${tonnes(slice.tonnes, locale)} t`}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {allocation.unpriced > 0 ? <p className="text-t-xs text-muted">{a.allocation.unpriced(allocation.unpriced)}</p> : null}
    </section>
  );
}

/** 分组名:项目类型取碳信用的大类(与旧 /portfolio 同一个 getCreditProfile),地域取国家,类别取移除 / 避免排放;都按界面语言 */
export function allocationLabel(by: AllocationBy, position: Pick<Position, "symbol">, meta: PositionMeta | undefined, lang: Lang, notProvided: string): string {
  if (!meta) return notProvided;
  if (by === "country") return tCountry(meta.country, lang);
  const profile = getCreditProfile({ symbol: position.symbol, projectType: meta.projectType });
  const zh = isChinese(lang);
  return by === "type" ? (zh ? profile.categoryZh : profile.category) : zh ? profile.approachZh : profile.approach;
}

/** 分布(容器):分组方式是本地状态(默认项目类型,不持久化);价格与各行同一组(prices,缺的退回持仓行自带的) */
export function AllocationSection({ positions, meta, prices }: { positions: readonly Position[]; meta: Readonly<Record<string, PositionMeta>>; prices: Readonly<Record<string, number | null>> }) {
  const ui = useT("ui");
  const { lang } = useLang();
  const [by, setBy] = useState<AllocationBy>("type");
  const allocation = useMemo(
    () =>
      allocationOf(
        positions,
        (position) => allocationLabel(by, position, meta[position.symbol], lang, ui.notProvided),
        (position) => prices[position.symbol] ?? position.lastPrice,
      ),
    [positions, meta, prices, by, lang, ui.notProvided],
  );
  return <AllocationView allocation={allocation} by={by} onBy={setBy} />;
}
