// 站内通知的句子与面板里的文案(英文,source of truth)。不在核心包里(计划 C9 的 P3-08 修订):铃铛在每个页面的 floor 包里,
// 但这些句子只有懒加载的通知面板与实时 Toast 要用 —— 由 components/notices/notice-copy.ts 直接引入,两种语言一起随面板 chunk 走。
// 铃铛自己要的(可访问名、弹出层标题、加载失败的提示)留在 core.notices。
// 价格已由调用方带上 $ 与千分位,数量带千分位;一句话讲一件事:哪个标的、买还是卖、多少吨、什么价。句子里的单位写全 tonnes(1 吨写 tonne),不写 t。
// 条件单触发只说「委托已提交」,不说成交(成交另有一条 fill 通知);失败原因与终端 terminal.triggers.reason 同字(终端文案不在这里引,各存一份,
// messages.test.ts 钉住一致)。市价单触发后一吨没成交(NO_FILL)单独成句,原因按方向说(买:没钱或没人卖;卖:没人买)。
const tonnes = (qty: string): string => `${qty} ${qty === "1" ? "tonne" : "tonnes"}`;

const notices = {
  empty: "No notifications yet",
  emptyHint: "Your trades, triggered orders and price alerts appear here.",
  unread: "Unread",
  fill: ({ buy, qty, symbol, price }: { buy: boolean; qty: string; symbol: string; price: string }) =>
    `${buy ? "Bought" : "Sold"} ${tonnes(qty)} of ${symbol} at ${price}`,
  // 条件单做什么:买卖 + 数量 + 标的
  act: ({ buy, qty, symbol }: { buy: boolean; qty: string; symbol: string }) => `${buy ? "buy" : "sell"} ${tonnes(qty)} of ${symbol}`,
  // 键 = 通知的 outcome;NO_FILL = REJECTED 且原因是 NO_FILL(委托交上去了,但一吨都没成交);act 是上一条的结果
  trigger: {
    TRIGGERED: ({ act, price }: { act: string; price: string }) => `Triggered · order submitted: ${act} (trigger price ${price})`,
    REJECTED: ({ act, price }: { act: string; price: string }) => `Order failed: ${act} (trigger price ${price})`,
    CANCELLED: ({ act, price }: { act: string; price: string }) => `Cancelled: ${act} (trigger price ${price})`,
    NO_FILL: ({ act, price }: { act: string; price: string }) => `Triggered, but nothing filled: ${act} (trigger price ${price})`,
  },
  alert: ({ symbol, up, price, alertPrice }: { symbol: string; up: boolean; price: string; alertPrice: string }) =>
    `Price alert: ${symbol} ${up ? "rose" : "fell"} to ${price} (your alert price ${alertPrice})`,
  // 键 = TriggerReason 去掉 USER(本人撤单不产生通知)与 NO_FILL(见 noFillReason)
  reason: {
    OCO: "The other order of the pair triggered first",
    INSUFFICIENT_CASH: "Not enough cash when it triggered",
    INSUFFICIENT_QTY: "Not enough holdings when it triggered",
    INVALID: "The order could not be placed",
  },
  // NO_FILL 的原因行,按那张单的方向
  noFillReason: { buy: "Not enough cash, or no one was selling", sell: "No one was buying" },
  // 认不得的通知种类(旧标签页遇上新版服务端才有的 kind):一句通用的,不让面板或 Toast 出错
  fallback: "New notification",
};

export type NoticeCopy = typeof notices;
export default notices;
