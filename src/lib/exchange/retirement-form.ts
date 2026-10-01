// 注销表单的纯逻辑(计划 §6.2.2 C7):原因预设、字段上限、填写校验、请求体与提交。
// 旧 /retirement 页与终端的 RetireDialog(src/components/account/)共用;本文件不引任何服务端模块 ——
// retirement.ts 带 node:crypto 与 Prisma,这里只取它的类型。校验规则与 retirementInputSchema 对得上这件事由
// retirement-form.test.ts 拿真的 schema 逐条核对(zod 不进浏览器的包)。
import { api, ApiError } from "../http/client";
import type { RetirementInput, RetirementRecord } from "./retirement";

/** 注销原因的六个预设:value 是存库的英文原文(证书上印的也是它),zh 只用于界面显示 */
export const RETIREMENT_REASONS = [
  { value: "Personal Carbon Offset", zh: "个人碳抵销" },
  { value: "Corporate Emissions Offset", zh: "企业排放抵销" },
  { value: "Event Offset", zh: "活动碳抵销" },
  { value: "Product Carbon Neutrality", zh: "产品碳中和" },
  { value: "ESG Commitment", zh: "ESG 承诺" },
  { value: "Other", zh: "其他" },
];

/** 选了 Other 时存库的原因 = 前缀 + 用户填的文字 */
export const OTHER_REASON = "Other";
export const OTHER_REASON_PREFIX = "Other: ";

/** 输入框的 maxLength(与 retirementInputSchema 的上限一致;customReason = 200 减去 "Other: " 的 7 个字符) */
export const RETIREMENT_FIELD_MAX = { customReason: 193, beneficiary: 200, purpose: 500, publicMessage: 500 } as const;

/** 存库的原因 → 界面显示:英文界面原样;中文界面把预设换成中文、"Other: x" 换成「其他：x」,认不出的原样 */
export function displayRetirementReason(value: string, chinese: boolean): string {
  if (!chinese) return value;
  if (value.startsWith(OTHER_REASON_PREFIX)) return `其他：${value.slice(OTHER_REASON_PREFIX.length)}`;
  return RETIREMENT_REASONS.find((option) => option.value === value)?.zh ?? value;
}

/** 填写步骤的字段(全是输入框里的原始字符串) */
export type RetirementFields = {
  quantity: string;
  /** 预设的 value,或 "Other";"" = 还没选 */
  reason: string;
  customReason: string;
  beneficiary: string;
  purpose: string;
  publicMessage: string;
};
export const EMPTY_RETIREMENT_FIELDS: RetirementFields = { quantity: "", reason: "", customReason: "", beneficiary: "", purpose: "", publicMessage: "" };

/** invalidAmount = 数量不是可用持仓范围内的正整数;missingFields = 原因 / 受益人 / 用途有空的 */
export type RetirementFormError = "invalidAmount" | "missingFields";
/** 请求体里由用户决定的部分(服务端按它算请求指纹);幂等键与确认标记在进入复核时补上 */
export type RetirementDetails = Omit<RetirementInput, "idempotencyKey" | "acknowledged">;

/**
 * 填写 → 复核之前的校验(与旧页的 review() 同一套规则、同一顺序):
 *   1. 数量:Number(text) 必须是正的安全整数且不超过 available(该持仓的可交易数量;锁在卖单 / 场外挂牌里的不算);
 *   2. 原因(选 Other 时取自填文字)、受益人、用途去掉首尾空白后不得为空。
 * 通过时返回去过空白的请求明细;Other 的原因存成 "Other: <文字>"。
 */
export function retirementDetails(
  assetId: string,
  available: number,
  fields: RetirementFields,
): { ok: true; details: RetirementDetails } | { ok: false; error: RetirementFormError } {
  const amount = Number(fields.quantity);
  if (!assetId || !Number.isSafeInteger(amount) || amount <= 0 || amount > available) return { ok: false, error: "invalidAmount" };
  const enteredReason = fields.reason === OTHER_REASON ? fields.customReason.trim() : fields.reason;
  const beneficiary = fields.beneficiary.trim();
  const purpose = fields.purpose.trim();
  if (!enteredReason || !beneficiary || !purpose) return { ok: false, error: "missingFields" };
  return {
    ok: true,
    details: {
      assetId,
      quantity: amount,
      reason: fields.reason === OTHER_REASON ? `${OTHER_REASON_PREFIX}${enteredReason}` : enteredReason,
      beneficiary,
      purpose,
      publicMessage: fields.publicMessage.trim(),
    },
  };
}

/**
 * 明细 + 幂等键 → POST /api/retirements 的请求体。幂等键在进入复核时生成一次(crypto.randomUUID()),
 * 同一份复核无论重试几次都带同一个键:服务端见过这个键就重放原结果,不会再扣一次。acknowledged 恒为 true
 *(界面上的勾选框挡在提交按钮前面,没勾不会走到这里)。
 */
export function retirementRequest(details: RetirementDetails, idempotencyKey: string): RetirementInput {
  return { ...details, idempotencyKey, acknowledged: true };
}

export type RetirementResult = { retirement: RetirementRecord; replayed: boolean };

/** 2xx 但响应里没有一条像样的注销记录时抛出的错误文字(界面在「结果不确定」的说明旁边原样显示) */
export const UNREADABLE_RETIREMENT_RESPONSE = "The server's response could not be read";

const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * 成功响应的形状检查:data.retirement 的 id、reference、certificateUrl 是非空字符串,quantity 是正整数。
 * 回执与证书链接就靠这四项;缺了任何一项都不能当「成功」显示(空回执 + 成功提示)。
 */
export function isRetirementResult(data: unknown): data is RetirementResult {
  if (typeof data !== "object" || data === null) return false;
  const record: unknown = (data as { retirement?: unknown }).retirement;
  if (typeof record !== "object" || record === null) return false;
  const { id, reference, certificateUrl, quantity } = record as Partial<Record<keyof RetirementRecord, unknown>>;
  return nonEmptyString(id) && nonEmptyString(reference) && nonEmptyString(certificateUrl) && typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity > 0;
}

/**
 * 提交注销:201 = 新记录,200 = 同一幂等键的重放(replayed: true);失败抛 ApiError(结果是否确定见 retirement-outcome.ts)。
 * 2xx 但响应不是一条注销记录(isRetirementResult 不过)→ 抛 status 200 的 ApiError:请求很可能已经入库,只是回执读不出来,
 * retirementOutcomeUncertain 把 2xx 的错误归为「结果不确定」,界面因此锁住明细、带同一个幂等键重试,服务端重放原记录。
 * (api() 不带回真实的状态码,201 与 200 在这里不分,统一记 200。)
 */
export async function submitRetirement(input: RetirementInput, request: typeof api = api): Promise<RetirementResult> {
  const data = await request<unknown>("/api/retirements", { method: "POST", body: JSON.stringify(input) });
  if (!isRetirementResult(data)) throw new ApiError(UNREADABLE_RETIREMENT_RESPONSE, 200);
  return { retirement: data.retirement, replayed: data.replayed === true };
}

/** 失败的种类(界面按它取本地化文案;other = 直接显示服务端给的原文) */
export type RetirementFailure = "session" | "holdingsChanged" | "rateLimited" | "other";

/**
 * HTTP 状态 → 失败种类:401 会话失效,409 可用持仓变了或不足(同一幂等键配不同明细也是 409,本界面不会产生),429 限流。
 * 「结果不确定的那次之后,同一个键重试得到 409」另有一句话,不走这里(见 retire-flow.ts 的 retirementFailureOutcome)。
 */
export function retirementFailure(status: number): RetirementFailure {
  if (status === 401) return "session";
  if (status === 409) return "holdingsChanged";
  if (status === 429) return "rateLimited";
  return "other";
}
