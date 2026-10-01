// 旧页面的 CSV 导出地址(P2-06):页面筛选 → C5 接口能表达的参数;表达不了的部分不带(页面在提示里说明文件里是什么)。
import { describe, expect, it } from "vitest";
import { legacyActivityCsv, legacyOrdersCsv } from "./csv-export-links";

describe("legacyOrdersCsv(/orders)", () => {
  it("未完成 → status=open(OPEN / PARTIAL,与页面的 ACTIVE 同一组),全部 → 不筛", () => {
    expect(legacyOrdersCsv("ACTIVE")).toEqual({ href: "/api/account/orders.csv?status=open", scope: "open" });
    expect(legacyOrdersCsv("ALL")).toEqual({ href: "/api/account/orders.csv", scope: "all" });
  });

  it("已成交、已取消 → status=history(两者一起,接口没有单独的一种)", () => {
    expect(legacyOrdersCsv("FILLED")).toEqual({ href: "/api/account/orders.csv?status=history", scope: "history" });
    expect(legacyOrdersCsv("CANCELLED")).toEqual({ href: "/api/account/orders.csv?status=history", scope: "history" });
  });
});

describe("legacyActivityCsv(/transactions)", () => {
  it("信用余额 → account=HOLDING,注销 → type=RETIREMENT,全部 → 不筛(与页面的逐行判定相同)", () => {
    expect(legacyActivityCsv("all")).toBe("/api/transactions.csv");
    expect(legacyActivityCsv("credits")).toBe("/api/transactions.csv?account=HOLDING");
    expect(legacyActivityCsv("retirement")).toBe("/api/transactions.csv?type=RETIREMENT");
  });

  it("现金是两个账户(CASH、CASH_LOCKED),接口一次只筛一个:导出全部流水", () => {
    expect(legacyActivityCsv("cash")).toBe("/api/transactions.csv");
  });
});
