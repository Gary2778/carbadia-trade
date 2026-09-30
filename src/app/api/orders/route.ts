import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { MAX_ORDER_QUANTITY, placeOrder } from "@/lib/exchange/matching";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp, retryAfterSeconds } from "@/lib/server/rate-limit";
import { MAX_PRICE_CENTS } from "@/lib/exchange/limits";
import { ledgerIdsByTrade, toFill, toOrder } from "@/lib/server/account-mappers";
import type { PlaceOrderResponse } from "@/shared/api-shapes";

const schema = z.object({
  assetId: z.string().min(1),
  side: z.enum(["BUY", "SELL"]),
  type: z.enum(["LIMIT", "MARKET"]),
  price: z
    .number()
    .int("Price must be an integer amount in cents")
    .positive()
    .max(MAX_PRICE_CENTS)
    .nullable()
    .optional(),
  // MARKET 与 LIMIT 同一个数量上限(P1-25b);MARKET 单的 price 若带了只做格式校验,撮合入口忽略它(落库 null)
  quantity: z.number().int().positive("Quantity must be a positive integer").max(MAX_ORDER_QUANTITY, "Quantity exceeds maximum"),
  // 客户端幂等键:同一用户重放同一 id 返回既有单(200 + replayed: true),不会再下一单
  clientOrderId: z.uuid("clientOrderId must be a UUID").optional(),
});

const WINDOW_MS = 60_000;
/**
 * 429 一律带 Retry-After(计划 §3.4「信封与限流基础件」、§9.1 第 26 条)。
 * 文案沿用全站既有的 "Too many requests, please retry later"(5386cb4 起、main 亦然;login / register / otc / track 同一句),
 * 而不是计划 §3.4 缩写的 "Too many requests"——已在 P1-07 报告里记为偏离,客户端(P1-20)只按状态码 + Retry-After 渲染 toast.rateLimited。
 */
const tooMany = (key: string) => fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, WINDOW_MS)) });

async function withExecutionPrices<
  T extends { id: string; filledQuantity: number },
>(orders: T[]) {
  const ids = orders
    .filter((order) => order.filledQuantity > 0)
    .map((order) => order.id);
  const executions = ids.length
    ? await prisma.trade.findMany({
        where: {
          OR: [{ buyOrderId: { in: ids } }, { sellOrderId: { in: ids } }],
        },
        select: {
          buyOrderId: true,
          sellOrderId: true,
          quantity: true,
          price: true,
        },
      })
    : [];
  const totals = new Map<string, { quantity: number; cost: number }>();
  for (const execution of executions) {
    for (const id of [execution.buyOrderId, execution.sellOrderId]) {
      const total = totals.get(id) ?? { quantity: 0, cost: 0 };
      total.quantity += execution.quantity;
      total.cost += execution.quantity * execution.price;
      totals.set(id, total);
    }
  }
  return orders.map((order) => {
    const total = totals.get(order.id);
    // Maker fills do not update the historical stored average. Use actual
    // executions; if old trades were pruned, report an unknown average.
    const complete =
      !!total &&
      total.quantity === order.filledQuantity &&
      Number.isSafeInteger(total.cost);
    return {
      ...order,
      avgFillPrice: complete ? Math.round(total.cost / total.quantity) : null,
    };
  });
}

export async function POST(req: Request) {
  try {
    // 先按 IP 粗筛(未登录的洪泛也挡),登录后再按用户细限:orders:ip 120/min、orders:user 60/min
    const ipKey = `orders:ip:${clientIp(req)}`;
    if (!rateLimit(ipKey, 120, WINDOW_MS)) return tooMany(ipKey);
    const user = await requireUser();
    const userKey = `orders:user:${user.id}`;
    if (!rateLimit(userKey, 60, WINDOW_MS)) return tooMany(userKey);
    const body = await parseBody(req, schema);
    const prior = await prisma.order.count({ where: { userId: user.id } });
    const result = await placeOrder({
      userId: user.id,
      assetId: body.assetId,
      side: body.side,
      type: body.type,
      price: body.price ?? null,
      quantity: body.quantity,
      clientOrderId: body.clientOrderId ?? null,
    });
    if (prior === 0 && !result.replayed)
      void prisma.event
        .create({ data: { name: "first_order" } })
        .catch(() => {});
    // Fill.ledgerRefs = 本人在该成交下的账本行 id(计划 §3.5):事务提交后一次查询,只在有成交时发生
    const ledgerIds = await ledgerIdsByTrade(prisma, user.id, result.trades.map((trade) => trade.id));
    const data: PlaceOrderResponse = {
      order: toOrder(result.order),
      filledQty: result.filledQty,
      filledCost: result.filledCost,
      fills: result.trades.map((trade) => toFill(trade, user.id, ledgerIds.get(trade.id))),
      replayed: result.replayed,
      // 自成交防护撤掉的本人挂单条数(计划 §9.1 第 41 条);重放时 placeOrder 给 0。终端据此弹 terminal.toast.selfTradeCancelled
      selfTradeCancelled: result.selfTradeCancelled,
    };
    return ok(data, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return handle(err);
  }
}

export async function GET(req: Request) {
  try {
    const user = await requireUser();
    const params = new URL(req.url).searchParams;
    // Existing clients receive the original array. The order workspace opts
    // into pagination so historical orders remain discoverable beyond 50 rows.
    if (params.has("page")) {
      const page = Number(params.get("page"));
      if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000)
        return fail("Invalid order page", 400);
      const status = params.get("status");
      const side = params.get("side");
      if (
        status &&
        !["ACTIVE", "OPEN", "PARTIAL", "FILLED", "CANCELLED"].includes(status)
      )
        return fail("Invalid order status", 400);
      if (side && !["BUY", "SELL"].includes(side))
        return fail("Invalid order side", 400);
      const where = {
        userId: user.id,
        ...(side ? { side } : {}),
        ...(status
          ? {
              status:
                status === "ACTIVE" ? { in: ["OPEN", "PARTIAL"] } : status,
            }
          : {}),
      };
      const [total, orders] = await prisma.$transaction([
        prisma.order.count({ where }),
        prisma.order.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (page - 1) * 25,
          take: 25,
          include: { asset: { select: { symbol: true, name: true } } },
        }),
      ]);
      return ok(
        {
          orders: await withExecutionPrices(orders),
          total,
          page,
          pages: Math.max(1, Math.ceil(total / 25)),
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const orders = await prisma.order.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { asset: { select: { symbol: true, name: true } } },
    });
    return ok(await withExecutionPrices(orders), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    return handle(err);
  }
}
