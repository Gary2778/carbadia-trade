// 公开行情快照(计划 §3.4「撮合与 OTC」末段、§3.5 api-shapes):四个 /api/market/* 路由与轮询帧(P1-14 poll-frames)共用。
// 形状 = src/shared/api-shapes 的 *Response,与 WS 事件同形,轮询降级时可以直接翻成 ServerFrame。
// 这个前缀下永不放含用户数据的响应(边缘名单整前缀可缓存);标的字段只经 INSTRUMENT_SELECT / toInstrument,anchorPrice 永不外露。
// 本模块会同时被 route handler 与 instrumentation(发布器)两个 bundle 加载:零模块级状态,进程缓存只挂 globalThis。
import type { InstrumentsResponse } from "../../shared/api-shapes";
import { auditRefOf, DEFAULT_FEE_SCHEDULE, DEPTH_OPTIONS, MAX_BARS, MAX_TAPE } from "../../shared/constants";
import { takerSideOf } from "../../shared/taker";
import type { CandleBar, CandleInterval, InstrumentListItem, OrderBookSnapshot, OrderType, TapeEntry, Ticker } from "../../shared/types";
import type { Topic } from "../../shared/ws-protocol";
import { INTERVALS } from "../exchange/candles";
import { getOrderBook } from "../exchange/matching";
import { stats24h } from "../exchange/stats24h";
import { prisma } from "./db";
import { INSTRUMENT_SELECT, toInstrument } from "./instrument-select";

/** listInstruments 的进程缓存时长;与 /api/assets 一样把 N 个访客的查询坍缩为每 2 s 一次 */
export const INSTRUMENTS_CACHE_TTL_MS = 2_000;

declare global {
  /**
   * listInstruments 缓存的代数(纯数据,跨 bundle 一份):invalidateInstrumentsCache() 递增。listInstruments 在查询前记下代数,
   * 返回时代数变了就不写回缓存——查询期间有人宣布它过时(OTC 成交改了 lastPrice),读到的可能是提交前的旧价。
   */
  var __carbadiaInstrumentsGen: number | undefined;
  /**
   * getBars / getPublicBars 的进程缓存(跨 bundle 一份,P1-25b;P1-25e 分档 + 过去的窗口):键 `${assetId}:${interval}:${档}:${窗口终点}`,
   * 档 = cacheTier(limit)(≤ 500 一档,更大的按周期上限一档),窗口终点 = "now"(到现在)或对齐到桶末尾的过去时刻。
   * 值:bars = 按「档」根数查库的 Promise(在途时并发请求共用它),at = 查询开始时刻,to = 这次查询的窗口终点(now 窗口即 at)。
   * 命中者按自己的 limit 从 bars 里截取时间窗(barsWindow);结果数组只读。
   */
  var __carbadiaBarsCache: Map<string, { at: number; to: number; bars: Promise<CandleBar[]> }> | undefined;
  /** K 线路由未命中缓存时的查库预算(令牌桶,全进程共享,P1-25e):tokens = 剩余,at = 上次结算时刻 */
  var __carbadiaBarsBudget: { tokens: number; at: number } | undefined;
}

/**
 * 作废标的列表缓存(发布器在 OTC 成交提交后调用):把已有条目标记为过期(at = 0),并让此刻正在查询的 listInstruments 不再把结果写回。
 * 标记而不是删掉(P1-25b):hub 的 symbolKnown 拿这份列表判断「标的存在吗」,删掉会让它在下一次 listInstruments 之前放行任何 symbol;
 * 过期条目 listInstruments 不再命中,下一次请求照常查库刷新。
 * 只作废不够:一个在提交前读了 Asset、在作废后才返回的请求会把旧价写回缓存,再挂 2 s——代数挡住它。
 */
export function invalidateInstrumentsCache(): void {
  globalThis.__carbadiaInstrumentsGen = (globalThis.__carbadiaInstrumentsGen ?? 0) + 1;
  const hit = globalThis.__carbadiaInstrumentsCache;
  if (hit) globalThis.__carbadiaInstrumentsCache = { at: 0, value: hit.value };
}

/** 盘口档数上限 = 客户端最大深度选项(50);getOrderBook 自己也钳到 50 */
export const MAX_BOOK_DEPTH = Math.max(...DEPTH_OPTIONS);
export const DEFAULT_BOOK_DEPTH = MAX_BOOK_DEPTH;
export const DEFAULT_TAPE_LIMIT = 100;
export const DEFAULT_BARS = 500;
/** getBars 进程缓存时长 = /api/market/[symbol]/candles 的 s-maxage(5 s) */
export const BARS_CACHE_TTL_MS = 5_000;
/** 缓存键上限(标的 × 周期 × 档 × 窗口终点):满了先清过期条目,仍满就整表清空(与 rate-limit.ts 的 MAX_KEYS 同一思路,缓存是尽力而为) */
export const BARS_CACHE_MAX_KEYS = 512;
/**
 * 公开 K 线每个周期最多给多少根(P1-25e 收紧;计划 §3.4 原为统一 1..1500):1m 保留 1500(分时请求 1440 根 = 24 h);
 * 5m / 15m / 1h 1000 根(≈ 3.5 d / 10.4 d / 41.7 d);4h / 1d 500 根(≈ 83 d / 500 d,终端对它们请求的就是 500)。
 * 窗口恒为 limit × interval(queryBars),所以时间窗上限 = 这里的根数 × interval。getBars 不带 to(到现在)时同样钳到它。
 */
export const PUBLIC_MAX_BARS: Readonly<Record<CandleInterval, number>> = { "1m": MAX_BARS, "5m": 1000, "15m": 1000, "1h": 1000, "4h": 500, "1d": 500 };
/**
 * K 线路由「过去的窗口」未命中缓存时的查库预算(P1-25e):全进程一个令牌桶,每秒回 10 个、最多攒 20 个。按 IP 限流挡得住单个来源,
 * 挡不住许多 IP 各带不同的过去 to —— 那条路径每个请求都是一个新缓存键、一次窗口内全表聚合,而连接池只有 1 条(db.ts),
 * 它排在下单、撤单与机器人前面。「到现在」的窗口不花这个预算:它的键空间本来有界(标的 × 周期 × 2 档,TTL 5 s),
 * 终端的正常请求(1m × 1440 与其余周期 × 500)未命中时每秒可能超过 10 次;若也扣同一个桶,别人刷过去 to 把桶抽干时,
 * 正常的图表加载会跟着 503、停在错误态等用户点重试。所以只有往前翻历史(带过去的 to)的请求会碰到它。
 */
export const BARS_QUERY_BUDGET = { perSecond: 10, burst: 20 } as const;
/**
 * K 线路由的按 IP 限流(P1-25b):公开、可被查询串绕过边缘缓存的端点里它最重(窗口内成交全表扫描)。
 * 正常客户端每分钟一次校准 + 切标的 / 周期时各一次,且规范 URL 多数被边缘缓存吃掉;与 orders:ip 同一个 120/min。
 */
export const CANDLES_RATE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

/** 三个 [symbol] 路由先按 symbol 解析出这个最小引用,再取快照;找不到 → null(路由回 404 'Instrument not found') */
export type AssetRef = { id: string; symbol: string };

export function findAssetRef(symbol: string): Promise<AssetRef | null> {
  return prisma.asset.findUnique({ where: { symbol }, select: { id: true, symbol: true } });
}

/** 查询串整数:缺省 / 非数字 → fallback,其余截断后钳到 [min, max] */
export function clampInt(value: string | number | null | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value === "") return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 查询串里的 unix 毫秒:缺省 / 非有限数 → undefined */
export function readMs(value: string | null | undefined): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  // 超出 Date 可表示范围(±8.64e15 ms)的值会变成 Invalid Date 让 Prisma 抛校验错(公开接口 500),按未提供处理
  if (!Number.isFinite(n) || n < 0 || n > 8.64e15) return undefined;
  return Math.trunc(n);
}

/** hub 写、REST 只读的 topic 序号;START_MODE=next 或 WS_DISABLED 无 hub → 0 = 无序号 */
export function topicSeq(topic: Topic): number {
  return globalThis.__carbadiaTopicSeq?.get(topic) ?? 0;
}

/**
 * 全部标的 + ticker(change24h 为百分数,stats24h 一处计算)+ 费率表 + serverTime。
 * 进程缓存 2 s(globalThis.__carbadiaInstrumentsCache,跨 bundle 同一份);命中时原样返回,serverTime 至多旧 2 s。
 * 查询期间缓存被 invalidateInstrumentsCache() 作废过(代数变了)→ 本次结果照常返回给这个请求,但不写回缓存。
 */
export async function listInstruments(): Promise<InstrumentsResponse> {
  const now = Date.now();
  const hit = globalThis.__carbadiaInstrumentsCache;
  if (hit && now - hit.at >= 0 && now - hit.at < INSTRUMENTS_CACHE_TTL_MS) return hit.value;
  const gen = globalThis.__carbadiaInstrumentsGen ?? 0;

  const rows = await prisma.asset.findMany({ orderBy: { symbol: "asc" }, select: INSTRUMENT_SELECT });
  const instruments: InstrumentListItem[] = await Promise.all(
    rows.map(async (row) => {
      // 最优买卖价直接取盘口第一档:与 /api/market/[symbol]/book 同一口径(只算未吃完的 LIMIT 挂单)
      const [book, stats] = await Promise.all([getOrderBook(row.id, 1), stats24h(row.id, row.lastPrice)]);
      const ticker: Ticker = {
        symbol: row.symbol,
        lastPrice: row.lastPrice,
        bestBid: book.bids[0]?.price ?? null,
        bestAsk: book.asks[0]?.price ?? null,
        change24h: stats.change24hPct,
        high24h: stats.high24h,
        low24h: stats.low24h,
        volume24h: stats.volume24h,
        ts: now,
      };
      return { instrument: toInstrument(row), ticker };
    }),
  );
  const value: InstrumentsResponse = { instruments, feeSchedule: DEFAULT_FEE_SCHEDULE, serverTime: now };
  if ((globalThis.__carbadiaInstrumentsGen ?? 0) === gen) globalThis.__carbadiaInstrumentsCache = { at: now, value };
  return value;
}

/** 50 档以内的盘口快照:bids 降序、asks 升序、原始 tick 精度(聚合在客户端) */
export async function getBookSnapshot(asset: AssetRef, depth = DEFAULT_BOOK_DEPTH): Promise<OrderBookSnapshot> {
  const { bids, asks } = await getOrderBook(asset.id, clampInt(depth, DEFAULT_BOOK_DEPTH, 1, MAX_BOOK_DEPTH));
  return { symbol: asset.symbol, bids, asks, ts: Date.now() };
}

const ORDER_STUB_SELECT = { id: true, type: true, price: true, createdAt: true } as const;

/**
 * 最近成交,时间升序(旧 → 新,与 WS trades 快照事件同序,轮询帧可直接喂 applyEvents)。
 * limit 钳到 1..MAX_TAPE(200);before = 只取 createdAt < before(unix ms)的成交,用于向前翻页。
 * takerSide 不落库,join 两张订单的最小字段经 takerSideOf 确定性派生(计划 §9.1 第 25 条)。
 */
export async function getRecentTrades(asset: AssetRef, limit = DEFAULT_TAPE_LIMIT, before?: number): Promise<TapeEntry[]> {
  const rows = await prisma.trade.findMany({
    where: { assetId: asset.id, ...(before === undefined ? {} : { createdAt: { lt: new Date(before) } }) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: clampInt(limit, DEFAULT_TAPE_LIMIT, 1, MAX_TAPE),
    select: { id: true, price: true, quantity: true, createdAt: true, buyOrder: { select: ORDER_STUB_SELECT }, sellOrder: { select: ORDER_STUB_SELECT } },
  });
  return rows.reverse().map((t) => ({
    id: t.id,
    symbol: asset.symbol,
    price: t.price,
    quantity: t.quantity,
    // type 列是自由 TEXT,但只有 matching.ts 用 LIMIT / MARKET 两个字面量写入
    takerSide: takerSideOf({
      price: t.price,
      buyOrder: { id: t.buyOrder.id, type: t.buyOrder.type as OrderType, price: t.buyOrder.price, createdAt: t.buyOrder.createdAt.getTime() },
      sellOrder: { id: t.sellOrder.id, type: t.sellOrder.type as OrderType, price: t.sellOrder.price, createdAt: t.sellOrder.createdAt.getTime() },
    }),
    ts: t.createdAt.getTime(),
    auditRef: auditRefOf(t.id),
  }));
}

type BarRow = { t: number | bigint; o: number | bigint; h: number | bigint; l: number | bigint; c: number | bigint; v: number | bigint };

/**
 * 最近 limit 根 K 线,窗口按需取,不看 INTERVALS.lookbackMs(计划 §9.1 第 22 条):
 * 起点对齐到桶边界 = bucketStart(to) − (limit − 1) × ms,这样返回的每根 bar 都是完整桶(最新一根是进行中的),
 * 窗口长度落在 ((limit − 1) × ms, limit × ms],是计划「lookback = limit × ms」窗口的子集。
 * 1m × 1440 = 24 h 分时;旧 /api/assets/[symbol]/candles 不走这里,仍是固定 lookback + 240 根。
 *
 * 给了 to(发布器按成交时刻补桶)→ limit 钳到 1..MAX_BARS,精确查库、不缓存 —— 缓存里的结果可能早于那几笔刚提交的成交。
 * 不给 to = 「到现在」的窗口 → limit 钳到 PUBLIC_MAX_BARS[interval],走进程缓存(见 __carbadiaBarsCache):TTL 5 s,在途查询共用,
 * limit 分档(cacheTier)后截取,不花查库预算(只有路由的 getPublicBars 对过去的窗口花)。
 */
export function getBars(asset: AssetRef, interval: CandleInterval, limit = DEFAULT_BARS, to?: number): Promise<CandleBar[]> {
  if (to !== undefined) return queryBars(asset.id, interval, clampInt(limit, DEFAULT_BARS, 1, MAX_BARS), to);
  const cap = PUBLIC_MAX_BARS[interval];
  return cachedBars(asset.id, interval, clampInt(limit, Math.min(DEFAULT_BARS, cap), 1, cap), undefined, null) as Promise<CandleBar[]>;
}

/**
 * 公开 K 线路由用(P1-25e):limit 钳到 PUBLIC_MAX_BARS[interval];to 缺省、在未来或落在当前桶里 → 「到现在」的窗口;
 * 过去的 to 对齐到它所在桶的末尾(最后一根是那一整桶),按对齐后的时刻缓存 —— 同一个桶里的不同 to 共用一次查库,
 * 往前翻历史的客户端(to = 最早一根的 t − 1)天然落在同一组键上。只有过去的窗口未命中缓存才花查库预算(spend,默认全进程令牌桶),
 * 预算用完返回 null,路由回 503 + Retry-After: 1;「到现在」的窗口从不花、从不 503(键空间有界,见 BARS_QUERY_BUDGET)。
 */
export function getPublicBars(
  asset: AssetRef,
  interval: CandleInterval,
  limit: number | string | null | undefined,
  to: number | undefined,
  spend: () => boolean = spendBarsQuery,
): Promise<CandleBar[]> | null {
  const cap = PUBLIC_MAX_BARS[interval];
  const max = clampInt(limit, Math.min(DEFAULT_BARS, cap), 1, cap);
  const ms = INTERVALS[interval].ms;
  const aligned = to === undefined ? undefined : Math.floor(to / ms) * ms + ms - 1;
  const pinned = aligned !== undefined && aligned < Date.now() ? aligned : undefined;
  return cachedBars(asset.id, interval, max, pinned, pinned === undefined ? null : spend);
}

/** 缓存档:limit ≤ 500 按 500 根查(周期上限更小时按上限),更大的按周期上限查;命中后由 barsWindow 截回 limit × interval 的时间窗 */
function cacheTier(interval: CandleInterval, limit: number): number {
  const cap = PUBLIC_MAX_BARS[interval];
  return limit <= DEFAULT_BARS ? Math.min(DEFAULT_BARS, cap) : cap;
}

/**
 * 从按「档」查出的 bars 里取 limit 根的窗口:t ≥ bucketStart(to) − (limit − 1) × ms。档的窗口是它的超集,queryBars 又从不截断
 * (窗口里正好「档」个桶),所以结果与直接按 limit 查库逐根相同 —— 不是「最新 limit 根有成交的桶」。不用截时原数组照返(引用稳定)。
 */
function barsWindow(bars: CandleBar[], interval: CandleInterval, limit: number, to: number): CandleBar[] {
  const ms = INTERVALS[interval].ms;
  const start = Math.floor(to / ms) * ms - (limit - 1) * ms;
  return bars.length === 0 || bars[0].t >= start ? bars : bars.filter((bar) => bar.t >= start);
}

/**
 * 缓存查找 / 填充。pinned = 过去窗口的终点(已对齐到桶末尾),undefined = 到现在。spend = null 不花预算;
 * 否则未命中时先 spend(),拿不到令牌就返回 null(不查库、不写缓存)。
 */
function cachedBars(assetId: string, interval: CandleInterval, limit: number, pinned: number | undefined, spend: (() => boolean) | null): Promise<CandleBar[]> | null {
  const cache: NonNullable<typeof globalThis.__carbadiaBarsCache> = (globalThis.__carbadiaBarsCache ??= new Map());
  const tier = cacheTier(interval, limit);
  const key = `${assetId}:${interval}:${tier}:${pinned ?? "now"}`;
  const now = Date.now();
  const fresh = (at: number): boolean => now - at >= 0 && now - at < BARS_CACHE_TTL_MS;
  const hit = cache.get(key);
  if (hit && fresh(hit.at)) return hit.bars.then((bars) => barsWindow(bars, interval, limit, hit.to));
  if (spend && !spend()) return null;
  if (!hit && cache.size >= BARS_CACHE_MAX_KEYS) {
    for (const [k, entry] of cache) if (!fresh(entry.at)) cache.delete(k);
    if (cache.size >= BARS_CACHE_MAX_KEYS) cache.clear();
  }
  const to = pinned ?? now;
  const bars = queryBars(assetId, interval, tier, to);
  cache.set(key, { at: now, to, bars });
  // 失败不留在缓存里:在途的等待者拿到同一个错误,下一次请求重新查(只删自己这一条,别删掉之后写入的新条目)
  bars.catch(() => {
    if (cache.get(key)?.bars === bars) cache.delete(key);
  });
  return bars.then((rows) => barsWindow(rows, interval, limit, to));
}

/** 从全进程查库预算里取一个令牌(BARS_QUERY_BUDGET:每秒回 perSecond 个,最多 burst 个);没有就 false */
export function spendBarsQuery(now = Date.now()): boolean {
  const { perSecond, burst } = BARS_QUERY_BUDGET;
  const budget = (globalThis.__carbadiaBarsBudget ??= { tokens: burst, at: now });
  budget.tokens = Math.min(burst, budget.tokens + (Math.max(0, now - budget.at) * perSecond) / 1_000);
  budget.at = now;
  if (budget.tokens < 1) return false;
  budget.tokens -= 1;
  return true;
}

/**
 * OHLCV 在 SQLite 里聚合(P1-25b):只有 ≤ max 行进 JS。旧做法把窗口内全部成交读进 Node 再分桶——1d × 500 的窗口覆盖整段历史,
 * 70k 笔时每次约 130 ms、十个并发把 RSS 推到 1.4 GB(对照同库 SQL 聚合约 23 ms、RSS 约 140 MB,数据见 P1-25b 报告)。
 * 语义与 bucketTrades 逐根相同:桶 = floor(createdAt / ms) × ms;高低量取 MAX / MIN / SUM;开盘 = 桶内 (createdAt, id) 最小那笔的价,
 * 收盘 = 最大那笔的价(同一毫秒按 id 定序,与旧查询的 orderBy [createdAt asc, id asc] 一致);只留最新 max 个桶,按 t 升序返回。
 * 开 / 收各一条走 (assetId, createdAt) 索引的子查询,最多 2 × max 次索引查找。
 * createdAt 是整数毫秒(Prisma 在 SQLite 里就这样存 DateTime,见 sparkline.ts);参数全部是扁平的标量,不用嵌套 Prisma.sql 片段
 *(instrumentation 与路由是两个 bundle,片段跨 bundle 会被当成普通参数,见 sparkline.ts 的 2026-09-24 事故说明)。
 * CAST(ms AS INTEGER) 保证整数除法,不依赖驱动把 JS number 绑成整数还是浮点。
 */
async function queryBars(assetId: string, interval: CandleInterval, max: number, to: number): Promise<CandleBar[]> {
  const ms = INTERVALS[interval].ms;
  const from = Math.floor(to / ms) * ms - (max - 1) * ms;
  const rows = await prisma.$queryRaw<BarRow[]>`
    SELECT g.b * CAST(${ms} AS INTEGER) AS t, g.h AS h, g.l AS l, g.v AS v,
      (SELECT "price" FROM "Trade" WHERE "assetId" = ${assetId} AND "createdAt" = g.t0 ORDER BY "id" ASC LIMIT 1) AS o,
      (SELECT "price" FROM "Trade" WHERE "assetId" = ${assetId} AND "createdAt" = g.t1 ORDER BY "id" DESC LIMIT 1) AS c
    FROM (
      SELECT CAST("createdAt" AS INTEGER) / CAST(${ms} AS INTEGER) AS b,
        MAX("price") AS h, MIN("price") AS l, SUM("quantity") AS v, MIN("createdAt") AS t0, MAX("createdAt") AS t1
      FROM "Trade"
      WHERE "assetId" = ${assetId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
      GROUP BY b ORDER BY b DESC LIMIT ${max}
    ) g
    ORDER BY t ASC`;
  // SQLite 的整数列经原生查询可能以 BigInt 回来(聚合列尤其如此);价格、数量、毫秒都在安全整数内
  return rows.map((r) => ({ t: Number(r.t), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v) }));
}
