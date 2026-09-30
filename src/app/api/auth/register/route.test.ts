// 注册不能占用机器人邮箱(P1-25b):carbadia.bot 整个域保留给做市机器人,不论库里有没有这个地址、不论大小写,
// 一律回与「已注册」相同的 409,不建用户、不发 cookie;其它地址照常注册。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn<(args: unknown) => Promise<unknown>>(async () => null),
  transaction: vi.fn<(fn: unknown) => Promise<unknown>>(async () => ({ id: "u-new", email: "new@example.test", name: "New" })),
  cookieSet: vi.fn(),
}));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    user: { findUnique: mocks.findUnique },
    $transaction: mocks.transaction,
    event: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: mocks.cookieSet, delete: () => {} }) }));

import { POST } from "./route";

let ipSeq = 0;
const register = (email: string) =>
  POST(
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      // 注册限流 5 次 / 小时 / IP:每次换一个 IP,用例之间互不影响
      headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++ipSeq}` },
      body: JSON.stringify({ email, name: "Someone", password: "password123" }),
    }),
  );

beforeAll(() => vi.stubEnv("PROXY_SECRET", undefined));
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  mocks.findUnique.mockClear();
  mocks.transaction.mockClear();
  mocks.cookieSet.mockClear();
});

describe("POST /api/auth/register 机器人邮箱", () => {
  it.each(["mm1@carbadia.bot", "MM2@Carbadia.Bot", "mm9@carbadia.bot"])("%s → 409 已注册,不建用户、不发 cookie", async (email) => {
    const res = await register(email);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "This email is already registered" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("对照:普通地址照常注册", async () => {
    const res = await register("new@example.test");
    expect(res.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });
});
