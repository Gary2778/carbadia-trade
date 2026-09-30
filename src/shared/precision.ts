// 按标的精度格式化(计划 §4.4):价格按 pricePrecision(钳到 0..2,§9.1 第 6 条),数量按 qtyStep 的小数位(Phase 1 整数吨即 0 位)。
// Intl.NumberFormat 按 locale + 小数位缓存;非法 locale 回退 en-US;非有限数显示「—」(与 src/lib/format.ts 的空值一致)。

const formatters = new Map<string, Intl.NumberFormat>();

function formatterFor(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    const options: Intl.NumberFormatOptions = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    try {
      fmt = new Intl.NumberFormat(locale, options);
    } catch {
      fmt = new Intl.NumberFormat("en-US", options);
    }
    formatters.set(key, fmt);
  }
  return fmt;
}

/** 价格显示小数位:pricePrecision 钳到 0..2(>2 需亚分存储,Phase 1 不做) */
export function clampPricePrecision(precision: number): number {
  if (!Number.isFinite(precision)) return 2;
  return Math.min(2, Math.max(0, Math.trunc(precision)));
}

/** 整数分 → 按精度与 locale 的元字符串(带千分位);非有限输入显示「—」 */
export function formatPrice(cents: number, precision: number, locale: string): string {
  if (!Number.isFinite(cents)) return "—";
  return formatterFor(locale, clampPricePrecision(precision)).format(cents / 100);
}

/** step 的小数位:整数步长 0 位,小数步长按其位数(≤ 4) */
export function qtyDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0 || Number.isInteger(step)) return 0;
  for (let d = 1; d <= 4; d++) {
    if (Number.isInteger(Number((step * 10 ** d).toFixed(6)))) return d;
  }
  return 4;
}

/** 数量(吨)→ 按 qtyStep 小数位与 locale 的字符串(带千分位);非有限输入显示「—」 */
export function formatQty(qty: number, step: number, locale: string): string {
  if (!Number.isFinite(qty)) return "—";
  return formatterFor(locale, qtyDecimals(step)).format(qty);
}
