import type { NoticeCopy } from "./en";

// 站内通知的句子与面板里的文案(简体中文):与 ./en.ts 一一对应,说明见那里。
const zhCN: NoticeCopy = {
  empty: "还没有通知",
  emptyHint: "你的成交、条件单触发和价格提醒会显示在这里。",
  unread: "未读",
  fill: ({ buy, qty, symbol, price }) => `已${buy ? "买入" : "卖出"} ${qty} 吨 ${symbol}，成交价 ${price}`,
  act: ({ buy, qty, symbol }) => `${buy ? "买入" : "卖出"} ${qty} 吨 ${symbol}`,
  trigger: {
    TRIGGERED: ({ act, price }) => `已触发 · 委托已提交：${act}（触发价 ${price}）`,
    REJECTED: ({ act, price }) => `下单失败：${act}（触发价 ${price}）`,
    CANCELLED: ({ act, price }) => `已撤销：${act}（触发价 ${price}）`,
    NO_FILL: ({ act, price }) => `已触发，但没有成交：${act}（触发价 ${price}）`,
  },
  alert: ({ symbol, up, price, alertPrice }) => `价格提醒：${symbol} ${up ? "涨到" : "跌到"} ${price}（你设的提醒价 ${alertPrice}）`,
  reason: {
    OCO: "同组的另一单先触发了",
    INSUFFICIENT_CASH: "触发时资金不足",
    INSUFFICIENT_QTY: "触发时持仓不足",
    INVALID: "委托没能提交",
  },
  noFillReason: { buy: "资金不足，或者没有人在卖", sell: "没有人在买" },
  fallback: "新通知",
};

export default zhCN;
