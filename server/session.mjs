// @ts-check
// 会话 cookie 签名的唯一实现(计划 §3.4 契约表、§9.2 D3):src/lib/server/auth.ts 的 sign/unsign 与 server/ws-hub.mjs 的
// upgrade 鉴权都调用这里,HMAC 只有一份。纯 JS、零模块级状态,可被 Node 直接 import,也会被打进 Next 的两个 realm。
// 格式:`<userId>.<hmac-sha256-hex>`;验签用 timingSafeEqual,失败一律返回 null(不区分原因,不给攻击者信息)。
// 密钥由调用方传入,但「密钥从哪来」的规则也只有 resolveSessionSecret() 一份:生产下缺失或等于公开的 DEV_SESSION_SECRET 都给 undefined
//(fail closed);auth.ts 的 getSecret() 见 undefined 即拒绝签名 / 验签,server.mjs 传给 hub 的 secret 同样取它,hub 见 undefined 即
// 全部连接按匿名处理——两边的检查因此一致(终审 P1-25a:修复前 hub 在生产里照收开发默认值签的 cookie)。
// 非生产没设 SESSION_SECRET 时回退 DEV_SESSION_SECRET:否则本地 dev 里 auth.ts 用回退密钥签的 cookie 到了 hub 这边验不过,/ws 全部匿名。
import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "cx_session";

/** 非生产环境没设 SESSION_SECRET 时的回退密钥。只在这里定义;它随公开快照公开,生产环境用到它即拒绝(resolveSessionSecret 给 undefined) */
export const DEV_SESSION_SECRET = "dev-insecure-secret-change-me";

/**
 * 会话密钥的解析规则:SESSION_SECRET 有值就用它;否则非生产回退 DEV_SESSION_SECRET。生产环境没设、或设成了公开的 DEV_SESSION_SECRET,
 * 都返回 undefined(调用方必须拒绝签名 / 验签:auth.ts 抛错,hub 全部按匿名)。
 * @param {Record<string, string | undefined>} [env] 默认 process.env;测试注入
 * @returns {string | undefined}
 */
export function resolveSessionSecret(env = process.env) {
  const production = env.NODE_ENV === "production";
  const secret = env.SESSION_SECRET || (production ? undefined : DEV_SESSION_SECRET);
  return production && secret === DEV_SESSION_SECRET ? undefined : secret;
}

/**
 * @param {string} value 通常是 userId
 * @param {string} secret
 * @returns {string} `<value>.<hex 签名>`
 */
export function signSession(value, secret) {
  const sig = createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${sig}`;
}

/**
 * @param {string} signed
 * @param {string} secret
 * @returns {string | null} 签名有效则返回原值;缺点、值为空、签名长度或内容不符都返回 null
 */
export function verifySession(signed, secret) {
  if (typeof signed !== "string" || typeof secret !== "string") return null;
  const idx = signed.lastIndexOf(".");
  if (idx <= 0) return null; // 无点,或点前的值为空
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac("sha256", secret).update(value).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return value;
}

/**
 * 从原始 Cookie 请求头里取出 cx_session 的值(未验签)。给 hub 的 upgrade 用:那里没有 next/headers 的 cookies()。
 * 值按 Next 写 cookie 的方式做 decodeURIComponent,保证 hub 看到的字符串与 auth.ts 经 cookies().get() 看到的一致。
 * @param {string | undefined} cookieHeader
 * @returns {string | null}
 */
export function readSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
