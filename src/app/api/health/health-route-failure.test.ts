// 深探时写入失败(设计 §3.4):库能读、Heartbeat 写不进去 → 仍 200,write false,writeError 带原消息,no-store。
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/db", () => ({ prisma: { $queryRaw: async () => [{ 1: 1 }] } }));
vi.mock("@/lib/server/heartbeat", () => ({
  touchHeartbeat: async () => { throw new Error("SQLITE_FULL: database or disk is full"); },
}));

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health 写入失败", () => {
  it("write false、writeError 有原消息、HTTP 200、no-store,原有字段照旧", async () => {
    vi.stubEnv("WATCHDOG_SECRET", "s3cret");
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/health", { headers: { "x-watchdog-secret": "s3cret" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const { ok, data } = await res.json();
    expect(ok).toBe(true);
    expect(data.db).toBe(true);
    expect(data.startMode).toBe("next");
    expect(data.write).toBe(false);
    expect(data.writeError).toMatch(/SQLITE_FULL/);
    expect(data.disk === null || typeof data.disk.usedPct === "number").toBe(true);
  });
});
