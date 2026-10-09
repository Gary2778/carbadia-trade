import { describe, expect, it, vi } from "vitest";
import sitemap from "./sitemap";

// 站点地图只读标的代码:不碰真的库,换成两个固定的 symbol
vi.mock("@/lib/server/db", () => ({ prisma: { asset: { findMany: async () => [{ symbol: "VCS-FOR-2021" }, { symbol: "GS-WIND-2022" }] } } }));

describe("sitemap", () => {
  it("lists the market overview page /trade/markets (P3-05) with the other static pages", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls.slice(0, 5)).toEqual(["https://cbda.trade", "https://cbda.trade/trade/markets", "https://cbda.trade/otc", "https://cbda.trade/terms", "https://cbda.trade/privacy"]);
    const overview = (await sitemap()).find((entry) => entry.url === "https://cbda.trade/trade/markets");
    expect(overview).toMatchObject({ changeFrequency: "daily", priority: 0.6 });
  });

  it("still lists both pages of every instrument (old market page and the terminal)", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    for (const symbol of ["VCS-FOR-2021", "GS-WIND-2022"]) {
      expect(urls).toContain(`https://cbda.trade/market/${symbol}`);
      expect(urls).toContain(`https://cbda.trade/trade/${symbol}`);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
});
