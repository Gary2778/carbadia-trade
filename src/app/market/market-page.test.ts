import { isValidElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarketPage from "@/app/market/[symbol]/page";

// 旧标的页的服务端入口(计划 §9.1 第 23 条,P2-08):tab=trade 且(mode=advanced 或情景标的)在渲染之前 redirect 到终端,
// 其余渲染客户端的 MarketContent。node 环境:redirect 与 prisma 按模块边界打桩 —— next/navigation 的 redirect 真身也是抛错中断渲染。
class Redirected extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));

const db = vi.hoisted(() => ({ assets: new Map<string, { isScenario: boolean }>(), queries: [] as unknown[] }));
vi.mock("@/lib/server/db", () => ({
  prisma: {
    asset: {
      findUnique: async (args: { where: { symbol: string } }) => {
        db.queries.push(args);
        return db.assets.get(args.where.symbol) ?? null;
      },
    },
  },
}));

// 内容组件是客户端的一整棵树(轮询、下单表单),这里只关心入口把什么交给它
vi.mock("@/app/market/[symbol]/MarketContent", () => ({ MarketContent: () => null }));

db.assets.set("VCS-FOR-2021", { isScenario: false });
db.assets.set("CEA-SCEN-2026", { isScenario: true });

afterEach(() => {
  db.queries.length = 0;
});

type Query = Record<string, string | string[] | undefined>;
const open = (symbol: string, query: Query = {}) => MarketPage({ params: Promise.resolve({ symbol }), searchParams: Promise.resolve(query) });
const redirectOf = async (symbol: string, query: Query): Promise<string | null> => {
  try {
    await open(symbol, query);
    return null;
  } catch (e) {
    if (e instanceof Redirected) return e.url;
    throw e;
  }
};

describe("/market/[symbol] 的服务端入口", () => {
  it("tab=trade&mode=advanced:服务端直接跳到 /trade/<symbol>,带上 side,不查库", async () => {
    expect(await redirectOf("VCS-FOR-2021", { tab: "trade", mode: "advanced", side: "SELL" })).toBe("/trade/VCS-FOR-2021?side=SELL");
    expect(await redirectOf("VCS-FOR-2021", { tab: "trade", mode: "advanced" })).toBe("/trade/VCS-FOR-2021?side=BUY");
    expect(db.queries).toEqual([]);
  });

  it("情景标的的交易页签:查到 isScenario 就跳;只取这一个字段", async () => {
    expect(await redirectOf("CEA-SCEN-2026", { tab: "trade" })).toBe("/trade/CEA-SCEN-2026?side=BUY");
    expect(await redirectOf("CEA-SCEN-2026", { tab: "trade", side: "SELL" })).toBe("/trade/CEA-SCEN-2026?side=SELL");
    expect(db.queries).toEqual([
      { where: { symbol: "CEA-SCEN-2026" }, select: { isScenario: true } },
      { where: { symbol: "CEA-SCEN-2026" }, select: { isScenario: true } },
    ]);
  });

  it("总览(含情景标的的总览)与普通标的的简易交易留在旧页面:渲染 MarketContent,按 symbol 作 key", async () => {
    for (const [symbol, query] of [
      ["VCS-FOR-2021", {}],
      ["CEA-SCEN-2026", {}],
      ["CEA-SCEN-2026", { mode: "advanced" }],
      ["VCS-FOR-2021", { tab: "trade", side: "SELL" }],
      ["NOPE-XXX", { tab: "trade" }],
    ] as Array<[string, Query]>) {
      const page = await open(symbol, query);
      expect(isValidElement(page), symbol).toBe(true);
      const content = (page as ReactElement<{ children: ReactElement<{ symbol: string }> }>).props.children;
      expect(content.props.symbol).toBe(symbol);
      expect(content.key).toBe(symbol);
    }
    // 只有交易页签才查标的(总览三次都不查)
    expect(db.queries).toEqual([
      { where: { symbol: "VCS-FOR-2021" }, select: { isScenario: true } },
      { where: { symbol: "NOPE-XXX" }, select: { isScenario: true } },
    ]);
  });
});
