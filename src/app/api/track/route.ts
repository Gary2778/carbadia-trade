import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { z } from "zod";
import { prisma } from "@/lib/server/db";
import { ok, fail, handle, parseBody } from "@/lib/server/api";
import { clientIp, rateLimit } from "@/lib/server/rate-limit";

const schema = z.object({
  name: z.literal("pageview"), // 客户端只允许报 pageview;漏斗事件全部服务端直写,防伪造
  path: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  try {
    if (!rateLimit(`track:${clientIp(req)}`, 60, 60_000)) return fail("Too many requests, please retry later", 429);
    const { name, path } = await parseBody(req, schema);
    const jar = await cookies();
    let vid = jar.get("cx_vid")?.value;
    // 校验格式:防止客户端塞任意长度的 cookie 值直接落库(占盘攻击)
    if (!vid || !/^[0-9a-f]{16}$/.test(vid)) {
      vid = randomBytes(8).toString("hex");
      jar.set("cx_vid", vid, { httpOnly: true, sameSite: "lax", maxAge: 31_536_000, path: "/" });
    }
    await prisma.event.create({ data: { name, path, visitorId: vid } });
    return ok(true);
  } catch (err) {
    return handle(err);
  }
}
