import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { clientIp, rateLimit, retryAfterSeconds } from "@/lib/server/rate-limit";

const schema = z.object({
  message: z.string().min(1).max(2000),
  contact: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  try {
    const key = `feedback:${clientIp(req)}`;
    if (!rateLimit(key, 5, 3_600_000)) return fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, 3_600_000)) });
    const { message, contact } = await parseBody(req, schema);
    await prisma.feedback.create({ data: { message, contact } });
    return ok(true);
  } catch (err) {
    return handle(err);
  }
}
