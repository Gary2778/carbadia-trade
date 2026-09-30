import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { createSession, verifyPassword } from "@/lib/server/auth";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp, retryAfterSeconds } from "@/lib/server/rate-limit";

const schema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(req: Request) {
  try {
    const key = `login:${clientIp(req)}`;
    if (!rateLimit(key, 10, 60_000)) return fail("Too many requests, please retry later", 429, { "Retry-After": String(retryAfterSeconds(key, 60_000)) });
    const { email, password } = await parseBody(req, schema);
    const user = await prisma.user.findUnique({ where: { email } });
    // 做市机器人账户不能登录(种子里它们与演示用户同一个公开密码):与密码错误同一个 401 文案,不泄露账户是否存在
    if (!user || user.isBot || !verifyPassword(password, user.passwordHash)) {
      return fail("Incorrect email or password", 401);
    }
    await createSession(user.id);
    return ok({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    return handle(err);
  }
}
