// 旧页面(/orders、/transactions)上的 CSV 导出地址(计划 §6.2.2 C5,P2-06)。纯函数,node 测试直接调用。
// 导出接口的筛选参数与终端的 JSON 接口相同(C5):订单只有 status=open|history 与 symbol,流水是 account / type / symbol / from / to。
// 旧页面的筛选更细或不同(订单分「已成交」「已取消」、另有买卖方向;流水的「现金」是 CASH 与 CASH_LOCKED 两个账户),
// 表达不了的部分就不带,页面把「文件里是什么」写进链接的提示,不假装与屏幕上一致。
// 文案不在这里:旧页面用页面现成的内联中英文写法(useExchangeText 的 c("…", "…"),§9.2 D32)。

/** /orders 页的状态筛选(URL 的 status 值) */
export type LegacyOrderStatus = "ACTIVE" | "ALL" | "FILLED" | "CANCELLED";
/** 文件里的订单范围:未完成(OPEN / PARTIAL)、全部、终态(FILLED / CANCELLED) */
export type OrdersCsvScope = "open" | "all" | "history";

/**
 * /orders 的导出地址。ACTIVE → status=open(与页面的「未完成订单」同一组状态);ALL → 不筛;
 * FILLED、CANCELLED → status=history(两者一起,接口没有单独的一种)。买卖方向接口不筛,文件里两个方向都有。
 */
export function legacyOrdersCsv(status: LegacyOrderStatus): { href: string; scope: OrdersCsvScope } {
  const scope: OrdersCsvScope = status === "ACTIVE" ? "open" : status === "ALL" ? "all" : "history";
  return { href: scope === "all" ? "/api/account/orders.csv" : `/api/account/orders.csv?status=${scope}`, scope };
}

/** /transactions 页的分类按钮 */
export type LegacyActivityFilter = "all" | "credits" | "cash" | "retirement";

/**
 * /transactions 的导出地址。credits → account=HOLDING、retirement → type=RETIREMENT(与页面的逐行判定相同);
 * cash 是两个账户(CASH、CASH_LOCKED),接口的 account 一次只收一个,所以导出全部流水(文件里有 account 列可以筛)。
 * 页面的分类只作用于已加载的记录;导出的是全部记录。
 */
export function legacyActivityCsv(filter: LegacyActivityFilter): string {
  if (filter === "credits") return "/api/transactions.csv?account=HOLDING";
  if (filter === "retirement") return "/api/transactions.csv?type=RETIREMENT";
  return "/api/transactions.csv";
}
