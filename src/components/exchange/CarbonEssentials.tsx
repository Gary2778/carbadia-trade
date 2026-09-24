"use client";

import Link from "next/link";
import { useState } from "react";
import { CREDIT_SOURCES } from "@/lib/exchange/carbon";
import { ExchangeIcon } from "./ExchangeIcon";
import { useExchangeText } from "./useExchange";
import "./discovery.css";

type Term = {
  id: string;
  en: string;
  zh: string;
  definition: string;
  definitionZh: string;
  category: "basics" | "quality" | "use";
  source: string;
  sourceName: string;
};
const VERRA_FAQ = "https://verra.org/faq/";
const TERMS: Term[] = [
  {
    id: "term-carbon-credit",
    en: "Carbon credit",
    zh: "碳信用",
    category: "basics",
    definition:
      "A unit representing one tonne of carbon dioxide equivalent reduced or removed under a crediting program. The unit alone does not tell you how the outcome was achieved or how strong the evidence is.",
    definitionZh:
      "在碳信用标准下，代表一吨二氧化碳当量减排或移除的单位。单位本身不会说明成果如何达成，或证据有多充分。",
    source: CREDIT_SOURCES.verra,
    sourceName: "Verra",
  },
  {
    id: "vintage",
    en: "Vintage",
    zh: "减排年份（Vintage）",
    category: "basics",
    definition:
      "The period when the emission reduction or removal happened. It can differ from the year a credit was issued, bought or retired. Check the precise vintage period in the project records.",
    definitionZh:
      "减排或移除发生的期间，可能与信用签发、购买或注销的年份不同。确切期间应以项目记录为准。",
    source: VERRA_FAQ,
    sourceName: "Verra",
  },
  {
    id: "registry",
    en: "Registry",
    zh: "注册处／登记簿",
    category: "basics",
    definition:
      "The record system that identifies projects and units and tracks issuance, transfers and retirement. Follow the project ID and unit records to the original registry when checking provenance.",
    definitionZh:
      "识别项目与信用单位，并追踪签发、转移和注销的记录系统。查核来源时，应依项目编号及单位记录追溯原始注册处。",
    source: "https://verra.org/registry/overview/",
    sourceName: "Verra Registry",
  },
  {
    id: "methodology",
    en: "Methodology",
    zh: "方法学",
    category: "basics",
    definition:
      "The rules used to define a baseline, calculate results and monitor an activity. The method and its version matter: a project category such as forestry is not a methodology.",
    definitionZh:
      "用以设置基准线、计算成果及监测活动的规则。方法及版本都很重要；例如“林业”这类项目分类并不是方法学。",
    source:
      "https://verra.org/programs/verified-carbon-standard/vcs-program-details/",
    sourceName: "Verra VCS",
  },
  {
    id: "additionality",
    en: "Additionality",
    zh: "额外性",
    category: "quality",
    definition:
      "Whether the credited outcome depends on the incentive from carbon credit revenue. Ask what would have happened without that incentive.",
    definitionZh:
      "信用所代表的成果，是否依赖碳信用收入提供的诱因。应探究：若没有这项诱因，原本会发生什么？",
    source: CREDIT_SOURCES.integrity,
    sourceName: "ICVCM",
  },
  {
    id: "permanence",
    en: "Permanence",
    zh: "持久性",
    category: "quality",
    definition:
      "How durable the climate outcome is. Where stored carbon can be released again, examine reversal risks and the measures used to address them.",
    definitionZh:
      "气候成果能持续多久。若存储的碳可能再次释放，应查看逆转风险及相应处理措施。",
    source: CREDIT_SOURCES.integrity,
    sourceName: "ICVCM",
  },
  {
    id: "leakage",
    en: "Leakage",
    zh: "泄漏",
    category: "quality",
    definition:
      "An activity can move emissions elsewhere instead of eliminating them. For example, protecting one forest may displace harvesting. The methodology should identify and account for relevant leakage.",
    definitionZh:
      "某项活动可能将排放转移至别处，而非消除排放。例如，保护一片森林可能使采伐转往其他地点。方法学应识别并计入相关泄漏。",
    source: VERRA_FAQ,
    sourceName: "Verra",
  },
  {
    id: "verification",
    en: "Verification",
    zh: "查证",
    category: "quality",
    definition:
      "An independent check of reported project results against the program's requirements. Read the monitoring period, verifier and report; a registry name by itself is not a verification report.",
    definitionZh:
      "依标准要求，对项目所报告成果进行独立查核。应阅读监测期间、查证机构及报告；注册处名称本身不是查证报告。",
    source:
      "https://verra.org/programs/verified-carbon-standard/vcs-program-details/",
    sourceName: "Verra VCS",
  },
  {
    id: "double-counting",
    en: "Double counting",
    zh: "重复计算",
    category: "quality",
    definition:
      "Counting the same mitigation outcome more than once, through duplicate issuance, use or claims. Trace unit identifiers and retirement records, and check the applicable claims rules.",
    definitionZh:
      "通过重复签发、使用或声明，多次计入相同的减缓成果。应追踪单位识别码及注销记录，并查核适用的声明规则。",
    source: CREDIT_SOURCES.integrity,
    sourceName: "ICVCM",
  },
  {
    id: "issuance",
    en: "Issuance",
    zh: "签发",
    category: "use",
    definition:
      "The creation of credit units after the program's required review and approval. A registered project may not yet have issued credits; an issued credit may already have been retired.",
    definitionZh:
      "经标准所要求的审查及核准后，建立信用单位的程序。已注册项目可能尚未签发信用；已签发信用也可能已经注销。",
    source: CREDIT_SOURCES.verra,
    sourceName: "Verra",
  },
  {
    id: "retirement",
    en: "Retirement",
    zh: "注销",
    category: "use",
    definition:
      "Taking a credit out of circulation so it cannot be used again. Buying and holding a credit is different from retiring it. A real claim needs the relevant registry evidence and applicable reporting rules.",
    definitionZh:
      "将碳信用移出流通，避免再次使用。购买并持有信用与注销不同。真实声明需要相关注册处证据，并遵循适用的报告规则。",
    source: CREDIT_SOURCES.verra,
    sourceName: "Verra",
  },
  {
    id: "vcu",
    en: "VCU — Verified Carbon Unit",
    zh: "VCU — 核证碳单位",
    category: "basics",
    definition:
      "The unit issued under Verra's Verified Carbon Standard. Each VCU represents one tonne CO₂e of reduction or removal. Check the underlying project and applicable program requirements.",
    definitionZh:
      "依 Verra 核证碳标准签发的单位。每份 VCU 代表一吨 CO₂e 的减排或移除；应查核其基础项目及适用规则。",
    source: CREDIT_SOURCES.verra,
    sourceName: "Verra",
  },
  {
    id: "accu",
    en: "ACCU — Australian Carbon Credit Unit",
    zh: "ACCU — 澳洲碳信用单位",
    category: "basics",
    definition:
      "A unit issued through Australia's ACCU Scheme, administered by the Clean Energy Regulator. One ACCU represents one tonne CO₂e stored or avoided by an eligible project.",
    definitionZh:
      "通过澳洲 ACCU 计划签发、由清洁能源监管机构管理的单位。每份 ACCU 代表合资格项目存储或避免排放的一吨 CO₂e。",
    source: CREDIT_SOURCES.accu,
    sourceName: "Clean Energy Regulator",
  },
  {
    id: "removal-avoidance",
    en: "Removal and avoidance",
    zh: "移除与避免排放",
    category: "basics",
    definition:
      "Removal takes carbon from the atmosphere and stores it. Avoidance reduces emissions against a baseline. Both need credible measurement; project type alone does not establish quality.",
    definitionZh:
      "移除是从大气中取出并存储碳；避免排放则是相对基准线减少排放。两者都需要可信的计量，不能仅靠项目类型判断质量。",
    source: CREDIT_SOURCES.accu,
    sourceName: "Clean Energy Regulator",
  },
];

export function CarbonEssentials() {
  const c = useExchangeText();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [expanded, setExpanded] = useState(false);
  const q = search.trim().toLowerCase();
  const terms = TERMS.filter(
    (term) =>
      (!category || term.category === category) &&
      (!q ||
        [term.en, term.zh, term.definition, term.definitionZh]
          .join(" ")
          .toLowerCase()
          .includes(q)),
  );
  const stages = [
    [
      "Design & assess",
      "设计与评估",
      "Define the activity, baseline and method. Assess eligibility and the project design.",
      "定义活动、基准线及方法，评估资格与项目设计。",
    ],
    [
      "Monitor outcomes",
      "监测成果",
      "Measure the activity and document results over a monitoring period.",
      "在监测期间量测活动并记录成果。",
    ],
    [
      "Verify & issue",
      "查证与签发",
      "Check results independently. The program reviews and approves credit issuance.",
      "独立查核成果，由标准计划审查并核准信用签发。",
    ],
    [
      "Transfer & hold",
      "转移与持有",
      "Units can change ownership while their registry records identify them.",
      "信用可转移所有权，并由注册处记录持续识别。",
    ],
    [
      "Retire the credit",
      "注销信用",
      "Remove units from circulation and record the retirement's details.",
      "将单位移出流通并记录注销详情。",
    ],
  ];
  const quality = [
    [
      "Find the original record",
      "寻找原始记录",
      "Does the project ID match the registry and the units offered?",
      "项目编号是否对应注册处及所提供的信用单位？",
    ],
    [
      "Understand the baseline",
      "理解基准线",
      "What is being compared, and why is the result additional?",
      "比较的基准是什么？成果为何具额外性？",
    ],
    [
      "Read the evidence",
      "阅读证据",
      "Which methodology, monitoring period and verification report apply?",
      "适用哪个方法学、监测期间及查证报告？",
    ],
    [
      "Examine durability",
      "查看持久性",
      "Could the outcome reverse, and how is that risk addressed?",
      "成果是否可能逆转？如何处理这项风险？",
    ],
    [
      "Check displaced impacts",
      "查核移转影响",
      "Are leakage, community rights and environmental safeguards addressed?",
      "是否处理泄漏、社区权利及环境保障？",
    ],
    [
      "Trace the final use",
      "追踪最终用途",
      "Are unit identifiers and retirement evidence available for the intended use?",
      "是否备有符合预定用途的单位识别码及注销证据？",
    ],
  ];
  const priceFactors = [
    [
      "Project & methodology",
      "项目与方法学",
      "Activities and locations have different implementation and monitoring needs. The methodology defines how results are measured, so buyers need to understand the specific project behind the unit.",
      "不同活动与地点有不同的执行及监测需求。方法学规范成果的计量方式，因此买方需要了解信用单位背后的具体项目。",
    ],
    [
      "Durability & reversal risk",
      "耐久性与逆转风险",
      "How long carbon stays stored, the risk of it being released again and the protections in place can influence buyer preferences. Removal credits do not all have the same durability.",
      "碳能存储多久、再次释放的风险及相应保障措施，都可能影响买方偏好。不同移除信用的耐久性并不相同。",
    ],
    [
      "Evidence & confidence",
      "证据与信心",
      "Additionality, the baseline and independent verification help buyers assess whether the claimed outcome is credible. A registry name alone does not replace the project evidence.",
      "额外性、基准线及独立查证，有助买方评估所声称的成果是否可信。注册处名称不能取代项目证据。",
    ],
    [
      "Documented co-benefits",
      "有证据支持的共同效益",
      "Some buyers value additional benefits for communities or biodiversity. Verra explains that additional certifications for these benefits can bring a price premium; the supporting evidence still matters.",
      "部分买方重视社区或生物多样性方面的额外效益。Verra 说明，这些效益的附加认证可能带来溢价，但仍需查看支持证据。",
    ],
    [
      "Supply & demand",
      "供给与需求",
      "Prices also reflect how many eligible credits are offered and how much buyers want them. Prices can change when supply or demand changes, even when the underlying project has not changed.",
      "价格也反映市场提供多少合资格信用，以及买方的需求。即使基础项目没有改变，供给或需求变化仍可能使价格改变。",
    ],
    [
      "Fit for the intended use",
      "是否符合预定用途",
      "A buyer may need a particular program, vintage or other eligibility criteria. Check the rules for the intended use: a VCU and an ACCU are not automatically interchangeable just because both use tonnes CO₂e.",
      "买方可能需要特定标准计划、年份或其他资格条件。应查核预定用途的规则：VCU 与 ACCU 都以吨 CO₂e 计量，不代表两者可自动互相替代。",
    ],
  ];
  return (
    <div className="ex-discovery-stack">
      <div className="ex-page-heading" style={{ marginBottom: 0 }}>
        <div>
          <h1>{c("Carbon credit essentials", "碳信用入门")}</h1>
          <p>
            {c(
              "A practical guide to the unit, the project and the decisions that connect them.",
              "从计量单位、基础项目到相关决策的实用指南。",
            )}
          </p>
        </div>
        <Link href="/" className="ex-button">
          <ExchangeIcon name="market" size={15} />
          {c("Explore the marketplace", "探索碳信用市场")}
        </Link>
      </div>
      <section className="ex-panel ex-learning-section" id="carbon-credit">
        <div className="ex-learn-intro">
          <div>
            <h2>
              {c(
                "One unit. A project worth understanding.",
                "一个单位，背后有值得理解的项目。",
              )}
            </h2>
            <p>
              {c(
                "A carbon credit represents a tonne of carbon dioxide equivalent reduced or removed under a crediting program. To understand a credit, look beyond the quantity to its project, method and evidence.",
                "碳信用代表依标准计划减少或移除的一吨二氧化碳当量。理解信用时，除了数量，还应查看其项目、方法及证据。",
              )}
            </p>
            <a
              className="ex-learn-source"
              href={CREDIT_SOURCES.verra}
              target="_blank"
              rel="noopener noreferrer"
            >
              {c("Read Verra's explanation", "阅读 Verra 的说明")}
              <ExchangeIcon name="external" size={12} />
            </a>
          </div>
          <div
            className="ex-credit-unit"
            aria-label={c(
              "One carbon credit represents one tonne of carbon dioxide equivalent",
              "一份碳信用代表一吨二氧化碳当量",
            )}
          >
            <div>
              <strong>1</strong>
              <small>{c("carbon credit", "份碳信用")}</small>
            </div>
            <span>=</span>
            <div>
              <strong>1 t</strong>
              <small>CO₂e</small>
            </div>
          </div>
        </div>
        <nav
          className="ex-learning-links"
          aria-label={c("On this page", "本页内容")}
        >
          <a href="#prices">{c("Why prices differ", "为何价格不同")}</a>
          <a href="#lifecycle">{c("Credit lifecycle", "信用生命周期")}</a>
          <a href="#quality">{c("Quality & evidence", "质量与证据")}</a>
          <a href="#glossary">{c("Glossary", "词汇表")}</a>
          <a href="#vcu-accu">VCU / ACCU</a>
          <a href="#simulation">
            {c("Practice in Carbadia", "在 Carbadia 练习")}
          </a>
        </nav>
      </section>
      <section className="ex-panel ex-learning-section" id="prices">
        <h2>
          {c("Why do carbon credit prices differ?", "为什么碳信用的价格不同？")}
        </h2>
        <p>
          {c(
            "One tonne is a common unit, but credits can represent different activities, risks and permitted uses. The factors below help explain what buyers compare; they are not a formula for a fair price.",
            "一吨是共通的单位，但不同信用可能代表不同活动、风险及允许用途。以下因素说明买方会比较哪些条件，并非计算合理价格的公式。",
          )}
        </p>
        <div className="ex-learning-checks">
          {priceFactors.map(([en, zh, text, textZh]) => (
            <div key={en}>
              <ExchangeIcon name="info" size={17} />
              <div>
                <h3>{c(en, zh)}</h3>
                <p>{c(text, textZh)}</p>
              </div>
            </div>
          ))}
        </div>
        <p>
          <strong>
            {c("Price is not a quality score. ", "价格不是质量评分。")}
          </strong>
          {c(
            "A higher price does not prove additionality, permanence or a greater climate benefit. Compare the project evidence, intended use and transaction terms alongside the price.",
            "较高价格不能证明额外性、永久性或更大的气候效益。比较价格时，应一并查看项目证据、预定用途及交易条件。",
          )}
        </p>
        <div className="ex-learning-links">
          <a
            href={CREDIT_SOURCES.verra}
            target="_blank"
            rel="noopener noreferrer"
          >
            {c(
              "Verra: units & additional certifications",
              "Verra：单位与附加认证",
            )}{" "}
            ↗
          </a>
          <a
            href={CREDIT_SOURCES.integrity}
            target="_blank"
            rel="noopener noreferrer"
          >
            {c("ICVCM: quality principles", "ICVCM：质量原则")} ↗
          </a>
          <a
            href={`${CREDIT_SOURCES.accu}/australian-carbon-credit-units`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {c("CER: ACCU supply, demand & uses", "CER：ACCU 供需及用途")} ↗
          </a>
          <a href="#quality">{c("Check the evidence", "查核证据")}</a>
        </div>
      </section>
      <section className="ex-panel ex-learning-section" id="lifecycle">
        <h2>{c("From project to retirement", "从项目到信用注销")}</h2>
        <p>
          {c(
            "A simplified lifecycle. Each program has its own detailed requirements and review steps.",
            "以下为简化流程，各标准计划另有详细要求与审查步骤。",
          )}
        </p>
        <div className="ex-lifecycle">
          {stages.map(([en, zh, text, textZh], index) => (
            <div className="ex-lifecycle-item" key={en}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{c(en, zh)}</h3>
              <p>{c(text, textZh)}</p>
            </div>
          ))}
        </div>
        <a
          className="ex-learn-source"
          href="https://verra.org/programs/verified-carbon-standard/vcs-program-details/"
          target="_blank"
          rel="noopener noreferrer"
        >
          {c("See the VCS program requirements", "查看 VCS 计划要求")}
          <ExchangeIcon name="external" size={12} />
        </a>
      </section>
      <section className="ex-panel ex-learning-section" id="quality">
        <h2>
          {c(
            "Ask for evidence before a quality label",
            "在接受质量标签前，先查核证据",
          )}
        </h2>
        <p>
          {c(
            "Use these questions to investigate a real project. Carbadia's demo classifications are catalogue descriptions; they do not establish verification, a quality rating or an environmental claim.",
            "可运用以下问题调查真实项目。Carbadia 的示范分类只是目录描述，并不代表查证、质量评级或环境声明。",
          )}
        </p>
        <div className="ex-learning-checks">
          {quality.map(([en, zh, text, textZh]) => (
            <div key={en}>
              <ExchangeIcon name="check" size={17} />
              <div>
                <h3>{c(en, zh)}</h3>
                <p>{c(text, textZh)}</p>
              </div>
            </div>
          ))}
        </div>
        <a
          className="ex-learn-source"
          href={CREDIT_SOURCES.integrity}
          target="_blank"
          rel="noopener noreferrer"
        >
          {c("Explore ICVCM's Core Carbon Principles", "探索 ICVCM 核心碳原则")}
          <ExchangeIcon name="external" size={12} />
        </a>
      </section>
      <section className="ex-learning-section" id="glossary">
        <div className="ex-learn-glossary-heading">
          <div>
            <h2>{c("The words behind the market", "理解市场用语")}</h2>
            <p>
              {c(
                "Search a term or expand a definition when you need it.",
                "搜索词汇，或展开您需要的说明。",
              )}
            </p>
          </div>
          <button
            className="ex-button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? c("Collapse definitions", "收起说明")
              : c("Expand definitions", "展开说明")}
          </button>
        </div>
        <div className="ex-market-toolbar ex-discovery-toolbar">
          <label className="ex-search-field">
            <ExchangeIcon name="search" size={15} />
            <input
              aria-label={c("Search the carbon glossary", "搜索碳信用词汇")}
              placeholder={c("Search terms and definitions", "搜索词汇及定义")}
              value={search}
              onChange={(e) => {
                const nextSearch = e.target.value;
                setSearch(nextSearch);
                if (nextSearch.trim().toLowerCase() !== q) {
                  setExpanded(!!nextSearch.trim());
                }
              }}
            />
          </label>
          <select
            className="ex-select"
            value={category}
            aria-label={c("Glossary topic", "词汇主题")}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">{c("All topics", "所有主题")}</option>
            <option value="basics">{c("The basics", "基本概念")}</option>
            <option value="quality">
              {c("Quality & integrity", "质量与诚信")}
            </option>
            <option value="use">{c("Issuance & use", "签发与用途")}</option>
          </select>
          <span className="ex-muted" aria-live="polite">
            {terms.length} {c("terms", "个词汇")}
          </span>
          {(search || category) && (
            <button
              className="ex-button ghost"
              onClick={() => {
                setSearch("");
                setCategory("");
                setExpanded(false);
              }}
            >
              {c("Clear", "清除")}
            </button>
          )}
        </div>
        {terms.length ? (
          <div className="ex-glossary">
            {terms.map((term) => (
              <details key={term.id} id={term.id} open={expanded}>
                <summary>{c(term.en, term.zh)}</summary>
                <p>{c(term.definition, term.definitionZh)}</p>
                <a href={term.source} target="_blank" rel="noopener noreferrer">
                  {c("Source", "来源")}: {term.sourceName} ↗
                </a>
              </details>
            ))}
          </div>
        ) : (
          <div className="ex-panel ex-empty">
            <ExchangeIcon name="search" size={28} />
            <h2>{c("No matching terms", "没有符合的词汇")}</h2>
            <p>
              {c(
                "Try a shorter word or select all topics.",
                "请尝试较短的关键字，或选择所有主题。",
              )}
            </p>
            <button
              className="ex-button"
              onClick={() => {
                setSearch("");
                setCategory("");
                setExpanded(false);
              }}
            >
              {c("Show all terms", "显示所有词汇")}
            </button>
          </div>
        )}
      </section>
      <section className="ex-panel ex-learning-section" id="vcu-accu">
        <h2>
          {c(
            "VCUs and ACCUs: understand the scheme",
            "VCU 与 ACCU：了解所属计划",
          )}
        </h2>
        <p>
          {c(
            "The tonne is a shared unit of measurement. Eligibility, methods, registry arrangements and permitted uses come from the particular scheme.",
            "吨是共通的计量单位；资格、方法、注册安排及允许用途，则取决于各计划。",
          )}
        </p>
        <div className="ex-table-wrap" style={{ marginTop: 20 }}>
          <table className="ex-table ex-learning-compare">
            <thead>
              <tr>
                <th>{c("Attribute", "属性")}</th>
                <th>VCU</th>
                <th>ACCU</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{c("Full name", "完整名称")}</td>
                <td>Verified Carbon Unit</td>
                <td>Australian Carbon Credit Unit</td>
              </tr>
              <tr>
                <td>{c("Program", "计划")}</td>
                <td>
                  {c("Verra's Verified Carbon Standard", "Verra 核证碳标准")}
                </td>
                <td>{c("Australia's ACCU Scheme", "澳洲 ACCU 计划")}</td>
              </tr>
              <tr>
                <td>{c("Administration", "管理机构")}</td>
                <td>Verra</td>
                <td>
                  {c(
                    "Clean Energy Regulator, Australia",
                    "澳洲清洁能源监管机构",
                  )}
                </td>
              </tr>
              <tr>
                <td>{c("Unit", "单位")}</td>
                <td>
                  {c("1 tonne CO₂e reduced or removed", "1 吨 CO₂e 减排或移除")}
                </td>
                <td>
                  {c(
                    "1 tonne CO₂e stored or avoided",
                    "1 吨 CO₂e 存储或避免排放",
                  )}
                </td>
              </tr>
              <tr>
                <td>{c("Primary source", "第一手来源")}</td>
                <td>
                  <a
                    className="ex-learn-source"
                    href={CREDIT_SOURCES.verra}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {c("Read about VCUs", "阅读 VCU 说明")}
                    <ExchangeIcon name="external" size={12} />
                  </a>
                </td>
                <td>
                  <a
                    className="ex-learn-source"
                    href={CREDIT_SOURCES.accu}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {c("Read about ACCUs", "阅读 ACCU 说明")}
                    <ExchangeIcon name="external" size={12} />
                  </a>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          {c(
            "A familiar acronym is not a substitute for project due diligence. Carbadia does not register, issue, custody or retire real units under either program.",
            "熟悉的缩写不能取代项目尽职调查。Carbadia 不在上述计划中注册、签发、托管或注销真实单位。",
          )}
        </p>
      </section>
      <div className="ex-two-column">
        <section
          className="ex-panel ex-learning-section ex-learning-simulation"
          id="simulation"
        >
          <h2>
            {c("Learn by doing in the simulation", "在模拟环境中动手学习")}
          </h2>
          <p>
            {c(
              "Carbadia uses demonstration credits and demo USD balances. Orders match within the simulator, with market-making activity providing liquidity. Prices are formed inside the simulation and are not live registry or exchange quotations.",
              "Carbadia 使用示范信用及模拟美元余额。订单在模拟市场内撮合，做市活动提供流动性。价格在模拟环境内形成，不是真实注册处或交易所报价。",
            )}
          </p>
          <p>
            {c(
              "A simulated retirement removes credits from your available holdings and creates a simulation receipt. It cannot support a real offset claim, compliance surrender or registry retirement. Retired demo credits cannot be traded again.",
              "模拟注销会从您的可用持仓中扣除信用，并产生模拟收据。这不能用于真实抵换声明、合规缴回或注册处注销。已注销的示范信用不能再次交易。",
            )}
          </p>
          <div className="ex-learning-links">
            <Link href="/login?returnTo=%2Fportfolio">
              {c("Start a demo session", "开始示范体验")}
            </Link>
            <Link href="/projects?view=registry">
              {c("Explore real registry records", "探索真实注册记录")}
            </Link>
          </div>
        </section>
        <section className="ex-panel" style={{ marginTop: 0 }}>
          <h2>{c("Try a complete journey", "体验完整流程")}</h2>
          <div className="ex-learning-practice">
            {[
              [
                "/projects",
                "Explore a project",
                "探索项目",
                "Read its category, vintage and evidence gaps.",
                "阅读分类、减排年份与缺少的证据。",
              ],
              [
                "/",
                "Compare and place an order",
                "比较并建立订单",
                "Choose a credit, enter an amount and review the demo cost.",
                "选择信用、输入数量并核对模拟成本。",
              ],
              [
                "/portfolio",
                "Review your portfolio",
                "查看资产组合",
                "Understand holdings, available credits and purchase cost.",
                "了解持仓、可用信用及购买成本。",
              ],
              [
                "/retirement",
                "Practice a retirement",
                "练习注销",
                "Choose a beneficiary and purpose, then review the receipt.",
                "选择受益人与用途，并查看收据。",
              ],
            ].map(([href, en, zh, text, textZh], index) => (
              <Link key={href} href={href}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{c(en, zh)}</strong>
                  <small>{c(text, textZh)}</small>
                </div>
                <ExchangeIcon name="arrow" size={15} />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
