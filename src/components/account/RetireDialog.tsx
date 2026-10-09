"use client";

import { useEffect, useId, useRef, type FormEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import type { Instrument, Position } from "@/shared";
import { formatQty } from "@/shared/precision";
import { useToast } from "@/components/anim/Toast";
import { Dialog } from "@/components/ui/Dialog";
import type { Messages } from "@/i18n";
import { isChinese } from "@/i18n/config";
import { tName, tRegistry } from "@/i18n/data";
import { useLang, useT } from "@/i18n/LangProvider";
import { displayRetirementReason, OTHER_REASON, RETIREMENT_FIELD_MAX, RETIREMENT_REASONS, retirementFailure, type RetirementFields } from "@/lib/exchange/retirement-form";
import { lockSourcesOf } from "@/lib/market/position-groups";
import { canEditRetirement, canSubmitRetirement, type RetireAction, type RetireFlow, type RetireSubmitError } from "@/lib/market/retire-flow";
import { dispatchRetireFlow, submitRetireFlow, useRetireFlow } from "@/lib/market/retire-flow-store";
import { formatTime } from "@/lib/time-format";
import { useTimeZone } from "@/providers/useTimeZone";

// 注销对话框(计划 §6.2.2 C7、§6.2.3 P2-09)。终端「持仓」页签与资产页(P2-10)共用,只能渲染在 /trade 之下(读 terminal.retire)。
// 调用方的约定:
//   - 用 next/dynamic({ ssr: false }) 引入,第一次点「注销」之后才挂载(不进首屏);
//   - 挂上之后就留着,关闭只把 open 置 false:填到一半的内容、复核、回执都还在,再打开同一持仓接着来(状态按 assetId 隔离,
//     换持仓即换一份);回执看完关掉才清空。
//   - 状态不在组件里,在 src/lib/market/retire-flow-store.ts(模块级,按 assetId):本组件卸载(换页签、换一行、持仓行消失)时
//     结果没定的那一份 —— 提交在途、或结果不确定的复核连同它的幂等键 —— 留在那里,下次挂上来原样取回(「修改」仍锁着);
//     其余随卸载丢掉。登出即全部清掉。
//   - position 传 account store 里的活数据:数量上限是它此刻的 available;注销成功后的持仓变化由 position 事件(轮询 ≤ 5 s)带来,
//     本组件不改 store。
// 样式只用全站 token(终端里由 data-glass="off" 映射成不透明面板色),不依赖 [data-terminal] 专用变量。

/** 对话框里要显示的标的信息(行情 store 的 instruments 里取;还没到就只显示代码) */
export type RetireInstrument = Pick<Instrument, "name" | "registry" | "standard" | "vintage">;

export type RetireDialogProps = {
  /** 要注销的持仓(活数据) */
  position: Position;
  instrument: RetireInstrument | undefined;
  open: boolean;
  /** Esc、点背景、关闭按钮、回执上的「关闭」都走这里;在途的提交不会因此中止,结果改用 toast 告知 */
  onClose: () => void;
};

type TerminalText = Messages["terminal"];

const INPUT =
  "min-h-touch w-full rounded-control border border-border bg-surface-2 px-2 text-t-base text-foreground placeholder:text-muted-2 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-60 aria-invalid:border-danger lg:min-h-0 lg:py-1.5";
const LABEL = "text-t-xs text-muted";
const BUTTON =
  "inline-flex min-h-touch items-center justify-center rounded-control px-3 text-t-sm focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 lg:min-h-0 lg:py-2";
const PRIMARY = `${BUTTON} bg-accent-strong font-semibold text-background`;
const SECONDARY = `${BUTTON} border border-border font-medium text-foreground`;
const UNIT = "tCO2e";

const numberLocale = (lang: string): string => (lang === "zh-CN" ? "zh-CN" : "en-US");

/** POST /api/retirements 的限流窗口(20 次 / 60 秒):429 时告诉用户最多等这么久(api() 不带回 Retry-After) */
const RATE_LIMIT_WINDOW_S = 60;

/**
 * 提交失败那一行的文字,全部是本地化文案(服务端 / 网络层的英文原文不上界面,只放进提示框的 title;P2-13,终审 UI-4):
 *   - 401 / 409 / 429:各自一句(前后两条沿用终端已有的 toast 文案);
 *   - 结果不确定之后同一个键重试得到的 409(conflictAfterUncertain)另有一句:先核对持仓行与注销记录,再决定要不要重来 ——
 *     这时「修改」已解锁,不再与「保留这些数据重试」的说明并排出现;
 *   - 状态 0(网络层失败,请求可能没到服务端)→「连接中断」;
 *   - 其它 4xx(请求到了、被拒绝)→「请求被拒绝」;
 *   - 5xx、2xx 却读不出回执、或者不是 ApiError(状态 null)→「服务器没有确认结果」。
 * 结果不确定的几类下面另有 retryHelp 说明怎么办。
 */
export function retirementFailureText(error: Pick<RetireSubmitError, "message" | "status"> & Partial<Pick<RetireSubmitError, "conflictAfterUncertain">>, text: TerminalText): string {
  if (error.conflictAfterUncertain) return text.retire.errorConflictAfterUncertain;
  const status = error.status;
  switch (status == null ? "other" : retirementFailure(status)) {
    case "session":
      return text.toast.loginRequired;
    case "holdingsChanged":
      return text.retire.errorHoldingsChanged;
    case "rateLimited":
      return text.toast.rateLimited(RATE_LIMIT_WINDOW_S);
    default:
      if (status === 0) return text.retire.errorConnection;
      if (status != null && status >= 400 && status < 500) return text.retire.errorRefused;
      return text.retire.errorUnconfirmed;
  }
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-gap">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{children}</dd>
    </div>
  );
}

/** 数量 + 单位 + 「模拟」徽标(复核与回执共用):数量再大也带着「模拟」 */
function SimulatedAmount({ label, quantity }: { label: string; quantity: string }) {
  const t = useT("terminal");
  return (
    <div className="flex flex-wrap items-center justify-between gap-gap rounded-panel bg-surface-2 p-panel">
      <div>
        <p className="text-t-xs text-muted">{label}</p>
        <p className="tnum text-t-xl font-semibold leading-t-tight">
          {quantity} <span className="text-t-sm font-normal text-muted">{UNIT}</span>
        </p>
      </div>
      <span data-simulated="" className="rounded-chip border border-warning/40 px-1.5 text-t-2xs font-semibold text-warning">
        {t.retire.badge}
      </span>
    </div>
  );
}

type StepProps = {
  position: Position;
  instrument: RetireInstrument | undefined;
  flow: RetireFlow;
  /** 这一步的标题:打开与换步时焦点落在这里 */
  stageRef?: RefObject<HTMLHeadingElement | null>;
};

const STAGE_TITLE = "text-t-md font-semibold leading-t-tight focus-visible:outline-none";

export type RetireDetailsStepProps = StepProps & {
  onField: (name: keyof RetirementFields, value: string) => void;
  onReview: () => void;
};

/**
 * 第一步:填写。数量上限 = 该持仓此刻的 available(锁在卖单 / 场外挂牌里的不算);情景标的、可交易为 0 时不出表单,只说明原因。
 * 表单 noValidate:校验走 retire-flow(与旧页同一套规则),错误用本地化文案显示在表单里,不用浏览器各说各话的气泡。
 */
export function RetireDetailsStep({ position, instrument, flow, stageRef, onField, onReview }: RetireDetailsStepProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const id = useId();
  const qty = (n: number) => formatQty(n, 1, locale);
  const { fields, formError } = flow;
  // 锁定来源服务端没给(回滚到 Phase 1 的服务端)时只显示锁定总数
  const lockedBy = lockSourcesOf(position);
  const blocked = position.isScenario ? { title: t.retire.scenarioBlocked, help: null } : position.available <= 0 ? { title: t.retire.noAvailable, help: t.retire.noAvailableHelp } : null;
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onReview();
  };

  const summary = (
    <div data-retire-position="" className="flex flex-col gap-1 rounded-panel border border-border p-panel text-t-sm">
      <p className="font-medium">{instrument ? tName(position.symbol, instrument.name, lang) : position.symbol}</p>
      {instrument ? (
        <p className="text-t-xs text-muted">
          {instrument.registry ? tRegistry(instrument.registry, lang) : t.meta.notProvided} · {t.meta.vintage} <span className="tnum">{instrument.vintage}</span>
        </p>
      ) : null}
      <p className="flex flex-wrap gap-x-panel text-t-xs text-muted">
        <span>
          {t.tabs.tradable} <strong className="tnum font-semibold text-foreground">{qty(position.available)}</strong>
        </span>
        <span>
          {t.tabs.locked} <strong className="tnum font-semibold text-foreground">{qty(position.locked)}</strong>
        </span>
      </p>
      {position.locked > 0 && lockedBy ? <p className="text-t-xs text-muted">{t.retire.lockedBy({ orders: qty(lockedBy.orders), otc: qty(lockedBy.otc) })}</p> : null}
    </div>
  );

  if (blocked) {
    return (
      <div data-retire-step="details" className="flex flex-col gap-panel">
        <h3 ref={stageRef} tabIndex={-1} className={STAGE_TITLE}>
          {blocked.title}
        </h3>
        {summary}
        {blocked.help ? <p className="text-t-sm text-muted">{blocked.help}</p> : null}
      </div>
    );
  }

  return (
    <form data-retire-step="details" onSubmit={handleSubmit} noValidate className="flex flex-col gap-panel">
      <h3 ref={stageRef} tabIndex={-1} className={STAGE_TITLE}>
        {t.retire.stepDetails}
      </h3>
      {summary}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-quantity`} className={LABEL}>
          {t.retire.amount}
        </label>
        <div className="flex items-center gap-gap">
          <input
            id={`${id}-quantity`}
            type="number"
            inputMode="numeric"
            min={1}
            max={position.available}
            step={1}
            required
            value={fields.quantity}
            onChange={(event) => onField("quantity", event.target.value)}
            aria-describedby={formError === "invalidAmount" ? `${id}-unit ${id}-error` : `${id}-unit`}
            aria-invalid={formError === "invalidAmount" || undefined}
            placeholder="0"
            className={`${INPUT} tnum`}
          />
          <span className="shrink-0 text-t-sm text-muted">{UNIT}</span>
        </div>
        <p id={`${id}-unit`} className="text-t-xs text-muted">
          {t.retire.unit}
        </p>
      </div>
      <div className="grid gap-panel sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-reason`} className={LABEL}>
            {t.retire.reason}
          </label>
          <select id={`${id}-reason`} required value={fields.reason} onChange={(event) => onField("reason", event.target.value)} className={INPUT}>
            <option value="">{t.retire.reasonSelect}</option>
            {RETIREMENT_REASONS.map((option) => (
              <option key={option.value} value={option.value}>
                {displayRetirementReason(option.value, isChinese(lang))}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-beneficiary`} className={LABEL}>
            {t.retire.beneficiary}
          </label>
          <input
            id={`${id}-beneficiary`}
            required
            maxLength={RETIREMENT_FIELD_MAX.beneficiary}
            value={fields.beneficiary}
            onChange={(event) => onField("beneficiary", event.target.value)}
            placeholder={t.retire.beneficiaryPlaceholder}
            className={INPUT}
          />
        </div>
      </div>
      {fields.reason === OTHER_REASON ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-custom-reason`} className={LABEL}>
            {t.retire.reasonOther}
          </label>
          <input
            id={`${id}-custom-reason`}
            required
            maxLength={RETIREMENT_FIELD_MAX.customReason}
            value={fields.customReason}
            onChange={(event) => onField("customReason", event.target.value)}
            placeholder={t.retire.reasonPlaceholder}
            className={INPUT}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-purpose`} className={LABEL}>
          {t.retire.purpose}
        </label>
        <textarea
          id={`${id}-purpose`}
          required
          maxLength={RETIREMENT_FIELD_MAX.purpose}
          rows={2}
          value={fields.purpose}
          onChange={(event) => onField("purpose", event.target.value)}
          placeholder={t.retire.purposePlaceholder}
          className={`${INPUT} resize-y py-1.5`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-message`} className={LABEL}>
          {t.retire.message} <span className="text-muted-2">{t.retire.optional}</span>
        </label>
        <textarea
          id={`${id}-message`}
          maxLength={RETIREMENT_FIELD_MAX.publicMessage}
          rows={2}
          value={fields.publicMessage}
          onChange={(event) => onField("publicMessage", event.target.value)}
          aria-describedby={`${id}-message-help`}
          className={`${INPUT} resize-y py-1.5`}
        />
        <p id={`${id}-message-help`} className="text-t-xs text-muted">
          {t.retire.messageHelp}
        </p>
      </div>
      {formError ? (
        <p id={`${id}-error`} role="alert" data-retire-error={formError} className="text-t-sm text-danger">
          {formError === "invalidAmount" ? t.retire.invalidAmount : t.retire.missingFields}
        </p>
      ) : null}
      <button type="submit" className={PRIMARY}>
        {t.retire.next}
      </button>
    </form>
  );
}

export type RetireReviewStepProps = StepProps & {
  onAcknowledge: (value: boolean) => void;
  onEdit: () => void;
  onConfirm: () => void;
  errorRef?: RefObject<HTMLDivElement | null>;
};

/**
 * 第二步:复核。摘要 + 必须勾选的确认;提交在途时按钮禁用;结果不确定(flow.uncertain)时「修改」禁用,
 * 只能原样重试(同一个幂等键,服务端重放原结果,不会扣两次)。不确定之后重试得到 409:换成一句专门的说明,附注销记录的链接
 *(新标签页打开,对话框里的内容不丢),「修改」解锁。
 */
export function RetireReviewStep({ position, instrument, flow, stageRef, errorRef, onAcknowledge, onEdit, onConfirm }: RetireReviewStepProps) {
  const t = useT("terminal");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const request = flow.request;
  if (!request) return null;
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onConfirm();
  };
  return (
    <form data-retire-step="review" onSubmit={handleSubmit} aria-busy={flow.busy} className="flex flex-col gap-panel">
      <div className="flex flex-col gap-1">
        <h3 ref={stageRef} tabIndex={-1} className={STAGE_TITLE}>
          {t.retire.reviewTitle}
        </h3>
        <p className="text-t-sm text-muted">{t.retire.reviewHelp}</p>
      </div>
      <SimulatedAmount label={t.retire.amount} quantity={formatQty(request.quantity, 1, locale)} />
      <dl data-retire-review="" className="flex flex-col gap-1 text-t-sm">
        <Row label={t.retire.project}>
          {position.symbol}
          {instrument ? ` · ${tName(position.symbol, instrument.name, lang)}` : ""}
        </Row>
        <Row label={t.retire.registry}>{instrument?.registry ? tRegistry(instrument.registry, lang) : t.meta.notProvided}</Row>
        <Row label={t.retire.standard}>{instrument?.standard || t.meta.notProvided}</Row>
        <Row label={t.meta.vintage}>{instrument ? <span className="tnum">{instrument.vintage}</span> : t.meta.notProvided}</Row>
        <Row label={t.retire.beneficiary}>{request.beneficiary}</Row>
        <Row label={t.retire.reason}>{displayRetirementReason(request.reason, isChinese(lang))}</Row>
        <Row label={t.retire.purpose}>{request.purpose}</Row>
        {request.publicMessage ? <Row label={t.retire.message}>{request.publicMessage}</Row> : null}
      </dl>
      <label className="flex cursor-pointer items-start gap-gap rounded-panel border border-border p-panel text-t-xs">
        <input
          type="checkbox"
          required
          checked={flow.acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
          disabled={flow.busy}
          className="mt-0.5 size-4 shrink-0 accent-(--accent-strong)"
        />
        <span>{t.retire.acknowledgement}</span>
      </label>
      {flow.submitError ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          data-retire-error={flow.uncertain ? "uncertain" : flow.submitError.conflictAfterUncertain ? "conflict" : "rejected"}
          className="flex flex-col gap-1 rounded-control border border-danger/25 bg-danger-soft p-panel text-t-sm text-danger focus-visible:outline-none"
        >
          <p title={flow.submitError.message}>{retirementFailureText(flow.submitError, t)}</p>
          {flow.uncertain ? <p className="text-t-xs">{t.retire.retryHelp}</p> : null}
          {flow.submitError.conflictAfterUncertain ? (
            <p className="text-t-xs">
              <Link href="/retirement" prefetch={false} target="_blank" rel="noopener noreferrer" className="rounded-chip font-medium underline focus-visible:outline-none focus-visible:shadow-focus">
                {t.retire.history}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-gap">
        <button type="button" onClick={onEdit} disabled={!canEditRetirement(flow)} className={SECONDARY}>
          {t.retire.edit}
        </button>
        <button type="submit" disabled={!canSubmitRetirement(flow)} aria-busy={flow.busy} className={PRIMARY}>
          {flow.busy ? t.retire.confirming : t.retire.confirm}
        </button>
      </div>
    </form>
  );
}

export type RetireReceiptStepProps = StepProps & {
  onAgain: () => void;
  onClose: () => void;
};

/** 第三步:回执。模拟注销记录、唯一模拟编号、证书链接(查看 / 打印、下载),以及该持仓此刻的数量(活数据,事件到了就变) */
export function RetireReceiptStep({ position, flow, stageRef, onAgain, onClose }: RetireReceiptStepProps) {
  const t = useT("terminal");
  const ui = useT("ui");
  const { lang } = useLang();
  const locale = numberLocale(lang);
  const tz = useTimeZone();
  const record = flow.receipt;
  if (!record) return null;
  const qty = (n: number) => formatQty(n, 1, locale);
  const created = new Date(record.createdAt);
  const date = Number.isNaN(created.getTime()) ? record.createdAt : formatTime(created, locale, tz, "full");
  return (
    <div data-retire-step="receipt" className="flex flex-col gap-panel">
      <div className="flex flex-col gap-1">
        <h3 ref={stageRef} tabIndex={-1} className={STAGE_TITLE}>
          {t.retire.saved}
        </h3>
        <p className="text-t-sm text-muted">{t.retire.doneBody}</p>
      </div>
      <SimulatedAmount label={t.retire.simulation} quantity={qty(record.quantity)} />
      <dl data-retire-receipt="" className="flex flex-col gap-1 text-t-sm">
        <Row label={t.retire.project}>{`${record.symbol} · ${tName(record.symbol, record.projectName, lang)}`}</Row>
        <Row label={t.retire.registry}>{record.registry ? tRegistry(record.registry, lang) : t.meta.notProvided}</Row>
        <Row label={t.meta.vintage}>
          <span className="tnum">{record.vintage}</span>
        </Row>
        <Row label={t.retire.beneficiary}>{record.beneficiary}</Row>
        <Row label={t.retire.reason}>{displayRetirementReason(record.reason, isChinese(lang))}</Row>
        <Row label={t.retire.purpose}>{record.purpose}</Row>
        {record.publicMessage ? <Row label={t.retire.message}>{record.publicMessage}</Row> : null}
        <Row label={t.retire.date}>{date}</Row>
        <Row label={t.retire.reference}>
          <span className="tnum break-all">{record.reference}</span>
        </Row>
      </dl>
      <div className="grid gap-gap sm:grid-cols-2">
        <a href={record.certificateUrl} target="_blank" rel="noopener noreferrer" className={PRIMARY}>
          {t.retire.view}
        </a>
        <a href={`${record.certificateUrl}?download=1`} className={SECONDARY}>
          {t.retire.download}
        </a>
      </div>
      <p data-retire-position="" role="status" className="text-t-xs text-muted">
        {t.retire.positionUpdated} {t.tabs.tradable} <span className="tnum text-foreground">{qty(position.available)}</span> · {t.tabs.retired}{" "}
        <span className="tnum text-foreground">{qty(position.retired)}</span>
      </p>
      <div className="flex flex-wrap items-center justify-between gap-gap">
        <div className="flex flex-wrap items-center gap-panel text-t-sm">
          {position.available > 0 && !position.isScenario ? (
            <button type="button" onClick={onAgain} className="rounded-chip font-medium text-accent-strong hover:underline focus-visible:outline-none focus-visible:shadow-focus">
              {t.retire.another}
            </button>
          ) : null}
          <Link href="/retirement" prefetch={false} className="rounded-chip text-muted hover:text-foreground focus-visible:outline-none focus-visible:shadow-focus">
            {t.retire.history}
          </Link>
        </div>
        <button type="button" onClick={onClose} className={SECONDARY}>
          {ui.close}
        </button>
      </div>
    </div>
  );
}

export type RetireDialogViewProps = RetireDialogProps &
  Pick<RetireDetailsStepProps, "onField" | "onReview"> &
  Pick<RetireReviewStepProps, "onAcknowledge" | "onEdit" | "onConfirm" | "errorRef"> &
  Pick<RetireReceiptStepProps, "onAgain"> & {
    flow: RetireFlow;
    stageRef?: RefObject<HTMLHeadingElement | null>;
  };

const STEPS = ["details", "review", "receipt"] as const;

/**
 * 纯展示(RetireDialog.ssr.test.ts 直接渲染):ui/Dialog + 「仅供模拟」说明 + 三步指示 + 当前一步。
 * 「仅供模拟」的说明在三步里都在,并经 aria-describedby 挂在对话框上。
 */
export function RetireDialogView({ open, onClose, position, instrument, flow, stageRef, errorRef, onField, onReview, onAcknowledge, onEdit, onConfirm, onAgain }: RetireDialogViewProps) {
  const t = useT("terminal");
  const noteId = useId();
  const current = STEPS.indexOf(flow.step);
  const labels = [t.retire.stepDetails, t.retire.stepReview, t.retire.stepCertificate];
  return (
    <Dialog open={open} onClose={onClose} title={t.retire.title(position.symbol)} initialFocusRef={stageRef} describedBy={noteId}>
      <div id={noteId} data-simulated="" className="flex flex-col gap-1 rounded-panel border border-warning/25 bg-warning-soft p-panel text-t-xs">
        <p className="font-semibold text-warning">{t.retire.simulation}</p>
        <p>{t.retire.warning}</p>
      </div>
      <ol aria-label={t.retire.stepsLabel} className="grid grid-cols-3 gap-gap text-t-xs">
        {labels.map((label, index) => (
          <li
            key={STEPS[index]}
            aria-current={index === current ? "step" : undefined}
            className={`flex items-center justify-center gap-1 rounded-control px-1 py-1 ${index === current ? "bg-surface-2 font-semibold text-foreground" : "text-muted"}`}
          >
            <span aria-hidden="true" className="tnum">
              {index < current ? "✓" : index + 1}
            </span>
            <span className="truncate">{label}</span>
          </li>
        ))}
      </ol>
      {flow.step === "details" ? (
        <RetireDetailsStep position={position} instrument={instrument} flow={flow} stageRef={stageRef} onField={onField} onReview={onReview} />
      ) : flow.step === "review" ? (
        <RetireReviewStep position={position} instrument={instrument} flow={flow} stageRef={stageRef} errorRef={errorRef} onAcknowledge={onAcknowledge} onEdit={onEdit} onConfirm={onConfirm} />
      ) : (
        <RetireReceiptStep position={position} instrument={instrument} flow={flow} stageRef={stageRef} onAgain={onAgain} onClose={onClose} />
      )}
    </Dialog>
  );
}

/**
 * 注销对话框(容器)。状态机在 src/lib/market/retire-flow.ts,状态存在 retire-flow-store.ts(模块级,按 assetId),
 * 校验与请求体在 src/lib/exchange/retirement-form.ts(与旧 /retirement 页共用):
 *   - 幂等键在点「复核」时生成(crypto.randomUUID()),同一份复核重试沿用;acknowledged: true;
 *   - 提交 POST /api/retirements(submitRetireFlow:结果由 store 落,本组件卸载了也照落);结果不确定时锁住「修改」,只许原样重试;
 *     不确定之后重试得到 409 → 解锁并换一句专门的说明;
 *   - 成功:回执 + 证书链接 + toast;结果回来时对话框已关掉或本组件已卸载:失败也改用 toast 告知(结果没定的状态留着,
 *     再打开还在复核那一步、同一个键);
 *   - 换步时焦点移到新一步的标题,出错时移到错误说明。
 * 状态按持仓隔离:内层组件以 assetId 为 key,调用方换一个持仓传进来读的就是另一份。
 */
export function RetireDialog(props: RetireDialogProps) {
  return <RetireDialogFlow key={props.position.assetId} {...props} />;
}

function RetireDialogFlow({ position, instrument, open, onClose }: RetireDialogProps) {
  const t = useT("terminal");
  const toast = useToast();
  const { assetId } = position;
  const flow = useRetireFlow(assetId);
  const dispatch = (action: RetireAction) => dispatchRetireFlow(assetId, action);
  const stageRef = useRef<HTMLHeadingElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  /** 用户此刻看不看得见对话框里的错误说明:开着且本组件还挂着 */
  const shownRef = useRef(open);
  const stepRef = useRef(flow.step);

  useEffect(() => {
    shownRef.current = open;
    return () => {
      shownRef.current = false;
    };
  }, [open]);

  // 换步:焦点移到新一步的标题(刚打开时由 Dialog 的 initialFocusRef 放好,这里只管之后的切换)
  useEffect(() => {
    if (stepRef.current === flow.step) return;
    stepRef.current = flow.step;
    stageRef.current?.focus();
  }, [flow.step]);

  useEffect(() => {
    if (flow.submitError) errorRef.current?.focus();
  }, [flow.submitError]);

  const handleReview = () => dispatch({ type: "review", assetId, available: position.available, idempotencyKey: crypto.randomUUID() });

  const handleConfirm = () => {
    const settled = submitRetireFlow(assetId);
    if (!settled) return;
    void settled.then((outcome) => {
      // null = 期间登出 / 换号,状态已清:不再提示
      if (!outcome) return;
      if (outcome.ok) {
        toast("ok", t.retire.saved);
        return;
      }
      // 对话框还开着:错误说明就在复核那一步里(role="alert")。已经被关掉或卸载:用 toast 告知,免得用户以为成了或没成
      if (shownRef.current) return;
      if (outcome.uncertain) toast("warning", t.retire.retryHelp);
      else toast("err", retirementFailureText(outcome.error, t));
    });
  };

  const handleClose = () => {
    // 回执看完即清空;其余(填到一半、复核中、结果不确定)留着,再打开接着来
    if (flow.step === "receipt") dispatch({ type: "reset" });
    onClose();
  };

  return (
    <RetireDialogView
      open={open}
      onClose={handleClose}
      position={position}
      instrument={instrument}
      flow={flow}
      stageRef={stageRef}
      errorRef={errorRef}
      onField={(name, value) => dispatch({ type: "field", name, value })}
      onReview={handleReview}
      onAcknowledge={(value) => dispatch({ type: "acknowledge", value })}
      onEdit={() => dispatch({ type: "edit" })}
      onConfirm={handleConfirm}
      onAgain={() => dispatch({ type: "again" })}
    />
  );
}
