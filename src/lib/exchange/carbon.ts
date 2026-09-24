/** Public demo-market metadata. None of these descriptors attest to verification. */
export type CarbonAsset = {
  id: string;
  symbol: string;
  name: string;
  standard: string;
  projectType: string;
  vintage: number;
  country: string;
  registry: string;
  description: string;
  isScenario: boolean;
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
  methodology: null;
  verification: null;
};
export function getCreditProfile(asset: {
  symbol: string;
  projectType: string;
  standard?: string;
  registry?: string;
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
      color: "#397d96",
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
      color: "#b17b4d",
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
      color: "#89709b",
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
      color: "#636e9d",
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
      color: "#488276",
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
      color: /wind/.test(s) ? "#6685ac" : "#b98b37",
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
      color: "#71828b",
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
    methodology: null,
    verification: null,
  };
}
export type CreditFilters = {
  search?: string;
  standard?: string;
  country?: string;
  vintage?: string;
  category?: string;
  approach?: string;
  family?: string;
  minSupply?: string;
  maxPrice?: string;
  sort?: string;
};
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
      (!f.minSupply || a.availableSupply >= Number(f.minSupply)) &&
      (!f.maxPrice ||
        (a.lastPrice !== null && a.lastPrice <= Number(f.maxPrice) * 100))
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
