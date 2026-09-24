import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { createSession, verifyPassword } from "@/lib/server/auth";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { rateLimit, clientIp } from "@/lib/server/rate-limit";

const schema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(req: Request) {
  try {
    if (!rateLimit(`login:${clientIp(req)}`, 10, 60_000)) return fail("Too many requests, please retry later", 429);
    const { email, password } = await parseBody(req, schema);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return fail("Incorrect email or password", 401);
    }
    await createSession(user.id);
    return ok({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    return handle(err);
  }
}
