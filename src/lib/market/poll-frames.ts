// 轮询帧翻译(计划 §3.2 降级路径、§9.2 D1):把 /api/market/* 与 /api/account/* 的 REST 响应翻成 ServerFrame,
// 喂给与 WS 相同的 batcher,组件无感。纯函数,零副作用。
// 语义:这些帧一律是快照(book.snapshot、整条 trades、ticker 全量、candle 逐根、account 逐条);
// seq 取 REST 响应原样(即 hub 的 __carbadiaTopicSeq,START_MODE=next 无 hub 时为 0),
// 没有 seq 的响应(instruments / candles / account)一律 0 = 无序号;ws-client 对 seq 0 不做缺口检测,
// 而且轮询帧根本不经过 ws-client(MarketProvider 直接 push 进 batcher),所以永远不会触发重订阅。
import type {
  Balance,
  BookResponse,
  CandleInterval,
  CandlesResponse,
  InstrumentsResponse,
  Order,
  Position,
  ServerFrame,
  TradesResponse,
} from "@/shared";

/** 无序号 */
export const NO_SEQ = 0;

export function framesFromBook(symbol: string, r: BookResponse): ServerFrame {
  return [{ t: "book.snapshot", topic: `book:${symbol}`, seq: r.seq, symbol, bids: r.bids, asks: r.asks, ts: r.ts }];
}

/**
 * REST 按 createdAt desc 分页返回;WS 快照是时间升序,store 也按到达顺序追加,所以这里按 ts 升序排。
 * 先 reverse 再稳定排序:同一毫秒的多笔成交(一笔吃单在一个事务里撮合多个挂单是常态)在 desc 里是倒着的,
 * 直接稳定排序会让它们保持倒序 —— 轮询模式 store 按数组顺序折 K 线,open / close 会取错一笔,tape 的顺序也与 WS 相反;
 * 反过来之后的稳定排序让同 ts 的成交保持创建顺序,与 WS / 事务顺序一致
 */
export function framesFromTrades(symbol: string, r: TradesResponse): ServerFrame {
  const trades = r.trades.slice().reverse().sort((a, b) => a.ts - b.ts);
  return [{ t: "trades", topic: `trades:${symbol}`, seq: r.seq, symbol, trades }];
}

/** 每个标的一条 ticker:* 事件(与 hub 对 ticker:* 的 snapshot-on-subscribe 同形:逐条全量) */
export function framesFromInstruments(r: InstrumentsResponse): ServerFrame {
  return r.instruments.map((item) => ({ t: "ticker", topic: "ticker:*", seq: NO_SEQ, symbol: item.instrument.symbol, ticker: item.ticker }));
}

/** 每根 bar 一条 candle 事件,store 按 t upsert;interval 以调用方为准(与请求的 URL 一致) */
export function framesFromCandles(symbol: string, interval: CandleInterval, r: CandlesResponse): ServerFrame {
  return r.candles.map((candle) => ({ t: "candle", topic: `candles:${symbol}:${interval}`, seq: NO_SEQ, symbol, interval, candle }));
}

/** 与 hub 对 account 的 snapshot-on-subscribe 同序:balance → 逐条 order → 逐条 position */
export function framesFromAccount(orders: readonly Order[], positions: readonly Position[], balance: Balance): ServerFrame {
  const frame: ServerFrame = [{ t: "balance", topic: "account", seq: NO_SEQ, balance }];
  for (const order of orders) frame.push({ t: "order", topic: "account", seq: NO_SEQ, order });
  for (const position of positions) frame.push({ t: "position", topic: "account", seq: NO_SEQ, position });
  return frame;
}
