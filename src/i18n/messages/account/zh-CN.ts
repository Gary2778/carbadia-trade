import type { AccountMessages } from "./en";

// 资产页 /trade/account 的文案(简体中文):与 ./en.ts 一一对应(类型保证缺键 / 多键编译失败,messages.test.ts 再比一遍叶子)。
// 术语与终端一致:持仓、可交易、已锁定、已注销、冻结现金、挂单、场外;symbol、OTC、t、tCO2e、$ 不译;中文标点用全角。
const account: AccountMessages = {
  title: "我的资产",
  intro: "你的演示账户：现金、按项目与年份分组的持仓、持仓分布和 OTC 挂牌。数值按最新的模拟价格计算。",
  demoNote: "演示资金没有价值，不能充值、提现或转出。",

  links: {
    label: "账户页面",
    orders: "委托与历史",
    ledger: "资产流水",
    retirements: "注销记录与证书",
    profile: "个人资料",
    terminal: "回到终端",
  },

  summary: {
    label: "账户总览",
    totalAssets: "总资产",
    availableCash: "可用现金",
    lockedCash: "冻结现金",
    holdingsValue: "持仓市值",
    change24h: "24 小时变化",
    change24hSince: (time: string) => `自 ${time} 起`,
    change24hUnavailable: "暂时算不出，例如某个持仓 24 小时前没有成交价。",
    unrealisedPnl: "未实现盈亏",
    pnlUnavailable: "算不出：有持仓没有成本记录，或没有最新价。",
    held: "持有碳信用",
    heldNote: "名义 tCO2e，不含情景标的",
    retired: "已注销碳信用",
    retiredNote: "模拟注销，不构成抵消声明",
    partialValuation: "没有最新价的持仓不计入合计。",
    refreshFailed: "刷新失败。24 小时变化与 OTC 挂牌显示的是上一次取到的值。",
  },

  holdings: {
    title: "持仓",
    searchLabel: "搜索持仓",
    searchPlaceholder: "代码、项目或名称",
    listLabel: "按项目分组的持仓",
    colInstrument: "标的",
    colOrigin: "产地与标准",
    colQuantity: "数量（吨）",
    empty: "暂无持仓",
    emptyHint: "在终端买入碳信用后，会出现在这里。",
    emptyCta: "去看行情",
    noMatch: "没有符合搜索的持仓",
    note: "买入转移的是模拟持有权。只有注销会把碳信用从这个模拟市场里移除。",
  },

  allocation: {
    title: "持仓分布",
    note: "按持仓市值计算占比，不含情景标的。",
    groupBy: "分组方式",
    byType: "项目类型",
    byCountry: "地域",
    byApproach: "类别",
    empty: "首次买入碳信用后，这里会显示分布。",
    unpriced: (count: number) => `有 ${count} 个持仓没有最新价，未计入。`,
  },

  otc: {
    title: "我的 OTC 挂牌",
    market: "OTC 市场",
    unitPrice: "单价",
    available: "可售（吨）",
    minQty: "最小成交量（吨）",
    cancel: "下架",
    cancelConfirm: "确认下架",
    keep: "保留",
    cancelled: "已下架",
    cancelFailed: "下架没有成功。",
    lockNote: "挂牌中的碳信用在售出或下架前保持锁定。",
  },

  gate: {
    title: "登录后查看你的资产",
  },

  errors: {
    load: "账户数据没有加载出来。",
    session: "无法确认登录状态。",
  },
};

export default account;
