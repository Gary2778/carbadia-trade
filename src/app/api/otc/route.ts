import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { requireUser } from "@/lib/server/auth";
import { createListing } from "@/lib/exchange/otc";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";
import { MAX_PRICE_CENTS } from "@/lib/exchange/limits";

export async function GET() {
  try {
    const listings = await prisma.otcListing.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      include: {
        asset: { select: { symbol: true, name: true, standard: true, projectType: true, vintage: true } },
        seller: { select: { name: true } },
      },
    });
    return ok(listings);
  } catch (err) {
    return handle(err);
  }
}

const schema = z.object({
  assetId: z.string().min(1),
  quantity: z.number().int().positive(),
  pricePerUnit: z.number().int("Unit price must be an integer amount in cents").positive().max(MAX_PRICE_CENTS),
  minQuantity: z.number().int().positive().optional(),
});

export async function POST(req: Request) {
  try {
    if (!rateLimit(`otc:${clientIp(req)}`, 30, 60_000)) return fail("Too many requests, please retry later", 429);
    const user = await requireUser();
    const body = await parseBody(req, schema);
    const listing = await createListing({ sellerId: user.id, ...body });
    return ok(listing);
  } catch (err) {
    return handle(err);
  }
}
