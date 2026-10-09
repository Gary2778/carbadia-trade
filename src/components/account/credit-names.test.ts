import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import { getCreditProfile } from "@/lib/exchange/carbon";
import type { PositionMeta } from "@/lib/market/position-groups";
import { allocationLabel } from "./Allocation";
import { creditName } from "./format";

// 资产页持仓行与分布的碳信用类别 / 类型名(P3-10):原来在组件里按语言在 getCreditProfile 的 category / categoryZh、approach / approachZh 之间挑,
// 现在读 account.credit.*(键是 getCreditProfile 给的英文名)。下面证明两种语言下显示的字和原来逐字相同。
// 每个分支都有一个样本(getCreditProfile 按 symbol + projectType 的正则分支);最后两个是「其他」:项目类型原值照原样、空串回「Other / 其他」。
const SAMPLES = [
  { symbol: "GS-MANG-2022", projectType: "蓝碳", category: "Blue carbon" },
  { symbol: "GS-COOK-2020", projectType: "能效", category: "Clean cookstoves" },
  { symbol: "CDM-METH-2019", projectType: "甲烷回收", category: "Methane capture" },
  { symbol: "VCS-BIOCHAR-2023", projectType: "Biochar", category: "Biochar" },
  { symbol: "DAC-2025", projectType: "direct air capture", category: "Direct air capture" },
  { symbol: "VCS-FOR-2021", projectType: "林业碳汇", category: "Forestry" },
  { symbol: "GS-WIND-2022", projectType: "可再生能源", category: "Wind energy" },
  { symbol: "CCER-SOL-2022", projectType: "可再生能源", category: "Solar energy" },
  { symbol: "XYZ-1", projectType: "Unlisted type", category: "Unlisted type" },
  { symbol: "XYZ-2", projectType: "", category: "Other" },
];

describe("creditName / account.credit(两种语言与 getCreditProfile 的双语字段逐字相同)", () => {
  it.each(SAMPLES)("$symbol · $projectType:类别与类型名,en 取英文字段、zh-CN 取中文字段", (sample) => {
    const p = getCreditProfile(sample);
    expect(p.category).toBe(sample.category); // 样本确实落在它要覆盖的分支上
    expect(creditName(en.account.credit.categories, p.category)).toBe(p.category);
    expect(creditName(en.account.credit.approaches, p.approach)).toBe(p.approach);
    expect(creditName(zhCN.account.credit.categories, p.category)).toBe(p.categoryZh);
    expect(creditName(zhCN.account.credit.approaches, p.approach)).toBe(p.approachZh);
  });

  it("表里没有的名字(项目类型原值)原样返回,不当成键去取;原型链上的名字也不当成键", () => {
    expect(creditName(zhCN.account.credit.categories, "Unlisted type")).toBe("Unlisted type");
    expect(creditName(zhCN.account.credit.categories, "constructor")).toBe("constructor");
    expect(creditName(zhCN.account.credit.approaches, "toString")).toBe("toString");
  });

  it("两种语言的键一致(类型已保证,这里再钉死键清单:新增类别要两边一起加)", () => {
    expect(Object.keys(zhCN.account.credit.categories)).toEqual(Object.keys(en.account.credit.categories));
    expect(Object.keys(zhCN.account.credit.approaches)).toEqual(Object.keys(en.account.credit.approaches));
    expect(Object.keys(en.account.credit.categories)).toEqual(["Blue carbon", "Clean cookstoves", "Methane capture", "Direct air capture", "Biochar", "Forestry", "Wind energy", "Solar energy", "Other"]);
    expect(Object.keys(en.account.credit.approaches)).toEqual(["Removal", "Avoidance", "Mixed / project-specific", "Not specified"]);
  });
});

describe("allocationLabel(分布的分组名)", () => {
  const meta: PositionMeta = { name: "Test", projectId: null, projectType: "林业碳汇", standard: "VCS", country: "巴西", registry: "Verra", vintage: 2021, pricePrecision: 2 };
  const position = { symbol: "VCS-FOR-2021" };

  it("项目类型 / 类别按界面语言取 account.credit;地域仍走 tCountry;没有元数据回 notProvided", () => {
    expect(allocationLabel("type", position, meta, "en", en.account.credit, "n/a")).toBe("Forestry");
    expect(allocationLabel("type", position, meta, "zh-CN", zhCN.account.credit, "n/a")).toBe("林业碳汇");
    expect(allocationLabel("approach", position, meta, "en", en.account.credit, "n/a")).toBe("Mixed / project-specific");
    expect(allocationLabel("approach", position, meta, "zh-CN", zhCN.account.credit, "n/a")).toBe("混合／依项目而定");
    expect(allocationLabel("country", position, meta, "en", en.account.credit, "n/a")).toBe("Brazil");
    expect(allocationLabel("country", position, meta, "zh-CN", zhCN.account.credit, "n/a")).toBe("巴西");
    expect(allocationLabel("type", position, undefined, "zh-CN", zhCN.account.credit, "n/a")).toBe("n/a");
  });
});

describe("终端与资产页的组件里没有内联语言三元", () => {
  const ROOT = fileURLToPath(new URL("../../", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []));
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("isChinese( 与 zh ? 在注释之外只剩 RetireDialog 里传给 displayRetirementReason 的语言标志(共享的格式化函数,它自己按标志挑措辞)", () => {
    const hits = ["components/terminal", "components/account"].flatMap((dir) =>
      files(dir).flatMap((file) =>
        code(readFileSync(join(ROOT, file), "utf8"))
          .split("\n")
          .filter((line) => /isChinese\(|zh \?/.test(line))
          .map((line) => `${file}: ${line.trim()}`),
      ),
    );
    expect(hits.sort()).toEqual([
      "components/account/RetireDialog.tsx: <Row label={t.retire.reason}>{displayRetirementReason(record.reason, isChinese(lang))}</Row>",
      "components/account/RetireDialog.tsx: <Row label={t.retire.reason}>{displayRetirementReason(request.reason, isChinese(lang))}</Row>",
      "components/account/RetireDialog.tsx: {displayRetirementReason(option.value, isChinese(lang))}",
    ]);
  });
});
