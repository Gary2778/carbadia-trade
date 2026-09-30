// 会话与机器人账户(P1-25b):getCurrentUser 对 isBot 用户返回 null,已经发出去的机器人 cookie 随之失效,requireUser 抛 AuthError(REST 一律 401);
// 机器人邮箱域保留(注册占不到);被锁的密码哈希(`!` 开头,非 `salt:hash` 形状)永远验不过。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn<(args: unknown) => Promise<unknown>>(async () => null),
  cookie: "",
}));
vi.mock("./db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => (mocks.cookie ? { value: mocks.cookie } : undefined),
    set: (_name: string, value: string) => {
      mocks.cookie = value;
    },
    delete: () => {
      mocks.cookie = "";
    },
  }),
}));

import { AuthError, createSession, getCurrentUser, hashPassword, isReservedEmail, requireUser, verifyPassword } from "./auth";

const user = (isBot: boolean) => ({ id: isBot ? "bot-1" : "human-1", email: isBot ? "mm1@carbadia.bot" : "a@example.test", isBot });

beforeEach(() => {
  mocks.cookie = "";
  mocks.findUnique.mockReset();
});

describe("getCurrentUser / requireUser", () => {
  it("有效 cookie 指向真人 → 返回该用户", async () => {
    await createSession("human-1");
    mocks.findUnique.mockResolvedValue(user(false));
    await expect(getCurrentUser()).resolves.toMatchObject({ id: "human-1" });
  });

  it("有效 cookie 指向机器人 → null(签名验得过也不认);requireUser 抛 AuthError", async () => {
    await createSession("bot-1");
    mocks.findUnique.mockResolvedValue(user(true));
    await expect(getCurrentUser()).resolves.toBeNull();
    await expect(requireUser()).rejects.toBeInstanceOf(AuthError);
  });

  it("没有 cookie 不查库", async () => {
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe("isReservedEmail", () => {
  it("机器人域 carbadia.bot 保留,大小写与首尾空白不绕得过", () => {
    for (const email of ["mm1@carbadia.bot", "MM1@Carbadia.BOT", " mm4@carbadia.bot ", "new@carbadia.bot"]) expect(isReservedEmail(email)).toBe(true);
  });

  it("其它域(含相似的)不受影响;demo 访客地址不在保留域", () => {
    for (const email of ["a@carbadia.io", "mm1@carbadia.bots", "mm1@notcarbadia.bot.example", "guest-0a1b2c3d@demo.carbadia.io"]) {
      expect(isReservedEmail(email)).toBe(false);
    }
  });
});

describe("verifyPassword", () => {
  it("正常哈希往返", () => {
    const stored = hashPassword("password123");
    expect(verifyPassword("password123", stored)).toBe(true);
    expect(verifyPassword("password124", stored)).toBe(false);
  });

  it("`!` 开头的锁定值(不是 salt:hash)对任何输入都是 false,包括把锁定值本身当密码", () => {
    const locked = `!${"ab".repeat(32)}`;
    for (const guess of ["password123", locked, "", "!", `${"ab".repeat(32)}`]) expect(verifyPassword(guess, locked)).toBe(false);
    // 即使锁定值碰巧带冒号,也不按 salt:hash 去验
    expect(verifyPassword("x", `!salt:${"00".repeat(64)}`)).toBe(false);
  });
});
