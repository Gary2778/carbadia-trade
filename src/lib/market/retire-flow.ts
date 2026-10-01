// 注销对话框的状态机(计划 §6.2.2 C7;纯函数,零 React,retire-flow.test.ts 直接测)。
// 三步:details(填写)→ review(复核并勾选确认)→ receipt(回执与证书链接)。与旧 /retirement 页的行为一一对应:
//   - 幂等键在「进入复核」时定下来(由调用方生成后随 review 动作传入,reducer 不碰 crypto),之后同一份复核重试几次都是同一个请求对象;
//   - 结果不确定(断网、5xx、2xx 但响应读不出来)之后不许回去改明细 —— 改了就是另一个指纹,同一个键会被服务端以 409 拒绝,
//     换新键又可能把已经扣过的数量再扣一次;只能原样重试,服务端见过这个键就重放原结果;
//   - 明确被拒(4xx)可以回去改,再进复核时换新键;
//   - 结果不确定之后,同一个键重试得到 409:服务端在这个键下没有同样明细的记录(有的话会重放原结果),而可交易数量已不够或变了 ——
//     继续原样重试只会一直 409,又不许改,是条死路(旧页就是这样)。这里解锁(uncertain 清掉,可以回去改,下次复核换新键),
//     并换一句专门的话:先看持仓那一行与注销记录,再决定要不要重来(见 retirementFailureOutcome)。
import { ApiError } from "../http/client";
import { retirementOutcomeUncertain } from "../exchange/retirement-outcome";
import { EMPTY_RETIREMENT_FIELDS, retirementDetails, retirementRequest, type RetirementFields, type RetirementFormError } from "../exchange/retirement-form";
import type { RetirementInput, RetirementRecord } from "../exchange/retirement";

export type RetireStep = "details" | "review" | "receipt";

export type RetireSubmitError = {
  /** 服务端给的原文(或网络层的错误文字) */
  message: string;
  /** HTTP 状态:0 = 网络层失败;null = 不是 ApiError */
  status: number | null;
  /** 这次是 409,而同一个请求之前有过结果不确定的尝试:界面换一句专门的话(先核对持仓与注销记录),并已解锁「修改」 */
  conflictAfterUncertain: boolean;
};

export type RetireFlow = {
  step: RetireStep;
  fields: RetirementFields;
  /** 填写步骤的校验错误(点「复核」时才查);改任何字段即清掉 */
  formError: RetirementFormError | null;
  /** 复核中的请求体(含幂等键);只在 review 步骤非空 */
  request: RetirementInput | null;
  acknowledged: boolean;
  /** 提交在途 */
  busy: boolean;
  /** 上一次提交的结果没法确认:不许改明细,只能原样重试 */
  uncertain: boolean;
  /** 上一次提交失败的原文与 HTTP 状态 */
  submitError: RetireSubmitError | null;
  /** 成功后的注销记录(回执);只在 receipt 步骤非空 */
  receipt: RetirementRecord | null;
};

export const INITIAL_RETIRE_FLOW: RetireFlow = {
  step: "details",
  fields: EMPTY_RETIREMENT_FIELDS,
  formError: null,
  request: null,
  acknowledged: false,
  busy: false,
  uncertain: false,
  submitError: null,
  receipt: null,
};

export type RetireAction =
  | { type: "field"; name: keyof RetirementFields; value: string }
  /** 点「复核」:available = 此刻该持仓的可交易数量;idempotencyKey = 调用方刚生成的 crypto.randomUUID() */
  | { type: "review"; assetId: string; available: number; idempotencyKey: string }
  | { type: "acknowledge"; value: boolean }
  | { type: "edit" }
  | { type: "submit" }
  | { type: "succeeded"; retirement: RetirementRecord }
  | { type: "failed"; error: unknown }
  /** 回执之后「再注销一些」:回到填写,数量清空,其余字段留着 */
  | { type: "again" }
  | { type: "reset" };

/**
 * 一次提交失败之后的去向(纯函数;reducer 与「对话框已关掉时改用 toast」的那条路共用):
 *   - 之前没有不确定的尝试:按 retirementOutcomeUncertain(断网、5xx、读不出来的 2xx → 不确定;4xx → 明确被拒);
 *   - 之前有过不确定的尝试:一般仍算不确定(后来的 401 / 429 / 5xx 证明不了头一次没入库),只能原样重试;
 *   - 例外是 409。同一个键、同一份明细:头一次若已入库,服务端会重放原记录(200),不会 409。所以 409 说明这个键下
 *     没有这笔记录,而持仓已经不够或变了(指纹不符的 409 本界面发不出来:重试用的是同一个请求对象)。再重试也还是 409,
 *     于是解锁:uncertain = false,conflictAfterUncertain = true。极端情况下头一次可能正好在这次检查的同时入库,
 *     所以那句话让用户先看持仓行与注销记录,而不是直接说「没成」。
 */
export function retirementFailureOutcome(error: unknown, previouslyUncertain: boolean): { uncertain: boolean; submitError: RetireSubmitError } {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : null;
  if (previouslyUncertain && status === 409) return { uncertain: false, submitError: { message, status, conflictAfterUncertain: true } };
  return { uncertain: retirementOutcomeUncertain(error, previouslyUncertain), submitError: { message, status, conflictAfterUncertain: false } };
}

/** 这一刻能不能提交:在复核步骤、勾了确认、没有在途请求 */
export const canSubmitRetirement = (flow: RetireFlow): boolean => flow.step === "review" && flow.request !== null && flow.acknowledged && !flow.busy;

/** 这一刻能不能回去改明细:在途或结果不确定时不行 */
export const canEditRetirement = (flow: RetireFlow): boolean => flow.step === "review" && !flow.busy && !flow.uncertain;

export function reduceRetireFlow(flow: RetireFlow, action: RetireAction): RetireFlow {
  switch (action.type) {
    case "field":
      if (flow.step !== "details") return flow;
      return { ...flow, fields: { ...flow.fields, [action.name]: action.value }, formError: null };
    case "review": {
      if (flow.step !== "details") return flow;
      const checked = retirementDetails(action.assetId, action.available, flow.fields);
      if (!checked.ok) return { ...flow, formError: checked.error };
      return {
        ...flow,
        step: "review",
        formError: null,
        request: retirementRequest(checked.details, action.idempotencyKey),
        acknowledged: false,
        uncertain: false,
        submitError: null,
      };
    }
    case "acknowledge":
      return flow.step === "review" && !flow.busy ? { ...flow, acknowledged: action.value } : flow;
    case "edit":
      return canEditRetirement(flow) ? { ...flow, step: "details", request: null, acknowledged: false, submitError: null } : flow;
    case "submit":
      return canSubmitRetirement(flow) ? { ...flow, busy: true, submitError: null } : flow;
    case "succeeded":
      if (!flow.busy) return flow;
      return { ...flow, step: "receipt", busy: false, uncertain: false, submitError: null, request: null, acknowledged: false, receipt: action.retirement };
    case "failed":
      if (!flow.busy) return flow;
      return { ...flow, busy: false, ...retirementFailureOutcome(action.error, flow.uncertain) };
    case "again":
      return flow.step === "receipt" ? { ...INITIAL_RETIRE_FLOW, fields: { ...flow.fields, quantity: "" } } : flow;
    case "reset":
      return INITIAL_RETIRE_FLOW;
  }
}
