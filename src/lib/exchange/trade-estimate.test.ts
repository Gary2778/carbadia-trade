import { describe, expect, it } from "vitest";

async function estimator() {
  const path = "./trade-estimate";
  const estimateModule = await import(path).catch(() => null);
  expect(estimateModule?.estimateMarketOrder, "market estimate is missing").toBeTypeOf("function");
  return estimateModule!.estimateMarketOrder as typeof import("./trade-estimate").estimateMarketOrder;
}

describe("estimateMarketOrder", () => {
  it("prices the requested credits across book levels in integer cents", async () => {
    const estimate = await estimator();
    expect(estimate([{ price: 1050, quantity: 2 }, { price: 1200, quantity: 10 }], 5))
      .toEqual({ quantity: 5, totalCents: 5700, unfilledQuantity: 0 });
  });

  it("shows the displayed partial liquidity without pricing unavailable credits", async () => {
    const estimate = await estimator();
    expect(estimate([{ price: 900, quantity: 2 }], 5))
      .toEqual({ quantity: 2, totalCents: 1800, unfilledQuantity: 3 });
  });

  it("caps a buy estimate at the credits affordable at each price level", async () => {
    const estimate = await estimator();
    expect(estimate([{ price: 1000, quantity: 2 }, { price: 1200, quantity: 5 }], 5, 3300))
      .toEqual({ quantity: 3, totalCents: 3200, unfilledQuantity: 2 });
  });

  it("does not imply a fill when the book is empty or no whole credit is affordable", async () => {
    const estimate = await estimator();
    expect(estimate([], 5)).toEqual({ quantity: 0, totalCents: 0, unfilledQuantity: 5 });
    expect(estimate([{ price: 1000, quantity: 2 }], 5, 999))
      .toEqual({ quantity: 0, totalCents: 0, unfilledQuantity: 5 });
  });

  it("rejects fractional, nonpositive and unsafe quantities", async () => {
    const estimate = await estimator();
    for (const quantity of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(estimate([{ price: 1000, quantity: 2 }], quantity)).toBeNull();
    }
  });

  it("rejects totals that cannot be represented exactly in integer cents", async () => {
    const estimate = await estimator();
    expect(estimate([{ price: 100000000, quantity: 100000000 }], 100000000)).toBeNull();
  });
});

describe("estimateMarketByAmount", () => {
  it("walks the levels best price first and spends the amount in whole credits", async () => {
    const path = "./trade-estimate";
    const { estimateMarketByAmount } = (await import(path)) as typeof import("./trade-estimate");
    expect(estimateMarketByAmount([{ price: 1000, quantity: 2 }, { price: 1200, quantity: 10 }], 5000))
      .toEqual({ quantity: 4, totalCents: 4400, unspentCents: 600 });
  });

  it("keeps the remainder when the visible book runs out", async () => {
    const path = "./trade-estimate";
    const { estimateMarketByAmount } = (await import(path)) as typeof import("./trade-estimate");
    expect(estimateMarketByAmount([{ price: 1000, quantity: 2 }], 5000))
      .toEqual({ quantity: 2, totalCents: 2000, unspentCents: 3000 });
    expect(estimateMarketByAmount([], 5000)).toEqual({ quantity: 0, totalCents: 0, unspentCents: 5000 });
  });

  it("stops at a level it cannot afford a whole credit of and does not skip ahead", async () => {
    const path = "./trade-estimate";
    const { estimateMarketByAmount } = (await import(path)) as typeof import("./trade-estimate");
    // 2000 buys the 1000 level twice and nothing at 1200; the cheaper 900 level behind it is never reached
    expect(estimateMarketByAmount([{ price: 1000, quantity: 2 }, { price: 1200, quantity: 1 }, { price: 900, quantity: 5 }], 2000))
      .toEqual({ quantity: 2, totalCents: 2000, unspentCents: 0 });
    expect(estimateMarketByAmount([{ price: 1000, quantity: 2 }], 999)).toEqual({ quantity: 0, totalCents: 0, unspentCents: 999 });
  });

  it("agrees with estimateMarketOrder when the amount exactly covers a quantity", async () => {
    const path = "./trade-estimate";
    const mod = (await import(path)) as typeof import("./trade-estimate");
    const levels = [{ price: 1050, quantity: 2 }, { price: 1200, quantity: 10 }];
    const byQty = mod.estimateMarketOrder(levels, 5)!;
    expect(mod.estimateMarketByAmount(levels, byQty.totalCents)).toEqual({ quantity: 5, totalCents: byQty.totalCents, unspentCents: 0 });
  });

  it("rejects fractional, nonpositive and unsafe amounts and invalid levels", async () => {
    const path = "./trade-estimate";
    const { estimateMarketByAmount } = (await import(path)) as typeof import("./trade-estimate");
    for (const amount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(estimateMarketByAmount([{ price: 1000, quantity: 2 }], amount)).toBeNull();
    }
    expect(estimateMarketByAmount([{ price: 0, quantity: 2 }], 1000)).toBeNull();
    expect(estimateMarketByAmount([{ price: 1000, quantity: -1 }], 1000)).toBeNull();
  });
});
