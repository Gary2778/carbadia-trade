"use client";

import Link from "next/link";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { usePolling } from "@/hooks/usePolling";
import { api } from "@/lib/http/client";
import { fmtMoney, fmtQty } from "@/lib/format";
import {
  filterCredits,
  getCreditProfile,
  type CarbonAsset,
  type CreditFilters,
} from "@/lib/exchange/carbon";
import { Sparkline } from "@/components/charts/Sparkline";
import { FlashCell } from "@/components/anim/FlashCell";
import { useToast } from "@/components/anim/Toast";
import { RansomText } from "@/components/RansomText";
import { useT, useLang } from "@/i18n/LangProvider";
import { tName, tCountry } from "@/i18n/data";
import { ExchangeIcon } from "./ExchangeIcon";
import { TableViewport } from "./TableViewport";
import { useExchangeText, useWatchlist } from "./useExchange";

type SortKey = "lastPrice" | "change24h" | "volume24h" | "availableSupply";
const sortNames: Record<SortKey, string> = {
  lastPrice: "price",
  change24h: "change",
  volume24h: "volume",
  availableSupply: "supply",
};
const filterKeys = [
  "q",
  "standard",
  "country",
  "vintage",
  "category",
  "approach",
  "family",
  "minSupply",
  "maxPrice",
  "sort",
  "kind",
];
const detailFilterKeys = [
  "category",
  "family",
  "country",
  "vintage",
  "approach",
  "maxPrice",
  "minSupply",
];
const fieldClass =
  "min-w-0 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/10";
const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium hover:border-accent/40 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40";
const instrumentHref = (asset: CarbonAsset) =>
  `/market/${asset.symbol}${asset.isScenario ? "?tab=trade&mode=advanced" : ""}`;

export function SpotTable({
  watchlistOnly = false,
}: {
  watchlistOnly?: boolean;
}) {
  const t = useT("exchange");
  const tm = useT("market");
  const c = useExchangeText();
  const { lang } = useLang();
  const router = useRouter();
  const params = useSearchParams();
  const watch = useWatchlist();
  const toast = useToast();
  const [assets, setAssets] = useState<CarbonAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const pendingRefresh = useRef<Promise<void> | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(() =>
    detailFilterKeys.some((key) => Boolean(params.get(key))),
  );
  const [showCreditDetails, setShowCreditDetails] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const toolsButton = useRef<HTMLButtonElement>(null);
  const comparisonTray = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const toolsId = useId();

  // Manual retries share the same request as polling to avoid stale overlaps.
  function refresh() {
    if (pendingRefresh.current) return pendingRefresh.current;
    setRefreshing(true);
    const request = api<CarbonAsset[]>("/api/assets")
      .then((data) => {
        setAssets(data);
        setErr("");
      })
      .catch((error) => {
        setErr(error.message);
        throw error;
      })
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
        pendingRefresh.current = null;
      });
    pendingRefresh.current = request;
    return request;
  }
  // Preserve the original visible-tab 2s polling and failure backoff.
  usePolling(refresh, 2000);

  const filters: CreditFilters = {
    search: params.get("q") || "",
    standard: params.get("standard") || "",
    country: params.get("country") || "",
    vintage: params.get("vintage") || "",
    category: params.get("category") || "",
    approach: params.get("approach") || "",
    family: params.get("family") || "",
    minSupply: params.get("minSupply") || "",
    maxPrice: params.get("maxPrice") || "",
    sort: params.get("sort") || "",
  };
  const kind = params.get("kind") || "";
  const anyFilters =
    Boolean(kind) ||
    Object.entries(filters).some(
      ([key, value]) => key !== "sort" && Boolean(value),
    );
  const sortKey =
    (Object.keys(sortNames) as SortKey[]).find(
      (key) => filters.sort?.split("-")[0] === sortNames[key],
    ) ?? null;
  const sortDir = filters.sort?.endsWith("-asc") ? "asc" : "desc";
  function change(key: string, value: string) {
    const next = new URLSearchParams(window.location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    window.history.replaceState(
      null,
      "",
      `${watchlistOnly ? "/watchlist" : "/"}${next.size ? `?${next}` : ""}`,
    );
  }
  function resetFilters() {
    const next = new URLSearchParams(window.location.search);
    filterKeys.forEach((key) => next.delete(key));
    window.history.replaceState(
      null,
      "",
      `${watchlistOnly ? "/watchlist" : "/"}${next.size ? `?${next}` : ""}`,
    );
  }
  const cycleSort = (key: SortKey) => {
    if (sortKey !== key)
      change("sort", key === "lastPrice" ? "price-desc" : sortNames[key]);
    else if (sortDir === "desc") change("sort", `${sortNames[key]}-asc`);
    else change("sort", "");
  };
  const creditAssets = assets.filter((asset) => !asset.isScenario);
  const searched = assets.map((asset) => ({
    ...asset,
    name: `${asset.name} ${tName(asset.symbol, asset.name, lang)} ${tCountry(asset.country, lang)}`,
  }));
  // Reuse credit filtering without its default sort; preserve API order until
  // a sortable column or a sorting tool is chosen.
  const matchedCredits = new Set(
    filterCredits(searched, filters).map((asset) => asset.id),
  );
  const sorted = assets.filter((asset) => {
    if (watchlistOnly && !watch.symbols.includes(asset.symbol)) return false;
    if (!asset.isScenario)
      return kind !== "scenario" && matchedCredits.has(asset.id);
    if (
      kind === "credit" ||
      filters.category ||
      filters.approach ||
      filters.family
    )
      return false;
    const query = filters.search?.trim().toLowerCase();
    const haystack =
      `${asset.symbol} ${asset.name} ${tName(asset.symbol, asset.name, lang)} ${asset.standard} ${asset.country} ${tCountry(asset.country, lang)}`.toLowerCase();
    return (
      (!query || haystack.includes(query)) &&
      (!filters.standard || asset.standard === filters.standard) &&
      (!filters.country || asset.country === filters.country) &&
      (!filters.vintage || String(asset.vintage) === filters.vintage) &&
      (!filters.minSupply ||
        asset.availableSupply >= Number(filters.minSupply)) &&
      (!filters.maxPrice ||
        (asset.lastPrice !== null &&
          asset.lastPrice <= Number(filters.maxPrice) * 100))
    );
  });
  if (sortKey)
    sorted.sort((left, right) => {
      const a = left[sortKey],
        b = right[sortKey];
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * (sortDir === "asc" ? 1 : -1);
    });
  const compared = creditAssets.filter((asset) =>
    selected.includes(asset.symbol),
  );
  const categories = Array.from(
    new Map(
      creditAssets.map((asset) => {
        const p = getCreditProfile(asset);
        return [p.category, p.categoryZh];
      }),
    ).entries(),
  ).sort(([a], [b]) => a.localeCompare(b));
  const filterDescriptions: [string, string, string | undefined][] = [
    ["q", c("Search", "搜索"), filters.search],
    [
      "kind",
      c("Type", "标的类型"),
      kind === "credit"
        ? c("Project credits", "项目碳信用")
        : kind === "scenario"
          ? tm.scenarioBadge
          : kind,
    ],
    ["standard", c("Standard", "标准"), filters.standard],
    [
      "category",
      c("Project type", "项目类型"),
      c(
        filters.category || "",
        categories.find(([value]) => value === filters.category)?.[1] ||
          filters.category ||
          "",
      ),
    ],
    [
      "family",
      c("Solution", "解决方案"),
      filters.family === "Nature-based"
        ? c("Nature-based", "自然型")
        : filters.family === "Technology-based"
          ? c("Technology-based", "技术型")
          : filters.family,
    ],
    [
      "country",
      c("Country", "国家"),
      filters.country ? tCountry(filters.country, lang) : "",
    ],
    ["vintage", c("Vintage", "减排年份"), filters.vintage],
    [
      "approach",
      c("Approach", "减碳方式"),
      (
        {
          Removal: c("Removal", "移除"),
          Avoidance: c("Avoidance", "避免排放"),
          "Mixed / project-specific": c(
            "Mixed / project-specific",
            "混合／依项目而定",
          ),
          "Not specified": c("Not specified", "未注明"),
        } as Record<string, string>
      )[filters.approach || ""] || filters.approach,
    ],
    ["maxPrice", c("Max price · USD", "最高价格 · 美元"), filters.maxPrice],
    ["minSupply", c("Min sell supply", "最低卖方供应量"), filters.minSupply],
  ];
  const activeFilters = filterDescriptions.filter(([, , value]) =>
    Boolean(value),
  );
  const detailFilterCount = detailFilterKeys.filter((key) =>
    params.get(key),
  ).length;
  const toggleCompare = (asset: CarbonAsset) => {
    if (asset.isScenario) return;
    setSelected((current) =>
      current.includes(asset.symbol)
        ? current.filter((symbol) => symbol !== asset.symbol)
        : current.length < 3
          ? [...current, asset.symbol]
          : current,
    );
  };
  const toggleWatch = (symbol: string) => {
    const added = !watch.symbols.includes(symbol);
    if (watch.toggle(symbol))
      toast(
        "ok",
        added
          ? c("Added to your watchlist", "已加入关注列表")
          : c("Removed from your watchlist", "已从关注列表移除"),
      );
    else
      toast(
        "err",
        c(
          "Browser storage is unavailable. Watchlist could not be saved.",
          "浏览器存储空间无法使用，未能存储清单。",
        ),
      );
  };
  const sortableTh = (key: SortKey, label: string, extraClass: string) => (
    <th
      scope="col"
      aria-sort={
        sortKey === key
          ? sortDir === "desc"
            ? "descending"
            : "ascending"
          : undefined
      }
      className={`text-end py-3 ${extraClass}`}
    >
      <button
        type="button"
        onClick={() => cycleSort(key)}
        className="font-medium hover:text-foreground transition-colors cursor-pointer"
      >
        {label}
        {sortKey === key && (
          <span aria-hidden className="text-xs ms-0.5">
            {sortDir === "desc" ? "▼" : "▲"}
          </span>
        )}
      </button>
    </th>
  );

  return (
    <section className="rounded-2xl border border-border bg-surface shadow-card overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">
            <RansomText text={t.spotMarket} />
          </h2>
          {watchlistOnly && (
            <span className="rounded border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted">
              {c("Watchlist", "关注列表")}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {err && assets.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              <span role="status" className="text-down">
                {tm.refreshFailed}
              </span>
              <button
                type="button"
                disabled={refreshing}
                className="text-accent hover:underline"
                onClick={() => void refresh().catch(() => {})}
              >
                {refreshing ? c("Retrying…", "重试中…") : c("Retry", "重试")}
              </button>
            </div>
          )}
          <span className="text-xs text-muted">
            {loading && assets.length === 0
              ? t.loading
              : err && assets.length === 0
                ? "—"
                : t.instrumentsMeta(sorted.length)}
          </span>
          <button
            type="button"
            ref={toolsButton}
            aria-expanded={toolsOpen}
            aria-controls={toolsId}
            onClick={() => setToolsOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent"
          >
            {c("Filters & tools", "筛选与工具")}
            {anyFilters && (
              <span className="rounded-full bg-accent/10 px-1.5 text-accent">
                {activeFilters.length}
              </span>
            )}
            <span aria-hidden>{toolsOpen ? "−" : "+"}</span>
          </button>
        </div>
      </div>
      {toolsOpen && (
        <div
          id={toolsId}
          className="space-y-4 border-b border-border bg-surface-2/40 px-5 py-4"
        >
          <nav
            aria-label={c("Market tools", "市场工具")}
            className="flex flex-wrap gap-x-5 gap-y-2 text-xs font-medium"
          >
            {[
              ["/", c("All instruments", "全部标的")],
              ["/projects", c("Projects", "项目")],
              ["/watchlist", c("Watchlist", "关注列表")],
              ["/research", c("Research", "市场研究")],
              ["/learn", c("Learn", "碳市场入门")],
            ].map(([href, label]) => (
              <Link
                key={href}
                href={href}
                className="text-accent hover:underline"
              >
                {label}
              </Link>
            ))}
            {watchlistOnly && (
              <span className="font-normal text-muted">
                {c("Saved in this browser", "存储于此浏览器")}
              </span>
            )}
          </nav>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <ToolField
              label={c("Search", "搜索")}
              className="col-span-2 sm:col-span-1"
            >
              <input
                className={fieldClass}
                type="search"
                autoComplete="off"
                placeholder={c("Project or symbol", "项目名称或代码")}
                value={filters.search}
                onChange={(event) => change("q", event.target.value)}
              />
            </ToolField>
            <ToolField label={c("Instrument type", "标的类型")}>
              <select
                className={fieldClass}
                value={kind}
                onChange={(event) => change("kind", event.target.value)}
              >
                <option value="">{c("All instruments", "全部标的")}</option>
                <option value="credit">
                  {c("Project credits", "项目碳信用")}
                </option>
                <option value="scenario">{tm.scenarioBadge}</option>
              </select>
            </ToolField>
            <ToolField label={c("Registry / standard", "登记簿／标准")}>
              <select
                className={fieldClass}
                value={filters.standard}
                onChange={(event) => change("standard", event.target.value)}
              >
                <option value="">{c("All standards", "所有标准")}</option>
                {Array.from(new Set(assets.map((asset) => asset.standard)))
                  .sort()
                  .map((standard) => (
                    <option key={standard}>{standard}</option>
                  ))}
              </select>
            </ToolField>
            <ToolField
              label={c("Sort", "排序")}
              className="col-span-2 sm:col-span-1"
            >
              <select
                className={fieldClass}
                value={filters.sort}
                onChange={(event) => change("sort", event.target.value)}
              >
                {[
                  ["", c("Default order", "默认顺序")],
                  ["volume", c("Most traded", "成交量由高到低")],
                  ["volume-asc", c("Least traded", "成交量由低到高")],
                  ["price-asc", c("Price: low to high", "价格由低到高")],
                  ["price-desc", c("Price: high to low", "价格由高到低")],
                  ["change", c("24h change: high to low", "24h 涨跌由高到低")],
                  [
                    "change-asc",
                    c("24h change: low to high", "24h 涨跌由低到高"),
                  ],
                  [
                    "supply",
                    c("Sell supply: high to low", "卖方供应量由高到低"),
                  ],
                  [
                    "supply-asc",
                    c("Sell supply: low to high", "卖方供应量由低到高"),
                  ],
                ].map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </ToolField>
          </div>
          <details
            open={moreFiltersOpen}
            onToggle={(event) => setMoreFiltersOpen(event.currentTarget.open)}
          >
            <summary className="w-fit cursor-pointer rounded text-xs font-medium text-muted hover:text-foreground">
              {c("More filters", "更多筛选")}
              {detailFilterCount > 0 ? ` (${detailFilterCount})` : ""}
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <ToolField label={c("Project type", "项目类型")}>
                <select
                  className={fieldClass}
                  value={filters.category}
                  onChange={(event) => change("category", event.target.value)}
                >
                  <option value="">
                    {c("All project types", "所有项目类型")}
                  </option>
                  {categories.map(([category, zh]) => (
                    <option key={category} value={category}>
                      {c(category, zh)}
                    </option>
                  ))}
                </select>
              </ToolField>
              <ToolField label={c("Solution type", "解决方案类型")}>
                <select
                  className={fieldClass}
                  value={filters.family}
                  onChange={(event) => change("family", event.target.value)}
                >
                  <option value="">{c("All solutions", "所有类型")}</option>
                  <option value="Nature-based">
                    {c("Nature-based", "自然型")}
                  </option>
                  <option value="Technology-based">
                    {c("Technology-based", "技术型")}
                  </option>
                </select>
              </ToolField>
              <ToolField label={c("Country / region", "国家／地区")}>
                <select
                  className={fieldClass}
                  value={filters.country}
                  onChange={(event) => change("country", event.target.value)}
                >
                  <option value="">{c("All locations", "所有地区")}</option>
                  {Array.from(new Set(assets.map((asset) => asset.country)))
                    .sort()
                    .map((country) => (
                      <option key={country} value={country}>
                        {tCountry(country, lang)}
                      </option>
                    ))}
                </select>
              </ToolField>
              <ToolField label={c("Vintage", "减排年份")}>
                <select
                  className={fieldClass}
                  value={filters.vintage}
                  onChange={(event) => change("vintage", event.target.value)}
                >
                  <option value="">{c("All years", "所有年份")}</option>
                  {Array.from(new Set(assets.map((asset) => asset.vintage)))
                    .sort((a, b) => b - a)
                    .map((vintage) => (
                      <option key={vintage}>{vintage}</option>
                    ))}
                </select>
              </ToolField>
              <ToolField label={c("Climate approach", "减碳方式")}>
                <select
                  className={fieldClass}
                  value={filters.approach}
                  onChange={(event) => change("approach", event.target.value)}
                >
                  <option value="">{c("All approaches", "所有方式")}</option>
                  {[
                    ["Removal", "移除"],
                    ["Avoidance", "避免排放"],
                    ["Mixed / project-specific", "混合／依项目而定"],
                    ["Not specified", "未注明"],
                  ].map(([value, zh]) => (
                    <option key={value} value={value}>
                      {c(value, zh)}
                    </option>
                  ))}
                </select>
              </ToolField>
              <ToolField
                label={c("Maximum price · demo USD", "最高价格 · 模拟美元")}
              >
                <input
                  className={fieldClass}
                  type="number"
                  min="0"
                  step="0.01"
                  value={filters.maxPrice}
                  onChange={(event) => change("maxPrice", event.target.value)}
                  placeholder="100.00"
                />
              </ToolField>
              <ToolField label={c("Minimum sell supply", "最低卖方供应量")}>
                <input
                  className={fieldClass}
                  type="number"
                  min="0"
                  step="1"
                  value={filters.minSupply}
                  onChange={(event) => change("minSupply", event.target.value)}
                  placeholder="100"
                />
              </ToolField>
            </div>
          </details>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={showCreditDetails}
                onChange={(event) => setShowCreditDetails(event.target.checked)}
                className="accent-accent"
              />
              {c("Expand project-credit details", "展开项目碳信用数据")}
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <span>
                {c(
                  "Star to save; select 2–3 project credits to compare.",
                  "以星号收藏；选择 2–3 种项目碳信用进行比较。",
                )}
              </span>
              <button
                type="button"
                onClick={resetFilters}
                disabled={!anyFilters && !filters.sort}
                className="text-accent hover:underline disabled:text-muted"
              >
                {c("Reset filters", "重设筛选")}
              </button>
            </div>
          </div>
        </div>
      )}
      {activeFilters.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3"
          aria-label={c("Active filters", "已套用的筛选")}
        >
          {activeFilters.map(([key, label, value]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                change(key, "");
                toolsButton.current?.focus();
              }}
              aria-label={c(
                `Remove filter: ${label}: ${value}`,
                `移除筛选：${label}：${value}`,
              )}
              title={`${label}: ${value}`}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-2.5 py-1 text-xs text-accent hover:bg-accent/10"
            >
              <span className="truncate">
                {label}: {value}
              </span>
              <ExchangeIcon name="close" size={12} />
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              resetFilters();
              toolsButton.current?.focus();
            }}
            className="px-1 text-xs text-muted hover:text-foreground"
          >
            {c("Clear all", "全部清除")}
          </button>
        </div>
      )}
      {loading && assets.length === 0 ? (
        <div className="p-8 text-center text-muted" role="status">
          {t.loading}
        </div>
      ) : err && assets.length === 0 ? (
        <div className="space-y-3 p-8 text-center text-sm">
          <p role="alert" className="text-down">
            {c("Market data could not be loaded.", "无法加载市场数据。")}
          </p>
          <p className="text-xs text-muted">
            {c(
              "Retry to reconnect. No prices are available yet.",
              "请重试以重新连接，目前尚无可用报价。",
            )}
          </p>
          <button
            type="button"
            className={buttonClass}
            disabled={refreshing}
            onClick={() => void refresh().catch(() => {})}
          >
            {refreshing ? c("Retrying…", "重试中…") : c("Retry", "重试")}
          </button>
        </div>
      ) : assets.length === 0 ? (
        <div className="p-10 text-center text-muted">{t.spotEmpty}</div>
      ) : sorted.length === 0 ? (
        <div className="space-y-3 p-10 text-center text-sm text-muted">
          <p>
            {watchlistOnly && !anyFilters
              ? c(
                  "Your watchlist is empty. Open Filters & tools in the spot market and save an instrument with its star.",
                  "关注列表尚无标的。展开现货行情的筛选与工具，再以星号收藏标的。",
                )
              : c(
                  "No instruments match these filters.",
                  "没有符合筛选条件的标的。",
                )}
          </p>
          {anyFilters ? (
            <button
              type="button"
              className={buttonClass}
              onClick={resetFilters}
            >
              {c("Reset filters", "重设筛选")}
            </button>
          ) : (
            <Link href="/" className="text-accent hover:underline">
              {t.spotMarket} →
            </Link>
          )}
        </div>
      ) : (
        <TableViewport
          label={c("Market instruments", "市场标的")}
          className="overflow-x-auto"
        >
          <table className="w-full text-sm">
            <thead className="text-muted text-xs">
              <tr className="border-b border-border">
                <th
                  scope="col"
                  className="text-start font-medium px-3 sm:px-5 py-3"
                >
                  {t.thSymbolProject}
                </th>
                <th
                  scope="col"
                  className="text-start font-medium px-3 py-3 hidden md:table-cell"
                >
                  {t.thStandard}
                </th>
                {sortableTh("lastPrice", t.thLastPrice, "px-3")}
                {sortableTh("change24h", t.thChange24h, "px-3")}
                <th
                  scope="col"
                  className="text-center font-medium px-3 py-3 hidden lg:table-cell"
                >
                  {t.thTrend24h}
                </th>
                <th
                  scope="col"
                  className="text-end font-medium px-3 py-3 hidden sm:table-cell"
                >
                  {t.thBidAsk}
                </th>
                {sortableTh("volume24h", t.thVolume24h, "px-3 sm:px-5")}
                {toolsOpen && (
                  <th scope="col" className="text-center font-medium px-3 py-3">
                    {c("Save / compare", "收藏／比较")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {sorted.map((asset, index) => (
                <Fragment key={asset.id}>
                  <motion.tr
                    className="border-b border-border/50 hover:bg-surface-2 transition-colors cursor-pointer"
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "a, button, input, label, select",
                        )
                      )
                        return;
                      router.push(instrumentHref(asset));
                    }}
                    initial={reduced ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      delay: reduced ? 0 : index * 0.05,
                      duration: 0.35,
                    }}
                  >
                    <td className="px-3 sm:px-5 py-3">
                      <Link
                        href={instrumentHref(asset)}
                        className="block group"
                      >
                        <div className="flex flex-wrap items-center gap-1.5 font-medium group-hover:text-accent transition-colors">
                          <span>{asset.symbol}</span>
                          {asset.isScenario && (
                            <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-normal text-accent">
                              {tm.scenarioBadge}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted truncate max-w-[44vw] sm:max-w-[200px]">
                          {tName(asset.symbol, asset.name, lang)}
                        </div>
                        {asset.spark.length > 1 && (
                          <span className="mt-2 flex items-center gap-2 lg:hidden">
                            <span className="text-[10px] font-normal text-muted">24h</span>
                            <Sparkline
                              data={asset.spark}
                              ariaLabel={`${asset.symbol} · ${t.thTrend24h}`}
                            />
                          </span>
                        )}
                        {asset.isScenario && (
                          <span className="mt-1 inline-block text-[10px] text-muted">
                            {c(
                              "Advanced trading · no retirement",
                              "高级交易 · 不可注销",
                            )}{" "}
                            ↗
                          </span>
                        )}
                      </Link>
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell">
                      <span className="text-xs px-2 py-0.5 rounded bg-surface-2 border border-border">
                        {asset.standard}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-end tnum font-medium">
                      <FlashCell
                        value={asset.lastPrice}
                        className="inline-block px-1 -mx-1"
                      >
                        {asset.lastPrice == null ? (
                          <span className="text-muted">—</span>
                        ) : (
                          `$${fmtMoney(asset.lastPrice)}`
                        )}
                      </FlashCell>
                    </td>
                    <td className="px-3 py-3 text-end">
                      {asset.change24h == null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span
                          className={`tnum text-xs px-1.5 py-0.5 rounded font-medium ${asset.change24h >= 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}
                        >
                          {asset.change24h >= 0 ? "+" : ""}
                          {asset.change24h.toFixed(2)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 hidden lg:table-cell">
                      <div className="flex justify-center">
                        {asset.spark.length > 1 ? (
                          <Sparkline
                            data={asset.spark}
                            ariaLabel={`${asset.symbol} · ${t.thTrend24h}`}
                          />
                        ) : (
                          <span
                            className="text-xs text-muted"
                            title={asset.spark.length === 0
                              ? c("No trades in the past 24 hours", "过去 24 小时暂无成交")
                              : c("More trades are needed to show a trend", "等待更多成交以显示走势")}
                          >
                            {asset.spark.length === 0
                              ? c("No trades", "暂无成交")
                              : c("Collecting prices…", "累积价格中…")}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-end tnum hidden sm:table-cell">
                      <span className="text-up">
                        {asset.bestBid == null ? "—" : fmtMoney(asset.bestBid)}
                      </span>
                      <span className="text-muted mx-1">/</span>
                      <span className="text-down">
                        {asset.bestAsk == null ? "—" : fmtMoney(asset.bestAsk)}
                      </span>
                    </td>
                    <td className="px-3 sm:px-5 py-3 text-end tnum text-muted">
                      {fmtQty(asset.volume24h)}
                    </td>
                    {toolsOpen && (
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-center gap-3">
                          <button
                            type="button"
                            aria-label={`${watch.symbols.includes(asset.symbol) ? c("Unwatch", "取消关注") : c("Watch", "关注")} ${tName(asset.symbol, asset.name, lang)}`}
                            aria-pressed={watch.symbols.includes(asset.symbol)}
                            onClick={() => toggleWatch(asset.symbol)}
                            className={`rounded p-1.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent ${watch.symbols.includes(asset.symbol) ? "text-amber-600" : "text-muted"}`}
                          >
                            <ExchangeIcon name="star" size={16} />
                          </button>
                          {asset.isScenario ? (
                            <span
                              className="text-muted"
                              title={c(
                                "Scenario instruments cannot be compared as carbon credits",
                                "情景标的不可作为碳信用比较",
                              )}
                            >
                              —
                            </span>
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={`${c("Compare", "比较")} ${tName(asset.symbol, asset.name, lang)}`}
                              checked={selected.includes(asset.symbol)}
                              disabled={
                                selected.length >= 3 &&
                                !selected.includes(asset.symbol)
                              }
                              onChange={() => toggleCompare(asset)}
                              className="h-3.5 w-3.5 accent-accent disabled:opacity-35"
                            />
                          )}
                        </div>
                      </td>
                    )}
                  </motion.tr>
                  {toolsOpen && showCreditDetails && !asset.isScenario && (
                    <tr className="border-b border-border/50 bg-surface-2/50">
                      <td colSpan={8} className="px-5 py-4">
                        <CreditDetails asset={asset} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
      {compared.length > 0 && (
        <div
          ref={comparisonTray}
          tabIndex={-1}
          aria-label={c("Selected credits", "已选碳信用")}
          className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface-2/50 px-5 py-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <div className="space-y-2">
            <p className="text-xs text-muted" role="status">
              {c(
                `${compared.length} of 3 project credits selected`,
                `已选 ${compared.length}／3 种项目碳信用`,
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              {compared.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => {
                    toggleCompare(asset);
                    if (compared.length > 1) comparisonTray.current?.focus();
                    else toolsButton.current?.focus();
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 text-xs hover:border-accent/40"
                  aria-label={c(
                    `Remove ${tName(asset.symbol, asset.name, lang)} from comparison`,
                    `从比较移除 ${tName(asset.symbol, asset.name, lang)}`,
                  )}
                >
                  <span>{asset.symbol}</span>
                  <ExchangeIcon name="close" size={12} />
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setSelected([]);
                toolsButton.current?.focus();
              }}
              className="text-xs text-muted hover:text-foreground"
            >
              {c("Clear", "清除")}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={compared.length < 2}
              onClick={() => setCompareOpen(true)}
            >
              {c("Compare credits", "比较碳信用")} →
            </button>
          </div>
        </div>
      )}
      <ComparisonDialog
        assets={compared}
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
      />
    </section>
  );
}

function ToolField({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`min-w-0 space-y-1.5 text-xs text-muted ${className}`}>
      <span className="block">{label}</span>
      {children}
    </label>
  );
}
function CreditDetails({ asset }: { asset: CarbonAsset }) {
  const c = useExchangeText();
  const { lang } = useLang();
  const profile = getCreditProfile(asset);
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-3 lg:grid-cols-6">
      {[
        [
          c("Project type", "项目类型"),
          c(profile.category, profile.categoryZh),
        ],
        [
          c("Climate approach", "减碳方式"),
          c(profile.approach, profile.approachZh),
        ],
        [c("Vintage", "减排年份"), asset.vintage],
        [c("Country", "国家"), tCountry(asset.country, lang)],
        [
          c("Registry label", "登记簿标签"),
          asset.registry || c("Not provided", "未提供"),
        ],
        [
          c("Available sell quantity", "卖单可成交数量"),
          fmtQty(asset.availableSupply),
        ],
      ].map(([label, value]) => (
        <div key={String(label)}>
          <dt className="text-muted">{label}</dt>
          <dd className="mt-1 font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// Reuse the native comparison dialog's focus management and Escape dismissal.
function ComparisonDialog({
  assets,
  open,
  onClose,
}: {
  assets: CarbonAsset[];
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const c = useExchangeText();
  const { lang } = useLang();
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current?.close();
  }, [open]);
  const rows = [
    [
      c("Price · demo USD", "价格 · 模拟美元"),
      ...assets.map((asset) =>
        asset.lastPrice == null ? "—" : `$${fmtMoney(asset.lastPrice)}`,
      ),
    ],
    [
      c("Project type", "项目类型"),
      ...assets.map((asset) => {
        const p = getCreditProfile(asset);
        return c(p.category, p.categoryZh);
      }),
    ],
    [
      c("Climate approach", "减碳方式"),
      ...assets.map((asset) => {
        const p = getCreditProfile(asset);
        return c(p.approach, p.approachZh);
      }),
    ],
    [c("Vintage", "减排年份"), ...assets.map((asset) => asset.vintage)],
    [
      c("Registry / standard", "登记簿／标准"),
      ...assets.map((asset) => `${asset.registry} / ${asset.standard}`),
    ],
    [
      c("Country", "国家"),
      ...assets.map((asset) => tCountry(asset.country, lang)),
    ],
    [
      c("Available sell quantity", "卖单可成交数量"),
      ...assets.map((asset) => fmtQty(asset.availableSupply)),
    ],
    [
      c("Methodology / verification", "方法学／核证"),
      ...assets.map(() =>
        c("Not supplied · demo project", "未提供 · 示实例目"),
      ),
    ],
  ];
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      onClose={onClose}
      aria-labelledby={titleId}
      className="glass-overlay fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-5xl overflow-auto rounded-2xl border border-border bg-surface p-5 text-foreground shadow-card backdrop:bg-black/40 sm:p-7"
    >
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-lg font-semibold">
            {c("Compare carbon credits", "比较碳信用")}
          </h2>
          <p className="mt-2 text-xs leading-5 text-muted">
            {c(
              "Equal tonnes do not mean equal quality. No platform rating is assigned.",
              "相同吨数不代表相同质量。平台未提供评分。",
            )}
          </p>
        </div>
        <button
          type="button"
          aria-label={c("Close comparison", "关闭比较")}
          onClick={onClose}
          className="rounded-lg p-2 text-muted hover:bg-surface-2"
        >
          <ExchangeIcon name="close" size={18} />
        </button>
      </header>
      <p className="mb-3 text-xs text-muted sm:hidden">
        {c(
          "Swipe the table to compare all selected credits.",
          "左右滑动表格，查看所有已选碳信用。",
        )}
      </p>
      <TableViewport
        label={c("Credit comparison", "碳信用比较")}
        className="overflow-x-auto"
      >
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-border text-start text-xs text-muted">
              <th scope="col" className="px-3 py-3 text-start font-medium">
                {c("Attribute", "比较项目")}
              </th>
              {assets.map((asset) => (
                <th
                  scope="col"
                  key={asset.id}
                  className="max-w-[220px] px-3 py-3 text-start font-medium text-foreground"
                >
                  {tName(asset.symbol, asset.name, lang)}
                  <span className="mt-1 block text-[10px] text-muted">
                    {asset.symbol}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, ...values]) => (
              <tr key={String(label)} className="border-b border-border/60">
                <th
                  scope="row"
                  className="px-3 py-3 text-start text-xs font-normal text-muted"
                >
                  {label}
                </th>
                {values.map((value, index) => (
                  <td key={index} className="px-3 py-3 text-xs">
                    {value}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td />
              {assets.map((asset) => (
                <td key={asset.id} className="px-3 pt-4">
                  <Link
                    href={`/market/${asset.symbol}`}
                    onClick={onClose}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {c("Review credit", "查看信用")} →
                  </Link>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </TableViewport>
    </dialog>
  );
}
