// 资产页 /trade/account 的文案(英文,source of truth;计划 §6.2.3 P2-10)。自成一个命名空间 account,不放进 terminal:
// terminal 随 /trade 布局加载,终端页的自有包余量很小,资产页的文案不该让终端首屏背(lead 决定,取代 C9「terminal.account 由 P2-10 填」)。
// 只由 src/i18n/AccountMessages.tsx 引入,那个 Provider 只由 src/app/trade/account/layout.tsx 挂;组件用 const a = useT("account") 消费,
// 在资产页布局之外调用会直接报错。资产页里复用的终端组件(RetireDialog、DemoBadge、ui/*)照常读 terminal.* / ui.*;
// 与终端「持仓」页签同义的列名、按钮也直接读 terminal.*(两处措辞一致),这里只放资产页自己的文案。
// symbol、OTC、单位 t、tCO2e、货币 $ 不译;函数型条目保持参数与模板结构。不写任何充值 / 提现 / 划转的入口,只有「不支持」的说明。
const account = {
  title: "Portfolio",
  intro: "Your demo account: cash, holdings by project and vintage, allocation and OTC listings. Values follow the latest simulated prices.",
  demoNote: "Demo funds have no value and cannot be deposited, withdrawn or transferred out.",

  links: {
    label: "Account pages",
    orders: "Orders and history",
    ledger: "Ledger",
    retirements: "Retirements and certificates",
    profile: "Profile",
    terminal: "Back to the terminal",
  },

  summary: {
    label: "Account summary",
    totalAssets: "Total assets",
    availableCash: "Available cash",
    lockedCash: "Reserved cash",
    holdingsValue: "Holdings value",
    change24h: "24h change",
    change24hSince: (time: string) => `Since ${time}`,
    change24hUnavailable: "Can't be calculated right now, for example when a holding has no trade price from 24 hours ago.",
    unrealisedPnl: "Unrealised P&L",
    pnlUnavailable: "Unavailable: some holdings have no recorded cost or no current price.",
    held: "Credits held",
    heldNote: "Nominal tCO2e, scenario instruments excluded",
    retired: "Credits retired",
    retiredNote: "Simulated retirements, no offset claim",
    partialValuation: "Holdings without a current price are left out of these totals.",
    refreshFailed: "Refresh failed. The 24h change and OTC listings show the last values received.",
  },

  holdings: {
    title: "Holdings",
    searchLabel: "Search holdings",
    searchPlaceholder: "Symbol, project or name",
    listLabel: "Holdings by project",
    colInstrument: "Instrument",
    colOrigin: "Origin and standard",
    colQuantity: "Quantity (t)",
    empty: "No holdings yet",
    emptyHint: "Buy a credit in the terminal and it shows up here.",
    emptyCta: "Browse the market",
    noMatch: "No holdings match this search",
    note: "Buying transfers simulated ownership. Only retirement takes credits out of circulation in this simulator.",
  },

  allocation: {
    title: "Allocation",
    note: "Share of holdings value. Scenario instruments are not included.",
    groupBy: "Group by",
    byType: "Project type",
    byCountry: "Geography",
    byApproach: "Credit type",
    empty: "Allocation shows up after your first credit purchase.",
    unpriced: (count: number) => (count === 1 ? "1 holding without a current price is not included." : `${count} holdings without a current price are not included.`),
  },

  // 碳信用的类别与类型名(持仓行的「产地」、分布的分组名):键是 getCreditProfile(lib/exchange/carbon.ts)给的英文名,值是当前语言;
  // 键里没有的(项目类型的原值)原样显示。两种语言的键必须一致(类型保证),与 carbon.ts 的措辞一致由 src/components/account/credit-names.test.ts 钉住
  credit: {
    categories: {
      "Blue carbon": "Blue carbon",
      "Clean cookstoves": "Clean cookstoves",
      "Methane capture": "Methane capture",
      "Direct air capture": "Direct air capture",
      Biochar: "Biochar",
      Forestry: "Forestry",
      "Wind energy": "Wind energy",
      "Solar energy": "Solar energy",
      Other: "Other",
    },
    approaches: {
      Removal: "Removal",
      Avoidance: "Avoidance",
      "Mixed / project-specific": "Mixed / project-specific",
      "Not specified": "Not specified",
    },
  },

  otc: {
    title: "My OTC listings",
    market: "OTC market",
    unitPrice: "Unit price",
    available: "Available (t)",
    minQty: "Minimum fill (t)",
    cancel: "Cancel listing",
    cancelConfirm: "Confirm cancel",
    keep: "Keep",
    cancelled: "Listing cancelled",
    cancelFailed: "The listing could not be cancelled.",
    lockNote: "Listed credits stay locked until the listing sells or is cancelled.",
  },

  gate: {
    title: "Sign in to see your portfolio",
  },

  errors: {
    load: "Your account data could not be loaded.",
    session: "Your sign-in status could not be confirmed.",
  },
};

export type AccountMessages = typeof account;
export default account;
