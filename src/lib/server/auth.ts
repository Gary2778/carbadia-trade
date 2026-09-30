import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";
// 会话 HMAC 的唯一实现在 server/session.mjs(hub 的 upgrade 鉴权也用它);这里只保留密钥来源与 cookie 读写(计划 §3.4、§9.2 D3)
import { DEV_SESSION_SECRET, SESSION_COOKIE_NAME, resolveSessionSecret, signSession, verifySession } from "../../../server/session.mjs";

const COOKIE_NAME = SESSION_COOKIE_NAME;

// 密钥从哪来(SESSION_SECRET,非生产回退 DEV_SESSION_SECRET)只有 server/session.mjs 的 resolveSessionSecret() 一份规则,
// server.mjs 传给 hub 的也是它,dev 下两个 realm 才验得过同一张 cookie;这里只加「生产必须显式配置」的检查:
// 生产环境必须显式配置 SESSION_SECRET(且不能是 dev 回退值),否则任何人都能伪造会话 cookie。
// 故意不在模块顶层抛错:next build 会加载路由模块,顶层 throw 会让构建直接失败;
// 推迟到签名/验签时再检查,构建期不受影响,运行时缺配置则快速失败。
function getSecret(): string {
  const secret = resolveSessionSecret();
  if (!secret || (process.env.NODE_ENV === "production" && secret === DEV_SESSION_SECRET)) {
    throw new Error("SESSION_SECRET must be set in production (and must not be the dev default)");
  }
  return secret;
}

// ---- 密码哈希 (scrypt, 无需额外依赖) ----
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

/**
 * 锁定值:`!` 开头、不是 salt:hash 形状的 passwordHash,任何密码都验不过。做市机器人账户在机器人循环里被改成这种值
 *(bot.ts lockBotCredentials),种子里公开的演示密码因此登不进机器人(P1-25b)。
 */
export const LOCKED_PASSWORD_PREFIX = "!";

export function verifyPassword(password: string, stored: string): boolean {
  if (stored.startsWith(LOCKED_PASSWORD_PREFIX)) return false;
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(derived, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 做市机器人的邮箱域 ----
/**
 * carbadia.bot 整个域保留给做市机器人(prisma/seed.ts 的 mm1/mm2/mm3@carbadia.bot):注册不能占用,不论大小写、库里有没有这个地址。
 * demo 访客地址是 guest-<hex>@demo.carbadia.io,结构上落不进这个域。
 */
export const BOT_EMAIL_DOMAIN = "carbadia.bot";

export function isReservedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${BOT_EMAIL_DOMAIN}`);
}

// ---- 会话 cookie (HMAC 签名的 userId;签名 / 验签本体在 server/session.mjs) ----
function sign(value: string): string {
  return signSession(value, getSecret());
}

function unsign(signed: string): string | null {
  return verifySession(signed, getSecret());
}

export async function createSession(userId: string) {
  const store = await cookies();
  store.set(COOKIE_NAME, sign(userId), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production", // 生产走 HTTPS,防止 cookie 明文传输
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 天
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getCurrentUser() {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const userId = unsign(raw);
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  // 做市机器人不是会话主体:签名验得过也不认,已经发出去的机器人 cookie 随之失效;requireUser 于是对它抛 AuthError(REST 一律 401)。
  // WS 那一侧(hub 只验 HMAC、看不到 isBot)由发布器跳过机器人的 account 事件收口(P1-25a)。
  if (!user || user.isBot) return null;
  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("Not logged in");
  return user;
}

export class AuthError extends Error {}
