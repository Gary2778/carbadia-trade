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
