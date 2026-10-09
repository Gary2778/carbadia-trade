// 交易终端文案(英文,source of truth)。只随 /trade 的 chunk 加载(计划 §6.2.2 C9):src/app/trade/layout.tsx 经
// src/i18n/TerminalMessages.tsx 登记,根 LangProvider 不引入本文件;组件照旧用 const t = useT("terminal") 消费,
// 在 /trade 之外调用会直接报错。终端之外也要用的文案放核心命名空间(../core/en.ts 的 nav / ui)。
// 叶子清单以 docs/trade-upgrade-plan.md §4.10 为准;前 14 组是 Phase 1 的(demo / connection / header / meta / instruments /
// book / tape / chart / order / tabs / shortcuts / a11y / toast / mobile),其后是 Phase 2 各任务的组(ledger / retire / exportCsv;
// 资产页 /trade/account 的文案不在这里,自成 account 命名空间,见 ../account/en.ts —— P2-10 删掉了原来预留的空组 account),
// 再其后是 Phase 3 的组(markets:市场总览页 /trade/markets;triggers:条件单、止盈止损与价格提醒;tz:时间显示的时区偏好选择器)。
// 连接徽章不写「Live」;symbol、OTC、CCER、单位 t、货币 USD 不译;函数型条目保持参数与模板结构。
const terminal = {
  demo: {
    label: "Simulated market",
    terms: "Terms",
  },

  connection: {
    live: "Connected · simulated feed",
    polling: "Polling · simulated feed",
    offline: "Offline",
    reconnecting: "Reconnecting…",
    degradedBody: "Push is unavailable. Quotes refresh every 2 seconds.",
    rtt: (ms: number) => `RTT ${ms} ms`,
  },

  header: {
    lastPrice: "Last",
    change24h: "24h change",
    high24h: "24h high",
    low24h: "24h low",
    volume24h: "24h volume (t)",
    bestBid: "Bid",
    bestAsk: "Ask",
    searchPlaceholder: "Search symbol or project",
    openInstruments: "Instruments",
    upDownLabel: "Colour of gains",
    greenUp: "Green up",
    redUp: "Red up",
    density: "Compact rows",
    perf: "Performance",
    unit: "per t",
  },

  meta: {
    title: "Carbon metadata",
    projectType: "Project type",
    methodology: "Methodology",
    vintage: "Vintage",
    registry: "Registry",
    standard: "Standard",
    country: "Country / region",
    verification: "Verification status",
    projectId: "Project ID",
    notProvided: "Not provided",
    scenario: "Scenario instrument",
    simulatedProjectId: "Simulated project ID, not a registry record",
    registryLink: "Registry home",
    registrySite: "Registry or programme site",
    unit: "1 credit = 1 tCO2e (nominal)",
  },

  instruments: {
    title: "Instruments",
    all: "All",
    watchlist: "Watchlist",
    watchlistOnly: "Watchlist only",
    filters: "Filters",
    registry: "Registry",
    projectType: "Project type",
    vintage: "Vintage",
    priceRange: "Price range",
    min: "Min",
    max: "Max",
    sort: "Sort",
    sortSymbol: "Symbol",
    sortChange: "Change",
    sortVolume: "Volume",
    sortPrice: "Price",
    clear: "Clear filters",
    empty: "No instruments match",
    count: (n: number) => (n === 1 ? "1 instrument" : `${n} instruments`),
    star: "Add to watchlist",
    unstar: "Remove from watchlist",
    vintages: "Vintages of this project",
    colSymbol: "Symbol",
    colPrice: "Price",
    colChange: "24h",
  },

  book: {
    title: "Order book",
    price: "Price",
    qty: "Qty (t)",
    cum: "Cum.",
    orders: "Orders",
    spread: "Spread",
    bps: "bps",
    depth: "Depth",
    agg: "Aggregate",
    bids: "Bids",
    asks: "Asks",
    mine: "Includes your order",
    empty: "No resting orders",
    clickToFill: "Click a price to fill the order form",
  },

  tape: {
    title: "Trades",
    time: "Time",
    price: "Price",
    qty: "Qty",
    side: "Side",
    buy: "Buy",
    sell: "Sell",
    auditRef: "Audit ref",
    auditNote: "Simulated trade reference, not a registry record",
    empty: "No trades yet",
    paused: "Paused while this tab is hidden",
  },

  chart: {
    title: "Chart",
    // 键 = CandleInterval 字面量 + 分时 time;IntervalTabs 按 1–7 的顺序呈现
    intervals: { time: "Time", "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1D" },
    ma: "MA",
    ema: "EMA",
    vol: "VOL",
    readout: ({ o, h, l, c, v }: { o: string; h: string; l: string; c: string; v: string }) =>
      `O ${o} H ${h} L ${l} C ${c} V ${v}`,
    retention: "Simulated history is kept for 7 days",
    loading: "Loading chart…",
    noData: "No candles for this interval yet",
    a11yHint: "← → move the crosshair, Home/End jump to the ends, Esc clears",
    intervalLabel: "Chart interval",
    indicatorsLabel: "Indicators",
  },

  order: {
    title: "Place order",
    buy: "Buy",
    sell: "Sell",
    limit: "Limit",
    market: "Market",
    price: "Price",
    qty: "Quantity (t)",
    amount: "Amount (USD)",
    availableCash: "Available cash",
    availableQty: "Available credits",
    positionPct: "Position %",
    estTotal: "Est. total",
    estAvg: "Est. avg price",
    fee: "Fee",
    feeDemo: "0.00 · demo",
    review: "Review order",
    confirm: "Confirm",
    confirmTitle: ({ side, symbol }: { side: string; symbol: string }) => `Confirm ${side} ${symbol}`,
    // 条件单的确认框标题:说明这是条件单(P3 终审)
    confirmConditionalTitle: ({ buy, symbol }: { buy: boolean; symbol: string }) => `Confirm conditional ${buy ? "buy" : "sell"} ${symbol}`,
    confirmBody: "This is a simulated order with demo funds. No real credits or money move.",
    submitting: "Submitting…",
    submitted: "Order submitted",
    filled: "Filled",
    partial: "Partially filled",
    partialWarning: "The book may fill only part of this order. The rest will be cancelled.",
    resting: "Resting on the book",
    uncertain: "We could not verify the result. Check your orders before retrying.",
    uncertainAction: "View all orders",
    login: "Log in to trade",
    loginBody: "Orders need an account. Demo accounts start with $100,000 of simulated cash.",
    // ---- 条件单票据(P3-07):第三种票据;方向的说法、状态与错误在 triggers 组 ----
    conditional: "Conditional",
    triggerPrice: "Trigger price",
    limitPrice: "Limit price",
    estTotalAtTrigger: "Est. total at trigger price",
    // 引擎实际做的事(计划 §6.3.2 C4):看逐笔成交价、触发后下普通委托、等待期间不冻结、触发时资源不够就拒并通知
    // (市价买单不预检现金:能买多少买多少,一吨都没成交才算失败)、OTC 不触发
    conditionalBody:
      "Waits until the last trade price reaches the trigger price, then places a normal order for you. Nothing is reserved while it waits. If cash or holdings fall short when it triggers, the order is rejected and you are notified; a market buy buys only what your cash covers. OTC deals do not trigger it.",
    // 键 = DraftError 联合的全部字面量(§4.8):validateDraft(P1-05)返回、OrderPanel(P1-20)渲染,三处共用同一枚举
    errors: {
      invalidPrice: "Enter a valid price",
      invalidQty: "Enter a valid quantity",
      belowMinQty: (min: number) => `Minimum quantity is ${min} t`,
      offTick: (tick: string) => `Price must be a multiple of ${tick}`,
      offStep: (step: number) => `Quantity must be a multiple of ${step} t`,
      insufficientCash: "Not enough available cash",
      insufficientQty: "Not enough available credits",
      noLiquidity: "No resting orders to fill against",
      overMaxNotional: "Order value exceeds the demo limit",
      overMaxPrice: "Price exceeds the demo limit",
    },
  },

  tabs: {
    open: "Open orders",
    history: "Order history",
    fills: "Fills",
    positions: "Positions",
    colTime: "Time",
    colAccount: "Account",
    colDelta: "Change",
    colReason: "Reason",
    scopeLabel: "Which orders to show",
    colSymbol: "Symbol",
    colSide: "Side",
    colType: "Type",
    colPrice: "Price",
    colQty: "Qty",
    colFilled: "Filled",
    colAvg: "Avg price",
    colStatus: "Status",
    colNotional: "Notional",
    colRole: "Role",
    colFee: "Fee",
    colAuditRef: "Audit ref",
    colMarketValue: "Market value",
    colAvgCost: "Avg cost",
    colPnl: "Unrealised P&L",
    tradable: "Tradable",
    locked: "Locked",
    retired: "Retired",
    cancel: "Cancel",
    cancelConfirm: "Confirm cancel",
    // 撤单按钮按行的可访问名(看得见的仍是 cancel / cancelConfirm);armed = 已按过一次,这一下是确认
    cancelOrderLabel: ({ buy, symbol, armed }: { buy: boolean; symbol: string; armed: boolean }) => `${armed ? "Confirm cancel" : "Cancel"} ${buy ? "buy" : "sell"} order ${symbol}`,
    cancelled: "Order cancelled",
    // 键 = OrderStatus / CancelReason 字面量(§3.5),按状态直接索引
    status: { OPEN: "Open", PARTIAL: "Partial", FILLED: "Filled", CANCELLED: "Cancelled" },
    cancelReason: { USER: "Cancelled by you", MARKET_REMAINDER: "Market remainder cancelled", SELF_TRADE: "Cancelled by self-trade prevention" },
    // 历史表状态格里可见的短原因(跟在状态之后:Cancelled · self-trade);完整原因给读屏与悬停提示
    cancelReasonShort: { USER: "by you", MARKET_REMAINDER: "remainder", SELF_TRADE: "self-trade" },
    maker: "Maker",
    taker: "Taker",
    retire: "Retire",
    retireHint: "Opens the retirement wizard",
    pnlUnavailable: "Cost basis incomplete",
    emptyOpen: "No open orders",
    emptyHistory: "No orders yet",
    emptyFills: "No fills yet",
    emptyPositions: "No positions",
    scenarioTag: "Scenario",
    fillDetail: "Fill detail",
    ledger: "Ledger lines",
    counterpartyBot: "Counterparty: market-making bot",
    counterpartyUser: "Counterparty: another demo user",
    disclosure: "Simulated trade — not a registry record",
    tablistLabel: "Orders, positions and ledger",
    // ---- 条件单页签(P3-07):当前委托之后;进行中 = PENDING / TRIGGERING,历史 = 其余 ----
    triggers: "Conditional",
    triggerOpen: "Open",
    triggerHistory: "History",
    // 进行中 / 历史 两项开关的可访问名
    triggerScopeLabel: "Show waiting or finished conditional orders and alerts",
    colCondition: "Condition",
    emptyTriggers: "No conditional orders or alerts",
    emptyTriggerHistory: "None finished yet",
  },

  // 快捷键帮助表(KeyboardShortcutsHelp)的行文案;括号里是按键
  shortcuts: {
    title: "Keyboard shortcuts",
    search: "Focus instrument search (/)",
    buy: "Buy side (b)",
    sell: "Sell side (s)",
    limit: "Limit order (l)",
    market: "Market order (m)",
    nudge: "Price ± one tick (↑ ↓)",
    nudge10: "Price ± ten ticks (Shift + ↑ ↓)",
    submit: "Review / confirm (Enter)",
    escape: "Close dialog / clear (Esc)",
    interval: "Chart interval (1–7)",
    help: "Show this help (?)",
    palette: "Instrument search (Ctrl/Cmd+K)",
    pointerOnly: "Shortcuts are enabled on keyboard-and-mouse devices",
  },

  a11y: {
    bookRegion: "Order book, scrollable",
    tapeRegion: "Recent trades, scrollable",
    instrumentsRegion: "Instrument list, scrollable",
    chartRegion: "Price chart",
    ordersRegion: "Orders table, scrollable",
    triggersRegion: "Conditional orders and alerts table, scrollable",
    priceUp: "up",
    priceDown: "down",
    connection: (state: string) => `Connection: ${state}`,
    selected: "Selected",
    drawerOpen: "Open instrument drawer",
    drawerClose: "Close instrument drawer",
    scrollHint: "Scroll horizontally to see more columns",
    fillsRegion: "Fills table, scrollable",
    positionsRegion: "Positions table, scrollable",
    chartRole: "Interactive chart",
  },

  toast: {
    orderPlaced: ({ side, qty, symbol }: { side: string; qty: number; symbol: string }) =>
      `${side} ${qty} t ${symbol} submitted`,
    orderFilled: "Order filled",
    orderPartial: "Partially filled, remainder resting",
    orderCancelled: "Order cancelled",
    fill: ({ qty, price }: { qty: number; price: string }) => `Filled ${qty} t at ${price}`,
    rateLimited: (s: number) => `Too many requests. Try again in ${s} s`,
    connectionLost: "Push connection lost, switched to polling",
    connectionBack: "Push connection restored",
    loginRequired: "Log in to continue",
    copied: "Copied",
    orderReplayed: ({ side, qty, symbol }: { side: string; qty: number; symbol: string }) =>
      `This ${side} ${qty} t ${symbol} order was already placed. Nothing new was submitted`,
    selfTradeCancelled: (count: number) =>
      count === 1 ? "1 of your resting orders crossed this one and was cancelled" : `${count} of your resting orders crossed this one and were cancelled`,
  },

  mobile: {
    chart: "Chart",
    book: "Book · Trades",
    order: "Order",
    buy: "Buy",
    sell: "Sell",
    meta: "Carbon metadata",
    more: "More",
    tabsLabel: "Terminal views",
  },

  // ---- Phase 2 预留组(计划 §6.2.2 C9):每个任务只往自己那一组里加键,en 与 zh-CN 同步;组与组之间的注释行不要删 ----
  // 流水页签(由 P2-07 填):底部第五个页签,数据来自 GET /api/transactions(计划 §6.2.2 C4)
  ledger: {
    tab: "Ledger",
    region: "Ledger table, scrollable",
    empty: "No ledger entries yet",
    emptyFiltered: "No entries match these filters",
    clearFilters: "Clear filters",
    colRef: "Reference",
    filtersLabel: "Ledger filters",
    filterAccount: "Account",
    filterType: "Type",
    filterSymbol: "Instrument",
    filterRange: "Period",
    allAccounts: "All accounts",
    allTypes: "All types",
    allSymbols: "All instruments",
    // 键 = LedgerRange(LedgerTab.tsx 的 LEDGER_RANGES);7d / 30d 含今天,按所选时区(时区偏好)的日历日起算
    ranges: { today: "Today", "7d": "7 days", "30d": "30 days", all: "All time" },
    // 键 = LedgerAccount(账本的四个账户)
    accounts: { CASH: "Cash", CASH_LOCKED: "Reserved cash", HOLDING: "Holdings", HOLDING_LOCKED: "Reserved holdings" },
    // 键 = ActivityType(src/shared/api-shapes.ts);接口的 label 是旧 /transactions 页用的英文标签,终端按 type 取这里的文案
    types: {
      BUY: "Bought",
      SELL: "Sold",
      SETTLEMENT: "Trade settlement",
      OTC_BUY: "OTC bought",
      OTC_SELL: "OTC sold",
      OTC_SETTLEMENT: "OTC settlement",
      RETIREMENT: "Simulated retirement",
      RESERVE: "Reserved",
      RELEASE: "Released",
      REFUND: "Price improvement refund",
      GRANT: "Demo grant",
      OPENING_BALANCE: "Opening balance",
      ADJUSTMENT: "Adjustment",
    },
    // 变动的单位:现金账户 USD,持仓账户 t;情景标的的持仓不是碳信用,写「单位」
    units: { cash: "USD", tonnes: "t", scenario: "units" },
    // 读屏用的增减说明(可见的是正负号;不借用涨跌色)
    increase: "Increase",
    decrease: "Decrease",
    // 键 = 账本的 refType(src/lib/exchange/ledger.ts);后面跟引用 id 的尾段
    refs: { TRADE: "Fill", ORDER: "Order", RETIREMENT: "Certificate", LISTING: "OTC listing", DEAL: "OTC deal" },
    refFillHint: "Open fill detail",
    refCertificateHint: "Open the simulated retirement certificate",
    newTab: "(opens in a new tab)",
  },

  // 注销对话框(由 P2-09 填)
  retire: {
    // ---- 持仓页签的分组(PositionsTab):锁定来源、「已注销」分组、情景标的的说明 ----
    lockedBy: ({ orders, otc }: { orders: string; otc: string }) => `Locked: sell orders ${orders} · OTC listings ${otc}`,
    // 数量 0、已注销 > 0 的行:可能是全部注销,也可能是注销一部分、其余卖掉(P2-13,终审 UI-2),所以只描述状态,不说「全部」
    retiredGroup: ({ count, tonnes }: { count: number; tonnes: string }) => `Retired, no longer held (${count}) · ${tonnes} t`,
    scenarioBlocked: "Scenario instruments cannot be retired",
    // ---- 注销对话框(RetireDialog):填写 → 复核 → 回执;「模拟」的标注一处都不能少 ----
    title: (symbol: string) => `Retire ${symbol}`,
    simulation: "Simulation only",
    badge: "SIMULATED",
    warning:
      "This permanently removes credits from your demo holdings. No real credits are held or retired in a registry, and no emissions claim or environmental benefit is created.",
    stepsLabel: "Retirement steps",
    stepDetails: "Details",
    stepReview: "Review",
    stepCertificate: "Certificate",
    amount: "Amount to retire",
    unit: "Whole simulated credits · 1 credit represents 1 modelled tCO2e",
    reason: "Reason",
    reasonSelect: "Select a reason",
    reasonOther: "Other reason",
    reasonPlaceholder: "For example, learning how retirement works",
    beneficiary: "Beneficiary",
    beneficiaryPlaceholder: "Person or organisation for this simulation",
    purpose: "Purpose",
    purposePlaceholder: "Describe the purpose of this demonstration retirement",
    message: "Public message",
    optional: "(optional)",
    messageHelp: "This optional message is saved on your private certificate. It is not published by Carbadia.",
    next: "Review retirement",
    invalidAmount: "Enter a positive whole amount within your tradable holdings.",
    missingFields: "Enter a reason, beneficiary and purpose before reviewing.",
    noAvailable: "No tradable credits to retire",
    noAvailableHelp: "Credits locked in open sell orders or OTC listings cannot be retired. Cancel those to release them.",
    reviewTitle: "Review your simulation",
    reviewHelp: "Check the amount and beneficiary before confirming. This action cannot be reversed in your demo account.",
    project: "Project",
    registry: "Registry label in demo",
    standard: "Standard label in demo",
    acknowledgement:
      "I understand that these simulated credits will be permanently removed from my available holdings. This does not retire real credits or support a real emissions claim.",
    confirm: "Confirm simulated retirement",
    confirming: "Recording simulation…",
    edit: "Edit details",
    retryHelp: "The result could not be confirmed. Keep these details and retry the same request; repeated submissions cannot remove the credits twice.",
    errorHoldingsChanged: "Your tradable holdings changed. Go back, check the amount and review again.",
    // 其余失败按状态分三类(P2-13,终审 UI-4):服务端 / 网络层的英文原文不上界面,只放进提示框的 title
    errorConnection: "The connection dropped before the server replied.",
    errorUnconfirmed: "The server did not confirm the result.",
    errorRefused: "The request was refused. Check the details and try again.",
    // 结果不确定之后,同一个请求重试得到 409:「修改」已解锁,不与 retryHelp 并排出现
    errorConflictAfterUncertain:
      "The earlier attempt could not be confirmed, and this retry was refused because your tradable holdings changed. Check this position and your retirement history before trying again.",
    doneBody: "The credits have been removed from your demo holdings. Your private simulation certificate is ready.",
    positionUpdated: "This position updates on its own:",
    reference: "Unique simulation reference",
    date: "Simulation date",
    view: "View / print certificate",
    download: "Download HTML certificate",
    another: "Retire more demo credits",
    history: "Retirement history",
    saved: "Simulated retirement recorded",
  },

  // CSV 导出(由 P2-06 填):历史委托、成交记录、流水三个页签工具区里的下载链接
  exportCsv: {
    label: "Export CSV",
    // 悬停提示:导出的是全部行,不只是列表里已经加载的那几页;文件是模拟数据
    hint: "Download every row in this tab as a CSV file, not only the rows loaded here. Simulated data.",
    hintFiltered: "Download every row that matches the current filters as a CSV file, not only the rows loaded here. Simulated data.",
  },

  // ---- Phase 3 ----
  // 市场总览页 /trade/markets(P3-05):模拟指数卡、三张榜单、情景标的分区。登记簿 / 项目类型 / 项目名称的显示名走 src/i18n/data.ts,
  // 24h 涨跌与成交量的列名沿用 header.change24h / header.volume24h;每个指数都写「模拟」(诚实规则:这是模拟盘,不是真实市场指数)
  markets: {
    title: "Market overview",
    intro: "How each group of projects moved over the last 24 hours. These are simulated indices: 24 hours ago = 100.",
    simulatedIndex: "Simulated index",
    allTitle: "All projects",
    byRegistry: "By registry",
    byProjectType: "By project type",
    level: "Index level",
    members: (n: number) => (n === 1 ? "1 project" : `${n} projects`),
    breadth: (up: number, down: number) => `${up} up · ${down} down`,
    partial: (counted: number, members: number) => `Based on ${counted} of ${members} projects. The rest have no 24h trades.`,
    noTrades: "No 24h trades yet",
    gainers: "Top gainers",
    losers: "Top losers",
    topVolume: "Top volume",
    emptyGainers: "No project is up over the last 24 hours",
    emptyLosers: "No project is down over the last 24 hours",
    emptyVolume: "No trades in the last 24 hours",
    scenarios: "Scenario instruments",
    scenariosNote: "Scenarios are not real credits and are not part of any index above.",
    noProjects: "No projects are listed yet",
    // 行情源断开、页面上还留着最后一次的数字时的一行说明(连接徽标在终端头部,总览页不引它:它连带 selectors.ts,自有 chunk 超预算)
    stale: "The connection is down, so these numbers may be out of date.",
    // 榜单 / 情景标的整行链接的可访问名:代码、项目名、最新价、24h 涨跌(成交量榜另加 24h 成交量);价格与涨跌就是行里看得见的那几串
    rowLabel: (p: { symbol: string; name: string; price: string; change: string; volume: string | null; scenario: boolean }) =>
      `${p.symbol}, ${p.name}${p.scenario ? " (scenario)" : ""}, last price ${p.price}, 24h change ${p.change}${p.volume === null ? "" : `, 24h volume ${p.volume}`}`,
  },

  // 条件单、止盈止损与价格提醒(P3-07):方向的说法、类型、状态与原因、两个对话框的说明、错误。
  // 「触发」一律是最新成交价(逐笔)达到触发价;已触发只说「委托已提交」,不说「成交」(委托可能部分成交或稍后成交,成交另有记录)
  triggers: {
    whenAbove: (price: string) => `When a trade happens at ${price} or higher`,
    whenBelow: (price: string) => `When a trade happens at ${price} or lower`,
    // 后面跟价格(组件里拼成「标签 价格」);确认框里单独作一行的标签
    lastTrade: "Last trade price",
    // 「触发后下的单」这一项在票据、确认框与页签表头里的同一个名字
    after: "After trigger",
    // 最新成交价未知(从未成交)时由用户自己选方向
    pickLabel: "No trades yet. Trigger when the price:",
    pickAbove: "rises to this price",
    pickBelow: "falls to this price",
    // 键 = 页签「类型」列的四种(ALERT → alert;同组成对的 ORDER:ABOVE 止盈、BELOW 止损;其余 conditional);两个对话框的标题与输入框也用它
    types: { conditional: "Conditional order", takeProfit: "Take-profit", stopLoss: "Stop-loss", alert: "Price alert" },
    // 键 = TriggerStatus;价格提醒不下单:触发中 / 已触发用 alertTriggering / alertTriggered
    status: { PENDING: "Waiting", TRIGGERING: "Placing order", TRIGGERED: "Triggered · order submitted", REJECTED: "Order failed", CANCELLED: "Cancelled" },
    alertTriggering: "Triggering",
    alertTriggered: "Triggered",
    // 键 = TriggerReason:历史里状态下面单独一行的原因
    reason: {
      USER: "Cancelled by you",
      OCO: "The other order of the pair triggered first",
      INSUFFICIENT_CASH: "Not enough cash when it triggered",
      INSUFFICIENT_QTY: "Not enough holdings when it triggered",
      INVALID: "The order could not be placed",
    },
    // 被拒但原因是 NO_FILL(市价单交上去了,一吨都没成交)不算「下单失败」:状态改说「已触发,但没有成交」,原因按那张单的方向说;
    // 通知(core 之外的 notices 文案模块)同一句、同样的标点,原因两句同字(messages.test.ts 钉住两边一致)
    noFill: { status: "Triggered, but nothing filled", buy: "Not enough cash, or no one was selling", sell: "No one was buying" },
    actionMarket: ({ buy, qty }: { buy: boolean; qty: string }) => `Market ${buy ? "buy" : "sell"} ${qty} t`,
    actionLimit: ({ buy, qty, price }: { buy: boolean; qty: string; price: string }) => `Limit ${price} ${buy ? "buy" : "sell"} ${qty} t`,
    // type = types 里的一项,止盈止损两个都设了是 tpslBoth
    placed: ({ type, symbol }: { type: string; symbol: string }) => `${type} set for ${symbol}`,
    cancelled: (type: string) => `${type} cancelled`,
    checkTab: "Open the Conditional tab",
    // 条件单页签撤销按钮按行的可访问名:type = types 里的一项;armed = 这一下是确认
    cancelLabel: ({ type, symbol, armed }: { type: string; symbol: string; armed: boolean }) => `${armed ? "Confirm cancel" : "Cancel"} ${type.toLowerCase()} ${symbol}`,
    // 两个对话框里价格输入框的标签
    takeProfitPrice: "Take-profit price",
    stopLossPrice: "Stop-loss price",
    alertPrice: "Alert price",
    // 止盈止损(持仓行的按钮与对话框)
    tpsl: "Take-profit / stop-loss",
    tpslBoth: "Take-profit and stop-loss",
    tpslBody:
      "Conditional market sell orders on this holding. Fill in a take-profit price, a stop-loss price, or both. When the last trade price rises to the take-profit price or falls to the stop-loss price, the sell order is placed. With both set, the first one to trigger cancels the other; if that order cannot be placed or nothing fills, the pair is finished — set a new one if you still want it. Nothing is reserved while they wait. OTC deals do not trigger them.",
    // 价格提醒(终端头部的按钮与对话框)
    alert: "Alert",
    alertBody:
      "You get a notice here when the last trade price reaches this price. An alert places no order. It stays in the Conditional tab until it triggers or you cancel it. OTC deals do not trigger it.",
    // 键 = TriggerDraftError(order-math 的 validateTriggerDraft、trigger-drafts 的 validateOcoDraft / validateAlertDraft)
    errors: {
      invalidTrigger: "Enter a valid trigger price",
      wouldTriggerNow: "Pick a price above or below the last trade price",
      directionNeeded: "Choose whether the price rises or falls to it",
      invalidPrice: "Enter a valid price",
      overMaxPrice: "Price exceeds the demo limit",
      offTick: (tick: string) => `Price must be a multiple of ${tick}`,
      invalidQty: "Enter a valid quantity",
      belowMinQty: (min: number) => `Minimum quantity is ${min} t`,
      offStep: (step: number) => `Quantity must be a multiple of ${step} t`,
      overMaxNotional: "Order value exceeds the demo limit",
      ocoNeedsOne: "Enter a take-profit or stop-loss price",
      takeProfitTooLow: "Take-profit must be above the last trade price and the stop-loss",
      stopLossTooHigh: "Stop-loss must be below the last trade price",
      overPosition: "More than you hold",
    },
    // 键 = TriggerSubmitError(trigger-submit.ts);rateLimited 有秒数时改用 toast.rateLimited
    submitErrors: {
      wouldTriggerNow: "The last trade price is already at or past this price",
      tooManyTriggers: "The limit is 50 waiting conditional orders and alerts. Cancel some first.",
      insufficientQty: "More than you hold",
      triggersDisabled: "Conditional orders and alerts are switched off for now. Try again later.",
      invalid: "The request was refused. Check it and try again.",
      notCancellable: "Already triggered or cancelled",
      rateLimited: "Too many requests. Try again shortly",
      unauthorized: "Log in to continue",
      network: "Connection lost. Check the Conditional tab before retrying",
      uncertain: "Result not confirmed. Check the Conditional tab before retrying",
    },
  },

  // 时区偏好(P3-09):选择器的名字与三个选项;三个选项的文字固定(UTC+8 北京),不随时间变
  tz: {
    label: "Time zone",
    local: "Local",
    beijing: "UTC+8 Beijing",
    utc: "UTC",
  },
};

export type TerminalMessages = typeof terminal;
export default terminal;
