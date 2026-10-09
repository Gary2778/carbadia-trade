// WebSocket 实时协议(计划 §3.3)。一个客户端文本帧 = 一个 ClientOp(JSON);一个服务端文本帧 = ServerEvent[](hub 每连接 50 ms 合帧)。
// 运行时 zod schema 在 server/ws-schema.mjs(纯 JS,hub 与测试共用);ws-protocol.test.ts 把本文件的示例值往返校验,保证两边不漂移。
import type { Balance, CandleBar, CandleInterval, Fill, Notice, Order, OrderBookLevel, Position, TapeEntry, TickerUpdate, Trigger } from "./types";

export const WS_PROTOCOL_VERSION = 1 as const;
/** 服务端 ws 层 ping 间隔;10 s 内无 pong → terminate() */
export const WS_HEARTBEAT_MS = 25_000;
/** 每连接 topic 上限;超出 → error too_many_topics */
export const WS_MAX_TOPICS = 64;
/** hub 为每个 trades:* topic 保留的 { seq, entry } 环长度;since 回放的缺口上限 */
export const WS_TAPE_RING = 64;

/** ticker:* 是唯一的通配 topic;trades:* / book:* 不存在 */
export type Topic =
  | `book:${string}`
  | `trades:${string}`
  | `ticker:${string}`
  | "ticker:*"
  | `candles:${string}:${CandleInterval}`
  | "account";

export type ClientOp =
  | { op: "subscribe"; topics: Topic[]; since?: Partial<Record<Topic, number>> }
  | { op: "unsubscribe"; topics: Topic[] }
  | { op: "ping"; t0: number };

export type WsErrorCode = "bad_request" | "unauthorized" | "too_many_topics" | "unknown_topic" | "rate_limited";

export type ServerEvent =
  | {
      t: "hello";
      v: typeof WS_PROTOCOL_VERSION;
      serverTime: number;
      heartbeatMs: typeof WS_HEARTBEAT_MS;
      userId: string | null;
      maxTopics: typeof WS_MAX_TOPICS;
      /** 本进程的启动标识(终审 P1-25a 起由 hub 填):与上次连接的不同 = 服务端重启过,客户端清掉 lastSeq、不带 since */
      bootId?: string;
    }
  | { t: "subscribed"; topic: Topic; seq: number }
  | { t: "unsubscribed"; topic: Topic }
  | { t: "pong"; t0: number; serverTime: number }
  | { t: "error"; code: WsErrorCode; message: string; topic?: Topic }
  | { t: "book.snapshot"; topic: `book:${string}`; seq: number; symbol: string; bids: OrderBookLevel[]; asks: OrderBookLevel[]; ts: number }
  | { t: "book.delta"; topic: `book:${string}`; seq: number; symbol: string; bids: OrderBookLevel[]; asks: OrderBookLevel[]; ts: number }
  | { t: "trades"; topic: `trades:${string}`; seq: number; symbol: string; trades: TapeEntry[] }
  | { t: "ticker"; topic: `ticker:${string}` | "ticker:*"; seq: number; symbol: string; ticker: TickerUpdate }
  | { t: "candle"; topic: `candles:${string}:${CandleInterval}`; seq: number; symbol: string; interval: CandleInterval; candle: CandleBar }
  | { t: "order"; topic: "account"; seq: number; order: Order }
  | { t: "fill"; topic: "account"; seq: number; fill: Fill }
  | { t: "balance"; topic: "account"; seq: number; balance: Balance }
  | { t: "position"; topic: "account"; seq: number; position: Position }
  | { t: "trigger"; topic: "account"; seq: number; trigger: Trigger }
  | { t: "notice"; topic: "account"; seq: number; notice: Notice; unread: number }
  | { t: "resync"; topic: Topic; reason: "backpressure" | "restart" };

/** 一个服务端文本帧 = JSON 数组(hub 每连接 50 ms 合帧) */
export type ServerFrame = ServerEvent[];
