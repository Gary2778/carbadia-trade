// 撤单遇到写锁争用 / 超时(P1-25b):与下单一样回 503 + Retry-After: 1(BusyError),不再是 500 + [API ERROR] 日志。
// 争用错误按 Prisma 已知错误的 code 字段识别(跨 bundle 不认类,见 src/lib/server/prisma-errors.ts):P1008 忙等超时、P2028 事务超时、P2034 写冲突;
// 下单的争用集合里还有 P2002(幂等键并发),撤单没有幂等键,不认它。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn<(fn: unknown) => Promise<unknown>>(),
}));
vi.mock("@/lib/server/db", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/server/auth", () => ({
  requireUser: async () => ({ id: "user-1", isBot: false }),
  AuthError: class AuthError extends Error {},
}));

import { BusyError, cancelOrderTx } from "@/lib/exchange/matching";
import { prismaErrorCode } from "@/lib/server/prisma-errors";
import { DELETE } from "./route";

/** 形状同 Prisma 的 PrismaClientKnownRequestError:Error + 字符串 code */
const prismaError = (code: string, message: string) => Object.assign(new Error(message), { code, name: "PrismaClientKnownRequestError" });
const cancel = (id: string) => DELETE(new Request(`http://localhost/api/orders/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });

// 块体:箭头函数若返回 mockReset() 的返回值(mock 本身),vitest 会把它当成 afterEach 清理函数去调用
beforeEach(() => {
  mocks.transaction.mockReset();
});

describe("DELETE /api/orders/[id] 争用", () => {
  it.each([
    ["P1008", "Operation has timed out"],
    ["P2028", "Transaction API error: Unable to start a transaction in the given time."],
    ["P2034", "Transaction failed due to a write conflict or a deadlock."],
  ])("%s → cancelOrderTx 抛 BusyError;路由回 503 + Retry-After: 1", async (code, message) => {
    mocks.transaction.mockRejectedValue(prismaError(code, message));
    await expect(cancelOrderTx("user-1", "order-1")).rejects.toBeInstanceOf(BusyError);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await cancel("order-2");
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("1");
      await expect(res.json()).resolves.toEqual({ ok: false, error: new BusyError().message });
      expect(errors).not.toHaveBeenCalled(); // 不是 500,不打 [API ERROR]
    } finally {
      errors.mockRestore();
    }
  });

  // P2002(唯一约束)在下单里是幂等键的并发重放、按键重读;撤单没有幂等键,撤单里出现它是真 bug,
  // 必须以 500 + [API ERROR] 暴露出来,不能变成永远可重试的 503「忙」(P1-25e)
  it.each([
    ["P2003", "Foreign key constraint failed"],
    ["P2002", "Unique constraint failed on the fields: (`userId`,`clientOrderId`)"],
  ])("其它错误原样抛出(不吞成 503):%s", async (code, message) => {
    mocks.transaction.mockRejectedValue(prismaError(code, message));
    const err: unknown = await cancelOrderTx("user-1", "order-1").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(BusyError);
    expect(prismaErrorCode(err)).toBe(code);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await cancel("order-2");
      expect(res.status).toBe(500);
      expect(errors).toHaveBeenCalled(); // [API ERROR] 照打
    } finally {
      errors.mockRestore();
    }
  });
});
