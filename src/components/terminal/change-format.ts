// 24h 涨跌的显示与着色(纯函数,零运行时依赖):从 InstrumentRow.tsx 挪出来的(P3-05),InstrumentRow 原样再导出,既有调用方不用改。
// 单独成模块是为了市场总览页 /trade/markets 用同一套格式而不必引入 InstrumentRow(它连带 selectors.ts、盘口视图与下单草稿,总览页的自有 chunk 多约 7 KB)。

/** 24 h 涨跌(百分数,1.23 = +1.23%)→ 显示串;null → 「—」 */
export function formatChangePct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** 涨跌着色:终端的方向文字 token(随涨跌轴翻转;浅色是比站点 --up / --down 深一级的同色相,§4.1.3);0 与空值用 muted */
export function changeTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "text-muted";
  return value > 0 ? "text-(--terminal-up)" : "text-(--terminal-down)";
}
