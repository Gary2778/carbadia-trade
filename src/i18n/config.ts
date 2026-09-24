// 语言注册表:Carbadia Trade 只有英文(默认)与简体中文两种界面语言。
// 主站 carbadia.io 冻结的 14 种语言不搬到这里。
export const LANGS = ["en", "zh-CN"] as const;

export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = "en";

// 与主站保持同一套判定函数名,便于搬过来的组件不改代码
export const ACTIVE_LANGS = LANGS;
export type ActiveLang = Lang;
export const isActiveLang = (l: Lang): l is ActiveLang => (ACTIVE_LANGS as readonly Lang[]).includes(l);

// label 用本语言原名(endonym)
export const LANG_META: Record<Lang, { label: string; htmlLang: string; dir: "ltr" | "rtl" }> = {
  en: { label: "English", htmlLang: "en", dir: "ltr" },
  "zh-CN": { label: "简体中文", htmlLang: "zh-CN", dir: "ltr" },
};

export const isLang = (v: unknown): v is Lang => LANGS.includes(v as Lang);

// CJK 标题字形高、行距要收紧
export const isCJK = (lang: Lang) => lang === "zh-CN";

// 交易应用页的内嵌中英文案取词:简中读者读中文
export const isChinese = (lang: Lang) => lang === "zh-CN";

// 按地区整块维护的文案(页脚附注等)
export type ContentLocale = "en" | "zh-CN";
export const contentLocale = (lang: Lang): ContentLocale => (lang === "zh-CN" ? "zh-CN" : "en");
