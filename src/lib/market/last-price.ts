// 行情 store 里某个标的的最新价(纯函数,零依赖):持仓估值(position-groups 再导出)、下单面板的条件单与两个条件单对话框共用这一个。
// 单独成模块:下单面板在首屏包里,引它不会把 position-groups 一起拖进去。

/** 行情 store 里某个标的的最新价:逐笔推送的 ticker 优先,其次标的列表里的 lastPrice;都没有 → null */
export function lastPriceOf(
  state: { tickers: Readonly<Record<string, { lastPrice: number | null } | undefined>>; instruments: Readonly<Record<string, { lastPrice: number | null } | undefined>> },
  symbol: string,
): number | null {
  return state.tickers[symbol]?.lastPrice ?? state.instruments[symbol]?.lastPrice ?? null;
}
