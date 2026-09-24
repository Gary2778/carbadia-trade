import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { placeOrder } from "@/lib/exchange/matching";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";
import { MAX_PRICE_CENTS } from "@/lib/exchange/limits";

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
  quantity: z.number().int().positive("Quantity must be a positive integer"),
});

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
    if (!rateLimit(`orders:${clientIp(req)}`, 30, 60_000))
      return fail("Too many requests, please retry later", 429);
    const user = await requireUser();
    const body = await parseBody(req, schema);
    const prior = await prisma.order.count({ where: { userId: user.id } });
    const result = await placeOrder({
      userId: user.id,
      assetId: body.assetId,
      side: body.side,
      type: body.type,
      price: body.price ?? null,
      quantity: body.quantity,
    });
    if (prior === 0)
      void prisma.event
        .create({ data: { name: "first_order" } })
        .catch(() => {});
    return ok(result);
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
