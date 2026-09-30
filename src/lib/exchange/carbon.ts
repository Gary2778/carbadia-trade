import type { VerificationStatus } from "@/shared/types";

/**
 * Public demo-market metadata (= /api/assets 的行). None of these descriptors attest to verification.
 * 无 description(计划 §9.1 第 16 条); projectId / methodology / verificationStatus 未知即 null, UI 显示「未提供」。
 */
export type CarbonAsset = {
  id: string;
  symbol: string;
  name: string;
  standard: string;
  projectType: string;
  vintage: number;
  country: string;
  registry: string;
  isScenario: boolean;
  /** 模拟项目编号 SIM-PRJ-<STANDARD>-<TYPE>; 同项目多 vintage 靠它归组 */
  projectId: string | null;
  methodology: string | null;
  verificationStatus: VerificationStatus | null;
  /** 价格显示小数位 */
  pricePrecision: number;
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  volume24h: number;
  change24h: number | null;
  spark: number[];
  availableSupply: number;
};
export type CreditProfile = {
  category: string;
  categoryZh: string;
  approach: string;
  approachZh: string;
  family: string;
  familyZh: string;
  color: string;
  icon: "forest" | "sun" | "water" | "flame" | "wind" | "layers";
  registryUrl?: string;
  programUrl?: string;
  provenance: string;
  /** 由 Instrument 填充, 这里从不杜撰; null → 未提供 */
  methodology: string | null;
  verification: string | null;
};
export function getCreditProfile(asset: {
  symbol: string;
  projectType: string;
  standard?: string;
  registry?: string;
  methodology?: string | null;
  verificationStatus?: string | null;
}): CreditProfile {
  const s = `${asset.symbol} ${asset.projectType}`.toLowerCase();
  let p: Pick<
    CreditProfile,
    | "category"
    | "categoryZh"
    | "approach"
    | "approachZh"
    | "family"
    | "familyZh"
    | "color"
    | "icon"
  >;
  if (/mang|blue|蓝碳|蓝碳/.test(s))
    p = {
      category: "Blue carbon",
      categoryZh: "蓝碳",
      approach: "Removal",
      approachZh: "移除",
      family: "Nature-based",
      familyZh: "自然型",
      color: "var(--series-2)",
      icon: "water",
    };
  else if (/cook|能效|cookstove/.test(s))
    p = {
      category: "Clean cookstoves",
      categoryZh: "清洁炉灶",
      approach: "Avoidance",
      approachZh: "避免排放",
      family: "Technology-based",
      familyZh: "技术型",
      color: "var(--series-3)",
      icon: "flame",
    };
  else if (/meth|甲烷/.test(s))
    p = {
      category: "Methane capture",
      categoryZh: "甲烷回收",
      approach: "Avoidance",
      approachZh: "避免排放",
      family: "Technology-based",
      familyZh: "技术型",
      color: "var(--series-4)",
      icon: "layers",
    };
  else if (/biochar|生物炭|dac|direct air/.test(s))
    p = {
      category: /dac|direct air/.test(s) ? "Direct air capture" : "Biochar",
      categoryZh: /dac|direct air/.test(s) ? "直接空气捕集" : "生物炭",
      approach: "Removal",
      approachZh: "移除",
      family: "Technology-based",
      familyZh: "技术型",
      color: "var(--series-4)",
      icon: "layers",
    };
  else if (/for|林业|林业|forest|afforestation/.test(s))
    p = {
      category: "Forestry",
      categoryZh: "林业碳汇",
      approach: "Mixed / project-specific",
      approachZh: "混合／依项目而定",
      family: "Nature-based",
      familyZh: "自然型",
      color: "var(--series)",
      icon: "forest",
    };
  else if (/sol|wind|renew|可再生/.test(s))
    p = {
      category: /wind/.test(s) ? "Wind energy" : "Solar energy",
      categoryZh: /wind/.test(s) ? "风力发电" : "太阳能",
      approach: "Avoidance",
      approachZh: "避免排放",
      family: "Technology-based",
      familyZh: "技术型",
      color: /wind/.test(s) ? "var(--series-2)" : "var(--series-3)",
      icon: /wind/.test(s) ? "wind" : "sun",
    };
  else
    p = {
      category: asset.projectType || "Other",
      categoryZh: asset.projectType || "其他",
      approach: "Not specified",
      approachZh: "未提供",
      family: "Not specified",
      familyZh: "未提供",
      color: "var(--series-4)",
      icon: "layers",
    };
  const urls: Record<string, string> = {
    VCS: "https://registry.verra.org/",
    GS: "https://registry.goldstandard.org/",
    CCER: "https://ccer.cets.org.cn/",
    CDM: "https://cdm.unfccc.int/Projects/projsearch.html",
    ACCU: "https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme",
    ACR: "https://acrcarbon.org/",
    CAR: "https://www.climateactionreserve.org/",
  };
  return {
    ...p,
    registryUrl: urls[asset.standard ?? ""],
    programUrl:
      asset.standard === "VCS"
        ? "https://verra.org/programs/verified-carbon-standard/"
        : urls[asset.standard ?? ""],
    provenance: "Demonstration asset; not linked to a registered project.",
    methodology: asset.methodology ?? null,
    verification: asset.verificationStatus ?? null,
  };
}
/** 全部取自 URL 查询串, 所以是字符串; 价格上下限以美元计(与既有 maxPrice 一致), 内部换算成分比较 */
export type CreditFilters = {
  search?: string;
  standard?: string;
  country?: string;
  vintage?: string;
  category?: string;
  approach?: string;
  family?: string;
  registry?: string;
  projectId?: string;
  minSupply?: string;
  /** 旧键, 与 priceMax 同义, 保留给既有 SpotTable 的 URL */
  maxPrice?: string;
  priceMin?: string;
  priceMax?: string;
  sort?: string;
};
// 美元字符串 → 整数分:先乘再四舍五入,否则 "4.35" * 100 = 434.99999999999994 会漏掉恰好等于边界的价格
const dollarsToCents = (raw: string) => Math.round(Number(raw) * 100);
export function filterCredits(
  assets: CarbonAsset[],
  f: CreditFilters,
): CarbonAsset[] {
  const q = (f.search ?? "").trim().toLowerCase();
  const result = assets.filter((a) => {
    if (a.isScenario) return false;
    const p = getCreditProfile(a);
    const hay = [
      a.symbol,
      a.name,
      a.standard,
      a.country,
      a.registry,
      a.vintage,
      p.category,
      p.categoryZh,
      p.approach,
    ]
      .join(" ")
      .toLowerCase();
    return (
      (!q || hay.includes(q)) &&
      (!f.standard || a.standard === f.standard) &&
      (!f.country || a.country === f.country) &&
      (!f.vintage || String(a.vintage) === f.vintage) &&
      (!f.category || p.category === f.category) &&
      (!f.approach || p.approach === f.approach) &&
      (!f.family || p.family === f.family) &&
      (!f.registry || a.registry === f.registry) &&
      (!f.projectId || a.projectId === f.projectId) &&
      (!f.minSupply || a.availableSupply >= Number(f.minSupply)) &&
      (!f.maxPrice ||
        (a.lastPrice !== null && a.lastPrice <= dollarsToCents(f.maxPrice))) &&
      (!f.priceMax ||
        (a.lastPrice !== null && a.lastPrice <= dollarsToCents(f.priceMax))) &&
      (!f.priceMin ||
        (a.lastPrice !== null && a.lastPrice >= dollarsToCents(f.priceMin)))
    );
  });
  return result.sort((a, b) => {
    const key = f.sort?.startsWith("price")
      ? "lastPrice"
      : f.sort === "change"
        ? "change24h"
        : f.sort === "supply"
          ? "availableSupply"
          : "volume24h";
    const av = a[key],
      bv = b[key];
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return f.sort === "price-asc" ? av - bv : bv - av;
  });
}
export const CREDIT_SOURCES = {
  verra:
    "https://verra.org/programs/verified-carbon-standard/verified-carbon-units-vcus/",
  integrity: "https://icvcm.org/core-carbon-principles/",
  accu: "https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme",
  goldStandard: "https://www.goldstandard.org/",
};
