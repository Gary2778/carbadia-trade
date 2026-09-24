import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { clientIp, rateLimit } from "@/lib/server/rate-limit";

const schema = z.object({
  message: z.string().min(1).max(2000),
  contact: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  try {
    if (!rateLimit(`feedback:${clientIp(req)}`, 5, 3_600_000)) return fail("Too many requests, please retry later", 429);
    const { message, contact } = await parseBody(req, schema);
    await prisma.feedback.create({ data: { message, contact } });
    return ok(true);
  } catch (err) {
    return handle(err);
  }
}
