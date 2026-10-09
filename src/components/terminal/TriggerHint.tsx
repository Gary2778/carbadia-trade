"use client";

import { memo } from "react";
import type { TriggerDirection } from "@/shared";
import { useLang, useT } from "@/i18n/LangProvider";
import { fmtPrice } from "@/lib/format";
import { lastPriceOf } from "@/lib/market/last-price";
import { useMarketStore } from "@/lib/market/store";
import { triggerDirection } from "@/shared/order-math";
import { priceOf } from "./trigger-ticket";

const DIRECTIONS: readonly TriggerDirection[] = ["ABOVE", "BELOW"];

export type TriggerHintProps = {
  /** 本行的 id:触发价输入框经 aria-describedby 指向它 */
  id: string;
  symbol: string;
  precision: number;
  /** 触发价输入框文本 */
  text: string;
  /** 最新成交价未知时用户选的方向(已知时不用) */
  pick: TriggerDirection | null;
  onPick: (direction: TriggerDirection) => void;
  /**
   * 只占一行(下单面板的条件单票据):句子放不下时截断,完整的句子在 title 里、读屏照念全文 —— 这一行是给触发价格子预留的高度,
   * 三种票据才能一样高。对话框里不传,句子照常折行。从未成交时的方向选择是例外,见组件说明。
   */
  oneLine?: boolean;
};

/**
 * 触发价下面那一行,把方向说成话:「有成交价达到或高于 X 时触发」/「达到或低于 X 时触发」(方向由触发价与最新成交价现推,
 * 与 validateTriggerDraft 同一规则)。触发价没填好或等于最新价时显示最新成交价作参考;最新成交价未知(从未成交)而触发价填了,
 * 给两个按钮让用户自己选涨到还是跌到(这时可能折成两行:种子数据里的标的都成交过,只有从未成交的新标的会走到这里)。
 * 下单面板的条件单票据与价格提醒对话框共用。自己订阅最新成交价(一个数):成交带动的重渲染只到这一行,下单面板其余部分不动(计划 §7.1)。
 */
export const TriggerHint = memo(function TriggerHint({ id, symbol, precision, text, pick, onPick, oneLine = false }: TriggerHintProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const last = useMarketStore((s) => lastPriceOf(s, symbol));
  const price = priceOf(text);
  const fmt = (cents: number | null) => fmtPrice(cents, { pricePrecision: precision }, lang);

  if (price !== null && !(last !== null && last > 0)) {
    return (
      <div id={id} role="group" aria-label={t.triggers.pickLabel} className="flex flex-wrap items-center gap-x-gap text-t-xs text-muted">
        <span aria-hidden="true">{t.triggers.pickLabel}</span>
        {DIRECTIONS.map((direction) => (
          <button
            key={direction}
            type="button"
            aria-pressed={pick === direction}
            onClick={() => onPick(direction)}
            className={`rounded-chip px-1 font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
              pick === direction ? "bg-(--terminal-selected) text-foreground" : "underline hover:text-foreground"
            }`}
          >
            {direction === "ABOVE" ? t.triggers.pickAbove : t.triggers.pickBelow}
          </button>
        ))}
      </div>
    );
  }
  const direction = price === null ? null : triggerDirection(price, last);
  const sentence = direction === "ABOVE" ? t.triggers.whenAbove(fmt(price)) : direction === "BELOW" ? t.triggers.whenBelow(fmt(price)) : `${t.triggers.lastTrade} ${fmt(last)}`;
  return (
    <p id={id} data-trigger-hint={direction ?? ""} title={oneLine ? sentence : undefined} className={`text-t-xs text-muted${oneLine ? " truncate" : ""}`}>
      {sentence}
    </p>
  );
});
