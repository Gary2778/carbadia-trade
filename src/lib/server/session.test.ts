// server/session.mjs 是会话 HMAC 的唯一实现:往返、篡改、缺点、cookie 头解析,以及「auth.ts 的 createSession / getCurrentUser
// 用的就是同一实现」——mock next/headers 的 cookies() 捕获写出的值,用 verifySession 直接校验;反向再用 signSession 造 cookie 喂 getCurrentUser。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEV_SESSION_SECRET, SESSION_COOKIE_NAME, readSessionCookie, resolveSessionSecret, signSession, verifySession } from "../../../server/session.mjs";

const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, email: `${where.id}@example.test` })),
}));

// createSession / getCurrentUser 不需要真实数据库;避免在这里加载生成的 Prisma client
vi.mock("./db", () => ({ prisma: { user: { findUnique: state.findUnique } } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
    },
    delete: (name: string) => {
      state.cookies.delete(name);
    },
  }),
}));

const SECRET = "test-session-secret";

describe("signSession / verifySession", () => {
  it("往返:签名后验签得到原值,签名是 64 位 hex", () => {
    const signed = signSession("user_abc", SECRET);
    expect(signed).toMatch(/^user_abc\.[0-9a-f]{64}$/);
    expect(verifySession(signed, SECRET)).toBe("user_abc");
  });

  it("值本身含点也能往返(按最后一个点切分)", () => {
    expect(verifySession(signSession("a.b.c", SECRET), SECRET)).toBe("a.b.c");
  });

  it("篡改签名一位失败", () => {
    const signed = signSession("user_abc", SECRET);
    const last = signed.at(-1)!;
    const flipped = signed.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(verifySession(flipped, SECRET)).toBeNull();
  });

  it("篡改值(换个 userId、保留签名)失败", () => {
    const sig = signSession("user_abc", SECRET).split(".")[1];
    expect(verifySession(`user_xyz.${sig}`, SECRET)).toBeNull();
  });

  it("换密钥失败", () => {
    expect(verifySession(signSession("user_abc", SECRET), "another-secret")).toBeNull();
  });

  it("缺点、空串、值为空、签名长度不对都失败", () => {
    expect(verifySession("user_abc", SECRET)).toBeNull();
    expect(verifySession("", SECRET)).toBeNull();
    expect(verifySession(`.${"0".repeat(64)}`, SECRET)).toBeNull();
    expect(verifySession("user_abc.deadbeef", SECRET)).toBeNull();
  });
});

describe("readSessionCookie", () => {
  it("没有 Cookie 头、没有该 cookie、值为空都返回 null", () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie("")).toBeNull();
    expect(readSessionCookie("theme=dark; other=1")).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it("从多个 cookie 里取出 cx_session(不匹配前缀相似的名字)", () => {
    const signed = signSession("user_abc", SECRET);
    expect(readSessionCookie(`theme=dark; x${SESSION_COOKIE_NAME}=nope;  ${SESSION_COOKIE_NAME}=${signed} ; z=1`)).toBe(signed);
  });

  it("值按 URL 编码解码(与 Next 写 cookie 的 encodeURIComponent 对称)", () => {
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=${encodeURIComponent("a b.c")}`)).toBe("a b.c");
    expect(readSessionCookie(`${SESSION_COOKIE_NAME}=%E0%A4%A`)).toBe("%E0%A4%A"); // 非法编码原样返回,交给验签去拒绝
  });

  it("取出的值能直接验签", () => {
    const signed = signSession("user_abc", SECRET);
    expect(verifySession(readSessionCookie(`${SESSION_COOKIE_NAME}=${signed}`)!, SECRET)).toBe("user_abc");
  });
});

describe("auth.ts 用的是同一实现", () => {
  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = SECRET;
    state.cookies.clear();
    state.findUnique.mockClear();
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
  });

  it("createSession 写出的 cookie 能被 verifySession 用同一密钥验出 userId", async () => {
    const { createSession } = await import("./auth");
    await createSession("user_abc");
    const raw = state.cookies.get(SESSION_COOKIE_NAME);
    expect(raw).toBeDefined();
    expect(verifySession(raw!, SECRET)).toBe("user_abc");
    expect(verifySession(raw!, "another-secret")).toBeNull();
    expect(raw).toBe(signSession("user_abc", SECRET)); // 逐字相同:不是「结果一致的两份实现」
  });

  it("getCurrentUser 接受 signSession 造的 cookie,拒绝篡改过的", async () => {
    const { getCurrentUser } = await import("./auth");
    state.cookies.set(SESSION_COOKIE_NAME, signSession("user_abc", SECRET));
    await expect(getCurrentUser()).resolves.toMatchObject({ id: "user_abc" });
    expect(state.findUnique).toHaveBeenCalledWith({ where: { id: "user_abc" } });

    state.findUnique.mockClear();
    state.cookies.set(SESSION_COOKIE_NAME, signSession("user_abc", "another-secret"));
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(state.findUnique).not.toHaveBeenCalled();
  });

  it("destroySession 删除同名 cookie", async () => {
    const { createSession, destroySession, getCurrentUser } = await import("./auth");
    await createSession("user_abc");
    await destroySession();
    expect(state.cookies.has(SESSION_COOKIE_NAME)).toBe(false);
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe("resolveSessionSecret(密钥解析规则只有一份)", () => {
  it("SESSION_SECRET 有值就用它,与 NODE_ENV 无关", () => {
    expect(resolveSessionSecret({ SESSION_SECRET: "abc" })).toBe("abc");
    expect(resolveSessionSecret({ SESSION_SECRET: "abc", NODE_ENV: "production" })).toBe("abc");
  });

  it("非生产没设(或设成空串)回退 DEV_SESSION_SECRET", () => {
    expect(resolveSessionSecret({})).toBe(DEV_SESSION_SECRET);
    expect(resolveSessionSecret({ NODE_ENV: "development" })).toBe(DEV_SESSION_SECRET);
    expect(resolveSessionSecret({ NODE_ENV: "test", SESSION_SECRET: "" })).toBe(DEV_SESSION_SECRET);
  });

  it("生产没设返回 undefined(调用方必须拒绝),绝不回退", () => {
    expect(resolveSessionSecret({ NODE_ENV: "production" })).toBeUndefined();
    expect(resolveSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "" })).toBeUndefined();
  });

  describe("dev 下 createSession 签的密钥就是 resolveSessionSecret() 给出的值", () => {
    let prevSecret: string | undefined;
    beforeEach(() => {
      prevSecret = process.env.SESSION_SECRET;
      delete process.env.SESSION_SECRET; // 本地 .env 里 SESSION_SECRET 是注释掉的:走回退
      state.cookies.clear();
    });
    afterEach(() => {
      if (prevSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSecret;
    });

    it("hub 传 secret: resolveSessionSecret() 就能验出 auth.ts 写的 cookie", async () => {
      expect(process.env.NODE_ENV).not.toBe("production");
      const secret = resolveSessionSecret();
      expect(secret).toBe(DEV_SESSION_SECRET);
      const { createSession } = await import("./auth");
      await createSession("user_abc");
      const raw = state.cookies.get(SESSION_COOKIE_NAME)!;
      expect(raw).toBe(signSession("user_abc", secret!));
      expect(verifySession(raw, secret!)).toBe("user_abc");
      expect(verifySession(raw, "some-other-secret")).toBeNull();
    });
  });
});
