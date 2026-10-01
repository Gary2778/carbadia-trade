import { describe, expect, it } from "vitest";
import { demoFailureOf } from "@/components/terminal/LoginGate";
import { postEnvelope } from "@/lib/market/order-submit";
import { requestDemoAccount } from "./AccountGate";

// 资产页的一键演示账户(P2-10):不引终端的 LoginGate / order-submit(见 AccountGate.tsx 的说明),自己发 POST /api/auth/demo;
// 这里对着终端那一套(demoFailureOf ∘ postEnvelope)逐个情形核对,两处的失败说明不会分叉。

const response = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body }) as unknown as Response;

const CASES: Array<[label: string, fetchImpl: typeof fetch]> = [
  ["200 with an ok envelope", async () => response(200, { ok: true, data: { id: "u1" } })],
  ["200 with a broken envelope", async () => response(200, { ok: false })],
  ["429 with Retry-After", async () => response(429, { ok: false, error: "Too many demo accounts" }, { "Retry-After": "30" })],
  ["429 with a fractional Retry-After", async () => response(429, { ok: false, error: "x" }, { "Retry-After": "2.5" })],
  ["429 without Retry-After", async () => response(429, { ok: false, error: "x" })],
  ["400", async () => response(400, { ok: false, error: "Bad request" })],
  ["500", async () => response(500, { ok: false, error: "Server error" })],
  ["unparsable body", async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new Error("bad json"); } }) as unknown as Response],
  ["network failure", async () => { throw new TypeError("Failed to fetch"); }],
];

describe("requestDemoAccount", () => {
  it.each(CASES)("%s: the same outcome as the terminal's LoginGate", async (_label, fetchImpl) => {
    expect(await requestDemoAccount(fetchImpl)).toEqual(demoFailureOf(await postEnvelope("/api/auth/demo", undefined, fetchImpl)));
  });

  it("posts to /api/auth/demo without a cache", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    await requestDemoAccount(async (url, init) => {
      calls.push([String(url), init]);
      return response(200, { ok: true, data: null });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/auth/demo");
    expect(calls[0][1]).toMatchObject({ method: "POST", cache: "no-store" });
  });
});
