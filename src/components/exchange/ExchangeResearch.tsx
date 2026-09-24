"use client";

import Link from "next/link";
import { useState } from "react";
import { CREDIT_SOURCES, getCreditProfile } from "@/lib/exchange/carbon";
import { fmtQty } from "@/lib/format";
import { ExchangeIcon } from "./ExchangeIcon";
import { Stat } from "./MarketPlace";
import { useExchangeText, useMarket } from "./useExchange";
import {
  OFFSETS_SOURCE,
  registryLabel,
  useRegistryOverview,
} from "./RegistryData";
import "./discovery.css";

export function ExchangeResearch() {
  const c = useExchangeText();
  const { overview, error, reload } = useRegistryOverview();
  const market = useMarket();
  const [retrying, setRetrying] = useState(false);
  const [metric, setMetric] = useState<"issuance" | "retirement">("retirement");
  const [distribution, setDistribution] = useState<"retired" | "issued">(
    "retired",
  );
  const hasSnapshot =
    !!overview && (overview.totals.projects > 0 || !!overview.asOf);
  const loadingSnapshot = !overview && (!error || retrying);
  const snapshotStatus = loadingSnapshot
    ? c("Waiting for the registry snapshot…", "正在等待注册处快照…")
    : c(
        "Registry data is unavailable. Use Retry above to load it again.",
        "目前无法取得注册处数据，请使用上方的重试按钮重新加载。",
      );
  const retryOverview = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      await reload();
    } catch {
      // The overview hook retains the last snapshot and exposes the error.
    } finally {
      setRetrying(false);
    }
  };
  const credits = market.assets.filter((a) => !a.isScenario);
  const groups = new Map<
    string,
    {
      category: string;
      categoryZh: string;
      color: string;
      volume: number;
      projects: number;
    }
  >();
  for (const asset of credits) {
    const profile = getCreditProfile(asset);
    const group = groups.get(profile.category) ?? {
      category: profile.category,
      categoryZh: profile.categoryZh,
      color: profile.color,
      volume: 0,
      projects: 0,
    };
    group.volume += asset.volume24h;
    group.projects += 1;
    groups.set(profile.category, group);
  }
  const categories = [...groups.values()].sort((a, b) => b.volume - a.volume);
  const demoVolume = categories.reduce((sum, g) => sum + g.volume, 0);
  const years = overview?.years.slice(-8) ?? [];
  const maxYear = Math.max(1, ...years.map((year) => year[metric]));
  const registries = [...(overview?.registries ?? [])].sort(
    (a, b) => b[distribution] - a[distribution],
  );
  const maxRegistry = Math.max(1, ...registries.map((r) => r[distribution]));
  const topBeneficiaries =
    overview?.beneficiaries
      .filter((b) => b.name !== "UNDISCLOSED")
      .slice(0, 5) ?? [];
  return (
    <>
      <div className="ex-page-heading">
        <div>
          <h1>{c("Carbon market research", "碳市场研究")}</h1>
          <p>
            {c(
              "Understand what has been issued, what has been retired and where the activity comes from.",
              "了解碳信用的签发、注销情况，以及市场活动的数据源。",
            )}
          </p>
        </div>
        <Link href="/projects?view=registry" className="ex-button">
          <ExchangeIcon name="projects" size={15} />
          {c("Explore registry projects", "浏览注册处项目")}
        </Link>
      </div>
      <div className="ex-research-source">
        <strong>{c("Real registry records", "真实注册处记录")}</strong> ·{" "}
        {overview?.asOf
          ? c(
              `Snapshot: ${overview.asOf.slice(0, 10)}`,
              `快照日期：${overview.asOf.slice(0, 10)}`,
            )
          : overview
            ? c("Snapshot date unavailable", "未提供快照日期")
            : loadingSnapshot
              ? c("Loading snapshot…", "正在加载快照…")
              : c("Snapshot unavailable", "无法取得快照")}
        {overview && error && (
          <span>
            {c(" · Previous snapshot · refresh failed", " · 旧快照 · 更新失败")}
          </span>
        )}
        <br />
        {c("Source: ", "来源：")}
        <a href={OFFSETS_SOURCE} target="_blank" rel="noopener noreferrer">
          CarbonPlan OffsetsDB
        </a>
        {c(
          ". Coverage reflects the registries in this dataset, not every carbon market. These figures do not describe Carbadia demo assets or tradable supply.",
          "。涵盖范围以此数据集收录的注册处为准，并非所有碳市场。以下数字不代表 Carbadia 示范资产或可交易供应量。",
        )}
      </div>
      {error && (
        <div className="ex-error" role="alert">
          <span>
            {overview
              ? c(
                  "Registry data could not be refreshed. The last received snapshot remains visible.",
                  "无法更新注册处数据，目前保留上次加载的快照。",
                )
              : c("Registry data could not be loaded.", "无法加载注册处数据。")}
          </span>
          <button
            disabled={retrying}
            aria-busy={retrying}
            onClick={() => void retryOverview()}
          >
            {retrying ? c("Retrying…", "正在重试…") : c("Retry", "重试")}
          </button>
        </div>
      )}
      <div className="ex-market-stats ex-large-value-stats">
        <Stat
          label={c("Projects in the dataset", "数据集中的项目")}
          value={hasSnapshot ? fmtQty(overview!.totals.projects) : "—"}
          note={c("Registry project records", "注册处项目记录")}
          icon="projects"
        />
        <Stat
          label={c("Cumulative issuance", "累计签发量")}
          value={hasSnapshot ? fmtQty(overview!.totals.issued) : "—"}
          unit="tCO₂e"
          note={c(
            "Reported across covered registries",
            "数据集涵盖注册处的报告数量",
          )}
          icon="layers"
        />
        <Stat
          label={c("Cumulative retirements", "累计注销量")}
          value={hasSnapshot ? fmtQty(overview!.totals.retired) : "—"}
          unit="tCO₂e"
          note={c("Historical retirement records", "历史注销记录")}
          icon="retire"
        />
        <Stat
          label={c("Registries covered", "涵盖的注册处")}
          value={hasSnapshot ? overview!.registries.length : "—"}
          note={c(
            "Coverage can change between snapshots",
            "涵盖范围可能随快照变更",
          )}
          icon="research"
        />
      </div>
      {loadingSnapshot && (
        <div className="ex-panel ex-loading" role="status">
          {c("Loading the registry snapshot…", "正在加载注册处快照…")}
        </div>
      )}
      {overview && !hasSnapshot && (
        <div className="ex-panel ex-empty">
          <ExchangeIcon name="research" size={30} />
          <h2>
            {c("No registry records in this snapshot", "此快照尚无注册处记录")}
          </h2>
          <p>
            {c(
              "Real-market charts will appear when source records are available. The original dataset and learning resources remain available below.",
              "来源记录可用时，将显示真实市场图表。您仍可使用下方的原始数据集及学习资源。",
            )}
          </p>
          <a
            href={OFFSETS_SOURCE}
            className="ex-button"
            target="_blank"
            rel="noopener noreferrer"
          >
            {c("Visit the source", "查看原始来源")}
            <ExchangeIcon name="external" size={13} />
          </a>
        </div>
      )}
      <div className="ex-research-layout" style={{ marginTop: 24 }}>
        <div>
          <section className="ex-panel ex-research-section">
            <header>
              <div>
                <h2>{c("Registry activity over time", "注册处历年活动")}</h2>
                <p>
                  {c(
                    "Recorded transaction year · tonnes CO₂e",
                    "记录中的交易年份 · 吨 CO₂e",
                  )}
                </p>
              </div>
              <div
                className="ex-research-toggle"
                role="group"
                aria-label={c("Annual activity metric", "年度活动指针")}
              >
                <button
                  aria-pressed={metric === "retirement"}
                  onClick={() => setMetric("retirement")}
                >
                  {c("Retirements", "注销")}
                </button>
                <button
                  aria-pressed={metric === "issuance"}
                  onClick={() => setMetric("issuance")}
                >
                  {c("Issuance", "签发")}
                </button>
              </div>
            </header>
            {!overview ? (
              <p className="ex-muted">{snapshotStatus}</p>
            ) : years.length ? (
              <div className="ex-research-bars">
                {years.map((year) => (
                  <div className="ex-research-row" key={year.year}>
                    <span>{year.year}</span>
                    <div className="ex-research-track" aria-hidden="true">
                      <div
                        style={{ width: `${(year[metric] / maxYear) * 100}%` }}
                      />
                    </div>
                    <strong>{fmtQty(year[metric])}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ex-muted">
                {c(
                  "No annual records are available in the current snapshot.",
                  "目前快照未提供年度记录。",
                )}
              </p>
            )}
            <p className="ex-discovery-caption" style={{ marginTop: 20 }}>
              {c(
                "The most recent year may be incomplete. A transaction year is different from a credit's vintage. Counts do not measure credit quality or avoided emissions by themselves.",
                "最近年份可能尚未完整。交易年份与信用的减排年份不同；数量本身并不衡量信用质量或实际避免的排放。",
              )}
            </p>
          </section>
          <section className="ex-panel ex-research-section">
            <header>
              <div>
                <h2>{c("Activity by registry", "依注册处比较活动")}</h2>
                <p>
                  {c(
                    "Cumulative reported volume · tonnes CO₂e",
                    "累计报告数量 · 吨 CO₂e",
                  )}
                </p>
              </div>
              <div
                className="ex-research-toggle"
                role="group"
                aria-label={c("Registry distribution metric", "注册处分布指针")}
              >
                <button
                  aria-pressed={distribution === "retired"}
                  onClick={() => setDistribution("retired")}
                >
                  {c("Retired", "已注销")}
                </button>
                <button
                  aria-pressed={distribution === "issued"}
                  onClick={() => setDistribution("issued")}
                >
                  {c("Issued", "已签发")}
                </button>
              </div>
            </header>
            {!overview ? (
              <p className="ex-muted">{snapshotStatus}</p>
            ) : registries.length ? (
              <div className="ex-research-bars">
                {registries.map((r) => (
                  <div className="ex-research-row" key={r.registry}>
                    <Link
                      href={`/projects?view=registry&registry=${encodeURIComponent(r.registry)}`}
                    >
                      {registryLabel(r.registry)}
                    </Link>
                    <div className="ex-research-track" aria-hidden="true">
                      <div
                        style={{
                          width: `${(r[distribution] / maxRegistry) * 100}%`,
                        }}
                      />
                    </div>
                    <strong>{fmtQty(r[distribution])}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ex-muted">
                {c(
                  "Registry distributions will appear once data is available.",
                  "数据可用时将显示各注册处分布。",
                )}
              </p>
            )}
            <div className="ex-learning-links">
              <a href="https://carbadia.io/atlas/data" rel="noopener">
                {c("Open the full Atlas data view", "打开 Atlas 完整数据")}
              </a>
            </div>
          </section>
          <section className="ex-panel ex-research-section">
            <header>
              <div>
                <h2>{c("Inside the simulator", "模拟市场内部活动")}</h2>
                <p>
                  {c(
                    "Executed demo trades by project category · last 24 hours",
                    "依项目类别呈现的示范成交 · 过去 24 小时",
                  )}
                </p>
              </div>
              <span className="ex-status-tag">
                {c("Demo data", "示范数据")}
              </span>
            </header>
            {market.error && (
              <div className="ex-error" role="alert">
                <span>
                  {c(
                    "Demo activity could not be refreshed.",
                    "无法更新示范市场活动。",
                  )}
                </span>
                <button onClick={() => void market.reload().catch(() => {})}>
                  {c("Retry", "重试")}
                </button>
              </div>
            )}
            {!market.loaded ? (
              <div className="ex-loading" role="status">
                {c("Loading simulation activity…", "正在加载模拟活动…")}
              </div>
            ) : !market.hasData ? null : demoVolume > 0 ? (
              <div className="ex-research-bars">
                {categories.map((group) => (
                  <div className="ex-research-row" key={group.category}>
                    <Link
                      href={`/?category=${encodeURIComponent(group.category)}`}
                    >
                      {c(group.category, group.categoryZh)}
                    </Link>
                    <div className="ex-research-track" aria-hidden="true">
                      <div
                        style={{
                          width: `${(group.volume / demoVolume) * 100}%`,
                          background: group.color,
                        }}
                      />
                    </div>
                    <strong>{fmtQty(group.volume)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ex-muted">
                {c(
                  "No matched demo credit trades were recorded in the last 24 hours.",
                  "过去 24 小时未有碳信用模拟撮合成交记录。",
                )}
              </p>
            )}
            <p className="ex-discovery-caption" style={{ marginTop: 20 }}>
              {c(
                "Units: simulated credits. Includes market-making activity; excludes OTC deals and allowance/index scenarios. Categories describe the demo catalogue. This is not a signal of real-world demand, prices or climate impact.",
                "单位：模拟碳信用。包含做市活动，不含大宗交易、配额及指数情景。分类仅描述示范目录，不代表真实市场需求、价格或气候影响。",
              )}
            </p>
          </section>
        </div>
        <aside>
          <section className="ex-panel">
            <div className="ex-panel-heading">
              <div>
                <h2>{c("Read the primary sources", "阅读第一手来源")}</h2>
                <p>
                  {c(
                    "Program rules and integrity frameworks",
                    "标准规则与诚信框架",
                  )}
                </p>
              </div>
            </div>
            <div className="ex-research-reading">
              <a
                href={CREDIT_SOURCES.integrity}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExchangeIcon name="check" size={18} />
                <div>
                  <strong>
                    {c("ICVCM Core Carbon Principles", "ICVCM 核心碳原则")}
                  </strong>
                  <small>
                    {c(
                      "A framework for understanding credit integrity, transparency and safeguards.",
                      "了解信用诚信、透明度与保障措施的框架。",
                    )}
                  </small>
                </div>
                <ExchangeIcon name="external" size={12} />
              </a>
              <a
                href={CREDIT_SOURCES.verra}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExchangeIcon name="layers" size={18} />
                <div>
                  <strong>
                    {c("Verra: understanding VCUs", "Verra：认识 VCU")}
                  </strong>
                  <small>
                    {c(
                      "How Verified Carbon Units are issued, transferred and retired.",
                      "核证碳单位的签发、转移及注销方式。",
                    )}
                  </small>
                </div>
                <ExchangeIcon name="external" size={12} />
              </a>
              <a
                href={CREDIT_SOURCES.accu}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExchangeIcon name="forest" size={18} />
                <div>
                  <strong>
                    {c("Australia's ACCU Scheme", "澳洲 ACCU 计划")}
                  </strong>
                  <small>
                    {c(
                      "The Clean Energy Regulator's guide to Australia's carbon credit scheme.",
                      "澳洲清洁能源监管机构的碳信用计划指南。",
                    )}
                  </small>
                </div>
                <ExchangeIcon name="external" size={12} />
              </a>
              <a
                href={OFFSETS_SOURCE}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExchangeIcon name="research" size={18} />
                <div>
                  <strong>CarbonPlan OffsetsDB</strong>
                  <small>
                    {c(
                      "The source of the registry project and transaction records shown here.",
                      "本页注册项目与交易记录的数据源。",
                    )}
                  </small>
                </div>
                <ExchangeIcon name="external" size={12} />
              </a>
            </div>
          </section>
          <section className="ex-panel">
            <div className="ex-panel-heading">
              <div>
                <h2>
                  {c("Recorded retirement beneficiaries", "记录中的注销受益人")}
                </h2>
                <p>
                  {c(
                    "Largest named entries in this dataset",
                    "此数据集中具名记录的累计排序",
                  )}
                </p>
              </div>
            </div>
            {!overview ? (
              <p className="ex-muted">{snapshotStatus}</p>
            ) : topBeneficiaries.length ? (
              <div>
                {topBeneficiaries.map((b) => (
                  <div className="ex-allocation-row" key={b.name}>
                    <span>{b.name}</span>
                    <strong>{fmtQty(b.tonnes)}</strong>
                  </div>
                ))}
              </div>
            ) : (
              <p className="ex-muted">
                {c(
                  "No named beneficiary records are available.",
                  "目前没有具名受益人记录。",
                )}
              </p>
            )}
            <p className="ex-discovery-caption" style={{ marginTop: 16 }}>
              {c(
                "Tonnes CO₂e recorded in the source. Undisclosed names are omitted here. A retirement record does not verify an organisation's wider climate claims.",
                "单位为来源记载的吨 CO₂e，未披露名称的记录未列于此处。注销记录并不验证组织的整体气候声明。",
              )}
            </p>
          </section>
          <div className="ex-info-strip">
            <ExchangeIcon name="learn" size={23} />
            <div>
              <strong>
                {c("Need context for the numbers?", "想了解数字的背景？")}
              </strong>
              <p>
                {c(
                  "Learn how issuance, vintage and retirement fit together.",
                  "了解签发、减排年份与注销如何相互关联。",
                )}
              </p>
            </div>
            <Link href="/learn">{c("Learn", "了解更多")}</Link>
          </div>
        </aside>
      </div>
    </>
  );
}
