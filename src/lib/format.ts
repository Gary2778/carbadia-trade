import type { Instrument } from "@/shared";
import { formatPrice } from "@/shared/precision";

/** 金额格式化: 入参为整数分(或分的插值中间值), 显示为两位小数的元 */
export const fmtMoney = (cents: number | null | undefined) =>
  cents == null
    ? "—"
    : (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtQty = (n: number | null | undefined) =>
  n == null ? "—" : n.toLocaleString("en-US");

/** 吨数格式化: 千分位整数。注册处签发/注销量是吨不是钱, 不走 fmtMoney 的分→元换算 */
export const fmtTonnes = (n: number | null | undefined) =>
  n == null ? "—" : Math.round(n).toLocaleString("en-US");

export const fmtTime = (iso: string | Date, locale = "en") => {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleString(locale, { hour12: false });
};

/**
 * 按标的精度显示价格(计划 §4.4、§4.8):整数分 → 元字符串,小数位取 instrument.pricePrecision(钳到 0..2),
 * 分隔符按界面语言(zh-CN → zh-CN,其余 → en-US)。空值显示「—」,与 fmtMoney 一致。
 * 终端组件的价格列一律走这里,不再用固定两位的 fmtMoney。
 */
export const fmtPrice = (
  cents: number | null | undefined,
  instrument: Pick<Instrument, "pricePrecision">,
  lang: string,
) => (cents == null ? "—" : formatPrice(cents, instrument.pricePrecision, lang === "zh-CN" ? "zh-CN" : "en-US"));
