// 信封基础件:fail() 的第三参把响应头透传给 NextResponse.json(429 的 Retry-After、503 的 Retry-After: 1 挂在这里)。
import { describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ prisma: {} })); // api.ts 经 auth / matching / otc 间接引到 db,这里不需要数据库

import { BusyError, TradingError } from "../exchange/matching";
import { fail, handle, ok } from "./api";

describe("fail", () => {
  it("第三参透传响应头,状态与信封不变", async () => {
    const res = fail("x", 429, { "Retry-After": "7" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("7");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "x" });
  });

  it("默认 400、不带额外头", async () => {
    const res = fail("bad");
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
    await expect(res.json()).resolves.toEqual({ ok: false, error: "bad" });
  });

  it("ok() 的 headers 形式与 fail() 对称", () => {
    expect(ok({ a: 1 }, { headers: { "Cache-Control": "no-store" } }).headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("handle", () => {
  it("BusyError → 503 + Retry-After: 1, 客户端原样重发同一请求", async () => {
    const res = handle(new BusyError());
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    await expect(res.json()).resolves.toEqual({ ok: false, error: "The account is busy. Retry this same request." });
  });

  it("BusyError 是 TradingError 的子类, 但普通 TradingError 仍是 400 且不带 Retry-After", async () => {
    expect(new BusyError()).toBeInstanceOf(TradingError);
    const res = handle(new TradingError("Insufficient available cash"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
    await expect(res.json()).resolves.toEqual({ ok: false, error: "Insufficient available cash" });
  });
});
