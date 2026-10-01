import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { AccountOverviewExtrasResponse, AccountOverviewResponse } from "@/shared";
import { ApiError, type api } from "@/lib/http/client";
import { fetchOverview, OVERVIEW_EXTRAS_URL, OVERVIEW_URL } from "./useAccountOverview";

// 资产页总览的取数(计划 §6.2.2 C6、P2-13):这个用户的第一次取全量(落账户 store),之后的重取只取 24 小时变化与挂牌。
// hook 本身不在 node 环境里跑(无 jsdom,§9.1 第 7 条):这里测取数函数,并对着源码钉住 hook 用「是否已落过 store」选模式。

const FULL = { balance: { cashBalance: 1, lockedCash: 0 }, positions: [], totals: {}, change24h: null, otcListings: [] } as unknown as AccountOverviewResponse;
const EXTRAS: AccountOverviewExtrasResponse = { change24h: { amount: 5, pct: 0.5, baseline: 10, since: 0 }, otcListings: [] };

describe("fetchOverview", () => {
  it("not seeded yet → the full overview; seeded → ?parts=extras", async () => {
    const request = vi.fn(async (url: string) => (url === OVERVIEW_URL ? FULL : EXTRAS)) as unknown as typeof api;
    expect(await fetchOverview(false, request)).toEqual({ full: true, overview: FULL });
    expect(await fetchOverview(true, request)).toEqual({ full: false, overview: EXTRAS });
    expect(vi.mocked(request).mock.calls.map((call) => call[0])).toEqual(["/api/account/overview", "/api/account/overview?parts=extras"]);
    expect(OVERVIEW_EXTRAS_URL).toBe("/api/account/overview?parts=extras");
  });

  it("failures pass through with their status (429 from the per-user limit keeps the last data in the hook)", async () => {
    const request = vi.fn(async () => {
      throw new ApiError("Too many requests, please retry later", 429);
    }) as unknown as typeof api;
    await expect(fetchOverview(true, request)).rejects.toMatchObject({ status: 429 });
  });
});

describe("useAccountOverview call site", () => {
  const code = readFileSync(fileURLToPath(new URL("./useAccountOverview.ts", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");

  it("picks the mode from whether this user already seeded the store, and only a full response seeds it", () => {
    expect(code).toMatch(/await fetchOverview\(seededFor\.current === meId\)/);
    expect(code).toMatch(/if \(fetched\.full && seededFor\.current !== meId\) \{/);
    // 没有别的地方直接取总览(全部经 fetchOverview)
    expect(code).not.toMatch(/\bapi</);
    expect(code.match(/request</g)?.length ?? 0).toBe(2);
  });
});
