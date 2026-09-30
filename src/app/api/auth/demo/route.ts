import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/server/db";
import { createSession, hashPassword } from "@/lib/server/auth";
import { ok, fail, handle } from "@/lib/server/api";
import { clientIp, rateLimit, retryAfterSeconds } from "@/lib/server/rate-limit";

// 一键演示账号:独立沙箱访客,避免公开密码 + 多访客共享同一账号互相踩仓位
export async function POST(req: Request) {
  try {
    const key = `demo:${clientIp(req)}`;
    if (!rateLimit(key, 3, 3_600_000)) {
      return fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, 3_600_000)) });
    }
    const tag = randomBytes(4).toString("hex");
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: `guest-${tag}@demo.carbadia.io`,
          name: "Guest",
          passwordHash: hashPassword(randomBytes(16).toString("hex")), // 不可猜、不外发:账号只活在本次会话里
          cashBalance: BigInt(10_000_000), // 赠金 $100,000(整数分)
        },
      });
      await tx.ledgerEntry.create({ data: { userId: u.id, account: "CASH", delta: BigInt(10_000_000), reason: "GRANT" } });
      return u;
    });
    await createSession(user.id);
    void prisma.event.create({ data: { name: "demo_login" } }).catch(() => {});
    return ok({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    return handle(err);
  }
}
