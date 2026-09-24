// 数据层 i18n:数据库中的标的/用户数据是中文种子,UI 文案(useT)无法覆盖。
// 中文原值在这里先映射到内部 key,再从 16 语中央目录(src/i18n/messages)取当前语言;
// 未命中时回退原值。标的集合是固定种子数据,故用前端映射即可,无需为多语字段做数据库迁移。

import { MESSAGES, type Messages } from "@/i18n";
import type { Lang } from "@/i18n/config";

type ProjectTypeKey = keyof Messages["data"]["projectTypes"];
type CountryKey = keyof Messages["data"]["countries"];
type RegistryKey = keyof Messages["data"]["registries"];
type RoleKey = keyof Messages["data"]["roles"];

const PROJECT_TYPE_KEY: Record<string, ProjectTypeKey> = {
  "林业碳汇": "forestry",
  "可再生能源": "renewable",
  "蓝碳": "blueCarbon",
  "能效": "efficiency",
  "甲烷回收": "methane",
  "配额情景": "allowanceScenario",
};

const COUNTRY_KEY: Record<string, CountryKey> = {
  "中国": "china",
  "印度": "india",
  "印度尼西亚": "indonesia",
  "肯尼亚": "kenya",
  "巴西": "brazil",
};

const REGISTRY_KEY: Record<string, RegistryKey> = {
  "国家温室气体自愿减排登记簿": "ccer",
  // 情景标的的 registry 原值(shadow.ts SCENARIO_ASSETS, ASCII 括号)
  "情景标的(无真实登记)": "scenario",
};

// 用户名:种子里带中文角色后缀(如 "Alice(碳资产开发商)"),拆成 名字 + 角色 key
const USER_KEY: Record<string, { name: string; role: RoleKey }> = {
  "Alice（碳资产开发商）": { name: "Alice", role: "carbonDeveloper" },
  "Bob（减排企业）": { name: "Bob", role: "abatementFirm" },
  "Carol（碳基金）": { name: "Carol", role: "carbonFund" },
  "Dave（履约企业）": { name: "Dave", role: "complianceBuyer" },
};

const data = (lang: Lang) => MESSAGES[lang].data;

export const tName = (symbol: string, raw: string, lang: Lang): string =>
  data(lang).assetNames[symbol] ?? raw;

export const tProjectType = (raw: string, lang: Lang): string => {
  const k = PROJECT_TYPE_KEY[raw];
  return k ? data(lang).projectTypes[k] : raw;
};

export const tCountry = (raw: string, lang: Lang): string => {
  const k = COUNTRY_KEY[raw];
  return k ? data(lang).countries[k] : raw;
};

export const tRegistry = (raw: string, lang: Lang): string => {
  const k = REGISTRY_KEY[raw];
  return k ? data(lang).registries[k] : raw;
};

export const tUserName = (raw: string, lang: Lang): string => {
  const u = USER_KEY[raw];
  if (u) return `${u.name} (${data(lang).roles[u.role]})`;
  if (raw.startsWith("做市商 ")) return `${data(lang).roles.marketMaker} ${raw.slice("做市商 ".length)}`;
  return raw;
};
