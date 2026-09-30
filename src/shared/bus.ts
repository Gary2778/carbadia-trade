// 进程内总线消息与 globalThis 契约(计划 §3.4「globalThis 总线契约」、§3.5)。
// instrumentation、route handler 与 server.mjs 是三个独立的 bundle / realm,凡是要跨它们共享的状态只能挂在 globalThis 上,
// 且只放 JSON 可序列化的纯数据:无 class、无 instanceof。唯一的 createBus() 实现在 server/bus.mjs(P1-04)。
import type { InstrumentsResponse } from "./api-shapes";
import type { Balance, CandleBar, CandleInterval, Fill, Order, OrderBookDelta, OrderBookSnapshot, Position, TapeEntry, TickerUpdate } from "./types";
import type { Topic } from "./ws-protocol";

export type AccountEvent =
  | { t: "order"; order: Order }
  | { t: "fill"; fill: Fill }
  | { t: "balance"; balance: Balance }
  | { t: "position"; position: Position };

export type BusMessage =
  | { kind: "book"; symbol: string; snapshot: OrderBookSnapshot; delta: OrderBookDelta | null }
  | { kind: "trades"; symbol: string; trades: TapeEntry[] }
  | { kind: "ticker"; symbol: string; ticker: TickerUpdate }
  | { kind: "candle"; symbol: string; interval: CandleInterval; candle: CandleBar }
  | { kind: "account"; userId: string; event: AccountEvent };

/** 同步扇出;订阅者异常隔离;hasSubscribers() 为 false(START_MODE=next 无 hub)时发布器跳过一切派生 */
export type CarbadiaBus = {
  publish(msg: BusMessage): void;
  subscribe(fn: (msg: BusMessage) => void): () => void;
  hasSubscribers(): boolean;
};

/** hub 维护、/api/health 直接返回;WS_DISABLED → enabled: false 且各计数 0 */
export type WsStats = {
  enabled: boolean;
  connections: number;
  subscriptions: number;
  framesOut: number;
  bytesOut: number;
  droppedDeltas: number;
  resyncs: number;
  rejected: number;
  closedByBackpressure: number;
  /**
   * account 订阅快照连续被该用户的事件穿插、放弃并改由 resync 恢复的次数(按连接计;计划 §9.2 D16)。
   * 这条路径同样发 resync{reason: "backpressure"},但不是背压,不计入 droppedDeltas / resyncs
   */
  snapshotRaces: number;
  startedAt: number;
};

/** hub 在 subscribe / unsubscribe / close 时增减;发布器经 presence.ts 的 hasInterest / hasUser 做第二级门控 */
export type Presence = { users: Map<string, number>; topics: Map<Topic, number> };

declare global {
  var __carbadiaBus: CarbadiaBus | undefined;
  var __carbadiaWsStats: WsStats | undefined;
  var __carbadiaPresence: Presence | undefined;
  /** 每个 topic 的单调 seq:hub 独占写,REST 路由只读;next start 无 hub 时 undefined(REST seq 恒 0) */
  var __carbadiaTopicSeq: Map<Topic, number> | undefined;
  /** key = assetId */
  var __carbadiaBookCache: Map<string, OrderBookSnapshot> | undefined;
  /** key = "assetId:interval" */
  var __carbadiaCandleState: Map<string, CandleBar> | undefined;
  /** listInstruments() 的 2 s 进程缓存 */
  var __carbadiaInstrumentsCache: { at: number; value: InstrumentsResponse } | undefined;
}
