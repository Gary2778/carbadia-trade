"use client";

import { memo, useId, useState, type KeyboardEvent } from "react";
import type { Lang } from "@/i18n/config";
import { htmlLang, useLang, useT } from "@/i18n/LangProvider";
import { tProjectType, tRegistry } from "@/i18n/data";
import {
  centsToPriceInput,
  hasActiveFilters,
  priceInputToCents,
  setFilter,
  sortOptionsByLabel,
  syncPriceInput,
  type InstrumentFacets,
  type InstrumentFilters as Filters,
  type InstrumentSort,
} from "@/lib/market/instrument-filter";

/** 搜索框的固定 id:focusInstrumentSearch()(/ 与 Ctrl/Cmd+K)按它找输入框;终端里只有一个标的面板 */
export const INSTRUMENT_SEARCH_ID = "terminal-instrument-search";

export type InstrumentFiltersProps = {
  filters: Filters;
  /** 下拉的可选值(facets(),只来自真实标的元数据);引用稳定时本组件不因行情重渲染 */
  facets: InstrumentFacets;
  onChange: (next: Filters) => void;
};

/** 触屏布局((pointer: coarse) 或 < 64rem)下控件至少一个触控目标高(计划 §4.7) */
const TOUCH = "pointer-coarse:min-h-touch max-lg:min-h-touch";
const FOCUS = "focus-visible:outline-none focus-visible:shadow-focus";
const CONTROL = `h-7 min-w-0 rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) text-t-xs text-foreground ${FOCUS} ${TOUCH}`;
const SEGMENT = `inline-flex items-center justify-center rounded-chip px-2 text-t-xs transition-colors duration-(--motion-fast) ${FOCUS} ${TOUCH}`;
const segmentTone = (on: boolean) => (on ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground");

/** 折叠区里的维度(注册机构 / 项目类型 / 年份 / 价格区间 / 排序)设了几个;搜索与「只看自选」在外面,不计 */
function advancedCount(f: Filters): number {
  let n = 0;
  if (f.registry?.trim()) n++;
  if (f.projectType?.trim()) n++;
  if (typeof f.vintage === "number" && Number.isFinite(f.vintage)) n++;
  if (f.minPrice !== undefined || f.maxPrice !== undefined) n++;
  if (f.sort) n++;
  return n;
}

/** 下拉的选项:facets 里没有、但当前筛选(来自 URL)设了的值也列出来,下拉显示与真实生效的筛选一致 */
function withCurrent<T>(values: readonly T[], current: T | undefined): readonly T[] {
  return current === undefined || values.includes(current) ? values : [...values, current];
}

/** 每种界面语言一个 collator(构造 Intl.Collator 不便宜,按语言缓存在模块里) */
const collators = new Map<Lang, Intl.Collator>();
function collatorFor(lang: Lang): Intl.Collator {
  let c = collators.get(lang);
  if (!c) {
    c = new Intl.Collator(htmlLang(lang));
    collators.set(lang, c);
  }
  return c;
}

/**
 * 文字下拉(注册机构 / 项目类型)的选项:值是种子原值,显示按当前语言翻译,并按显示文字以当前语言的 collator 排序 ——
 * 英文界面不再按中文原值的顺序出现。显式给 collator 的语言,不用运行时默认 locale:SSR 与水合首帧的 lang 都是
 * DEFAULT_LANG,服务端与浏览器用同一语言排同一组文字,顺序一致(URL 带高级筛选时这些选项在服务端就渲染)。
 */
function textOptions(values: readonly string[], current: string | undefined, label: (raw: string, lang: Lang) => string, lang: Lang) {
  return sortOptionsByLabel(
    withCurrent(values, current).map((v) => ({ value: v, label: label(v, lang) })),
    collatorFor(lang),
  );
}

/**
 * 价格输入(美元,最多两位小数):本地保留正在输入的原文(「12.」不会被改写成 12.00),能解析时才提交整数分;
 * 空串提交 undefined(清掉该端);解析不了时不提交、标 aria-invalid。外部改了值(清除筛选、URL)时经 syncPriceInput
 * 同步原文:仍表示新值的原文保留,其余(含解析不了的「12.5x」)换成新值 —— 清除筛选后不残留红框。
 */
function PriceInput({ cents, label, placeholder, onCommit }: { cents: number | undefined; label: string; placeholder: string; onCommit: (cents: number | undefined) => void }) {
  const [text, setText] = useState(() => centsToPriceInput(cents));
  const [seen, setSeen] = useState(cents);
  if (seen !== cents) {
    setSeen(cents);
    const synced = syncPriceInput(text, cents);
    if (synced !== text) setText(synced);
  }
  const invalid = text.trim() !== "" && priceInputToCents(text) === undefined;
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={text}
      placeholder={placeholder}
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const value = e.target.value;
        setText(value);
        if (value.trim() === "") onCommit(undefined);
        else {
          const next = priceInputToCents(value);
          if (next !== undefined) onCommit(next);
        }
      }}
      className={`${CONTROL} tnum w-full px-1.5 aria-[invalid=true]:border-danger`}
    />
  );
}

/**
 * 标的筛选条(计划 §3.1):搜索框、全部 / 自选、折叠的筛选区(注册机构 / 项目类型 / 年份 / 价格区间 / 排序)、清除筛选。
 * 受控组件:筛选主状态在 InstrumentPanel,这里只把「改了哪个维度」经 setFilter 拼成新对象交给 onChange(URL 镜像在那边)。
 * 下拉的显示值按当前语言翻译(tRegistry / tProjectType),提交的仍是种子原值(与 URL、filterInstruments 同一口径)。
 * 折叠区的开合是本组件的 UI 状态:初值由 filters 决定(URL 里带了高级筛选就展开),服务端与水合首帧一致。
 */
export const InstrumentFilters = memo(function InstrumentFilters({ filters, facets, onChange }: InstrumentFiltersProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const panelId = useId();
  const [open, setOpen] = useState(() => advancedCount(filters) > 0);
  // 「清除筛选」按钮每按一次,价格框换一代(key)重挂载:从未提交过的无效原文(值一直是 undefined,
  // syncPriceInput 看不到值的变化)也随之清掉,清除之后不留红框
  const [priceGeneration, setPriceGeneration] = useState(0);
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => onChange(setFilter(filters, key, value));

  const watchlistOnly = filters.watchlistOnly === true;
  const extra = advancedCount(filters);
  const sorts: [InstrumentSort, string][] = [
    ["symbol", t.instruments.sortSymbol],
    ["change", t.instruments.sortChange],
    ["volume", t.instruments.sortVolume],
    ["price", t.instruments.sortPrice],
  ];

  // Esc:搜索框有字时先清空,并且不让这次 Esc 冒泡到窗口(抽屉的 Esc 关闭);空框的 Esc 照常冒泡
  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape" || !filters.q) return;
    e.preventDefault();
    e.stopPropagation();
    set("q", undefined);
  };

  const select = (label: string, value: string, options: readonly { value: string; label: string }[], onSelect: (v: string) => void) => (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-t-2xs text-muted-2">{label}</span>
      <select value={value} aria-label={label} onChange={(e) => onSelect(e.target.value)} className={`${CONTROL} w-full px-1`}>
        <option value="">{t.instruments.all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div data-instrument-filters="" className="flex flex-col gap-gap px-panel pb-gap">
      <div className="relative">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute inset-y-0 start-2 my-auto size-3 text-muted-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5l3 3" />
        </svg>
        <input
          id={INSTRUMENT_SEARCH_ID}
          type="search"
          autoComplete="off"
          spellCheck={false}
          value={filters.q ?? ""}
          placeholder={t.header.searchPlaceholder}
          aria-label={t.header.searchPlaceholder}
          onChange={(e) => set("q", e.target.value)}
          onKeyDown={onSearchKeyDown}
          className={`${CONTROL} w-full ps-7 pe-2 text-t-sm`}
        />
      </div>

      <div className="flex items-center justify-between gap-gap">
        <div role="group" aria-label={t.instruments.watchlistOnly} className="inline-flex gap-0.5 rounded-control border border-(--terminal-border) p-0.5">
          <button type="button" aria-pressed={!watchlistOnly} onClick={() => set("watchlistOnly", undefined)} className={`${SEGMENT} h-6 ${segmentTone(!watchlistOnly)}`}>
            {t.instruments.all}
          </button>
          <button type="button" aria-pressed={watchlistOnly} onClick={() => set("watchlistOnly", true)} className={`${SEGMENT} h-6 ${segmentTone(watchlistOnly)}`}>
            {t.instruments.watchlist}
          </button>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className={`${SEGMENT} h-7 gap-1 border border-(--terminal-border) ${extra > 0 ? "text-foreground" : "text-muted hover:text-foreground"}`}
        >
          <span>{t.instruments.filters}</span>
          {extra > 0 ? <span className="tnum rounded-chip bg-(--terminal-selected) px-1.5 text-t-2xs">{extra}</span> : null}
          <svg aria-hidden="true" viewBox="0 0 16 16" className={`size-3 transition-transform duration-(--motion-fast) ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </div>

      {open ? (
        <div id={panelId} className="grid grid-cols-2 gap-gap">
          {select(
            t.instruments.registry,
            filters.registry ?? "",
            textOptions(facets.registries, filters.registry, tRegistry, lang),
            (v) => set("registry", v),
          )}
          {select(
            t.instruments.projectType,
            filters.projectType ?? "",
            textOptions(facets.projectTypes, filters.projectType, tProjectType, lang),
            (v) => set("projectType", v),
          )}
          {select(
            t.instruments.vintage,
            filters.vintage === undefined ? "" : String(filters.vintage),
            withCurrent(facets.vintages, filters.vintage).map((y) => ({ value: String(y), label: String(y) })),
            (v) => set("vintage", v === "" ? undefined : Number(v)),
          )}
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 text-t-2xs text-muted-2">{t.instruments.priceRange}</legend>
            <div className="flex items-center gap-1">
              <PriceInput key={`min-${priceGeneration}`} cents={filters.minPrice} label={`${t.instruments.priceRange} · ${t.instruments.min}`} placeholder={t.instruments.min} onCommit={(c) => set("minPrice", c)} />
              <span aria-hidden="true" className="text-muted-2">
                –
              </span>
              <PriceInput key={`max-${priceGeneration}`} cents={filters.maxPrice} label={`${t.instruments.priceRange} · ${t.instruments.max}`} placeholder={t.instruments.max} onCommit={(c) => set("maxPrice", c)} />
            </div>
          </fieldset>
          <div role="group" aria-label={t.instruments.sort} className="col-span-2 flex flex-wrap items-center gap-1">
            <span aria-hidden="true" className="text-t-2xs text-muted-2">
              {t.instruments.sort}
            </span>
            {sorts.map(([value, label]) => {
              const on = filters.sort === value;
              // 再点一次当前排序 = 取消排序(回到服务端顺序)
              return (
                <button key={value} type="button" aria-pressed={on} onClick={() => set("sort", on ? undefined : value)} className={`${SEGMENT} h-6 border border-(--terminal-border) ${segmentTone(on)}`}>
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {hasActiveFilters(filters) ? (
        <button
          type="button"
          onClick={() => {
            setPriceGeneration((g) => g + 1);
            onChange({});
          }}
          className={`self-start rounded-chip text-t-xs text-accent hover:underline ${FOCUS} ${TOUCH}`}
        >
          {t.instruments.clear}
        </button>
      ) : null}
    </div>
  );
});
