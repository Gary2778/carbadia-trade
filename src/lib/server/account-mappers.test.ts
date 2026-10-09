// Prisma 行 → 共享 Order / Fill / Position 的映射(计划 §3.5、§9.1 第 1/24/25/41 条):cancelReason 派生(含自成交防护撤单)、updatedAt 回退、role 由 takerSideOf 决定、
// 持仓三态与成本状态、账本视图、按成交重算均价;条件单与通知(P3-02):枚举列的收窄与回退、payload 的解析与逐字段核对。
import { describe, expect, it } from "vitest";
import type { Notification as NotificationRow, Trigger as TriggerRow } from "@/generated/prisma";
import type { NoticePayload } from "@/shared/types";
import type { OrderRow, TradeRow } from "../exchange/matching";
import type { CostBasisLedgerLine } from "../exchange/portfolio-analysis";
import { avgFillPricesByOrder, ledgerIdsByTrade, selfTradeCancelledIds, toFill, toLedgerLineView, toNotice, toOrder, toPosition, toTrigger, type HoldingRow } from "./account-mappers";

const T0 = new Date("2026-09-26T00:00:00.000Z");
const T1 = new Date("2026-09-26T00:00:05.000Z");

function orderRow(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "ord_1", userId: "u_alice", assetId: "a_1", side: "BUY", type: "LIMIT", price: 10_000, quantity: 5, filledQuantity: 0,
    status: "OPEN", avgFillPrice: null, createdAt: T0, clientOrderId: null, updatedAt: null, asset: { symbol: "VCS-FOR-2021" }, ...over,
  };
}

function tradeRow(over: Partial<TradeRow> = {}): TradeRow {
  return {
    id: "trd_1", assetId: "a_1", buyOrderId: "ord_buy", sellOrderId: "ord_sell", buyerId: "u_alice", sellerId: "u_bob",
    price: 9_800, quantity: 3, createdAt: T1, asset: { symbol: "VCS-FOR-2021" },
    buyOrder: { id: "ord_buy", type: "LIMIT", price: 10_000, createdAt: T1 },
    sellOrder: { id: "ord_sell", type: "LIMIT", price: 9_800, createdAt: T0 },
    ...over,
  };
}

describe("toOrder", () => {
  it("symbol 来自 asset, 时间转 unix ms, 旧行 updatedAt NULL 回退到 createdAt, 不外露 userId", () => {
    const order = toOrder(orderRow({ clientOrderId: "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab" }));
    expect(order).toEqual({
      id: "ord_1", clientOrderId: "6f1d2c1e-3b0a-4c7d-9e8f-0123456789ab", assetId: "a_1", symbol: "VCS-FOR-2021", side: "BUY", type: "LIMIT",
      price: 10_000, quantity: 5, filledQuantity: 0, status: "OPEN", avgFillPrice: null, cancelReason: null,
      createdAt: T0.getTime(), updatedAt: T0.getTime(),
    });
    expect("userId" in order).toBe(false);
    expect(toOrder(orderRow({ updatedAt: T1 })).updatedAt).toBe(T1.getTime());
  });

  it("cancelReason: MARKET 余量撤销 → MARKET_REMAINDER, LIMIT 撤单 → USER, 未撤销 → null", () => {
    expect(toOrder(orderRow({ type: "MARKET", price: null, status: "CANCELLED", filledQuantity: 2 })).cancelReason).toBe("MARKET_REMAINDER");
    expect(toOrder(orderRow({ type: "LIMIT", status: "CANCELLED", filledQuantity: 2 })).cancelReason).toBe("USER");
    expect(toOrder(orderRow({ status: "PARTIAL", filledQuantity: 2 })).cancelReason).toBeNull();
    expect(toOrder(orderRow({ status: "FILLED", filledQuantity: 5 })).cancelReason).toBeNull();
  });

  it("cancelReason: selfTraded 里的 LIMIT 撤单 → SELF_TRADE;不在里面的、未撤销的、市价单不受影响", () => {
    const stp = new Set(["ord_stp"]);
    expect(toOrder(orderRow({ id: "ord_stp", status: "CANCELLED" }), undefined, stp).cancelReason).toBe("SELF_TRADE");
    expect(toOrder(orderRow({ id: "ord_stp", status: "CANCELLED", filledQuantity: 2 }), 9_900, stp)).toMatchObject({ cancelReason: "SELF_TRADE", avgFillPrice: 9_900 });
    expect(toOrder(orderRow({ id: "ord_user", status: "CANCELLED" }), undefined, stp).cancelReason).toBe("USER");
    expect(toOrder(orderRow({ id: "ord_stp", status: "OPEN" }), undefined, stp).cancelReason).toBeNull();
    expect(toOrder(orderRow({ id: "ord_stp", type: "MARKET", price: null, status: "CANCELLED", filledQuantity: 2 }), undefined, stp).cancelReason).toBe("MARKET_REMAINDER");
  });

  it("avg 第二参覆盖行上的 avgFillPrice(含显式 null), 不传则沿用", () => {
    const row = orderRow({ avgFillPrice: 9_900, filledQuantity: 5, status: "FILLED" });
    expect(toOrder(row).avgFillPrice).toBe(9_900);
    expect(toOrder(row, 9_850).avgFillPrice).toBe(9_850);
    expect(toOrder(row, null).avgFillPrice).toBeNull();
  });
});

describe("toFill", () => {
  it("买方视角: 限价买 taker(价 ≠ 成交价)→ side BUY, role TAKER, orderId 取 buyOrderId; ledgerRefs 不传即 []", () => {
    const fill = toFill(tradeRow(), "u_alice");
    expect(fill).toEqual({
      id: "trd_1", orderId: "ord_buy", symbol: "VCS-FOR-2021", side: "BUY", role: "TAKER", price: 9_800, quantity: 3, notional: 29_400,
      feeCents: 0, ts: T1.getTime(), auditRef: "SIM-TRD-trd_1", ledgerRefs: [],
    });
  });

  it("ledgerRefs = 传入的本人账本行 id(计划 §3.5), 拷贝一份而不是引用调用方的数组", () => {
    const ids = ["led_1", "led_2"];
    const fill = toFill(tradeRow(), "u_alice", ids);
    expect(fill.ledgerRefs).toEqual(["led_1", "led_2"]);
    expect(fill.ledgerRefs).not.toBe(ids);
  });

  it("卖方视角同一笔成交: side SELL, role MAKER, orderId 取 sellOrderId", () => {
    const fill = toFill(tradeRow(), "u_bob");
    expect(fill).toMatchObject({ orderId: "ord_sell", side: "SELL", role: "MAKER", notional: 29_400, feeCents: 0 });
  });

  it("MARKET 单一律是 taker, 与价格无关", () => {
    const t = tradeRow({ price: 9_800, buyOrder: { id: "ord_buy", type: "LIMIT", price: 9_800, createdAt: T0 }, sellOrder: { id: "ord_sell", type: "MARKET", price: null, createdAt: T1 } });
    expect(toFill(t, "u_bob").role).toBe("TAKER");
    expect(toFill(t, "u_alice").role).toBe("MAKER");
  });
});

describe("selfTradeCancelledIds", () => {
  it("只拿 CANCELLED 的 LIMIT 单去查 SELF_TRADE_UNLOCK / ORDER 流水,一批一次;没有候选时不查库", async () => {
    const calls: unknown[] = [];
    const db = {
      ledgerEntry: {
        findMany: async (args: unknown) => {
          calls.push(args);
          // 同一张单两行流水(CASH_LOCKED / CASH)、refId 为空的脏行都要能处理
          return [{ refId: "ord_stp" }, { refId: "ord_stp" }, { refId: null }];
        },
      },
    } as unknown as Parameters<typeof selfTradeCancelledIds>[0];

    const orders = [
      orderRow({ id: "ord_stp", status: "CANCELLED" }),
      orderRow({ id: "ord_user", status: "CANCELLED" }),
      orderRow({ id: "ord_open", status: "OPEN" }),
      orderRow({ id: "ord_mkt", type: "MARKET", price: null, status: "CANCELLED", filledQuantity: 1 }),
    ];
    expect([...(await selfTradeCancelledIds(db, orders))]).toEqual(["ord_stp"]);
    expect(calls).toEqual([{ where: { refType: "ORDER", refId: { in: ["ord_stp", "ord_user"] }, reason: "SELF_TRADE_UNLOCK" }, select: { refId: true } }]);

    expect((await selfTradeCancelledIds(db, [orderRow({ status: "FILLED" })])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("ledgerIdsByTrade", () => {
  it("按 tradeId 分组本人的 TRADE 账本行 id, 一批一次查询; tradeIds 为空时不查库", async () => {
    const calls: unknown[] = [];
    const db = {
      ledgerEntry: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [
            { id: "led_1", refId: "trd_1" },
            { id: "led_2", refId: "trd_1" },
            { id: "led_3", refId: "trd_2" },
            { id: "led_x", refId: null },
          ];
        },
      },
    } as unknown as Parameters<typeof ledgerIdsByTrade>[0];

    const byTrade = await ledgerIdsByTrade(db, "u_alice", ["trd_1", "trd_2", "trd_9"]);
    expect([...byTrade.entries()]).toEqual([["trd_1", ["led_1", "led_2"]], ["trd_2", ["led_3"]]]);
    expect(byTrade.get("trd_9")).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ where: { userId: "u_alice", refType: "TRADE", refId: { in: ["trd_1", "trd_2", "trd_9"] } } });

    expect((await ledgerIdsByTrade(db, "u_alice", [])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });
});

describe("toPosition", () => {
  const holding = (over: Partial<HoldingRow> = {}): HoldingRow => ({
    assetId: "a_1", quantity: 10, locked: 3, asset: { symbol: "VCS-FOR-2021", lastPrice: 10_000, isScenario: false }, ...over,
  });
  const NO_LOCKS = { orders: 0, otc: 0 };
  const line = (over: Partial<CostBasisLedgerLine>): CostBasisLedgerLine => ({
    id: "led_1", account: "HOLDING", assetId: "a_1", delta: 10, reason: "TRADE_SETTLE", refType: "TRADE", refId: "trd_1", createdAt: T0, ...over,
  });

  it("三态 + 锁定来源 + 市值 + 成本完整: available = quantity − locked, retired 与 lockedBy 来自参数, avg / pnl 由账本重建", () => {
    const rows = [
      line({ id: "led_cash", account: "CASH", assetId: null, delta: -95_000 }),
      line({ id: "led_hold", account: "HOLDING", delta: 10 }),
    ];
    expect(toPosition(holding(), 4, rows, { orders: 2, otc: 1 })).toEqual({
      assetId: "a_1", symbol: "VCS-FOR-2021", quantity: 10, locked: 3, lockedBy: { orders: 2, otc: 1 }, available: 7, retired: 4, lastPrice: 10_000, marketValue: 100_000,
      averagePurchasePrice: 9_500, unrealisedPnl: 5_000, costBasisStatus: "complete", isScenario: false,
    });
  });

  it("成本不完整时 averagePurchasePrice / unrealisedPnl 为 null 而不是 0: 种子持仓 → unknown_acquisition_cost, 账本对不上 → incomplete_ledger", () => {
    const seeded = toPosition(holding(), 0, [line({ reason: "SEED", refType: null, refId: null })], NO_LOCKS);
    expect(seeded).toMatchObject({ costBasisStatus: "unknown_acquisition_cost", averagePurchasePrice: null, unrealisedPnl: null, marketValue: 100_000 });
    const missing = toPosition(holding(), 0, [], NO_LOCKS);
    expect(missing).toMatchObject({ costBasisStatus: "incomplete_ledger", averagePurchasePrice: null, unrealisedPnl: null });
  });

  it("lastPrice 为 null → marketValue 0、lastPrice null; 情景标的带 isScenario true; locked 超过 quantity 时 available 不为负", () => {
    const p = toPosition(holding({ quantity: 2, locked: 5, asset: { symbol: "CEA-SCENARIO", lastPrice: null, isScenario: true } }), 0, [], NO_LOCKS);
    expect(p).toMatchObject({ lastPrice: null, marketValue: 0, available: 0, isScenario: true });
    expect("userId" in p).toBe(false);
  });

  it("lockedBy 与 locked 对不上时两边都照实给出: locked / available 以 Holding 行为准, lockedBy 是传入的值(不改、不补差)", () => {
    const source = { orders: 1, otc: 0 };
    const p = toPosition(holding(), 0, [], source); // holding().locked = 3
    expect(p).toMatchObject({ locked: 3, available: 7, lockedBy: { orders: 1, otc: 0 } });
    expect(p.lockedBy).not.toBe(source); // 拷贝:调用方之后改自己的对象不影响已发出的行
  });

  it("整仓注销的行: quantity 0、retired > 0 → available 0、marketValue 0, 没有剩余数量所以没有均价", () => {
    const retiredOut = toPosition(holding({ quantity: 0, locked: 0 }), 10, [line({ id: "led_in", delta: 10, reason: "SEED", refType: null, refId: null }), line({ id: "led_out", delta: -10, reason: "SIMULATED_RETIREMENT", refType: "RETIREMENT", refId: "ret_1" })], NO_LOCKS);
    expect(retiredOut).toMatchObject({ quantity: 0, locked: 0, available: 0, retired: 10, marketValue: 0, averagePurchasePrice: null });
  });
});

describe("toLedgerLineView", () => {
  it("delta BigInt → number, createdAt → unix ms, 不带 userId / refId", () => {
    const view = toLedgerLineView({ id: "led_1", account: "CASH", delta: BigInt(-28_500), reason: "TRADE_SETTLE", createdAt: T1 });
    expect(view).toEqual({ id: "led_1", account: "CASH", delta: -28_500, reason: "TRADE_SETTLE", createdAt: T1.getTime() });
  });
});

describe("avgFillPricesByOrder", () => {
  it("只对 filledQuantity > 0 的订单查一次成交; 成交量对得上 → 四舍五入均价, 对不上 → null; 没有已成交订单不查库", async () => {
    const calls: unknown[] = [];
    const db = {
      trade: {
        findMany: async (args: unknown) => {
          calls.push(args);
          return [
            { id: "t1", buyOrderId: "ord_a", sellOrderId: "ord_x", quantity: 2, price: 9_000 },
            { id: "t2", buyOrderId: "ord_a", sellOrderId: "ord_y", quantity: 1, price: 9_301 },
            { id: "t3", buyOrderId: "ord_z", sellOrderId: "ord_b", quantity: 1, price: 5_000 },
          ];
        },
      },
    } as unknown as Parameters<typeof avgFillPricesByOrder>[0];

    const avg = await avgFillPricesByOrder(db, [
      { id: "ord_a", filledQuantity: 3 },
      { id: "ord_b", filledQuantity: 4 }, // 只查到 1 吨成交: 旧成交已清理 → 未知
      { id: "ord_c", filledQuantity: 0 },
    ]);
    expect(avg.get("ord_a")).toBe(9_100); // (18000 + 9301) / 3 = 9100.33 → 9100
    expect(avg.get("ord_b")).toBeNull();
    expect(avg.has("ord_c")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ where: { OR: [{ buyOrderId: { in: ["ord_a", "ord_b"] } }, { sellOrderId: { in: ["ord_a", "ord_b"] } }] } });

    expect((await avgFillPricesByOrder(db, [{ id: "ord_c", filledQuantity: 0 }])).size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  // P2-13:OR 两个 IN 列表超过 Prisma 的 999 个参数时,Prisma 自己拆批会把同一笔成交返回不止一次,所以这里每 400 张一批、按成交 id 去重
  it("每 400 张订单一次查询;买卖两张单落在不同批里的成交只算一次", async () => {
    const orders = Array.from({ length: 401 }, (_, i) => ({ id: `o${String(i).padStart(3, "0")}`, filledQuantity: 1 }));
    const calls: string[][] = [];
    const db = {
      trade: {
        findMany: async (args: { where: { OR: [{ buyOrderId: { in: string[] } }, unknown] } }) => {
          const ids = args.where.OR[0].buyOrderId.in;
          calls.push(ids);
          // o000 买、o400 卖的那一笔两批都取得到;其余每张单一笔对外的成交
          const cross = { id: "cross", buyOrderId: "o000", sellOrderId: "o400", quantity: 1, price: 7_000 };
          return [cross, ...ids.filter((id) => id !== "o000" && id !== "o400").map((id) => ({ id: `t-${id}`, buyOrderId: id, sellOrderId: "bot", quantity: 1, price: 5_000 }))];
        },
      },
    } as unknown as Parameters<typeof avgFillPricesByOrder>[0];
    const avg = await avgFillPricesByOrder(db, orders);
    expect(calls.map((ids) => ids.length)).toEqual([400, 1]);
    expect(avg.size).toBe(401);
    // 去重之后 o000 与 o400 各只有 1 吨成交,与 filledQuantity 对得上
    expect(avg.get("o000")).toBe(7_000);
    expect(avg.get("o400")).toBe(7_000);
    expect(avg.get("o123")).toBe(5_000);
  });
});

function triggerRow(over: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: "trg_1", userId: "u_alice", assetId: "a_1", kind: "ORDER", direction: "ABOVE", triggerPrice: 11_000, side: "SELL", orderType: "LIMIT", limitPrice: 10_900,
    quantity: 5, ocoGroupId: null, status: "PENDING", reason: null, orderId: null, firedPrice: null, clientKey: "key-1", createdAt: T0, updatedAt: T0, firedAt: null, ...over,
  };
}

describe("toTrigger", () => {
  it("symbol 由调用方给,时间转 unix ms,不外露 userId / clientKey", () => {
    const trigger = toTrigger(triggerRow(), "VCS-FOR-2021");
    expect(trigger).toEqual({
      id: "trg_1", kind: "ORDER", assetId: "a_1", symbol: "VCS-FOR-2021", direction: "ABOVE", triggerPrice: 11_000, side: "SELL", orderType: "LIMIT", limitPrice: 10_900,
      quantity: 5, ocoGroupId: null, status: "PENDING", reason: null, orderId: null, firedPrice: null, createdAt: T0.getTime(), updatedAt: T0.getTime(), firedAt: null,
    });
    expect("userId" in trigger).toBe(false);
    expect("clientKey" in trigger).toBe(false);
  });

  it("已触发的 ORDER:orderId、firedPrice、firedAt 原样带出;被撤的 OCO 成员带 reason", () => {
    const fired = toTrigger(triggerRow({ status: "TRIGGERED", orderId: "ord_1", firedPrice: 11_020, firedAt: T1, updatedAt: T1, ocoGroupId: "oco_1" }), "VCS-FOR-2021");
    expect(fired).toMatchObject({ status: "TRIGGERED", orderId: "ord_1", firedPrice: 11_020, firedAt: T1.getTime(), updatedAt: T1.getTime(), ocoGroupId: "oco_1" });
    const cancelled = toTrigger(triggerRow({ status: "CANCELLED", reason: "OCO", ocoGroupId: "oco_1" }), "VCS-FOR-2021");
    expect(cancelled).toMatchObject({ status: "CANCELLED", reason: "OCO" });
    expect(toTrigger(triggerRow({ status: "REJECTED", reason: "INSUFFICIENT_QTY" }), "S").reason).toBe("INSUFFICIENT_QTY");
  });

  it("ALERT:下单字段全为 null", () => {
    const alert = toTrigger(triggerRow({ kind: "ALERT", direction: "BELOW", side: null, orderType: null, limitPrice: null, quantity: null }), "VCS-FOR-2021");
    expect(alert).toMatchObject({ kind: "ALERT", direction: "BELOW", side: null, orderType: null, limitPrice: null, quantity: null });
  });

  it("五种状态、两种类型、两个方向、五种原因都原样通过", () => {
    for (const status of ["PENDING", "TRIGGERING", "TRIGGERED", "REJECTED", "CANCELLED"]) expect(toTrigger(triggerRow({ status }), "S").status).toBe(status);
    for (const kind of ["ORDER", "ALERT"]) expect(toTrigger(triggerRow({ kind }), "S").kind).toBe(kind);
    for (const direction of ["ABOVE", "BELOW"]) expect(toTrigger(triggerRow({ direction }), "S").direction).toBe(direction);
    for (const reason of ["USER", "OCO", "INSUFFICIENT_CASH", "INSUFFICIENT_QTY", "NO_FILL", "INVALID"]) expect(toTrigger(triggerRow({ reason }), "S").reason).toBe(reason);
  });

  it("未知状态当 CANCELLED(界面不会出现永远等不到触发的幻影条件单);未知类型当 ALERT;未知方向当 ABOVE", () => {
    expect(toTrigger(triggerRow({ status: "WAITING" }), "S").status).toBe("CANCELLED");
    expect(toTrigger(triggerRow({ status: "pending" }), "S").status).toBe("CANCELLED"); // 大小写敏感
    expect(toTrigger(triggerRow({ status: "" }), "S").status).toBe("CANCELLED");
    expect(toTrigger(triggerRow({ kind: "STOP" }), "S").kind).toBe("ALERT");
    expect(toTrigger(triggerRow({ direction: "UP" }), "S").direction).toBe("ABOVE");
  });

  it("可空的枚举列(side / orderType / reason)遇到未知值回 null", () => {
    const t = toTrigger(triggerRow({ side: "HOLD", orderType: "STOP", reason: "BROKE" }), "S");
    expect(t).toMatchObject({ side: null, orderType: null, reason: null });
  });
});

function notificationRow(payload: unknown, over: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: "ntc_1", userId: "u_alice", kind: typeof payload === "object" && payload !== null && "kind" in payload ? String(payload.kind) : "fill",
    payload: typeof payload === "string" ? payload : JSON.stringify(payload), dedupeKey: "fill:ord_1:5", createdAt: T0, readAt: null, ...over,
  };
}

const fillPayload: NoticePayload = { kind: "fill", orderId: "ord_1", symbol: "VCS-FOR-2021", side: "BUY", role: "TAKER", quantity: 5, price: 9_800, orderStatus: "FILLED" };
const triggerPayload: NoticePayload = {
  kind: "trigger", triggerId: "trg_1", symbol: "VCS-FOR-2021", outcome: "REJECTED", reason: "INSUFFICIENT_CASH", side: "BUY", quantity: 5, triggerPrice: 11_000, orderId: null,
};
const alertPayload: NoticePayload = { kind: "price_alert", triggerId: "trg_2", symbol: "VCS-FOR-2021", direction: "BELOW", triggerPrice: 9_000, firedPrice: 8_990 };

describe("toNotice", () => {
  it("三种载荷各自解析成 Notice:id / createdAt(毫秒)/ readAt 加上载荷字段,不外露 userId / dedupeKey", () => {
    for (const payload of [fillPayload, triggerPayload, alertPayload]) {
      const notice = toNotice(notificationRow(payload));
      expect(notice).toEqual({ id: "ntc_1", createdAt: T0.getTime(), readAt: null, ...payload });
      expect(notice && "userId" in notice).toBe(false);
      expect(notice && "dedupeKey" in notice).toBe(false);
    }
  });

  it("已读:readAt 转毫秒", () => {
    expect(toNotice(notificationRow(fillPayload, { readAt: T1 }))?.readAt).toBe(T1.getTime());
  });

  it("trigger 载荷的可空字段(reason / side / quantity / orderId)给 null 或给值都行;已触发的带 orderId", () => {
    const triggered: NoticePayload = { kind: "trigger", triggerId: "trg_1", symbol: "S", outcome: "TRIGGERED", reason: null, side: "SELL", quantity: 5, triggerPrice: 11_000, orderId: "ord_9" };
    expect(toNotice(notificationRow(triggered))).toMatchObject({ outcome: "TRIGGERED", reason: null, orderId: "ord_9" });
    const alertCancelled: NoticePayload = { kind: "trigger", triggerId: "trg_3", symbol: "S", outcome: "CANCELLED", reason: "OCO", side: null, quantity: null, triggerPrice: 9_500, orderId: null };
    expect(toNotice(notificationRow(alertCancelled))).toMatchObject({ outcome: "CANCELLED", reason: "OCO", side: null, quantity: null });
  });

  it("payload 解析不了(不是 JSON、空串、截断)→ null", () => {
    for (const payload of ["not json", "", '{"kind":"fill"', "{'kind':'fill'}"]) expect(toNotice(notificationRow(payload))).toBeNull();
  });

  it("payload 是 JSON 但不是对象(null、数字、字符串、数组)→ null", () => {
    for (const payload of ["null", "42", '"fill"', "[]", `[${JSON.stringify(fillPayload)}]`, "true"]) expect(toNotice(notificationRow(payload))).toBeNull();
  });

  it("kind 缺失或未知 → null(以载荷里的 kind 为准,不看 Notification.kind 列)", () => {
    expect(toNotice(notificationRow({ ...fillPayload, kind: "promo" }))).toBeNull();
    expect(toNotice(notificationRow({ ...fillPayload, kind: undefined }))).toBeNull();
    expect(toNotice(notificationRow({ ...fillPayload, kind: 7 }))).toBeNull();
  });

  it("缺字段 → null:每个载荷的每个字段单独去掉都不通过", () => {
    for (const payload of [fillPayload, triggerPayload, alertPayload]) {
      for (const key of Object.keys(payload).filter((k) => k !== "kind")) {
        const without = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== key));
        expect(toNotice(notificationRow(without)), `${payload.kind} without ${key}`).toBeNull();
      }
    }
  });

  it("字段类型或取值不对 → null:数量带小数 / 为负、价格是字符串、side / role / orderStatus / outcome / reason / direction 未知、symbol 为空", () => {
    const bad: unknown[] = [
      { ...fillPayload, quantity: 0.5 },
      { ...fillPayload, quantity: -1 },
      { ...fillPayload, price: "9800" },
      { ...fillPayload, price: Number.NaN },
      { ...fillPayload, side: "HOLD" },
      { ...fillPayload, role: "BOTH" },
      { ...fillPayload, orderStatus: "NEW" },
      { ...fillPayload, orderId: "" },
      { ...fillPayload, symbol: 12 },
      { ...triggerPayload, outcome: "PENDING" },
      { ...triggerPayload, reason: "BROKE" },
      { ...triggerPayload, reason: undefined },
      { ...triggerPayload, side: "HOLD" },
      { ...triggerPayload, quantity: 1.5 },
      { ...triggerPayload, orderId: 5 },
      { ...triggerPayload, triggerPrice: null },
      { ...alertPayload, direction: "UP" },
      { ...alertPayload, firedPrice: 1.5 },
      { ...alertPayload, triggerId: "" },
    ];
    for (const payload of bad) expect(toNotice(notificationRow(payload)), JSON.stringify(payload)).toBeNull();
  });

  it("JSON 里多出来的键不进响应(按字段重建);大数字与 0 都合法", () => {
    const notice = toNotice(notificationRow({ ...fillPayload, userId: "u_alice", secret: "x", quantity: 0, price: 123_456_789 }));
    expect(notice).toEqual({ id: "ntc_1", createdAt: T0.getTime(), readAt: null, ...fillPayload, quantity: 0, price: 123_456_789 });
    expect(notice && "secret" in notice).toBe(false);
    expect(notice && "userId" in notice).toBe(false);
  });
});
