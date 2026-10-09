// 止盈止损与价格提醒的草稿校验(P3-06 写成,P3-07 复审时从 ./order-math.ts 挪出来):只有终端的两个对话框(懒加载)用它们,
// 单独成模块,打包时随对话框的 chunk 走,不进下单面板的首屏包。规则与 order-math 的条件单校验共用(priceProblem / checkTrigger / failure),
// 输入约定也一样:空框 null,垃圾输入 NaN。纯函数,零 React / next / Prisma。
import type { AlertFields, OcoFields } from "./api-shapes";
import { checkTrigger, failure, isInt, isLastPrice, priceProblem, stepOf, type DraftInstrument, type TriggerDraftFailure } from "./order-math";
import type { Instrument, TriggerDirection } from "./types";

/** 价格提醒草稿:只有触发价与(最新价未知时的)方向 */
export type AlertDraft = { triggerPrice: number | null; direction?: TriggerDirection | null };
export type AlertDraftResult = { ok: true; alert: AlertFields } | TriggerDraftFailure;

/** 价格提醒草稿校验:就是条件单的第 1 步(触发价三条规则 + 方向),通过时给出 submitAlert 的输入 */
export function validateAlertDraft(draft: AlertDraft, instrument: Pick<Instrument, "id" | "tickSize">, lastPrice: number | null): AlertDraftResult {
  const trigger = checkTrigger(draft.triggerPrice, draft.direction, instrument.tickSize, lastPrice);
  if (!trigger.ok) return trigger;
  return { ok: true, alert: { assetId: instrument.id, direction: trigger.direction, triggerPrice: draft.triggerPrice! } };
}

/** 止盈止损草稿:takeProfit / stopLoss 为 null = 没填(NaN = 填了但无效);quantity 同 TriggerDraft */
export type OcoDraft = { takeProfit: number | null; stopLoss: number | null; quantity: number | null };
export type OcoDraftResult = { ok: true; oco: OcoFields } | TriggerDraftFailure;

/**
 * 止盈止损草稿校验(两条 SELL MARKET 条件单:止盈 ABOVE、止损 BELOW),第一条不通过的规则即返回:
 * 1. ocoNeedsOne:两个价都没填(null)
 * 2. 填了的价:invalidPrice → overMaxPrice → offTick(先止盈后止损)
 * 3. 与最新价的关系:止盈 > 最新价(takeProfitTooLow)、止损 < 最新价(stopLossTooHigh);最新价未知时只要求两个都填了的话止盈 > 止损(takeProfitTooLow)
 * 4. 数量:invalidQty → offStep → overPosition(> positionQty;服务端按持仓总数量查,含挂卖单 / 场外挂牌锁着的部分,所以这里传 Position.quantity 而不是 available)
 * 通过时给出 submitOco 的输入。
 */
export function validateOcoDraft(draft: OcoDraft, instrument: DraftInstrument, lastPrice: number | null, positionQty: number): OcoDraftResult {
  const { takeProfit, stopLoss, quantity } = draft;
  if (takeProfit === null && stopLoss === null) return failure("ocoNeedsOne", "form");
  if (takeProfit !== null) {
    const problem = priceProblem(takeProfit, instrument.tickSize, "invalidPrice");
    if (problem) return failure(problem, "takeProfit");
  }
  if (stopLoss !== null) {
    const problem = priceProblem(stopLoss, instrument.tickSize, "invalidPrice");
    if (problem) return failure(problem, "stopLoss");
  }
  const last = isLastPrice(lastPrice) ? lastPrice : null;
  if (takeProfit !== null && last !== null && takeProfit <= last) return failure("takeProfitTooLow", "takeProfit");
  if (stopLoss !== null && last !== null && stopLoss >= last) return failure("stopLossTooHigh", "stopLoss");
  if (takeProfit !== null && stopLoss !== null && takeProfit <= stopLoss) return failure("takeProfitTooLow", "takeProfit");
  if (!isInt(quantity) || quantity <= 0) return failure("invalidQty", "quantity");
  if (quantity % stepOf(instrument.qtyStep) !== 0) return failure("offStep", "quantity");
  if (!(quantity <= positionQty)) return failure("overPosition", "quantity");
  return { ok: true, oco: { assetId: instrument.id, quantity, takeProfit, stopLoss } };
}
