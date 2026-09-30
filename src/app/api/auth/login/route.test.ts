// 429 带 Retry-After(计划 §3.4「429 一律 fail(..., 429, { Retry-After })」):经真实路由断言响应头,窗口与 rateLimit 调用一致(login 60 s)。
// 做市机器人账户不能登录(P1-25b):种子里 mm1/mm2/mm3@carbadia.bot 与演示用户同一个公开密码,密码对了也回 401,文案与密码错误相同。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 不需要数据库:findUnique 默认返回 null → 401,前 10 次都走到这里;第 11 次在限流处就返回
const mocks = vi.hoisted(() => ({
  findUnique: vi.fn<(args: unknown) => Promise<unknown>>(async () => null),
  cookieSet: vi.fn(),
}));
vi.mock("@/lib/server/db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: mocks.cookieSet, delete: () => {} }) }));

import { hashPassword } from "@/lib/server/auth";
import { POST } from "./route";

const attempt = (ip: string, body: { email: string; password: string } = { email: "nobody@example.test", password: "wrong" }) =>
  POST(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );

beforeAll(() => vi.stubEnv("PROXY_SECRET", undefined)); // 无反代密钥:xff 末跳就是分桶 IP
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue(null);
  mocks.cookieSet.mockClear();
});

describe("POST /api/auth/login 限流", () => {
  it("同一 IP 第 11 次 → 429,带 Retry-After(1..60 的整数秒)", async () => {
    for (let i = 0; i < 10; i++) expect((await attempt("203.0.113.7")).status).toBe(401);
    const res = await attempt("203.0.113.7");
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Too many requests, please retry later" });
  });

  it("另一个 IP 不受影响", async () => {
    expect((await attempt("203.0.113.8")).status).toBe(401);
  });
});

describe("POST /api/auth/login 机器人账户", () => {
  const SEED_PASSWORD = "password123"; // prisma/seed.ts 给演示用户与机器人的同一个公开密码
  const account = (isBot: boolean) => ({
    id: isBot ? "bot-mm1" : "human-alice",
    email: isBot ? "mm1@carbadia.bot" : "alice@carbadia.io",
    name: isBot ? "做市商 MM1" : "Alice",
    passwordHash: hashPassword(SEED_PASSWORD),
    isBot,
  });

  it("mm1@carbadia.bot + 种子密码 → 401,文案与密码错误相同,不发 cookie", async () => {
    mocks.findUnique.mockResolvedValue(account(true));
    const res = await attempt("198.51.100.1", { email: "mm1@carbadia.bot", password: SEED_PASSWORD });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Incorrect email or password" });
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("对照:同一密码的真人账户照常登录(200 + 发 cookie)", async () => {
    mocks.findUnique.mockResolvedValue(account(false));
    const res = await attempt("198.51.100.2", { email: "alice@carbadia.io", password: SEED_PASSWORD });
    expect(res.status).toBe(200);
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });

  it("不存在的账户与机器人账户回同一个 401 响应体(不泄露账户存在)", async () => {
    const missing = await (await attempt("198.51.100.3", { email: "mm9@carbadia.bot", password: SEED_PASSWORD })).json();
    mocks.findUnique.mockResolvedValue(account(true));
    const bot = await (await attempt("198.51.100.3", { email: "mm1@carbadia.bot", password: SEED_PASSWORD })).json();
    expect(bot).toEqual(missing);
  });
});
