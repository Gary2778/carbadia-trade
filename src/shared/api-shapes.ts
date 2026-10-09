// REST 形状(计划 §3.4 路由表、§3.5)。REST 快照形状 = 轮询降级时的帧来源,与 WS 事件同形。
// 信封 { ok: true, data } / { ok: false, error } 不变;下面的类型都是 data 的形状。
import type { WsStats } from "./bus";
import type { FILL_DISCLOSURE } from "./constants";
import type {
  Balance,
  CandleBar,
  CandleInterval,
  FeeSchedule,
  Fill,
  InstrumentListItem,
  LedgerLineView,
  MarketIndices,
  Notice,
  Order,
  OrderBookSnapshot,
  OrderType,
  Position,
  Side,
  TapeEntry,
  Trigger,
  TriggerDirection,
} from "./types";

/** GET /api/market/instruments(进程缓存 2 s;ticker.change24h 为百分数) */
export type InstrumentsResponse = { instruments: InstrumentListItem[]; feeSchedule: FeeSchedule; serverTime: number };
/** GET /api/market/[symbol]/book?depth=50;seq = hub 的 __carbadiaTopicSeq["book:SYM"],无 hub 时 0 */
export type BookResponse = OrderBookSnapshot & { seq: number };
/** GET /api/market/[symbol]/trades?limit=100&before=<ms>;seq 同上("trades:SYM") */
export type TradesResponse = { trades: TapeEntry[]; seq: number };
/** GET /api/market/[symbol]/candles?interval=1m&limit=500&to=<ms> */
export type CandlesResponse = { interval: CandleInterval; candles: CandleBar[] };
/** GET /api/account/orders?status=open|history&symbol=&cursor=&limit=50;键集分页 createdAt desc, id desc */
export type AccountOrdersResponse = { orders: Order[]; nextCursor: string | null };
/** GET /api/account/fills?symbol=&cursor=&limit=50 */
export type FillsResponse = { fills: Fill[]; nextCursor: string | null };
/** GET /api/account/fills/[id];非买卖双方 404;ledger = 本人在该成交下的账本行 */
export type FillDetailResponse = { fill: Fill; ledger: LedgerLineView[]; counterpartyIsBot: boolean; disclosure: typeof FILL_DISCLOSURE };
/** GET /api/account/positions */
export type PositionsResponse = { positions: Position[]; balance: Balance };
/** 账本账户:CASH / CASH_LOCKED 的 delta 是整数分,HOLDING / HOLDING_LOCKED 是整数吨(与 src/lib/exchange/ledger.ts 的写入器同一联合) */
export type LedgerAccount = "CASH" | "CASH_LOCKED" | "HOLDING" | "HOLDING_LOCKED";
/**
 * 流水分类(计划 §6.2.2 C4):给人看的类别,一个 type 对应一组账本 reason(买卖还要看账户与正负)。
 * 分类规则与筛选映射在 src/lib/exchange/ledger-activity.ts(activityOf / activityFilter)。
 */
export type ActivityType =
  | "BUY" | "SELL" | "SETTLEMENT"
  | "OTC_BUY" | "OTC_SELL" | "OTC_SETTLEMENT"
  | "RETIREMENT" | "RESERVE" | "RELEASE" | "REFUND"
  | "GRANT" | "OPENING_BALANCE" | "ADJUSTMENT";
/**
 * 一行账户流水。ts = 入账时刻(unix ms);delta 带符号(分或吨,看 account);label 是英文标签(旧 /transactions 页用,
 * 终端按 type 取 i18n 文案);assetId / symbol:现金行本身不带标的,由同一引用下本人的持仓行或订单补出,补不出为 null。
 * isScenario:这一行解析出的标的是不是情景标的(持仓的单位写「情景单位」而不是「份信用」);没有标的的行恒为 false。
 */
export type LedgerActivity = {
  id: string; ts: number; account: LedgerAccount; type: ActivityType; label: string; reason: string;
  assetId: string | null; symbol: string | null; isScenario: boolean; delta: number; refType: string | null; refId: string | null;
};
/**
 * GET /api/transactions?limit=50&cursor=&account=&type=&symbol=&from=&to=;键集分页 createdAt desc, id desc,
 * 游标同 /api/account/orders;from ≤ ts < to(毫秒);不返回总数。
 */
export type LedgerActivityResponse = { items: LedgerActivity[]; nextCursor: string | null };
/**
 * 账户合计(计划 §6.2.2 C6):由 src/shared/account-totals.ts 的 computeAccountTotals 算出,服务端与客户端同一个函数。
 * holdingsValue / totalAssets / unrealisedPnl 是整数分;totalAssets = cashBalance + lockedCash + holdingsValue。
 * heldCredits / retiredCredits 是吨:heldCredits 不含情景标的(情景单位不是信用,与旧 /api/portfolio 同一口径),retiredCredits = 各持仓 retired 之和。
 * valuationComplete:持有的标的都有价格;为 false 时没有价格的那几个不计入 holdingsValue(合计偏小,界面要标出来)。
 * costBasisComplete:持有的标的成本都完整。unrealisedPnl 只在两者都为 true 时给数,否则 null(不把缺的成本或价格当成 0)。
 * unrealisedPnl 的成本取持仓行上服务端取整后的那一份:客户端不改写已存 Position 行的 lastPrice / marketValue / unrealisedPnl,
 * 实时价只经 computeAccountTotals 的 priceOf(逐行用 unrealisedPnlAt)传入。
 */
export type AccountTotals = {
  holdingsValue: number; totalAssets: number;
  heldCredits: number; retiredCredits: number;
  unrealisedPnl: number | null;
  valuationComplete: boolean; costBasisComplete: boolean;
};
/**
 * 账户 24 小时资产变化(计划 §6.2.2 C6、§9.2 D29):从账本倒推,不是快照表。
 * since:基准时刻(unix ms)= 现在往前 24 小时、再向下对齐到 10 分钟(所以窗口是 24 小时到 24 小时 10 分之间);
 * baseline:since 时刻的账户资产,加上窗口内赠予的现金与持仓(赠予不算盈亏;GRANT / SEED / MIGRATION_BASELINE 的正行,
 *   现金含冻结现金账户),整数分;
 * amount:窗口内交易与行情带来的变化,整数分,带符号(窗口内注销掉的持仓按现价加回,不算亏损);
 * pct:amount / baseline,**小数比例**(0.0123 = +1.23%;与 Ticker.change24h 的百分数不同),baseline ≤ 0 时为 null。
 * 注销掉的份额按现价加回,所以注销后最多 24 小时里它仍随价格浮动:界面文案只叫「24 小时变化」,不要叫持仓盈亏。
 * 取不到需要的价格、或倒推出负的余额 / 数量时,整个值是 null(AccountOverview.change24h)。
 */
export type EquityChange = { amount: number; pct: number | null; baseline: number; since: number };
/** 本人一条 ACTIVE 的场外挂牌;quantity 是剩余可售数量(吨),pricePerUnit 整数分 / 吨,createdAt unix ms */
export type OtcListingView = { id: string; assetId: string; symbol: string; quantity: number; pricePerUnit: number; minQuantity: number; createdAt: number };
/**
 * 资产总览。positions 含整仓注销的行(quantity 0、retired > 0),与 GET /api/account/positions 同一份读取;
 * change24h 算不出(取不到价格、账本对不上、没有任何账本行)就是 null,界面显示「—」;otcListings 只有本人 ACTIVE 的挂牌,新的在前。
 */
export type AccountOverview = {
  balance: Balance;
  positions: Position[];
  totals: AccountTotals;
  change24h: EquityChange | null;
  otcListings: OtcListingView[];
};
/** GET /api/account/overview */
export type AccountOverviewResponse = AccountOverview;
/**
 * GET /api/account/overview?parts=extras(精简模式,P2-13):只有总览里这个接口独有的两样。资产页第一次取全量、用它落账户 store,
 * 之后持仓与余额跟 store,重取只要这两样 —— 服务端于是不做持仓的成本回放(只读余额、持仓行与现价、24 小时窗口、ACTIVE 挂牌)。
 * 两个字段与全量响应里的同名字段同一口径、同一份计算。
 */
export type AccountOverviewExtras = Pick<AccountOverview, "change24h" | "otcListings">;
export type AccountOverviewExtrasResponse = AccountOverviewExtras;
/** POST /api/orders 请求体;clientOrderId 为 uuid,重放同一 id 返回既有单 */
export type PlaceOrderRequest = { assetId: string; side: Side; type: OrderType; price?: number | null; quantity: number; clientOrderId?: string };
/**
 * POST /api/orders 响应;重放 200 + replayed: true。
 * selfTradeCancelled:下单前因自成交防护(计划 §9.1 第 41 条,EXPIRE_MAKER)撤掉的本人挂单条数;缺省视为 0(P1-07b 之前的服务端不带)。
 */
export type PlaceOrderResponse = { order: Order; filledQty: number; filledCost: number; fills: Fill[]; replayed: boolean; selfTradeCancelled?: number };
/** POST /api/account/triggers(kind = ORDER):触发后以 MARKET / LIMIT 下单;limitPrice 只在 orderType = LIMIT 时给;clientKey 是创建幂等键,重发同一个返回同一条 */
export type CreateOrderTriggerRequest = {
  kind: "ORDER";
  assetId: string;
  direction: TriggerDirection;
  triggerPrice: number;
  side: Side;
  orderType: OrderType;
  limitPrice?: number | null;
  quantity: number;
  clientKey: string;
};
/** POST /api/account/triggers(kind = ALERT):价格提醒,不下单 */
export type CreateAlertRequest = { kind: "ALERT"; assetId: string; direction: TriggerDirection; triggerPrice: number; clientKey: string };
/** POST /api/account/triggers 请求体,按 kind 区分 */
export type CreateTriggerRequest = CreateOrderTriggerRequest | CreateAlertRequest;
/** POST /api/account/triggers 与 DELETE /api/account/triggers/[id] 的响应(同一个 clientKey 重发返回同一条;DELETE 只有 PENDING 能撤,否则 409) */
export type TriggerResponse = { trigger: Trigger };
/** POST /api/account/triggers/oco:止盈止损成对(SELL MARKET);takeProfit / stopLoss 至少给一个,价格整数分,quantity 整数吨 */
export type CreateOcoRequest = { assetId: string; quantity: number; takeProfit?: number | null; stopLoss?: number | null; clientKey: string };
/**
 * 创建条件单的业务字段(请求体去掉 kind 与幂等键 clientKey,limitPrice 恒显式:MARKET 为 null):
 * order-math 的 validateTriggerDraft 通过时给出它,客户端的 submitOrderTrigger 以它为输入并补上 kind 与 clientKey
 */
export type OrderTriggerFields = { assetId: string; direction: TriggerDirection; triggerPrice: number; side: Side; orderType: OrderType; limitPrice: number | null; quantity: number };
/** 价格提醒的业务字段(trigger-drafts 的 validateAlertDraft 的输出,submitAlert 的输入) */
export type AlertFields = { assetId: string; direction: TriggerDirection; triggerPrice: number };
/** 止盈止损的业务字段(trigger-drafts 的 validateOcoDraft 的输出,submitOco 的输入);takeProfit / stopLoss 至少一个非 null */
export type OcoFields = { assetId: string; quantity: number; takeProfit: number | null; stopLoss: number | null };
/** POST /api/account/triggers/oco 响应:1 或 2 条,同一 ocoGroupId */
export type CreateOcoResponse = { triggers: Trigger[] };
/** GET /api/account/triggers?status=open|history&cursor&limit;open = PENDING / TRIGGERING;键集分页同 /api/account/orders */
export type AccountTriggersResponse = { triggers: Trigger[]; nextCursor: string | null };
/** GET /api/account/notices?cursor&limit;新的在前;unread = 本人全部未读条数(不只本页) */
export type NoticesResponse = { items: Notice[]; nextCursor: string | null; unread: number };
/** POST /api/account/notices/read:ids = 指定几条,all = 全部标已读 */
export type MarkNoticesReadRequest = { ids: string[] } | { all: true };
export type MarkNoticesReadResponse = { unread: number };
/** GET /api/market/indices(public, max-age=1, s-maxage=5, swr=10);标「模拟指数,24 小时前 = 100」 */
export type MarketIndicesResponse = MarketIndices;
/** 数据卷用量(看门狗深探):与 df 同一口径,三个数都取整 */
export type DiskUsage = { totalMb: number; freeMb: number; usedPct: number };
/**
 * GET /api/health;成功体里 db 恒 true(失败走 fail(…, 500));ws 在 START_MODE=next 下为 null。
 * 请求头 x-watchdog-secret 与 WATCHDOG_SECRET 相等时多 write / writeError / disk(写一次 Heartbeat 表 + 卷用量),否则没有这三个字段。
 */
export type HealthResponse = {
  db: boolean;
  bot: boolean;
  startMode: "custom" | "next";
  ws: WsStats | null;
  write?: boolean;
  writeError?: string;
  disk?: DiskUsage | null;
};
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
