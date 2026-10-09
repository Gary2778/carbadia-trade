"use client";
// 下单面板「条件单」票据的状态与处理函数(P3-07;复审时从 OrderPanel 拆出来)。状态是 trigger-ticket.ts 的纯 reducer(reduceCondTicket),
// 这里只做三件 React 的事:useReducer、渲染期按新的草稿种子调整(盘口点价切回限价)、用一个只返回校验结果的 selector 订阅最新成交价
// (成交怎么跳,结果不变就不重渲染下单面板)。确认与提交在途的公共部分(busy、失败显示在哪)仍在 OrderPanel,与限价 / 市价共用。
import { useCallback, useReducer } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Side } from "@/shared";
import { validateTriggerDraft, type DraftInstrument, type TriggerDraftFailure } from "@/shared/order-math";
import { lastPriceOf } from "@/lib/market/last-price";
import { writePrefs } from "@/lib/market/prefs";
import type { DraftAvail, DraftInstrumentInfo } from "@/lib/market/order-draft";
import { useMarketStore, type DraftSeed } from "@/lib/market/store";
import { condTriggerDraft, condView, initialCondTicket, reduceCondTicket, type CondDraft, type TriggerReview } from "./trigger-ticket";

/** 条件单的提交:按需加载 trigger-submit(不进首屏包);chunk 取不到(离线)为 null = 请求没发出去 */
export const submitConditional = (review: TriggerReview) => import("@/lib/market/trigger-submit").then((m) => m.submitOrderTrigger(review.fields), () => null);
/** 指针移到 / 焦点落到「核对订单」上时预取同一个 chunk */
export const preloadConditional = () => void import("@/lib/market/trigger-submit");
/**
 * 手机布局(< 48rem)里底部页签只挂在「下单」手机页签下;不在那一页时点它(页签状态归 TerminalShell,点击走它自己的 onTabChange)。
 * 页签按钮的 id 是 MobileTabs 的 tabId(`${useId()}-order-tab`)
 */
const MOBILE_ORDER_TAB = '[data-terminal][data-layout="mobile"]:not([data-mobile-tab="order"]) [data-area="mobile-tabs"] [role="tab"][id$="-order-tab"]';
/**
 * 把底部页签切到「条件单」并让人看到它:写偏好(手机上先切到「下单」页签),等页签条按新偏好重渲染之后(下一帧),
 * 把底部页签区([data-area="tabs"])滚进视野、焦点移到选中的页签上。条件单结果未确认时让用户去那里核对、新建成功后的 toast 动作 ——
 * 下单面板的失败说明、toast 与各对话框共用这一个。
 * 从模态对话框里调时,调用方随即关掉对话框:对话框卸载时把焦点还给打开它的按钮,这里在下一帧才聚焦,落在页签上
 */
export const showTriggersTab = () => {
  writePrefs({ bottomTab: "triggers" });
  document.querySelector<HTMLElement>(MOBILE_ORDER_TAB)?.click();
  requestAnimationFrame(() => {
    const area = document.querySelector<HTMLElement>('[data-area="tabs"]');
    if (!area) return;
    area.scrollIntoView({ block: "nearest" });
    area.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  });
};

export type ConditionalTicketInput = {
  symbol: string;
  /** 买卖方向:与限价 / 市价票据共用 OrderPanel 的草稿 */
  side: Side;
  /** 标的精度(数量步长);标的还没到时是兜底值 */
  info: DraftInstrumentInfo;
  /** 可用现金(分)与可用持仓(吨):滑杆换算用 */
  avail: DraftAvail;
  /** 当前的草稿种子(store.draft) */
  seed: DraftSeed;
};

export function useConditionalTicket({ symbol, side, info, avail, seed }: ConditionalTicketInput) {
  const [state, dispatch] = useReducer(reduceCondTicket, seed.nonce, initialCondTicket);
  // 新的草稿种子:渲染期按「随输入调整 state」处理(只在 nonce 换了的那一次);带价格的盘口点价把票据切回限价,只带方向的不切
  if (seed.nonce !== state.seedNonce) dispatch({ kind: "seed", nonce: seed.nonce, symbol: seed.symbol, price: seed.price, currentSymbol: symbol });

  // 数量 / 滑杆 / 预估合计:按可用资源与参考价(委托价或触发价)现算
  const view = condView(state.draft, side, avail, info.qtyStep);
  // 校验要用最新成交价(定方向):selector 只返回校验结果(浅比较),核对过之前恒为 null
  const failure = useMarketStore(
    useShallow((s): TriggerDraftFailure | null => {
      if (!state.active || !state.attempted) return null;
      const check = validateTriggerDraft(condTriggerDraft(state.draft, side, view.qtyText), info, lastPriceOf(s, symbol));
      return check.ok ? null : check;
    }),
  );

  const enter = useCallback(() => dispatch({ kind: "enter" }), []);
  const leave = useCallback(() => dispatch({ kind: "leave" }), []);
  const onChange = useCallback((patch: Partial<CondDraft>) => dispatch({ kind: "edit", patch }), []);
  const onPct = useCallback((pct: number) => dispatch({ kind: "pct", pct }), []);
  const close = useCallback(() => dispatch({ kind: "close" }), []);
  const placed = useCallback(() => dispatch({ kind: "placed" }), []);

  /** 「核对订单」:按此刻的最新成交价校验(方向在这里定);通过则打开确认框并返回 true,没通过只记「核对过」(错误随后实时显示) */
  const openReview = (instrument: DraftInstrument): boolean => {
    const lastPrice = lastPriceOf(useMarketStore.getState(), symbol);
    const check = validateTriggerDraft(condTriggerDraft(state.draft, side, view.qtyText), instrument, lastPrice);
    if (!check.ok) {
      dispatch({ kind: "attempt" });
      return false;
    }
    dispatch({ kind: "review", review: { fields: check.trigger, estNotional: view.estNotional, lastPrice } });
    return true;
  };

  return { state, view, failure, enter, leave, onChange, onPct, openReview, close, placed };
}
