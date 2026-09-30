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
  Order,
  OrderBookSnapshot,
  OrderType,
  Position,
  Side,
  TapeEntry,
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
/** POST /api/orders 请求体;clientOrderId 为 uuid,重放同一 id 返回既有单 */
export type PlaceOrderRequest = { assetId: string; side: Side; type: OrderType; price?: number | null; quantity: number; clientOrderId?: string };
/**
 * POST /api/orders 响应;重放 200 + replayed: true。
 * selfTradeCancelled:下单前因自成交防护(计划 §9.1 第 41 条,EXPIRE_MAKER)撤掉的本人挂单条数;缺省视为 0(P1-07b 之前的服务端不带)。
 */
export type PlaceOrderResponse = { order: Order; filledQty: number; filledCost: number; fills: Fill[]; replayed: boolean; selfTradeCancelled?: number };
/** GET /api/health;成功体里 db 恒 true(失败走 fail(…, 500));ws 在 START_MODE=next 下为 null */
export type HealthResponse = { db: boolean; bot: boolean; startMode: "custom" | "next"; ws: WsStats | null };
export type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
