import { describe, expect, it } from "vitest";
import { takerSideOf, type OrderStub } from "./taker";

const limit = (price: number, createdAt: number, id: string): OrderStub => ({ type: "LIMIT", price, createdAt, id });
const market = (createdAt: number, id: string): OrderStub => ({ type: "MARKET", price: null, createdAt, id });

describe("takerSideOf", () => {
  it("规则 1:MARKET 单是 taker(买方市价)", () => {
    expect(takerSideOf({ price: 1000, buyOrder: market(5, "b"), sellOrder: limit(1000, 9, "s") })).toBe("BUY");
  });

  it("规则 1:MARKET 单是 taker(卖方市价),即使它更早创建", () => {
    expect(takerSideOf({ price: 1000, buyOrder: limit(1000, 9, "b"), sellOrder: market(1, "s") })).toBe("SELL");
  });

  it("规则 2:挂单价 ≠ 成交价的一方是 taker(限价买穿过卖一,按卖一价成交)", () => {
    expect(takerSideOf({ price: 1000, buyOrder: limit(1010, 1, "b"), sellOrder: limit(1000, 9, "s") })).toBe("BUY");
  });

  it("规则 2:卖方价低于成交价 → 卖方是 taker,不看时间", () => {
    expect(takerSideOf({ price: 1000, buyOrder: limit(1000, 9, "b"), sellOrder: limit(990, 1, "s") })).toBe("SELL");
  });

  it("规则 3:两边价都等于成交价时,较晚 createdAt 是 taker", () => {
    expect(takerSideOf({ price: 1000, buyOrder: limit(1000, 2, "b"), sellOrder: limit(1000, 1, "s") })).toBe("BUY");
    expect(takerSideOf({ price: 1000, buyOrder: limit(1000, 1, "b"), sellOrder: limit(1000, 2, "s") })).toBe("SELL");
  });

  it("规则 4:createdAt 相同时 id 大的是 taker", () => {
    expect(takerSideOf({ price: 1000, buyOrder: limit(1000, 1, "b2"), sellOrder: limit(1000, 1, "b1") })).toBe("BUY");
    expect(takerSideOf({ price: 1000, buyOrder: limit(1000, 1, "a"), sellOrder: limit(1000, 1, "z") })).toBe("SELL");
  });

  it("两边都 MARKET(不可能出现)退到后续规则而不是报错", () => {
    expect(takerSideOf({ price: 1000, buyOrder: market(2, "b"), sellOrder: market(1, "s") })).toBe("BUY");
  });

  it("两边价都 ≠ 成交价(数据异常)退到时间规则", () => {
    expect(takerSideOf({ price: 1000, buyOrder: limit(1010, 1, "b"), sellOrder: limit(990, 2, "s") })).toBe("SELL");
  });

  it("确定性:同一输入多次调用结果一致", () => {
    const input = { price: 1000, buyOrder: limit(1000, 1, "x"), sellOrder: limit(1000, 1, "y") };
    expect(new Set([takerSideOf(input), takerSideOf(input), takerSideOf(input)]).size).toBe(1);
  });
});
