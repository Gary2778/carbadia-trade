// 资产页 /trade/account 的数字格式(纯函数,node 环境可测)。与终端同一套精度规则(src/shared/precision.ts:金额两位小数、
// 价格按标的精度、数量整数吨,按界面语言的千分位);资产页是文档式页面,金额前面带 $(终端的表格列不带)。
// 正负号:正数带「+」,负数用 Intl 的「-」,0 不带号(与终端 TabTable 的 fmtSignedCents 一致)。空值一律「—」,不把缺的数当 0。
import { formatPrice, formatQty } from "@/shared/precision";

/** 界面语言 → 数字 / 日期的 Intl locale(与终端 numberLocale、fmtPrice 同一规则) */
export const localeOf = (lang: string): string => (lang === "zh-CN" ? "zh-CN" : "en-US");

const DASH = "—";

/** 碳信用类别 / 类型名:getCreditProfile 给的英文名 → 当前语言(account.credit.*);表里没有的(项目类型的原值)原样返回 */
export function creditName(names: Readonly<Record<string, string>>, english: string): string {
  return Object.hasOwn(names, english) ? names[english] : english;
}

/** 整数分 → $1,234.56(precision 是标的的价格精度,金额合计用默认 2);null → — */
export function usd(cents: number | null | undefined, locale: string, precision = 2): string {
  if (cents == null || !Number.isFinite(cents)) return DASH;
  return cents < 0 ? `-$${formatPrice(-cents, precision, locale)}` : `$${formatPrice(cents, precision, locale)}`;
}

/** 带正负号的金额(盈亏、24 小时变化):+$12.34 / -$12.34 / $0.00;null → — */
export function signedUsd(cents: number | null | undefined, locale: string): string {
  if (cents == null || !Number.isFinite(cents)) return DASH;
  return cents > 0 ? `+${usd(cents, locale)}` : usd(cents, locale);
}

const percentFormats = new Map<string, Intl.NumberFormat>();
function percentFormat(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let fmt = percentFormats.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits });
    percentFormats.set(key, fmt);
  }
  return fmt;
}

/**
 * 小数比例 → 带正负号的百分数(EquityChange.pct 是小数:0.0123 = +1.23%,与 Ticker.change24h 的百分数不同);null → —
 */
export function signedPct(ratio: number | null | undefined, locale: string): string {
  if (ratio == null || !Number.isFinite(ratio)) return DASH;
  const text = percentFormat(locale, 2).format(ratio);
  return ratio > 0 ? `+${text}` : text;
}

/** 0..1 的占比 → 一位小数的百分数(分布图例);不带正负号 */
export function share(ratio: number, locale: string): string {
  return Number.isFinite(ratio) ? percentFormat(locale, 1).format(ratio) : DASH;
}

/** 数量(整数吨)→ 带千分位;null → — */
export function tonnes(qty: number | null | undefined, locale: string): string {
  return qty == null ? DASH : formatQty(qty, 1, locale);
}

/**
 * 盈亏 / 24 小时变化的着色:终端量过对比度的方向文字 token(随涨跌轴翻转,§4.1.3);0 与空值 muted。
 * 与终端 TabTable 的 pnlTone 同一规则(资产页不引 TabTable:它带着虚拟列表)。
 */
export const gainTone = (value: number | null | undefined): string =>
  value == null || value === 0 ? "text-muted" : value > 0 ? "text-(--terminal-up)" : "text-(--terminal-down)";
