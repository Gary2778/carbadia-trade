// 市场总览页的数字格式(纯函数,node 环境可测):指数点位(两位小数)与吨数;空值一律「—」,不把缺的数当 0。
// 价格走 src/lib/format.ts 的 fmtPrice(按标的精度),涨跌走 src/components/terminal/change-format.ts 的 formatChangePct(InstrumentRow 再导出的就是它)—— 与终端同一套。
import { formatQty } from "@/shared/precision";

const levelFormats = new Map<string, Intl.NumberFormat>();

/** 指数点位 → 两位小数、按界面语言的千分位(zh-CN → zh-CN,其余 → en-US);null / 非有限数 → 「—」 */
export function formatLevel(level: number | null | undefined, lang: string): string {
  if (level == null || !Number.isFinite(level)) return "—";
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  let fmt = levelFormats.get(locale);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    levelFormats.set(locale, fmt);
  }
  return fmt.format(level);
}

/** 24h 成交吨数 → 整数、千分位(数量步长 1 吨) */
export function formatTonnes(tonnes: number, lang: string): string {
  return formatQty(tonnes, 1, lang === "zh-CN" ? "zh-CN" : "en-US");
}
