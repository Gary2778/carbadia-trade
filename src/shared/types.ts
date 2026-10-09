// 前后端共用的领域类型(计划 §3.5)。本目录零 React / next / Prisma / @/lib 依赖,purity.test.ts 静态扫描强制。
// 单位约定:金额一律整数分,数量一律整数吨,时间一律 unix 毫秒(只有图表适配层才转秒)。
// 诚实规则:Instrument 不含 anchorPrice / description / createdAt(锚定价与影子价永不外露);
// 登记机构相关字段未知即 null(UI 显示「未提供」),不得杜撰序列号或核证状态。

export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type OrderStatus = "OPEN" | "PARTIAL" | "FILLED" | "CANCELLED";
export type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
/** 核证状态只有这一个字面量:模拟盘不得出现真实核证状态。DB 列是自由 TEXT,读取边界经 narrowVerification 收窄,不用 as 断言 */
export type VerificationStatus = "SIMULATED_UNVERIFIED";
/** 审计引用 SIM-TRD-<tradeId>:模拟成交引用,不是登记机构记录。组件 prop 一律叫 auditRef,不得叫 ref */
export type AuditRef = `SIM-TRD-${string}`;

export type Instrument = {
  id: string;
  symbol: string;
  name: string;
  standard: string;
  projectType: string;
  vintage: number;
  country: string;
  registry: string;
  isScenario: boolean;
  /** 模拟项目编号 SIM-PRJ-<STANDARD>-<TYPE>;null → 未提供 */
  projectId: string | null;
  /** 方法学;null → 未提供,不得杜撰 */
  methodology: string | null;
  verificationStatus: VerificationStatus | null;
  /** 最小价格变动,分 */
  tickSize: number;
  /** 价格显示小数位;>2 时格式化钳到 2(计划 §9.1 第 6 条) */
  pricePrecision: number;
  /** 数量步长,吨 */
  qtyStep: number;
  /** 最小数量,吨 */
  minQty: number;
  currency: "USD";
  /** 最新成交价,分;无成交为 null */
  lastPrice: number | null;
}; // 无 anchorPrice / description / createdAt(ws-protocol.test.ts 用 expectTypeOf 断言键集)

export type Ticker = {
  symbol: string;
  lastPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  /**
   * 24 h 涨跌,单位是百分数:1.23 = +1.23%,不是小数比例。
   * 与 /api/assets 及 SpotTable / market page 现有的 toFixed(2) + "%" 渲染一致;
   * 定义 = (lastPrice − 24 h 窗口首笔成交价) / 首笔 × 100,由 stats24h() 一处计算。
   */
  change24h: number | null;
  high24h: number | null;
  low24h: number | null;
  /** 24 h 成交量,吨 */
  volume24h: number;
  ts: number;
};
/** ticker 事件是部分字段,客户端合并;symbol 与 ts 必带 */
export type TickerUpdate = Partial<Omit<Ticker, "symbol" | "ts">> & { symbol: string; ts: number };
export type InstrumentListItem = { instrument: Instrument; ticker: Ticker };

export type OrderBookLevel = { price: number; quantity: number; orders: number };
/** bids 降序、asks 升序、原始 tick 精度(聚合在客户端) */
export type OrderBookSnapshot = { symbol: string; bids: OrderBookLevel[]; asks: OrderBookLevel[]; ts: number };
/** 只含变化档;quantity === 0 删档 */
export type OrderBookDelta = OrderBookSnapshot;
export type TapeEntry = { id: string; symbol: string; price: number; quantity: number; takerSide: Side; ts: number; auditRef: AuditRef };
/** t = 桶起点 unix ms;o/h/l/c 分,v 吨 */
export type CandleBar = { t: number; o: number; h: number; l: number; c: number; v: number };

/**
 * 由映射派生,不落库(计划 §9.1 第 24、41 条):MARKET + CANCELLED → MARKET_REMAINDER;LIMIT + CANCELLED 且有
 * SELF_TRADE_UNLOCK 解冻流水(refType ORDER)→ SELF_TRADE(自成交防护撤单);其余 LIMIT + CANCELLED → USER
 */
export type CancelReason = "USER" | "MARKET_REMAINDER" | "SELF_TRADE";
export type Order = {
  id: string;
  clientOrderId: string | null;
  assetId: string;
  symbol: string;
  side: Side;
  type: OrderType;
  price: number | null;
  quantity: number;
  filledQuantity: number;
  status: OrderStatus;
  avgFillPrice: number | null;
  cancelReason: CancelReason | null;
  createdAt: number;
  updatedAt: number;
};
export type Fill = {
  id: string;
  orderId: string;
  symbol: string;
  side: Side;
  role: "MAKER" | "TAKER";
  price: number;
  quantity: number;
  /** 成交金额,分 */
  notional: number;
  feeCents: number;
  ts: number;
  auditRef: AuditRef;
  /** 本人在该成交下的账本行 id */
  ledgerRefs: string[];
};
export type LedgerLineView = { id: string; account: string; delta: number; reason: string; createdAt: number };
export type CostBasisStatus = "complete" | "unknown_acquisition_cost" | "incomplete_ledger";
/**
 * 持仓一行(计划 §6.2.2 C1;REST、WS 快照、WS 事件、客户端 store 四处同一口径)。
 * available = 可交易(tradable)= quantity − locked;locked = Holding.locked(挂单与场外挂牌合计冻结);
 * retired = 已注销(Retirement 按 assetId 聚合)。整仓注销的行(quantity 0、retired > 0)也是持仓载荷的一部分;
 * 卖光且从没注销过的行(quantity 0、retired 0)只在事件里出现,用来让客户端清掉这一行。
 */
export type Position = {
  assetId: string;
  symbol: string;
  quantity: number;
  locked: number;
  /**
   * locked 的来源拆分,直接读表(不回放账本):orders = 本人在该标的上未完结(OPEN / PARTIAL)SELL 挂单的剩余数量之和,
   * otc = 本人在该标的上 ACTIVE 的场外挂牌数量之和。orders + otc 应等于 locked;不等时以 locked 为准
   *(可交易数量按 locked 算,这里照实给出读到的值,服务端记一行日志)。
   */
  lockedBy: { orders: number; otc: number };
  available: number;
  retired: number;
  lastPrice: number | null;
  marketValue: number;
  averagePurchasePrice: number | null;
  unrealisedPnl: number | null;
  costBasisStatus: CostBasisStatus;
  isScenario: boolean;
};
export type Balance = { cashBalance: number; lockedCash: number };
/** = 现有 GET /api/auth/me 的 data 形状;unreadNotices = 本人未读的站内通知条数(P3-04) */
export type Me = { id: string; email: string; name: string; cashBalance: number; lockedCash: number; unreadNotices: number } | null;
/** Phase 1 全零(计划 §9.1 第 1 条);demo 恒 true */
export type FeeSchedule = { makerBps: number; takerBps: number; minFeeCents: number; demo: true };
export type ConnectionState = {
  transport: "ws" | "poll" | "none";
  state: "connecting" | "open" | "degraded" | "offline";
  lastMessageAt: number | null;
  rttMs: number | null;
};
/** 下单草稿校验失败原因:order-math.validateDraft 返回、terminal.order.errors.<DraftError> 渲染;P1-03 / P1-05 / P1-20 以此为准 */
export type DraftError =
  | "invalidPrice"
  | "invalidQty"
  | "belowMinQty"
  | "offTick"
  | "offStep"
  | "insufficientCash"
  | "insufficientQty"
  | "noLiquidity"
  | "overMaxNotional"
  | "overMaxPrice"; // 价格超过 MAX_PRICE_CENTS 演示上限(§4.8/§4.10 的 order.errors.overMaxPrice)

// ---- 条件单与通知(计划 §6.3.2 C2;Prisma 的 Trigger / Notification 行经 account-mappers 的 toTrigger / toNotice 映射)----
export type TriggerKind = "ORDER" | "ALERT";
/** ABOVE:成交价 ≥ 触发价;BELOW:成交价 ≤ 触发价 */
export type TriggerDirection = "ABOVE" | "BELOW";
export type TriggerStatus = "PENDING" | "TRIGGERING" | "TRIGGERED" | "REJECTED" | "CANCELLED";
/** CANCELLED:USER(本人撤)| OCO(同组另一个已触发);REJECTED:触发时下单被拒的原因(NO_FILL = 市价单一吨也没成交:没钱或没有对手盘) */
export type TriggerReason = "USER" | "OCO" | "INSUFFICIENT_CASH" | "INSUFFICIENT_QTY" | "NO_FILL" | "INVALID";
/**
 * 一条条件单或价格提醒。side / orderType / limitPrice / quantity 只有 ORDER 才有(ALERT 全为 null;limitPrice 只在 LIMIT 时非 null)。
 * triggerPrice / limitPrice / firedPrice 整数分,quantity 整数吨,时间 unix 毫秒。orderId = 触发后生成的委托(未触发或被拒为 null)。
 */
export type Trigger = {
  id: string;
  kind: TriggerKind;
  assetId: string;
  symbol: string;
  direction: TriggerDirection;
  triggerPrice: number;
  side: Side | null;
  orderType: OrderType | null;
  limitPrice: number | null;
  quantity: number | null;
  ocoGroupId: string | null;
  status: TriggerStatus;
  reason: TriggerReason | null;
  orderId: string | null;
  firedPrice: number | null;
  createdAt: number;
  updatedAt: number;
  firedAt: number | null;
};
/**
 * 条件单 / 止盈止损草稿校验失败的原因(order-math 的 validateTriggerDraft、trigger-drafts 的 validateOcoDraft / validateAlertDraft 返回,P3-07 以此为键渲染文案):
 * invalidTrigger = 触发价空 / 非整数 / ≤ 0;invalidPrice = 限价或止盈止损价同样的问题(哪个框见返回的 field);
 * wouldTriggerNow = 触发价与最新价相等(或 ABOVE / BELOW 已被穿过),创建就会触发,服务端同样拒;directionNeeded = 最新价未知又没选方向;
 * overMaxPrice / offTick / invalidQty / belowMinQty / offStep / overMaxNotional 与 DraftError 同一组规则
 *(价格与数量的上限、限价单的名义额上限服务端创建时同样查;offTick / belowMinQty / offStep 服务端不查,和普通下单一样只是客户端的规则);
 * ocoNeedsOne = 止盈止损一个价都没给;takeProfitTooLow = 止盈价不高于最新价(最新价未知时:不高于止损价);stopLossTooHigh = 止损价不低于最新价;overPosition = 数量超过持仓。
 * 不含现金 / 持仓不足(创建时不锁资金、不锁持仓,触发时才检查);overPosition 只用于止盈止损(它要求数量 ≤ 持仓,服务端同样)。
 */
export type TriggerDraftError =
  | "invalidTrigger"
  | "wouldTriggerNow"
  | "directionNeeded"
  | "invalidPrice"
  | "overMaxPrice"
  | "offTick"
  | "invalidQty"
  | "belowMinQty"
  | "offStep"
  | "overMaxNotional"
  | "ocoNeedsOne"
  | "takeProfitTooLow"
  | "stopLossTooHigh"
  | "overPosition";
/** 通知载荷(Notification.payload 的 JSON);kind 与 Notification.kind 列同值:fill | trigger | price_alert */
export type NoticePayload =
  | { kind: "fill"; orderId: string; symbol: string; side: Side; role: "MAKER" | "TAKER"; quantity: number; price: number; orderStatus: OrderStatus }
  | { kind: "trigger"; triggerId: string; symbol: string; outcome: "TRIGGERED" | "REJECTED" | "CANCELLED"; reason: TriggerReason | null; side: Side | null; quantity: number | null; triggerPrice: number; orderId: string | null }
  | { kind: "price_alert"; triggerId: string; symbol: string; direction: TriggerDirection; triggerPrice: number; firedPrice: number };
/** 共享类型叫 Notice,不叫 Notification(与浏览器全局类型撞名) */
export type Notice = { id: string; createdAt: number; readAt: number | null } & NoticePayload;

/** 一组等权指数:level = 100 × (1 + change24h / 100),即「24 小时前 = 100」;change24h 是百分数(同 Ticker.change24h) */
export type IndexRow = { key: string; members: number; counted: number; change24h: number | null; level: number | null; volume24h: number; advancers: number; decliners: number };
export type MarketIndices = { ts: number; all: IndexRow; byRegistry: IndexRow[]; byProjectType: IndexRow[] };
