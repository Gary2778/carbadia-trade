"use client";

import { useCallback } from "react";
import type { OrderType } from "@/shared";
import type { TriggerDraftField } from "@/shared/order-math";
import { useT } from "@/i18n/LangProvider";
import { Field } from "./Field";
import { TriggerHint } from "./TriggerHint";
import type { CondDraft } from "./trigger-ticket";

/** 触发后下的单:两项分段开关,市价在前(默认) */
const AFTER_TYPES: readonly OrderType[] = ["MARKET", "LIMIT"];

export type ConditionalFieldsProps = {
  /** 表单的 useId 前缀(输入框 id 与错误说明的 id 都从它来) */
  ids: string;
  symbol: string;
  precision: number;
  cond: CondDraft;
  /** 数量框显示的文本(condView 派生:滑杆是最后动的那一项时由它换算) */
  qtyText: string;
  /** 校验失败归哪个框:aria-invalid 并指向错误说明(errorId) */
  invalidField: TriggerDraftField | null;
  errorId: string;
  /** 输入框的类名(与限价 / 市价票据同一个 INPUT) */
  inputClass: string;
  onChange: (patch: Partial<CondDraft>) => void;
};

/**
 * 条件单票据的三行输入(计划 §6.3.2 C3;P3-07),与限价票据的价格 / 数量 / 金额三行逐行等高,换票据时表单不变高
 *(terminal.css 的 min-height 常数对三种票据都成立):
 *   1. 触发价:标签 + 输入框 + 一行说明(TriggerHint oneLine:把方向说成话,只占一行,放不下截断、title 里是全文);
 *   2. 「触发后」:只有控件这一行(没有标签行,这一行的名字就是行首那几个字,分组经 aria-labelledby 指向它)——
 *      市价 / 限价两项开关,补上了第 1 行多出的说明行;
 *   3. 委托价(限价时)与数量并排,各带可见标签;市价时只有数量。
 * 两个价格框都不带 data-price-field(↑↓ 步进与 Enter 提交只属于限价单的价格框)。
 */
export function ConditionalFields({ ids, symbol, precision, cond, qtyText, invalidField, errorId, inputClass, onChange }: ConditionalFieldsProps) {
  const t = useT("terminal");
  const hintId = `${ids}-trigger-hint`;
  const invalid = (field: TriggerDraftField) => (invalidField === field ? { "aria-invalid": true, "aria-describedby": errorId } : {});
  const handlePick = useCallback((direction: CondDraft["direction"]) => onChange({ direction }), [onChange]);
  const isLimit = cond.then === "LIMIT";
  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${ids}-trigger`} className="text-t-xs text-muted">
          {t.order.triggerPrice}
        </label>
        <input
          id={`${ids}-trigger`}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={cond.triggerText}
          onChange={(e) => onChange({ triggerText: e.currentTarget.value })}
          className={inputClass}
          aria-invalid={invalidField === "triggerPrice" || undefined}
          aria-describedby={invalidField === "triggerPrice" || invalidField === "direction" ? `${hintId} ${errorId}` : hintId}
        />
        <TriggerHint id={hintId} symbol={symbol} precision={precision} text={cond.triggerText} pick={cond.direction} onPick={handlePick} oneLine />
      </div>
      <div role="group" aria-labelledby={`${ids}-after`} className="flex items-stretch gap-gap">
        <span id={`${ids}-after`} className="self-center text-t-xs text-muted">
          {t.triggers.after}
        </span>
        <div className="grid min-h-touch flex-1 grid-cols-2 gap-0.5 rounded-control border border-(--terminal-border) bg-(--terminal-panel-2) p-0.5 lg:min-h-0">
          {AFTER_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={cond.then === type}
              onClick={() => onChange({ then: type })}
              className={`rounded-chip px-2 py-1 text-t-base font-medium transition-colors duration-(--motion-fast) focus-visible:outline-none focus-visible:shadow-focus ${
                cond.then === type ? "bg-(--terminal-selected) text-foreground" : "text-muted hover:text-foreground"
              }`}
            >
              {type === "LIMIT" ? t.order.limit : t.order.market}
            </button>
          ))}
        </div>
      </div>
      <div className={isLimit ? "grid grid-cols-2 gap-gap" : "flex flex-col"}>
        {isLimit ? (
          <Field id={`${ids}-limit`} label={t.order.limitPrice}>
            <input
              id={`${ids}-limit`}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={cond.limitText}
              onChange={(e) => onChange({ limitText: e.currentTarget.value })}
              className={inputClass}
              {...invalid("limitPrice")}
            />
          </Field>
        ) : null}
        <Field id={`${ids}-qty`} label={t.order.qty}>
          <input
            id={`${ids}-qty`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={qtyText}
            onChange={(e) => onChange({ qtyText: e.currentTarget.value, lastEdited: "qty" })}
            className={inputClass}
            {...invalid("quantity")}
          />
        </Field>
      </div>
    </>
  );
}
