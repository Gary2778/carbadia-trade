import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { createSession, hashPassword, isReservedEmail } from "@/lib/server/auth";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp, retryAfterSeconds } from "@/lib/server/rate-limit";

const schema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().min(1, "Name is required").max(40),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export async function POST(req: Request) {
  try {
    const key = `register:${clientIp(req)}`;
    if (!rateLimit(key, 5, 3_600_000)) return fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, 3_600_000)) });
    const { email, name, password } = await parseBody(req, schema);
    // carbadia.bot 域保留给做市机器人:与「已注册」同一个 409,不区分库里有没有这个地址
    if (isReservedEmail(email)) return fail("This email is already registered", 409);
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return fail("This email is already registered", 409);

    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email,
          name,
          passwordHash: hashPassword(password),
          cashBalance: BigInt(10_000_000), // 新用户赠送 $100,000 演示资金(整数分)
        },
      });
      await tx.ledgerEntry.create({ data: { userId: u.id, account: "CASH", delta: BigInt(10_000_000), reason: "GRANT" } });
      return u;
    });
    await createSession(user.id);
    void prisma.event.create({ data: { name: "register" } }).catch(() => {});
    return ok({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    return handle(err);
  }
}
