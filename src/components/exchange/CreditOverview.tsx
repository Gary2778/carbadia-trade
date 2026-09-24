"use client";

import Link from "next/link";
import { useLang } from "@/i18n/LangProvider";
import { isChinese } from "@/i18n/config";
import { tCountry, tProjectType, tRegistry } from "@/i18n/data";
import { fmtMoney, fmtQty } from "@/lib/format";
import { getCreditProfile } from "@/lib/exchange/carbon";
import { ExchangeIcon } from "./ExchangeIcon";

type Asset = {
  symbol: string;
  name: string;
  standard: string;
  projectType: string;
  vintage: number;
  country: string;
  registry: string;
  description: string;
  lastPrice: number | null;
  isScenario: boolean;
};

const DESCRIPTIONS: Record<string, { en: string; zh: string }> = {
  "VCS-FOR-2021": {
    en: "An illustrative forest-management project focused on increasing forest carbon stocks through sustainable management.",
    zh: "示范森林经营项目，以永续管理增加森林碳储量为主题。",
  },
  "CCER-SOL-2023": {
    en: "An illustrative solar-power project exploring the replacement of fossil-fuel electricity with ground-mounted photovoltaic generation.",
    zh: "示范太阳能项目，以大型地面光伏发电替代化石能源发电为主题。",
  },
  "GS-WIND-2022": {
    en: "An illustrative onshore wind project exploring emissions reductions from grid-connected renewable electricity.",
    zh: "示范陆上风电项目，以并网可再生能源发电带来的减排为主题。",
  },
  "GS-MANG-2022": {
    en: "An illustrative mangrove-restoration project exploring carbon storage in coastal ecosystems.",
    zh: "示范红树林修复项目，以沿海生态系统的碳存储为主题。",
  },
  "VCS-COOK-2020": {
    en: "An illustrative efficient-cookstove project exploring reductions in fuelwood consumption.",
    zh: "示范高效炉灶项目，以减少薪柴消耗为主题。",
  },
  "CDM-METH-2019": {
    en: "An illustrative landfill-gas project exploring methane collection and electricity generation.",
    zh: "示范垃圾掩埋气项目，以甲烷收集及发电为主题。",
  },
};

export function CreditOverview({
  asset,
  availableSupply,
  holding,
}: {
  asset: Asset;
  availableSupply: number;
  holding: { quantity: number; locked: number } | null;
}) {
  const { lang } = useLang();
  const zh = isChinese(lang);
  const profile = getCreditProfile(asset);
  const description = DESCRIPTIONS[asset.symbol];
  const projectDescription = description
    ? zh
      ? description.zh
      : description.en
    : zh
      ? "此示范标的用于探索模拟市场。未提供可核实的项目描述或注册处项目编号。"
      : "This demonstration instrument is used to explore a simulated market. A verifiable project description and registry project ID have not been provided.";
  const notProvided = zh ? "未提供" : "Not provided";
  const lifecycle = [
    {
      name: zh ? "项目" : "Project",
      registry: true,
      detail: zh
        ? "项目设计与监测证据接受评估。"
        : "Project design and monitoring evidence are assessed.",
    },
    {
      name: zh ? "签发" : "Issuance",
      registry: true,
      detail: zh
        ? "注册处记录已签发的碳信用及序号。"
        : "A registry records issued credits and serial numbers.",
    },
    {
      name: zh ? "交易" : "Trading",
      registry: false,
      detail: zh
        ? "已成交订单在账户间转移示范碳信用与模拟资金。"
        : "Filled orders move demo credits and simulated funds between accounts.",
    },
    {
      name: zh ? "持有" : "Ownership",
      registry: false,
      detail: zh
        ? "投资组合记录可用及已锁定的持仓。"
        : "Your portfolio tracks available and locked holdings.",
    },
    {
      name: zh ? "注销" : "Retirement",
      registry: false,
      detail: zh
        ? "合资格的项目碳信用从示范持仓中扣除，并产生模拟凭证。"
        : "Eligible project credits leave your demo holdings and receive a simulation receipt.",
    },
  ];
  const checks = [
    {
      name: zh ? "额外性" : "Additionality",
      detail: zh
        ? "若没有碳信用收入，这项减排或移除是否仍会发生？"
        : "Would the reduction or removal happen without revenue from carbon credits?",
    },
    {
      name: zh ? "持久性" : "Permanence",
      detail: zh
        ? "碳存储会维持多久？逆转风险如何管理？"
        : "How long is carbon stored, and how are reversals managed?",
    },
    {
      name: zh ? "量化与基准线" : "Quantification and baseline",
      detail: zh
        ? "如何建立反事实基准线，以及计算减排量？"
        : "How are the baseline and claimed reductions calculated?",
    },
    {
      name: zh ? "泄漏与重复计算" : "Leakage and double counting",
      detail: zh
        ? "排放是否移转至其他地方？相同成果是否被重复声明？"
        : "Are emissions displaced elsewhere, or the same outcomes claimed twice?",
    },
    {
      name: zh ? "独立查证" : "Independent verification",
      detail: zh
        ? "谁查证了监测结果？报告及查证期间为何？"
        : "Who checked the monitoring results, and where is the verification report?",
    },
    {
      name: zh ? "社会与环境保障" : "Social and environmental safeguards",
      detail: zh
        ? "如何处理社区权利、生物多样性及申诉？"
        : "How are community rights, biodiversity and grievances addressed?",
    },
  ];

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <ExchangeIcon
                name={asset.isScenario ? "layers" : profile.icon}
                size={25}
              />
            </div>
            <div>
              <h2 className="text-base font-semibold">
                {asset.isScenario
                  ? zh
                    ? "关于此情景标的"
                    : "About this scenario"
                  : zh
                    ? "关于此碳信用"
                    : "About this credit"}
              </h2>
              <p className="mt-2 max-w-[70ch] text-sm leading-6 text-muted">
                {asset.isScenario
                  ? zh
                    ? "此模拟配额或指数情景并非自愿性碳信用，也不对应可交付的真实资产。"
                    : "This simulated allowance or index scenario is not a voluntary carbon credit and does not represent a deliverable real asset."
                  : projectDescription}
              </p>
            </div>
          </div>
          {!asset.isScenario && (
            <dl className="mt-6 grid gap-x-6 gap-y-4 border-t border-border pt-5 sm:grid-cols-3">
              <Metadata
                label={zh ? "项目类别" : "Project category"}
                value={zh ? profile.categoryZh : profile.category}
              />
              <Metadata
                label={zh ? "减碳方式" : "Carbon approach"}
                value={zh ? profile.approachZh : profile.approach}
              />
              <Metadata
                label={zh ? "解决方案类型" : "Solution type"}
                value={zh ? profile.familyZh : profile.family}
              />
            </dl>
          )}
          <p className="mt-4 text-xs leading-5 text-muted">
            {zh
              ? "以上分类仅依示范目录描述，并非项目质量认证或独立评级。"
              : "These categories describe the demo catalogue. They are not project certification or an independent quality rating."}
          </p>
        </section>

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 className="text-base font-semibold">
            {zh ? "项目数据与来源" : "Project details and provenance"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {zh
              ? "这是示范目录标的，未链接至真实注册项目。下列标签不可视为注册处背书。"
              : profile.provenance +
                " The labels below do not establish registry endorsement."}
          </p>
          <dl className="mt-5 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            <Metadata
              label={zh ? "目录中的标准" : "Standard in catalogue"}
              value={asset.standard}
            />
            <Metadata
              label={zh ? "目录中的注册处" : "Registry in catalogue"}
              value={tRegistry(asset.registry, lang)}
            />
            <Metadata
              label={zh ? "地点" : "Location"}
              value={tCountry(asset.country, lang)}
            />
            <Metadata
              label={zh ? "项目类型" : "Project type"}
              value={tProjectType(asset.projectType, lang)}
            />
            <Metadata
              label={zh ? "项目开发商" : "Project developer"}
              value={notProvided}
              missing
            />
            <Metadata
              label={zh ? "项目开始日期" : "Project start date"}
              value={notProvided}
              missing
            />
            <Metadata
              label={
                asset.isScenario
                  ? zh
                    ? "情景参考年份"
                    : "Scenario reference year"
                  : zh
                    ? "年份（Vintage）"
                    : "Vintage"
              }
              value={String(asset.vintage)}
            />
            <Metadata
              label={zh ? "注册处项目编号" : "Registry project ID"}
              value={notProvided}
              missing
            />
            <Metadata
              label={zh ? "方法学与版本" : "Methodology and version"}
              value={notProvided}
              missing
            />
            <Metadata
              label={zh ? "查证机构与报告" : "Verifier and verification report"}
              value={notProvided}
              missing
            />
            <Metadata
              label={zh ? "签发序号范围" : "Issued serial-number range"}
              value={notProvided}
              missing
            />
            <Metadata
              label={
                zh ? "注册状态与签发日期" : "Registry status and issuance date"
              }
              value={notProvided}
              missing
            />
          </dl>
          {!asset.isScenario && (
            <p className="mt-5 rounded-xl bg-surface-2 p-3 text-xs leading-5 text-muted">
              {zh
                ? "Vintage 指减排或移除发生的年份，而非碳信用签发或购买年份。此页显示的是示范目录中的年份，未经项目文档核实。"
                : "Vintage is the year the reduction or removal occurred, rather than when the credit was issued or purchased. The year shown here is a demo-catalogue value, not verified against project documents."}
            </p>
          )}
        </section>

        {!asset.isScenario && (
          <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 className="text-base font-semibold">
              {zh ? "环境与社会影响" : "Environmental and social impact"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {zh
                ? "评估碳量的同时，也应关注自然环境与社区的成果。共同效益需要项目监测及社区数据支持。"
                : "Consider outcomes for nature and communities alongside carbon accounting. Co-benefits need support from project monitoring and community evidence."}
            </p>
            <dl className="mt-5 grid gap-5 sm:grid-cols-2">
              <Metadata
                label={zh ? "环境共同效益" : "Environmental co-benefits"}
                value={zh ? "未提供证据" : "Evidence not provided"}
                missing
              />
              <Metadata
                label={zh ? "社会共同效益" : "Social co-benefits"}
                value={zh ? "未提供证据" : "Evidence not provided"}
                missing
              />
            </dl>
          </section>
        )}

        {!asset.isScenario && (
          <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 className="text-base font-semibold">
              {zh ? "了解碳信用的生命周期" : "Follow a credit’s lifecycle"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              {zh
                ? "此目录未链接注册处记录；后三个阶段可在此模拟操作。"
                : "Registry records are not connected to this catalogue. The last three stages are actions you can practice here."}
            </p>
            <ol className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {lifecycle.map((stage, index) => (
                <li
                  key={stage.name}
                  className="rounded-xl border border-border bg-surface-2/50 p-3"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[10px] font-semibold text-muted"
                      aria-hidden="true"
                    >
                      {index + 1}
                    </span>
                    <h3 className="text-xs font-semibold">{stage.name}</h3>
                    {index < lifecycle.length - 1 && (
                      <span aria-hidden="true" className="ms-auto text-muted">
                        →
                      </span>
                    )}
                  </div>
                  <p
                    className={`mt-3 text-[10px] font-medium ${stage.registry ? "text-muted" : "text-accent"}`}
                  >
                    {stage.registry
                      ? zh
                        ? "注册处 · 未链接"
                        : "Registry · unlinked"
                      : zh
                        ? "模拟平台"
                        : "Simulator"}
                  </p>
                  <p className="mt-1.5 text-xs leading-5 text-muted">
                    {stage.detail}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-3 text-sm font-medium">
              <Link
                href="/transactions"
                className="text-accent hover:underline"
              >
                {zh ? "查看账户活动" : "View account activity"} →
              </Link>
              <Link
                href="/retirement"
                className="text-accent hover:underline"
              >
                {zh ? "探索模拟注销" : "Explore simulated retirement"} →
              </Link>
            </div>
          </section>
        )}

        {!asset.isScenario && (
          <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold">
                {zh ? "质量尽职调查清单" : "Quality due diligence"}
              </h2>
              <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
                {zh ? "未评分" : "Not scored"}
              </span>
            </div>
            <p className="mt-2 text-sm leading-6 text-muted">
              {zh
                ? "真实交易前，应核对下列问题。本示范目录未提供足以评估它们的项目证据。"
                : "Questions to investigate before a real purchase. This demo catalogue does not provide the project evidence needed to assess them."}
            </p>
            <div className="mt-4 divide-y divide-border">
              {checks.map((check) => (
                <div
                  key={check.name}
                  className="grid gap-2 py-4 sm:grid-cols-[1fr_auto]"
                >
                  <div>
                    <h3 className="text-sm font-medium">{check.name}</h3>
                    <p className="mt-1 max-w-[66ch] text-xs leading-5 text-muted">
                      {check.detail}
                    </p>
                  </div>
                  <span className="self-start text-xs text-muted">
                    {zh ? "需要项目证据" : "Project evidence needed"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 className="text-base font-semibold">
            {zh ? "文档与参考数据" : "Documents and references"}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            {zh
              ? "项目设计文档、监测报告及查证报告均未提供。以下为一般标准或注册处资源，并非此标的的项目证据。"
              : "Project design documents, monitoring reports and verification reports have not been supplied. These are general program or registry resources, not evidence for this instrument."}
          </p>
          <div className="mt-4 space-y-2">
            {profile.registryUrl && (
              <ReferenceLink
                href={profile.registryUrl}
                label={
                  zh
                    ? `浏览 ${asset.standard} 注册处／计划`
                    : `Visit the ${asset.standard} registry / program`
                }
              />
            )}
            {profile.programUrl &&
              profile.programUrl !== profile.registryUrl && (
                <ReferenceLink
                  href={profile.programUrl}
                  label={
                    zh
                      ? `${asset.standard} 标准说明`
                      : `${asset.standard} program information`
                  }
                />
              )}
            {!profile.registryUrl && (
              <p className="rounded-xl bg-surface-2 p-3 text-sm text-muted">
                {zh
                  ? "此示范标的没有可供核查的注册处项目链接。"
                  : "No registry project link is available for this demonstration instrument."}
              </p>
            )}
          </div>
        </section>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6">
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
          <h2 className="font-semibold">
            {zh ? "模拟市场概况" : "Demo market snapshot"}
          </h2>
          <p className="mt-5 text-xs text-muted">
            {zh ? "最近成交价／单位" : "Last trade / unit"}
          </p>
          <p className="mt-1 text-2xl font-semibold text-accent tnum">
            {asset.lastPrice === null ? "—" : `$${fmtMoney(asset.lastPrice)}`}
          </p>
          <dl className="mt-5 space-y-3 border-t border-border pt-4 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">
                {zh ? "显示的卖方供应量" : "Displayed sell supply"}
              </dt>
              <dd className="tnum">{fmtQty(availableSupply)}</dd>
            </div>
            {holding && (
              <div className="flex justify-between gap-3">
                <dt className="text-muted">
                  {zh ? "您的模拟持仓" : "Your demo holding"}
                </dt>
                <dd className="tnum">{fmtQty(holding.quantity)}</dd>
              </div>
            )}
          </dl>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Link
              href={`/market/${asset.symbol}?tab=trade&side=BUY`}
              className="rounded-full bg-accent px-4 py-2.5 text-center text-sm font-semibold text-background transition-colors hover:bg-accent-strong"
            >
              {zh ? "买入" : "Buy"}
            </Link>
            <Link
              href={`/market/${asset.symbol}?tab=trade&side=SELL`}
              className="rounded-full border border-accent/30 bg-accent/10 px-4 py-2.5 text-center text-sm font-semibold text-accent transition-colors hover:bg-accent/15"
            >
              {zh ? "卖出" : "Sell"}
            </Link>
          </div>
          <p className="mt-3 text-xs leading-5 text-muted">
            {zh
              ? "仅限模拟资金，成交价格及供应量会变动。"
              : "Simulated funds only. Execution prices and supply can change."}
          </p>
        </section>
        {!asset.isScenario && (
          <section className="rounded-2xl border border-border bg-surface p-5 shadow-card">
            <h2 className="font-semibold">
              {zh ? "理解名义碳量" : "Understanding carbon quantity"}
            </h2>
            <p className="my-4 text-base font-semibold tnum">
              1 {zh ? "碳信用" : "credit"} = 1 tCO₂e
            </p>
            <p className="text-xs leading-5 text-muted">
              {zh
                ? "这是名义单位关系，不是经此平台核证的环境成果。购买、持有与注销是不同的步骤。"
                : "This is a nominal unit relationship, not an environmental outcome verified by this platform. Buying, holding and retiring are separate steps."}
            </p>
            <p className="mt-3 text-xs leading-5 text-muted">
              {zh
                ? "模拟交易不产生真实碳信用，也不代表您已抵销任何排放。"
                : "Demo trades do not create real credits or mean that you have offset any emissions."}
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}

function Metadata({
  label,
  value,
  missing,
}: {
  label: string;
  value: string;
  missing?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`mt-1.5 text-sm ${missing ? "text-muted" : "font-medium"}`}
      >
        {value}
      </dd>
    </div>
  );
}

function ReferenceLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-sm font-medium hover:border-accent/40 hover:text-accent"
    >
      <span>{label}</span>
      <ExchangeIcon name="external" size={16} />
    </a>
  );
}
