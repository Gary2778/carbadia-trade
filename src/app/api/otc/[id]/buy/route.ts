import { z } from "zod";
import { requireUser } from "@/lib/server/auth";
import { buyListing } from "@/lib/exchange/otc";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";

const schema = z.object({ quantity: z.number().int().positive() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    if (!rateLimit(`otcbuy:${clientIp(req)}`, 30, 60_000)) return fail("Too many requests, please retry later", 429);
    const user = await requireUser();
    const { id } = await ctx.params;
    const { quantity } = await parseBody(req, schema);
    const deal = await buyListing(user.id, id, quantity);
    return ok(deal);
  } catch (err) {
    return handle(err);
  }
}
