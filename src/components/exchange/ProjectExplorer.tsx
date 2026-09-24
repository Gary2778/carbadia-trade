"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { filterCredits, getCreditProfile } from "@/lib/exchange/carbon";
import { api } from "@/lib/http/client";
import { fmtMoney, fmtQty } from "@/lib/format";
import { useLang } from "@/i18n/LangProvider";
import { tCountry, tName } from "@/i18n/data";
import { ExchangeIcon } from "./ExchangeIcon";
import { useExchangeText, useMarket } from "./useExchange";
import {
  categoryLabel,
  OFFSETS_SOURCE,
  registryLabel,
  sourceUrl,
  useRegistryOverview,
} from "./RegistryData";
import "./discovery.css";

type RegistryProject = {
  id: string;
  name: string;
  registry: string;
  country: string | null;
  category: string | null;
  projectType: string | null;
  protocol: string | null;
  status: string | null;
  issued: number;
  retired: number;
  projectUrl: string | null;
  syncedAt: string;
};
type RegistryPage = {
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  data: RegistryProject[];
};

export function ProjectExplorer() {
  const c = useExchangeText();
  const router = useRouter();
  const params = useSearchParams();
  const tab = params.get("view") === "registry" ? "registry" : "demo";
  const change = (values: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.replace(`/projects${next.size ? `?${next}` : ""}`, {
      scroll: false,
    });
  };
  return (
    <>
      <div className="ex-page-heading">
        <div>
          <h1>{c("Explore carbon projects", "探索碳信用项目")}</h1>
          <p>
            {c(
              "Start with the activity behind a credit. Explore project types, compare their attributes and follow the evidence.",
              "从碳信用背后的活动出发，探索项目类型、比较特征，并追溯数据源。",
            )}
          </p>
        </div>
        <Link href="/learn#quality" className="ex-button">
          <ExchangeIcon name="learn" size={15} />
          {c("What makes a quality credit?", "如何了解信用质量？")}
        </Link>
      </div>
      <div
        className="ex-market-tabs ex-discovery-tabs"
        role="group"
        aria-label={c("Project data source", "项目数据源")}
      >
        <button
          aria-pressed={tab === "demo"}
          onClick={() => change({ view: "", page: "" })}
        >
          {c("Demo credit projects", "示范碳信用项目")}
        </button>
        <button
          aria-pressed={tab === "registry"}
          onClick={() => change({ view: "registry", page: "" })}
        >
          {c("Real registry explorer", "真实注册处浏览器")}
        </button>
      </div>
      {tab === "demo" ? (
        <DemoProjects change={change} />
      ) : (
        <RegistryProjects change={change} />
      )}
    </>
  );
}

function DemoProjects({
  change,
}: {
  change: (values: Record<string, string>) => void;
}) {
  const c = useExchangeText();
  const { lang } = useLang();
  const params = useSearchParams();
  const { assets, loaded, hasData, error, reload } = useMarket();
  const q = params.get("q") ?? "",
    category = params.get("type") ?? "",
    country = params.get("location") ?? "";
  const credits = assets
    .filter((a) => !a.isScenario)
    .map((a) => ({ ...a, name: tName(a.symbol, a.name, lang) }));
  const search = q.trim().toLowerCase();
  const matchingIds = new Set(
    filterCredits(credits, { search: q }).map((a) => a.id),
  );
  const rows = filterCredits(
    credits.filter(
      (a) =>
        matchingIds.has(a.id) ||
        [
          tCountry(a.country, lang),
          tCountry(a.country, "en"),
          tCountry(a.country, "zh-CN"),
        ].some((label) => label.toLowerCase().includes(search)),
    ),
    { category, country },
  );
  const profiles = [
    ...new Map(
      credits.map((a) => {
        const p = getCreditProfile(a);
        return [p.category, p];
      }),
    ).values(),
  ].sort((a, b) => a.category.localeCompare(b.category));
  return (
    <>
      <div className="ex-market-toolbar ex-discovery-toolbar">
        <label className="ex-search-field">
          <ExchangeIcon name="search" size={15} />
          <input
            aria-label={c("Search demonstration projects", "搜索示范项目")}
            placeholder={c(
              "Search name, country or standard",
              "搜索名称、国家或标准",
            )}
            value={q}
            onChange={(e) => change({ q: e.target.value })}
          />
        </label>
        <select
          className="ex-select"
          aria-label={c("Project type", "项目类型")}
          value={category}
          onChange={(e) => change({ type: e.target.value })}
        >
          <option value="">{c("All project types", "所有项目类型")}</option>
          {profiles.map((p) => (
            <option key={p.category} value={p.category}>
              {c(p.category, p.categoryZh)}
            </option>
          ))}
        </select>
        <select
          className="ex-select"
          aria-label={c("Country", "国家")}
          value={country}
          onChange={(e) => change({ location: e.target.value })}
        >
          <option value="">{c("All countries", "所有国家")}</option>
          {[...new Set(credits.map((a) => a.country))].sort().map((value) => (
            <option key={value} value={value}>
              {tCountry(value, lang)}
            </option>
          ))}
        </select>
        {(q || category || country) && (
          <button
            className="ex-button ghost"
            onClick={() => change({ q: "", type: "", location: "" })}
          >
            {c("Clear filters", "清除筛选")}
          </button>
        )}
        <span className="ex-muted" aria-live="polite">
          {hasData
            ? `${rows.length} ${c("projects", "个项目")}`
            : loaded
              ? "—"
              : c("Loading…", "加载中…")}
        </span>
      </div>
      {error && (
        <div className="ex-error" role="alert">
          <span>
            {c(
              "Demo project data could not be refreshed.",
              "无法更新示范项目数据。",
            )}
          </span>
          <button onClick={() => void reload().catch(() => {})}>
            {c("Retry", "重试")}
          </button>
        </div>
      )}
      {!loaded ? (
        <div
          className="ex-card-grid"
          aria-label={c("Loading projects", "正在加载项目")}
          role="status"
        >
          {[1, 2, 3].map((n) => (
            <div className="ex-panel" key={n}>
              <div className="ex-skeleton" />
              <div className="ex-skeleton" />
              <div className="ex-skeleton" />
            </div>
          ))}
        </div>
      ) : rows.length ? (
        <div className="ex-card-grid">
          {rows.map((a) => {
            const p = getCreditProfile(a);
            return (
              <article
                className="ex-project-card"
                key={a.id}
                style={{ "--project-color": p.color } as CSSProperties}
              >
                <div className="ex-project-art">
                  <ExchangeIcon name={p.icon} />
                  <span>{c("Demonstration project", "示范项目")}</span>
                </div>
                <div className="ex-project-copy">
                  <div className="ex-actions">
                    <span className="ex-registry-tag">
                      {a.standard === "VCS"
                        ? "Verra VCS"
                        : a.standard === "GS"
                          ? "Gold Standard"
                          : a.standard}
                    </span>
                    <span className="ex-muted">
                      {c(p.category, p.categoryZh)}
                    </span>
                  </div>
                  <h2 className="ex-project-name">
                    <Link
                      href={`/market/${encodeURIComponent(a.symbol)}`}
                    >
                      {a.name}
                    </Link>
                  </h2>
                  <p>
                    {tCountry(a.country, lang)} · {c(p.approach, p.approachZh)}
                  </p>
                  <dl className="ex-project-facts">
                    <div>
                      <dt>{c("Vintage", "减排年份")}</dt>
                      <dd>{a.vintage}</dd>
                    </div>
                    <div>
                      <dt>{c("Demo USD / credit", "模拟美元／信用")}</dt>
                      <dd>
                        {a.lastPrice == null
                          ? "—"
                          : `$${fmtMoney(a.lastPrice)}`}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {c("Available on sell orders", "公开卖单可成交量")}
                      </dt>
                      <dd>
                        {fmtQty(a.availableSupply)} {c("credits", "份")}
                      </dd>
                    </div>
                    <div>
                      <dt>{c("Registry project ID", "注册处项目编号")}</dt>
                      <dd>{c("Not supplied", "未提供")}</dd>
                    </div>
                  </dl>
                  <p className="ex-project-provenance">
                    {c(
                      "Illustrative catalogue entry. No link to a verified, registered project.",
                      "此项目为示范目录内容，未链接至已查证的真实注册项目。",
                    )}
                  </p>
                  <Link
                    href={`/market/${encodeURIComponent(a.symbol)}`}
                    className="ex-button"
                  >
                    {c("View credit and project details", "查看信用与项目数据")}
                    <ExchangeIcon name="arrow" size={14} />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        !error && (
          <div className="ex-panel ex-empty">
            <ExchangeIcon name="projects" size={30} />
            <h2>{c("No matching demo projects", "没有符合条件的示范项目")}</h2>
            <p>
              {c(
                "Try a broader search or explore the separate registry data collection.",
                "请放宽搜索条件，或浏览另一分页中的注册处数据。",
              )}
            </p>
            <button
              className="ex-button"
              onClick={() => change({ q: "", type: "", location: "" })}
            >
              {c("Clear filters", "清除筛选")}
            </button>
          </div>
        )
      )}
      <div className="ex-info-strip">
        <ExchangeIcon name="info" size={24} />
        <div>
          <strong>
            {c("A catalogue label is a starting point.", "目录标签只是起点。")}
          </strong>
          <p>
            {c(
              "Before assessing a real credit, check the registry ID, methodology, monitoring and verification reports, and retirement record.",
              "评估真实碳信用前，应核对注册编号、方法学、监测与查证报告，以及注销记录。",
            )}
          </p>
        </div>
        <Link href="/learn#quality">
          {c("See the checklist", "查看检查清单")}
        </Link>
      </div>
    </>
  );
}

function RegistryProjects({
  change,
}: {
  change: (values: Record<string, string>) => void;
}) {
  const c = useExchangeText();
  const params = useSearchParams();
  const {
    overview,
    error: overviewError,
    reload: reloadOverview,
  } = useRegistryOverview();
  const registry = params.get("registry") ?? "",
    country = params.get("country") ?? "",
    category = params.get("category") ?? "";
  const requestedPage = Number(params.get("page") || "1");
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const query = new URLSearchParams({
    ...(registry ? { registry } : {}),
    ...(country ? { country } : {}),
    ...(category ? { category } : {}),
    page: String(page),
  }).toString();
  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<{
    query: string;
    attempt: number;
    data: RegistryPage | null;
    error: string;
  } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    api<RegistryPage>(`/api/real/projects?${query}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (active) setResult({ query, attempt, data, error: "" });
      })
      .catch((error: Error) => {
        if (active)
          setResult((previous) => ({
            query,
            attempt,
            data: previous?.query === query ? previous.data : null,
            error: error.message,
          }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [query, attempt]);
  const current = result?.query === query ? result : null;
  const loading = !current || current.attempt !== attempt;
  const q = search.trim().toLowerCase();
  const rows =
    current?.data?.data.filter(
      (p) =>
        !q ||
        [p.id, p.name, p.country, p.protocol, p.projectType]
          .join(" ")
          .toLowerCase()
          .includes(q),
    ) ?? [];
  const pagination = current?.data?.pagination;
  const filter = (key: string, value: string) => {
    setSearch("");
    change({ [key]: value, page: "" });
  };
  return (
    <>
      <p className="ex-discovery-caption" style={{ marginBottom: 19 }}>
        {c(
          "Public registry records sourced through CarbonPlan OffsetsDB. These projects are not the demo assets traded on Carbadia. Issuance and retirement totals are historical quantities, not credits available to buy.",
          "此处通过 CarbonPlan OffsetsDB 提供公开注册处记录，与 Carbadia 的示范交易标的无关。签发及注销量是历史数量，不代表可购买的信用。",
        )}
      </p>
      <section
        className="ex-market-body"
        aria-label={c("Real registry projects", "真实注册项目")}
      >
        <div className="ex-market-toolbar">
          <select
            className="ex-select"
            aria-label={c("Filter by registry", "依注册处筛选")}
            value={registry}
            onChange={(e) => filter("registry", e.target.value)}
          >
            <option value="">{c("All registries", "所有注册处")}</option>
            {(overview?.registries ?? []).map((r) => (
              <option key={r.registry} value={r.registry}>
                {registryLabel(r.registry)}
              </option>
            ))}
          </select>
          <select
            className="ex-select"
            aria-label={c("Filter by country", "依国家筛选")}
            value={country}
            onChange={(e) => filter("country", e.target.value)}
          >
            <option value="">{c("All countries", "所有国家")}</option>
            {overview?.filters.countries.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <select
            className="ex-select"
            aria-label={c("Filter by category", "依类别筛选")}
            value={category}
            onChange={(e) => filter("category", e.target.value)}
          >
            <option value="">{c("All categories", "所有类别")}</option>
            {overview?.filters.categories.map((value) => (
              <option key={value} value={value}>
                {categoryLabel(value)}
              </option>
            ))}
          </select>
          {(registry || country || category) && (
            <button
              className="ex-button ghost"
              onClick={() => {
                setSearch("");
                change({ registry: "", country: "", category: "", page: "" });
              }}
            >
              {c("Clear filters", "清除筛选")}
            </button>
          )}
          <span className="ex-muted">
            {pagination
              ? `${fmtQty(pagination.total)} ${c("matching records", "笔符合记录")}`
              : c("Loading records…", "加载记录中…")}
          </span>
        </div>
        <div className="ex-registry-search">
          <label className="ex-search-field">
            <ExchangeIcon name="search" size={15} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={c(
                "Search this page by name or ID",
                "依名称或编号搜索本页",
              )}
              aria-label={c("Search the current page only", "仅搜索目前页面")}
            />
          </label>
          <span>
            {c(
              "Name search covers this page. Registry, country and category filters cover all records.",
              "名称搜索仅涵盖本页；注册处、国家及类别筛选涵盖全部记录。",
            )}
          </span>
        </div>
        {current?.error && (
          <div className="ex-error" role="alert">
            <span>
              {c(
                "Registry records could not be refreshed. Any visible records are the last received page.",
                "无法更新注册处记录；目前显示的记录为上次加载的页面。",
              )}
            </span>
            <button onClick={() => setAttempt((n) => n + 1)}>
              {c("Retry", "重试")}
            </button>
          </div>
        )}
        {loading && !current?.data ? (
          <div className="ex-loading" role="status">
            {c("Loading registry records…", "正在加载注册记录…")}
          </div>
        ) : rows.length ? (
          <div className="ex-table-wrap" aria-busy={loading}>
            <table className="ex-table ex-registry-table">
              <thead>
                <tr>
                  <th>{c("Project / source ID", "项目／来源编号")}</th>
                  <th>{c("Registry", "注册处")}</th>
                  <th>{c("Country", "国家")}</th>
                  <th className="numeric">
                    {c("Issued · tCO₂e", "签发量 · tCO₂e")}
                  </th>
                  <th className="numeric">
                    {c("Retired · tCO₂e", "注销量 · tCO₂e")}
                  </th>
                  <th>{c("Source", "来源")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const url = sourceUrl(p.projectUrl);
                  return (
                    <tr key={p.id}>
                      <td>
                        <strong>
                          {p.name || c("Unnamed project", "未命名项目")}
                        </strong>
                        <span className="ex-subline">
                          {p.id} ·{" "}
                          {p.category
                            ? categoryLabel(p.category)
                            : c("Category not supplied", "未提供类别")}
                        </span>
                        <details>
                          <summary>
                            {c("Project attributes", "项目属性")}
                          </summary>
                          <p>
                            {c("Status", "状态")}:{" "}
                            {p.status || c("Not supplied", "未提供")}
                            <br />
                            {c("Type", "类型")}:{" "}
                            {p.projectType || c("Not supplied", "未提供")}
                            <br />
                            {c("Protocol", "方法／协议")}:{" "}
                            {p.protocol || c("Not supplied", "未提供")}
                            <br />
                            {c("Synced", "同步日期")}: {p.syncedAt.slice(0, 10)}
                          </p>
                        </details>
                      </td>
                      <td>{registryLabel(p.registry)}</td>
                      <td>{p.country || "—"}</td>
                      <td className="numeric">{fmtQty(p.issued)}</td>
                      <td className="numeric">{fmtQty(p.retired)}</td>
                      <td>
                        {url ? (
                          <a
                            className="ex-learn-link"
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`${c("Open source for", "打开来源：")} ${p.name || p.id}`}
                          >
                            {c("View record", "查看记录")}
                            <ExchangeIcon name="external" size={12} />
                          </a>
                        ) : (
                          <span className="ex-muted">
                            {c("No source link", "无来源链接")}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !current?.error && (
            <div className="ex-empty">
              <ExchangeIcon name="projects" size={30} />
              <h2>
                {q
                  ? c("No matches on this page", "本页没有符合记录")
                  : c(
                      "No registry records to display",
                      "目前没有可显示的注册记录",
                    )}
              </h2>
              <p>
                {q
                  ? c(
                      "Clear the page search or move to another results page.",
                      "请清除本页搜索或切换其他结果页面。",
                    )
                  : registry || country || category
                    ? c(
                        "Broaden your filters to find more records.",
                        "请放宽筛选条件以寻找更多记录。",
                      )
                    : c(
                        "A registry snapshot may not have been loaded yet. You can still visit the original data source.",
                        "系统可能尚未加载注册处快照。您仍可前往原始数据源查看。",
                      )}
              </p>
              {q ? (
                <button className="ex-button" onClick={() => setSearch("")}>
                  {c("Clear page search", "清除本页搜索")}
                </button>
              ) : (
                <a
                  className="ex-button"
                  href={OFFSETS_SOURCE}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  CarbonPlan OffsetsDB
                  <ExchangeIcon name="external" size={13} />
                </a>
              )}
            </div>
          )
        )}
        {pagination && pagination.totalPages > 0 && (
          <div className="ex-discovery-pages">
            <span aria-live="polite">
              {c(
                `Page ${pagination.page} of ${pagination.totalPages}`,
                `第 ${pagination.page}／${pagination.totalPages} 页`,
              )}{" "}
              · {rows.length} {c("shown", "笔显示")}
            </span>
            <div>
              <button
                className="ex-button"
                disabled={page <= 1 || loading}
                onClick={() => {
                  setSearch("");
                  change({ page: String(page - 1) });
                }}
              >
                {c("Previous", "上一页")}
              </button>
              <button
                className="ex-button"
                disabled={page >= pagination.totalPages || loading}
                onClick={() => {
                  setSearch("");
                  change({ page: String(page + 1) });
                }}
              >
                {c("Next", "下一页")}
              </button>
            </div>
          </div>
        )}
        <div className="ex-registry-meta">
          <span>
            {overview?.asOf
              ? c(
                  `Data as of ${overview.asOf.slice(0, 10)}`,
                  `数据截至 ${overview.asOf.slice(0, 10)}`,
                )
              : c("Snapshot date unavailable", "未提供快照日期")}
          </span>
          <a href={OFFSETS_SOURCE} target="_blank" rel="noopener noreferrer">
            CarbonPlan OffsetsDB
          </a>
          {overviewError && (
            <span role="status">
              {c(
                "Filter options could not be refreshed.",
                "无法更新筛选选项。",
              )}{" "}
              <button onClick={() => void reloadOverview().catch(() => {})}>
                {c("Retry", "重试")}
              </button>
            </span>
          )}
          <Link href="/research">
            {c("Explore market context", "查看市场背景")}
          </Link>
        </div>
      </section>
    </>
  );
}
