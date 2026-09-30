"use client";

import { memo } from "react";
import type { FeeSchedule } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { estimateOrderFee } from "@/lib/market/order-draft";
import { formatPrice } from "@/shared/precision";

export type FeeLineProps = {
  /** 预估名义额(分) */
  notionalCents: number;
  /** 费率;演示标记(fees.demo)决定 0 费用时是否显示「0.00 · 演示」 */
  fees: FeeSchedule;
  /**
   * 已算好的手续费(分):确认框传 review.estFee(toReview 按它自己的费率算的),手续费只有一个来源;
   * 缺省时按 notionalCents 与 fees 现算(面板里的草稿预估)。
   */
  feeCents?: number;
};

/**
 * 手续费行(计划 §3.1、§9.1 第 1 条、§9.2 D8):estimateFee 的结果;演示费率为 0 时显示 terminal.order.feeDemo(「0.00 · 演示」)。
 * 渲染成一对 <dt>/<dd>(外包 div),放进调用方的 <dl> 摘要里。
 */
export const FeeLine = memo(function FeeLine({ notionalCents, fees, feeCents }: FeeLineProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const fee = feeCents ?? estimateOrderFee(notionalCents, fees);
  const value = fee === 0 && fees.demo ? t.order.feeDemo : formatPrice(fee, 2, lang === "zh-CN" ? "zh-CN" : "en-US");
  return (
    <div data-fee-line="" className="flex items-baseline justify-between gap-gap">
      <dt className="text-muted">{t.order.fee}</dt>
      <dd className="tnum text-foreground">{value}</dd>
    </div>
  );
});
