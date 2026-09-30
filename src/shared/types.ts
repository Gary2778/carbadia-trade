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
/** available = 可交易(tradable),locked = 挂单锁定,retired = 已注销(Retirement 按 assetId 聚合) */
export type Position = {
  assetId: string;
  symbol: string;
  quantity: number;
  locked: number;
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
/** = 现有 GET /api/auth/me 的 data 形状 */
export type Me = { id: string; email: string; name: string; cashBalance: number; lockedCash: number } | null;
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
