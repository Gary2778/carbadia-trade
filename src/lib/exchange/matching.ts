import { prisma } from "../server/db";
import type { Order, Prisma, Trade } from "@/generated/prisma";
import type { OrderBookLevel } from "@/shared/types";
import { MAX_NOTIONAL_CENTS, MAX_PRICE_CENTS } from "./limits";
import { writeLedger, type LedgerLine } from "./ledger";
import { publishOrderResult } from "../server/market-publisher";

export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";

export class TradingError extends Error {}

/**
 * 单笔数量上限(吨),MARKET 与 LIMIT 同一个(P1-25b):= LIMIT 在最低价 1 分时名义额上限允许的数量(MAX_NOTIONAL_CENTS / 1)。
 * 也保证落得进 Order.quantity 的 32 位 INT 列(2,147,483,647);之前 MARKET 没有上限,3e9 让 order.create 抛 P2023 → 500。
 */
export const MAX_ORDER_QUANTITY = MAX_NOTIONAL_CENTS;
/**
 * 并发兜底(计划 §3.4):撮合事务遇到写冲突 / 超时,且按 userId_clientOrderId 重读不到既有单时抛出;
 * handle() 映射为 503 + Retry-After: 1,客户端原样重发同一请求即可(与 retirement.ts 的 503 策略一致)。
 */
export class BusyError extends TradingError {
  constructor(message = "The account is busy. Retry this same request.") {
    super(message);
    this.name = "BusyError";
  }
}

export interface PlaceOrderInput {
  userId: string;
  assetId: string;
  side: Side;
  type: OrderType;
  price?: number | null; // LIMIT 必填, 整数分
  quantity: number; // 整数(吨)
  /** 客户端幂等键(uuid);同一用户重放同一 id 返回既有单而不是再下一单。bot 不传 */
  clientOrderId?: string | null;
}

/** 订单行 + 标的 symbol:发布器与 account-mappers.toOrder 都需要 symbol,这里在事务内顺手带上,免得每个消费者再查一次 */
export type OrderRow = Order & { asset: { symbol: string } };
/** takerSideOf 需要的两张订单的最小字段 */
export type OrderStubRow = Pick<Order, "id" | "type" | "price" | "createdAt">;
/** 成交行 + symbol + 买卖两张订单的存根:toFill / TapeEntry 的 takerSide 由此派生,不落 Trade.takerSide 列(计划 §9.1 第 25 条) */
export type TradeRow = Trade & { asset: { symbol: string }; buyOrder: OrderStubRow; sellOrder: OrderStubRow };

export type PlaceOrderResult = {
  order: OrderRow;
  /** 本次成交数量(吨);重放时为既有单的累计成交量 */
  filledQty: number;
  /** 本次成交金额(分);重放时为既有单全部成交的 Σ price × quantity */
  filledCost: number;
  /** 本次撮合产生的成交;重放为 [] */
  trades: TradeRow[];
  /**
   * 本次被吃到的挂单(更新后的行),以及因自成交防护被撤的本人挂单(status CANCELLED);按撮合遍历的顺序。
   * 发布器对其中每一张发 account 的 order 事件并标脏盘口,被撤的本人挂单因此不需要另开通道。重放为 []
   */
  makerOrders: OrderRow[];
  /** 自成交防护(EXPIRE_MAKER)撤掉的本人挂单条数,即 makerOrders 里 CANCELLED 的那几张;重放为 0 */
  selfTradeCancelled: number;
  /** true = 命中既有 clientOrderId,没有再锁资金、没有再撮合 */
  replayed: boolean;
};
export type CancelOrderResult = { order: OrderRow };

/** SQLite 单写者下并发双击更常见的是 P2034(写冲突)/ P2028(事务超时)/ P1008(操作超时)而不是 P2002(唯一键) */
const CONTENTION_CODES = new Set(["P2002", "P2034", "P2028", "P1008"]);

/**
 * Prisma 已知错误的 code 字段;只认字段,不认类:instrumentation 与 route handler 是两个 bundle,各带一份 Prisma 运行时
 *(计划 §1.4、§3.2 三个 realm),生产下 globalThis.prisma 由 instrumentation 那份创建,请求路径里抛出的错误对本 bundle 的
 * Prisma.PrismaClientKnownRequestError 做 instanceof 恒为 false(2026-09-24 Prisma.sql 跨 bundle 事故的镜像)。
 * 判据:Error 实例(同一 V8 realm,Error 是同一个全局)+ 字符串 code(P 开头的 code 是 Prisma 的命名空间;
 * err.name 也是自有属性 "PrismaClientKnownRequestError",但不再多加一个可能写错的字符串条件)。不是 Error 或没有字符串 code → null。
 * retirement.ts 的 P2002 重放分支也用它。
 */
export function prismaErrorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && typeof code === "string" ? code : null;
}

/** 争用 / 超时错误(code ∈ CONTENTION_CODES):placeOrderTx 按幂等键重读,retirement.ts 映射 503;跨 bundle 同样成立 */
export function isContentionError(err: unknown): boolean {
  const code = prismaErrorCode(err);
  return code != null && CONTENTION_CODES.has(code);
}

/**
 * 撤单的争用集合:由 CONTENTION_CODES 派生、去掉 P2002(以后往 CONTENTION_CODES 加的争用 code 撤单自动跟上,不会回 500)。
 * 下单里 P2002 是幂等键(userId, clientOrderId)的并发重放,按键重读即可;
 * 撤单没有幂等键,撤单事务里的唯一约束失败是真 bug —— 映射成 503「忙」会让客户端永远重试、服务端也不打 [API ERROR](P1-25e)。
 */
const CANCEL_CONTENTION_CODES: ReadonlySet<string> = new Set([...CONTENTION_CODES].filter((code) => code !== "P2002"));

function isCancelContentionError(err: unknown): boolean {
  const code = prismaErrorCode(err);
  return code != null && CANCEL_CONTENTION_CODES.has(code);
}

/** 幂等键命中时既有单必须与本次载荷一致:同一 uuid 配了不同订单是客户端 bug,不能静默返回一张不相干的单当作重放 */
function assertSameOrder(existing: OrderRow, input: { assetId: string; side: Side; type: OrderType; price: number | null; quantity: number }) {
  if (
    existing.assetId !== input.assetId ||
    existing.side !== input.side ||
    existing.type !== input.type ||
    // MARKET 单不看价格:本次载荷里的价格已被忽略(null),而修复前落库的 MARKET 单可能带着客户端当时传的价
    (input.type === "LIMIT" && existing.price !== input.price) ||
    existing.quantity !== input.quantity
  ) {
    throw new TradingError("clientOrderId already used with a different order");
  }
}
const MAX_BOOK_DEPTH = 50;

const ASSET_SYMBOL = { asset: { select: { symbol: true } } } as const;

/** 既有单的重放结果:不锁资金、不撮合,只把累计成交金额算出来 */
async function replayResult(db: Pick<Prisma.TransactionClient, "trade">, order: OrderRow): Promise<PlaceOrderResult> {
  const fills = await db.trade.findMany({
    where: order.side === "BUY" ? { buyOrderId: order.id } : { sellOrderId: order.id },
    select: { price: true, quantity: true },
  });
  const filledCost = fills.reduce((sum, t) => sum + t.price * t.quantity, 0);
  return { order, filledQty: order.filledQuantity, filledCost, trades: [], makerOrders: [], selfTradeCancelled: 0, replayed: true };
}

/**
 * 解冻流水的 reason:用户撤单 ORDER_UNLOCK;自成交防护撤单 SELF_TRADE_UNLOCK(订单表没有撤单原因列、不加迁移,
 * 这是库里唯一能区分两种撤单的地方,计划 §9.1 第 41 条)
 */
type UnlockReason = "ORDER_UNLOCK" | "SELF_TRADE_UNLOCK";

/**
 * 撤掉一张挂单(调用方已确认它是 OPEN / PARTIAL):按剩余量释放冻结——限价买单按挂单价退回现金,卖单解冻持仓——
 * 流水推进 ledger(由调用方写入),状态置 CANCELLED。已成交部分、它的成交与结算流水都不动。
 * 用户撤单(cancelOrderTx)与自成交防护(placeOrderTx 撮合循环)共用这一份释放逻辑。
 */
async function releaseAndCancel(tx: Prisma.TransactionClient, order: Order, reason: UnlockReason, ledger: LedgerLine[]): Promise<Order> {
  const { userId, assetId } = order;
  const remaining = order.quantity - order.filledQuantity;
  if (order.side === "BUY" && order.price != null) {
    const unlock = order.price * remaining;
    await tx.user.update({
      where: { id: userId },
      data: { lockedCash: { decrement: BigInt(unlock) }, cashBalance: { increment: BigInt(unlock) } },
    });
    ledger.push(
      { userId, account: "CASH_LOCKED", delta: -unlock, reason, refType: "ORDER", refId: order.id },
      { userId, account: "CASH", delta: unlock, reason, refType: "ORDER", refId: order.id },
    );
  } else if (order.side === "SELL") {
    await tx.holding.update({
      where: { userId_assetId: { userId, assetId } },
      data: { locked: { decrement: remaining } },
    });
    ledger.push({ userId, account: "HOLDING_LOCKED", assetId, delta: -remaining, reason, refType: "ORDER", refId: order.id });
  }
  return tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
}

const stubOf = (o: OrderStubRow): OrderStubRow => ({ id: o.id, type: o.type, price: o.price, createdAt: o.createdAt });

/**
 * 下单 + 撮合。整个过程在一个事务中完成，保证资金/持仓与订单状态一致。
 * 撮合规则: 价格优先、时间优先。成交价取被动方(挂单方)价格。
 * 自成交防护(EXPIRE_MAKER,计划 §9.1 第 41 条): 遍历到本人挂单时不成交,在同一事务里撤掉它(释放剩余冻结),继续向下撮合;
 * 于是新单若有余量挂出,它前面所有与之价格交叉的本人挂单都已撤掉,盘口不会出现买一 ≥ 卖一。
 * 金额语义: 一切价格/金额均为整数分; JS number 运算, 仅 User.cashBalance/lockedCash 在 Prisma 边界转 BigInt。
 * 幂等: 带 clientOrderId 时事务内先查 userId_clientOrderId,命中即返回既有单(replayed: true);
 * 事务因写冲突 / 超时 / 唯一键失败时再按同一键重读,读到就重放,读不到抛 BusyError。
 * 只负责事务本身;导出的 placeOrder 在事务提交后把结果交给发布器。
 */
export async function placeOrderTx(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const { userId, assetId, side, type } = input;
  const quantity = Math.trunc(input.quantity);
  // MARKET 单忽略客户端传来的价格(P1-25b):按对手盘成交,价格落库为 null,toOrder 不会把一个假价格显示在市价单上
  const price = type === "MARKET" ? null : (input.price ?? null);
  const clientOrderId = input.clientOrderId ?? null;

  if (quantity <= 0) throw new TradingError("Quantity must be a positive integer");
  if (quantity > MAX_ORDER_QUANTITY) throw new TradingError("Quantity exceeds maximum");
  if (type === "LIMIT") {
    if (price == null || price <= 0) throw new TradingError("Limit orders require a price greater than 0");
    if (!Number.isInteger(price)) throw new TradingError("Price must be an integer amount in cents");
    if (price > MAX_PRICE_CENTS) throw new TradingError("Price exceeds maximum");
    if (price * quantity > MAX_NOTIONAL_CENTS) throw new TradingError("Order notional exceeds maximum");
  }

  const payload = { assetId, side, type, price, quantity };

  try {
    return await prisma.$transaction(async (tx) => {
      // ---- 幂等: 事务内先查既有单, 命中(且载荷一致)即返回, 不再锁资金 ----
      if (clientOrderId) {
        const existing = await tx.order.findUnique({
          where: { userId_clientOrderId: { userId, clientOrderId } },
          include: ASSET_SYMBOL,
        });
        if (existing) {
          assertSameOrder(existing, payload);
          return replayResult(tx, existing);
        }
      }

      const asset = await tx.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw new TradingError("Instrument not found");
      const withSymbol = <T>(row: T): T & { asset: { symbol: string } } => ({ ...row, asset: { symbol: asset.symbol } });

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new TradingError("User not found");

      // 审计流水: 事务内累积, 末尾一次 createMany(ref 需订单/成交创建后才可得)
      const ledger: LedgerLine[] = [];

      // ---- 下单前冻结资源 ----
      if (side === "BUY" && type === "LIMIT") {
        const lock = price! * quantity;
        if (Number(user.cashBalance) < lock) throw new TradingError("Insufficient available cash");
        await tx.user.update({
          where: { id: userId },
          data: { cashBalance: { decrement: BigInt(lock) }, lockedCash: { increment: BigInt(lock) } },
        });
      }
      if (side === "SELL") {
        const holding = await tx.holding.findUnique({
          where: { userId_assetId: { userId, assetId } },
        });
        const available = (holding?.quantity ?? 0) - (holding?.locked ?? 0);
        if (available < quantity) throw new TradingError("Insufficient available holdings");
        await tx.holding.update({
          where: { userId_assetId: { userId, assetId } },
          data: { locked: { increment: quantity } },
        });
      }

      // ---- 创建 taker 订单 ----
      const takerOrder = await tx.order.create({
        data: { userId, assetId, side, type, price, quantity, status: "OPEN", clientOrderId },
      });

      // 冻结流水(冻结发生在订单创建前, ref 统一挂 taker 订单)
      if (side === "BUY" && type === "LIMIT") {
        const lock = price! * quantity;
        ledger.push(
          { userId, account: "CASH", delta: -lock, reason: "ORDER_LOCK", refType: "ORDER", refId: takerOrder.id },
          { userId, account: "CASH_LOCKED", delta: lock, reason: "ORDER_LOCK", refType: "ORDER", refId: takerOrder.id },
        );
      }
      if (side === "SELL") {
        ledger.push({ userId, account: "HOLDING_LOCKED", assetId, delta: quantity, reason: "ORDER_LOCK", refType: "ORDER", refId: takerOrder.id });
      }

      // ---- 拉取对手方挂单(含本人的:遍历到时按自成交防护撤掉,见下) ----
      const candidates = await tx.order.findMany({
        where: {
          assetId,
          status: { in: ["OPEN", "PARTIAL"] },
          side: side === "BUY" ? "SELL" : "BUY",
          ...(type === "LIMIT"
            ? side === "BUY"
              ? { price: { lte: price! } }
              : { price: { gte: price! } }
            : {}),
        },
        orderBy: side === "BUY" ? [{ price: "asc" }, { createdAt: "asc" }] : [{ price: "desc" }, { createdAt: "asc" }],
      });

      let remaining = quantity;
      let filledCost = 0; // 已成交金额
      let filledQty = 0;
      let takerCash = Number(user.cashBalance); // 市价买单实时余额(限价买已冻结)
      const trades: TradeRow[] = [];
      const makerOrders: OrderRow[] = [];
      let selfTradeCancelled = 0;

      for (const maker of candidates) {
        if (remaining <= 0) break;
        const makerRemaining = maker.quantity - maker.filledQuantity;
        if (makerRemaining <= 0) continue;
        const fp = maker.price!; // 挂单一定是限价单, price 非空

        let q = Math.min(remaining, makerRemaining);

        // 市价买单受可用现金约束
        if (side === "BUY" && type === "MARKET") {
          const affordable = Math.floor(takerCash / fp);
          q = Math.min(q, affordable);
          if (q <= 0) break;
        }

        // 自成交防护:这一笔会与本人挂单成交 → 不成交,撤掉那张挂单(只释放它的剩余部分,已成交的不动),接着看下一张。
        // 放在上面的 break 之后:新单本来就够不着的本人挂单(市价买钱不够)不撤;新单吃满后循环在开头就停,更深的本人挂单也不撤。
        if (maker.userId === userId) {
          const cancelled = await releaseAndCancel(tx, maker, "SELF_TRADE_UNLOCK", ledger);
          makerOrders.push(withSymbol(cancelled));
          selfTradeCancelled += 1;
          continue;
        }

        const buyerId = side === "BUY" ? userId : maker.userId;
        const sellerId = side === "BUY" ? maker.userId : userId;
        const buyerIsTaker = side === "BUY";
        const amount = fp * q;

        // --- 资金结算 ---
        // 卖方收款(进可用余额)
        await tx.user.update({ where: { id: sellerId }, data: { cashBalance: { increment: BigInt(amount) } } });
        // 买方付款
        if (buyerIsTaker) {
          if (type === "MARKET") {
            await tx.user.update({ where: { id: buyerId }, data: { cashBalance: { decrement: BigInt(amount) } } });
            takerCash -= amount;
          } else {
            // 限价买 taker: 按下单价冻结, 成交价更优时退还差额
            // 冻结解除必须按下单价(price×q)而非成交价(amount), 否则差额会同时留在冻结里又退进余额
            const refund = (price! - fp) * q;
            await tx.user.update({
              where: { id: buyerId },
              data: { lockedCash: { decrement: BigInt(price! * q) }, cashBalance: { increment: BigInt(refund) } },
            });
          }
        } else {
          // 买方是挂单方: 按其挂单价(=fp)冻结, 直接从冻结扣除
          await tx.user.update({ where: { id: buyerId }, data: { lockedCash: { decrement: BigInt(amount) } } });
        }

        // --- 持仓结算 ---
        // 卖方交付(卖方下单时已冻结)
        await tx.holding.update({
          where: { userId_assetId: { userId: sellerId, assetId } },
          data: { quantity: { decrement: q }, locked: { decrement: q } },
        });
        // 买方收货
        await tx.holding.upsert({
          where: { userId_assetId: { userId: buyerId, assetId } },
          create: { userId: buyerId, assetId, quantity: q, locked: 0 },
          update: { quantity: { increment: q } },
        });

        // --- 更新挂单 ---
        const makerNewFilled = maker.filledQuantity + q;
        const updatedMaker = await tx.order.update({
          where: { id: maker.id },
          data: {
            filledQuantity: makerNewFilled,
            status: makerNewFilled >= maker.quantity ? "FILLED" : "PARTIAL",
          },
        });
        makerOrders.push(withSymbol(updatedMaker));

        // --- 成交记录 ---
        const trade = await tx.trade.create({
          data: {
            assetId,
            buyOrderId: buyerIsTaker ? takerOrder.id : maker.id,
            sellOrderId: buyerIsTaker ? maker.id : takerOrder.id,
            buyerId,
            sellerId,
            price: fp,
            quantity: q,
          },
        });
        trades.push({
          ...withSymbol(trade),
          buyOrder: stubOf(buyerIsTaker ? takerOrder : maker),
          sellOrder: stubOf(buyerIsTaker ? maker : takerOrder),
        });

        // 结算流水(与上方资金/持仓结算逐一对应)
        ledger.push({ userId: sellerId, account: "CASH", delta: amount, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
        if (buyerIsTaker) {
          if (type === "MARKET") {
            ledger.push({ userId: buyerId, account: "CASH", delta: -amount, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
          } else {
            ledger.push({ userId: buyerId, account: "CASH_LOCKED", delta: -(price! * q), reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
            const refund = (price! - fp) * q;
            if (refund > 0) {
              ledger.push({ userId: buyerId, account: "CASH", delta: refund, reason: "PRICE_IMPROVE_REFUND", refType: "TRADE", refId: trade.id });
            }
          }
        } else {
          ledger.push({ userId: buyerId, account: "CASH_LOCKED", delta: -amount, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id });
        }
        ledger.push(
          { userId: sellerId, account: "HOLDING", assetId, delta: -q, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id },
          { userId: sellerId, account: "HOLDING_LOCKED", assetId, delta: -q, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id },
          { userId: buyerId, account: "HOLDING", assetId, delta: q, reason: "TRADE_SETTLE", refType: "TRADE", refId: trade.id },
        );

        remaining -= q;
        filledQty += q;
        filledCost += amount;
      }

      // ---- 处理 taker 剩余 ----
      let finalStatus: string;
      if (remaining === 0) {
        finalStatus = "FILLED";
      } else if (type === "LIMIT") {
        finalStatus = filledQty > 0 ? "PARTIAL" : "OPEN"; // 挂在订单簿上
      } else {
        finalStatus = "CANCELLED"; // 市价单剩余撤销(映射层据 MARKET + CANCELLED 派生 cancelReason MARKET_REMAINDER)
        if (side === "SELL") {
          await tx.holding.update({
            where: { userId_assetId: { userId, assetId } },
            data: { locked: { decrement: remaining } },
          });
          ledger.push({ userId, account: "HOLDING_LOCKED", assetId, delta: -remaining, reason: "ORDER_UNLOCK", refType: "ORDER", refId: takerOrder.id });
        }
      }

      const updatedTaker = await tx.order.update({
        where: { id: takerOrder.id },
        data: {
          filledQuantity: filledQty,
          status: finalStatus,
          avgFillPrice: filledQty > 0 ? Math.round(filledCost / filledQty) : null, // 展示用参考价, 允许 ±1 分舍入
        },
      });

      if (filledQty > 0) {
        const lastPrice = Math.round(filledCost / filledQty);
        await tx.asset.update({ where: { id: assetId }, data: { lastPrice } });
      }

      await writeLedger(tx, ledger);

      return { order: withSymbol(updatedTaker), filledQty, filledCost, trades, makerOrders, selfTradeCancelled, replayed: false };
    });
  } catch (err) {
    // 并发兜底(计划 §3.4):写冲突 / 事务超时 / Order_userId_clientOrderId_key 唯一键——按同一幂等键重读,
    // 读到说明另一次提交已经落库,按重放返回;读不到(或根本没带 clientOrderId)让客户端原样重发。其它错误原样抛。
    if (isContentionError(err)) {
      if (clientOrderId) {
        const existing = await prisma.order.findUnique({
          where: { userId_clientOrderId: { userId, clientOrderId } },
          include: ASSET_SYMBOL,
        });
        if (existing) {
          assertSameOrder(existing, payload);
          return replayResult(prisma, existing);
        }
      }
      throw new BusyError();
    }
    throw err;
  }
}

/** 下单:事务提交(Promise resolve)后把结果交给发布器,失败的事务永不进总线;发布不 await */
export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const result = await placeOrderTx(input);
  publishOrderResult(result);
  return result;
}

/**
 * 撤单事务。写锁争用 / 超时(code ∈ CANCEL_CONTENTION_CODES:P1008 / P2028 / P2034)与下单一样抛 BusyError → 503 + Retry-After: 1
 *(P1-25b;之前原样抛出 P1008,handle() 回 500 并打 [API ERROR])。P2002 不在其中(见 CANCEL_CONTENTION_CODES),原样抛出。
 * 撤单天然幂等:重发时单子若已撤,回 400 "Order can no longer be cancelled"。
 */
export async function cancelOrderTx(userId: string, orderId: string): Promise<CancelOrderResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: orderId }, include: ASSET_SYMBOL });
      if (!order) throw new TradingError("Order not found");
      if (order.userId !== userId) throw new TradingError("Not your order");
      if (!["OPEN", "PARTIAL"].includes(order.status)) throw new TradingError("Order can no longer be cancelled");

      const ledger: LedgerLine[] = [];
      const cancelled = await releaseAndCancel(tx, order, "ORDER_UNLOCK", ledger);
      await writeLedger(tx, ledger);
      return { order: { ...cancelled, asset: order.asset } };
    });
  } catch (err) {
    if (isCancelContentionError(err)) throw new BusyError();
    throw err;
  }
}

/** 撤单:事务提交后交给发布器,同 placeOrder */
export async function cancelOrder(userId: string, orderId: string): Promise<CancelOrderResult> {
  const result = await cancelOrderTx(userId, orderId);
  publishOrderResult(result);
  return result;
}

/** 聚合订单簿(买卖各价位档位,每档带挂单笔数);depth 夹在 1..50 */
export async function getOrderBook(assetId: string, depth = 12): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] }> {
  const take = Math.min(MAX_BOOK_DEPTH, Math.max(1, Math.trunc(depth) || 0));
  const open = await prisma.order.findMany({
    where: { assetId, status: { in: ["OPEN", "PARTIAL"] }, type: "LIMIT" },
    select: { side: true, price: true, quantity: true, filledQuantity: true },
  });

  const agg = (s: Side): OrderBookLevel[] => {
    const map = new Map<number, { quantity: number; orders: number }>();
    for (const o of open) {
      if (o.side !== s || o.price == null) continue;
      const rem = o.quantity - o.filledQuantity;
      if (rem <= 0) continue;
      const level = map.get(o.price) ?? { quantity: 0, orders: 0 };
      level.quantity += rem;
      level.orders += 1;
      map.set(o.price, level);
    }
    return [...map.entries()]
      .map(([price, { quantity, orders }]) => ({ price, quantity, orders }))
      .sort((a, b) => (s === "BUY" ? b.price - a.price : a.price - b.price))
      .slice(0, take);
  };

  return { bids: agg("BUY"), asks: agg("SELL") };
}

export type OrderBook = Awaited<ReturnType<typeof getOrderBook>>;
export type TxClient = Prisma.TransactionClient;
