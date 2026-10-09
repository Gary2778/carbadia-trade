"use client";
// 市场 store(计划 §3.6):zustand 5 模块级单例,永不随路由重建。
//
// SSR 规则(§6.1):zustand 5 的 useStore 在服务端渲染与客户端水合期读的都是 getInitialState() —— 即本文件
// createInitialState() 的空状态。渲染期写 store 既不会出现在 HTML 里,也会造成水合不一致。因此:
//   - 首屏可见内容(头部价格、左栏列表、碳元数据)一律由 props(initialInstruments)渲染,组件写成 `store 值 ?? props 值`;
//   - 任何组件不得在渲染期调用 marketActions;store 只在 MarketProvider 挂载后的 useEffect 里由 setInstruments 灌入;
//   - 服务端进程里这个 store 永远是空的,不存在跨请求残留。
//
// 写入纪律:WS / 轮询帧一律经 batcher 走 marketActions.applyEvents(唯一批量写入口,一次 set());
// 结构共享:只替换被触碰的 symbol 键,未触碰的键引用不变;book.version / instrumentsVersion / tickersVersion 单调递增,
// 供 selectors 的显式 memo cache 当键。金额整数分、数量整数吨、时间 unix ms。
import { create } from "zustand";
import type {
  CandleBar,
  CandleInterval,
  ConnectionState,
  Instrument,
  InstrumentListItem,
  OrderBookLevel,
  ServerEvent,
  Side,
  TapeEntry,
  Ticker,
  TickerUpdate,
} from "@/shared";
import { CANDLE_INTERVALS, MAX_BARS, MAX_TAPE } from "@/shared";
import { INTERVAL_MS, bucketUpdate } from "@/shared/candle-live";

/** 单个标的的盘口:Map 按价格索引(原始 tick 精度,聚合在视图层);version 全局单调,evict 后重订阅也不会撞键 */
export type BookState = {
  bids: Map<number, OrderBookLevel>;
  asks: Map<number, OrderBookLevel>;
  /** 最后一条已应用事件的 seq;轮询帧为 0 */
  seq: number;
  version: number;
  ts: number;
};

/** 盘口点价写入的下单草稿种子;nonce 保证同价再点也触发 OrderPanel 的 effect */
export type DraftSeed = { symbol: string; side?: Side; price?: number; nonce: number };

export type CandleKey = `${string}:${CandleInterval}`;
export const candleKey = (symbol: string, interval: CandleInterval): CandleKey => `${symbol}:${interval}`;

export type MarketState = {
  instruments: Record<string, Instrument>;
  tickers: Record<string, Ticker>;
  books: Record<string, BookState>;
  /** 按到达顺序追加(旧 → 新),≤ MAX_TAPE;按 id 去重 */
  tapes: Record<string, TapeEntry[]>;
  /**
   * 逐标的的成交快照就绪标记:订阅 trades:S 以来收到过 S 的 trades 事件(快照哪怕是空的)就置位 ——
   * 空快照不给 tapes 建键,成交面板靠它区分「还没加载」(骨架)与「确实没有成交」(空态)。
   * hub 回 unsubscribed{trades:S}(换标的、标签页隐藏时退订)与 evictSymbol 时清掉:ws-client 退订时丢掉该 topic 的 seq 基线,
   * 下一次订阅不带 since,hub 一定回整份快照,标记会重新置位;断线重连 / 缺口重订阅不退订,标记保留(手里的数据仍有效)。
   */
  tapeReady: Record<string, true>;
  /** 键 `${symbol}:${interval}`,按 t 升序,≤ MAX_BARS */
  candles: Record<CandleKey, CandleBar[]>;
  connection: ConnectionState;
  draft: DraftSeed;
  /** 镜像 localStorage 的 carbadia-credit-watchlist */
  watchlist: string[];
  instrumentsVersion: number;
  tickersVersion: number;
};

export function createInitialState(): MarketState {
  return {
    instruments: {},
    tickers: {},
    books: {},
    tapes: {},
    tapeReady: {},
    candles: {},
    connection: { transport: "none", state: "offline", lastMessageAt: null, rttMs: null },
    draft: { symbol: "", nonce: 0 },
    watchlist: [],
    instrumentsVersion: 0,
    tickersVersion: 0,
  };
}

/** 模块级单例。不含 action:写入一律走下面的 marketActions,避免组件拿到 set 后在渲染期误用 */
export const useMarketStore = create<MarketState>()(() => createInitialState());

/** book.version 全局递增:同一 symbol 被 evict 再订阅后版本号也不回头,selectors 的缓存键永不撞车 */
let bookVersionSeq = 0;
const nextBookVersion = (): number => ++bookVersionSeq;

const emptyTicker = (symbol: string, ts: number): Ticker => ({
  symbol,
  lastPrice: null,
  bestBid: null,
  bestAsk: null,
  change24h: null,
  high24h: null,
  low24h: null,
  volume24h: 0,
  ts,
});

/** 合并 ticker 部分字段:只覆盖已定义的字段(轮询翻译层可能带 undefined),ts 取新值 */
function mergeTicker(prev: Ticker | undefined, update: TickerUpdate): Ticker {
  const next: Ticker = { ...(prev ?? emptyTicker(update.symbol, update.ts)) };
  for (const key of Object.keys(update) as (keyof TickerUpdate)[]) {
    const value = update[key];
    if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
  }
  next.symbol = update.symbol;
  next.ts = update.ts;
  return next;
}

const levelsToMap = (levels: OrderBookLevel[]): Map<number, OrderBookLevel> => {
  const m = new Map<number, OrderBookLevel>();
  for (const level of levels) m.set(level.price, level);
  return m;
};

/** 就地把增量合进工作副本(副本仅本批可见,所以直接 mutate 比每条事件复制一次 Map 便宜) */
function applyDeltaInPlace(levels: Map<number, OrderBookLevel>, delta: OrderBookLevel[]): void {
  for (const level of delta) {
    if (level.quantity === 0) levels.delete(level.price);
    else levels.set(level.price, level);
  }
}

/** 二分找 t 的插入位(bars 按 t 升序);命中返回 { index, found: true } */
function locateBar(bars: CandleBar[], t: number): { index: number; found: boolean } {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return { index: lo, found: lo < bars.length && bars[lo].t === t };
}

/** 按 t upsert 一根 bar(就地);超过 MAX_BARS 从最旧的一端裁掉 */
function upsertBar(bars: CandleBar[], bar: CandleBar): void {
  const last = bars[bars.length - 1];
  if (!last || bar.t > last.t) bars.push(bar);
  else if (bar.t === last.t) bars[bars.length - 1] = bar;
  else {
    const { index, found } = locateBar(bars, bar.t);
    if (found) bars[index] = bar;
    else bars.splice(index, 0, bar);
  }
  if (bars.length > MAX_BARS) bars.splice(0, bars.length - MAX_BARS);
}

/**
 * 纯归约:把一批服务端事件折成 store 的 patch(只含被触碰的切片;切片内只替换被触碰的键)。
 * 无任何变化返回 null。applyEvents 用它做一次 set();测试直接调用它断言结构共享。
 *
 * 语义(计划 §3.3):book.snapshot 整体替换;book.delta 只含变化档、quantity 0 删档,无快照在手时忽略;
 * trades 追加、按 id 去重(全是重复时不产生 patch)、保持按 ts 升序(乱序批次 —— WS 降级轮询后 REST 的更早成交 —— 按 ts 稳定排序)、
 * 保留 ts 最新的 MAX_TAPE 笔,并置该标的的 tapeReady(空的 trades 快照也置);
 * unsubscribed{trades:S} 清掉 S 的 tapeReady;ticker 部分字段合并;candle 按 t upsert;
 * 轮询模式(connection.transport === "poll")下把比已知最新成交更新的成交用 bucketUpdate 折进已加载的六个 interval,
 * WS 模式以 candle 事件为准不折算;hello / subscribed / 其它 topic 的 unsubscribed / pong / error / resync 不改 store
 * (重订阅由 ws-client 负责,随后到达的快照会覆盖旧数据);account 事件(order / fill / balance / position)
 * 不属于本 store,由 MarketProvider 的 apply 回调转交 useAccountStore.applyAccountEvent。
 */
export function reduceEvents(state: MarketState, events: readonly ServerEvent[]): Partial<MarketState> | null {
  // 工作副本:首次触碰某键时从 state 复制一份,之后本批内就地修改
  const books = new Map<string, BookState>();
  /** added:本批真的进了新成交(全是重复的 trades 事件 —— 轮询每 2 s 一份 —— 不产生 patch,TradesTape 不重渲染) */
  const tapes = new Map<string, { entries: TapeEntry[]; ids: Set<string>; newestTs: number; added: boolean }>();
  const candles = new Map<CandleKey, CandleBar[]>();
  let tickers: Record<string, Ticker> | null = null;
  /** tapeReady 的工作副本:只在某个标的真的翻转时才复制,重复的空快照(轮询每 2 s 一次)不产生 patch */
  let tapeReady: Record<string, true> | null = null;
  const poll = state.connection.transport === "poll";
  const setTapeReady = (symbol: string, ready: boolean): void => {
    const current = tapeReady ?? state.tapeReady;
    if ((current[symbol] === true) === ready) return;
    if (ready) tapeReady = { ...current, [symbol]: true };
    else tapeReady = omitKey(current, symbol);
  };

  const workingBook = (symbol: string): BookState | undefined => {
    const touched = books.get(symbol);
    if (touched) return touched;
    const prev = state.books[symbol];
    if (!prev) return undefined;
    const copy: BookState = { bids: new Map(prev.bids), asks: new Map(prev.asks), seq: prev.seq, version: nextBookVersion(), ts: prev.ts };
    books.set(symbol, copy);
    return copy;
  };
  const workingTape = (symbol: string) => {
    let slot = tapes.get(symbol);
    if (!slot) {
      const prev = state.tapes[symbol] ?? [];
      slot = { entries: prev.slice(), ids: new Set(prev.map((e) => e.id)), newestTs: prev.length ? prev[prev.length - 1].ts : Number.NEGATIVE_INFINITY, added: false };
      tapes.set(symbol, slot);
    }
    return slot;
  };
  /** 只对已加载(键存在)的 interval 返回工作副本;没有历史的 interval 不凭空开桶 */
  const workingCandles = (key: CandleKey, createIfMissing: boolean): CandleBar[] | undefined => {
    const touched = candles.get(key);
    if (touched) return touched;
    const prev = state.candles[key];
    if (!prev && !createIfMissing) return undefined;
    const copy = prev ? prev.slice() : [];
    candles.set(key, copy);
    return copy;
  };

  for (const ev of events) {
    switch (ev.t) {
      case "book.snapshot": {
        books.set(ev.symbol, { bids: levelsToMap(ev.bids), asks: levelsToMap(ev.asks), seq: ev.seq, version: nextBookVersion(), ts: ev.ts });
        break;
      }
      case "book.delta": {
        const book = workingBook(ev.symbol);
        if (!book) break;
        applyDeltaInPlace(book.bids, ev.bids);
        applyDeltaInPlace(book.asks, ev.asks);
        book.seq = ev.seq;
        book.ts = ev.ts;
        break;
      }
      case "trades": {
        setTapeReady(ev.symbol, true);
        if (ev.trades.length === 0) break;
        const tape = workingTape(ev.symbol);
        const knownNewest = tape.newestTs;
        // 比 tape 里最新的一笔还早的成交(WS → 轮询降级后 REST 的 100 笔比 hub 环里的 ≤ 64 笔更往前)不能追加在尾部,
        // 否则顶行(newestFirst 的第一行)显示的是旧成交;记下乱序,循环后再排
        let outOfOrder = false;
        for (const trade of ev.trades) {
          if (tape.ids.has(trade.id)) continue;
          tape.ids.add(trade.id);
          tape.entries.push(trade);
          tape.added = true;
          if (trade.ts < tape.newestTs) outOfOrder = true;
          else tape.newestTs = trade.ts;
          // 轮询模式:只把比已知最新成交更新的成交折进 K 线(更早的已在 REST 历史里,折进去会重复计量);
          // 之前没有 tape 时(knownNewest = -∞)同样不折,首批快照交给 REST 历史
          if (poll && Number.isFinite(knownNewest) && trade.ts > knownNewest) {
            for (const interval of CANDLE_INTERVALS) {
              const bars = workingCandles(candleKey(ev.symbol, interval), false);
              if (!bars) continue;
              const last = bars.length ? bars[bars.length - 1] : null;
              const { bar, isNew } = bucketUpdate(last, trade, INTERVAL_MS[interval]);
              if (isNew) upsertBar(bars, bar);
              else if (bar !== last) bars[bars.length - 1] = bar;
            }
          }
        }
        // 只按 ts 稳定排序,不带 id:同一毫秒的成交(一笔 taker 吃掉几档)保持到达 / 生成顺序(framesFromTrades 同样只按 ts 稳定排)。
        // 只有乱序批次才排,平常的追加不花这一步;排好之后数组头部就是 ts 最旧的,下面的截断丢的就是最旧的
        if (outOfOrder) tape.entries.sort((a, b) => a.ts - b.ts);
        if (tape.entries.length > MAX_TAPE) {
          const dropped = tape.entries.splice(0, tape.entries.length - MAX_TAPE);
          for (const e of dropped) tape.ids.delete(e.id);
        }
        break;
      }
      case "ticker": {
        if (!tickers) tickers = { ...state.tickers };
        tickers[ev.symbol] = mergeTicker(tickers[ev.symbol], ev.ticker);
        break;
      }
      case "candle": {
        const bars = workingCandles(candleKey(ev.symbol, ev.interval), true)!;
        upsertBar(bars, ev.candle);
        break;
      }
      case "unsubscribed": {
        if (ev.topic.startsWith("trades:")) setTapeReady(ev.topic.slice("trades:".length), false);
        break;
      }
      default:
        // hello / subscribed / pong / error / resync / order / fill / balance / position / trigger / notice:本 store 不变(账户事件归账户 store)
        break;
    }
  }

  const patch: Partial<MarketState> = {};
  let changed = false;
  if (books.size) {
    patch.books = { ...state.books };
    for (const [symbol, book] of books) patch.books[symbol] = book;
    changed = true;
  }
  for (const [symbol, slot] of tapes) {
    if (!slot.added) continue;
    patch.tapes ??= { ...state.tapes };
    patch.tapes[symbol] = slot.entries;
    changed = true;
  }
  if (candles.size) {
    patch.candles = { ...state.candles };
    for (const [key, bars] of candles) patch.candles[key] = bars;
    changed = true;
  }
  if (tapeReady) {
    patch.tapeReady = tapeReady;
    changed = true;
  }
  if (tickers) {
    patch.tickers = tickers;
    patch.tickersVersion = state.tickersVersion + 1;
    changed = true;
  }
  return changed ? patch : null;
}

const sameStrings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
/** 去掉一个键,返回新对象(其余键引用不变) */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const rest: Record<string, T> = {};
  for (const k of Object.keys(record)) if (k !== key) rest[k] = record[k];
  return rest;
}
const sameConnection = (a: ConnectionState, b: ConnectionState): boolean =>
  a.transport === b.transport && a.state === b.state && a.lastMessageAt === b.lastMessageAt && a.rttMs === b.rttMs;

export const marketActions = {
  /** 唯一批量写入口(由 batcher.flush 调用):一批事件一次 set() */
  applyEvents(events: readonly ServerEvent[]): void {
    if (events.length === 0) return;
    const patch = reduceEvents(useMarketStore.getState(), events);
    if (patch) useMarketStore.setState(patch);
  },

  /**
   * 灌入标的列表(SSR props 或轮询 /api/market/instruments):instruments 整体替换,ticker 只在更新(ts 更大)时覆盖 live 值;
   * onlyIfEmpty 且已灌过(instrumentsVersion > 0)时不写 —— TerminalShell / MarketProvider 挂载 effect 用它
   */
  setInstruments(items: readonly InstrumentListItem[], opts?: { onlyIfEmpty?: boolean }): void {
    const state = useMarketStore.getState();
    if (opts?.onlyIfEmpty && state.instrumentsVersion > 0) return;
    const instruments: Record<string, Instrument> = {};
    const tickers: Record<string, Ticker> = { ...state.tickers };
    for (const item of items) {
      const symbol = item.instrument.symbol;
      instruments[symbol] = item.instrument;
      const live = tickers[symbol];
      if (!live || item.ticker.ts >= live.ts) tickers[symbol] = item.ticker;
    }
    useMarketStore.setState({
      instruments,
      tickers,
      instrumentsVersion: state.instrumentsVersion + 1,
      tickersVersion: state.tickersVersion + 1,
    });
  },

  setConnection(connection: ConnectionState): void {
    if (sameConnection(useMarketStore.getState().connection, connection)) return;
    useMarketStore.setState({ connection: { ...connection } });
  },

  /**
   * 盘口点价 / 手机买卖条 / 持仓 Sell / b · s 热键写草稿种子;每次调用 nonce + 1,同价再点也会触发。
   * 整颗替换、不与上一颗合并:只带 side 的调用不会带回上一次盘口点价的 price;不带 symbol 的调用 symbol 为 "",
   * OrderPanel 不认(shouldConsumeSeed 只认当前标的)。显式传 price: undefined 的旧写法照样兼容。
   */
  setDraft(partial: Partial<Omit<DraftSeed, "nonce">>): void {
    const { nonce } = useMarketStore.getState().draft;
    useMarketStore.setState({ draft: { symbol: "", ...partial, nonce: nonce + 1 } });
  },

  setWatchlist(symbols: readonly string[]): void {
    if (sameStrings(useMarketStore.getState().watchlist, symbols)) return;
    useMarketStore.setState({ watchlist: [...symbols] });
  },

  /** 退订 90 s 后丢弃该 symbol 的盘口 / tape(连同就绪标记)/ 全部 interval 的 K 线;instruments / tickers(ticker:* 全量订阅)保留 */
  evictSymbol(symbol: string): void {
    const state = useMarketStore.getState();
    const patch: Partial<MarketState> = {};
    if (symbol in state.books) patch.books = omitKey(state.books, symbol);
    if (symbol in state.tapes) patch.tapes = omitKey(state.tapes, symbol);
    if (symbol in state.tapeReady) patch.tapeReady = omitKey(state.tapeReady, symbol);
    const candleKeys = CANDLE_INTERVALS.map((interval) => candleKey(symbol, interval)).filter((key) => key in state.candles);
    if (candleKeys.length) {
      const rest = { ...state.candles };
      for (const key of candleKeys) delete rest[key];
      patch.candles = rest;
    }
    if (Object.keys(patch).length) useMarketStore.setState(patch);
  },
};
