import crypto from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";

const COOKIE_NAME = "cx_session";
const DEV_SECRET = "dev-insecure-secret-change-me";

// 生产环境必须显式配置 SESSION_SECRET,否则任何人都能伪造会话 cookie。
// 故意不在模块顶层抛错:next build 会加载路由模块,顶层 throw 会让构建直接失败;
// 推迟到签名/验签时再检查,构建期不受影响,运行时缺配置则快速失败。
function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production" && (!secret || secret === DEV_SECRET)) {
    throw new Error("SESSION_SECRET must be set in production (and must not be the dev default)");
  }
  return secret ?? DEV_SECRET;
}

// ---- 密码哈希 (scrypt, 无需额外依赖) ----
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(derived, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 会话 cookie (HMAC 签名的 userId) ----
function sign(value: string): string {
  const sig = crypto.createHmac("sha256", getSecret()).update(value).digest("hex");
  return `${value}.${sig}`;
}

function unsign(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", getSecret()).update(value).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
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
  return user;
}

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("Not logged in");
  return user;
}

export class AuthError extends Error {}
