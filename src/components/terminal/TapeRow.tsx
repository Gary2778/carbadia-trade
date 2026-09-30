"use client";

import { memo } from "react";
import type { AuditRef, Side } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { formatPrice, formatQty } from "@/shared/precision";

export type TapeRowProps = {
  /** 成交价(分) */
  price: number;
  /** 成交量(吨) */
  quantity: number;
  /** 主动方(吃单方)方向,决定价格颜色 */
  takerSide: Side;
  /** 成交时间 unix ms */
  ts: number;
  /** 模拟成交引用 SIM-TRD-<tradeId>;prop 不叫 ref(那是 React 的保留名,也会被 tokens-only 门禁拦下) */
  auditRef: AuditRef;
  precision: number;
  /** 数量步长(Instrument.qtyStep,吨;决定数量的小数位),默认 1 */
  qtyStep?: number;
};

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
/** HH:MM:SS,24 小时制,浏览器时区(Phase 1 不做时区偏好,§9.1 第 32 条);Intl 实例按 locale 缓存 */
export function formatTapeTime(ts: number, locale: string): string {
  let fmt = timeFormatters.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    timeFormatters.set(locale, fmt);
  }
  return fmt.format(ts);
}

/**
 * 成交 tape 的一行(计划 §3.1):React.memo + 原始类型 props,新成交进来时已有的行零提交。
 * 价格按主动方着色(买 = 涨色、卖 = 跌色,随涨跌轴翻转),读屏另念方向文字(颜色不是唯一信息);
 * 审计引用与 terminal.tape.auditNote「模拟成交引用,不是登记机构记录」—— 不是登记机构的序列号,也不暗示是(计划 §9.2 D5),
 * 引用出现的地方都带这句说明:指针悬停看 tooltip(title);读屏从行尾的 sr-only 文字读到(不可聚焦元素上的 title 读屏不念)。
 * 触屏与只用键盘的明眼用户在这里看不到逐笔引用:自己成交的引用在底部「成交」页签与成交详情里可见、可聚焦(FillsTab /
 * FillDetailDialog,§4.8 列的另两处展示);公共 tape 行不进 Tab 序列(最多 200 行)。
 * 数量按 qtyStep 的小数位显示(§4.4;Phase 1 种子恒 1,即整数吨)。
 */
export const TapeRow = memo(function TapeRow({ price, quantity, takerSide, ts, auditRef, precision, qtyStep = 1 }: TapeRowProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = lang === "zh-CN" ? "zh-CN" : "en-US";
  const buy = takerSide === "BUY";
  const audit = `${t.tape.auditRef} ${auditRef}`;
  return (
    <div
      data-tape-row=""
      title={`${audit}\n${t.tape.auditNote}`}
      className="t-tape-grid h-row px-gap text-t-sm leading-t-tight hover:bg-(--terminal-row-hover)"
    >
      <span className="tnum truncate text-t-2xs text-muted">{formatTapeTime(ts, locale)}</span>
      <span className={`tnum truncate text-end ${buy ? "text-(--terminal-up)" : "text-(--terminal-down)"}`}>
        {formatPrice(price, precision, locale)}
        <span className="sr-only"> {buy ? t.tape.buy : t.tape.sell}</span>
      </span>
      <span className="tnum truncate text-end text-foreground">{formatQty(quantity, qtyStep, locale)}</span>
      <span className="sr-only">{`${audit} · ${t.tape.auditNote}`}</span>
    </div>
  );
});
