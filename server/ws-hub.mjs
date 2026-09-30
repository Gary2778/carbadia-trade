// @ts-check
// WebSocket hub(计划 §3.3 全部语义、§3.4 契约表):/ws 的 upgrade 路由、鉴权、连接与速率上限、每 topic 单调 seq、
// 快照缓存(book 50 档 / ticker 最后值 / trades 64 条环)、since 回放、每连接 50 ms 合帧、背压(delta 与订阅快照都受限)、心跳、统计与 presence。
// 纯 JS、零 DB、不 import src/**:数据只从 globalThis.__carbadiaBus 的 BusMessage 来,协议由 server/ws-schema.mjs 校验。
// 两层:createHub() 是与传输无关的核心(连接对象只需 HubSocket 的几个方法,单元测试用假 socket);
// attachWsHub() 把核心接到 http.Server 的 upgrade 事件与 ws 的 WebSocketServer 上(集成测试用真实 http + ws 客户端)。
//
// globalThis 契约(只放纯数据,无 class):
//   __carbadiaWsStats  = WsStats(本文件原地累加;/api/health 直接返回;每 60 s 打一行 {"src":"ws","ev":"stats",...})
//   __carbadiaPresence = { users: Map<userId, n>, topics: Map<Topic, n> }(subscribe / unsubscribe / close 时增减;
//                        users 计的是该用户 account 订阅的连接数,发布器据此决定要不要派生 account 事件)
//   __carbadiaTopicSeq = Map<Topic, number>(hub 独占写,REST 路由读;进程启动从 1 起,每次发布 +1,快照不增)
// account topic 的 seq 按用户各自单调(内部 Map<userId, seq>),不写进 __carbadiaTopicSeq:该 topic 的事件流本来就是按用户切分的,
// 若共用一个计数器,任何用户的成交都会让其他用户的客户端看到「缺口」而反复重订阅。
// account 订阅时的快照(balance + 挂单 + 持仓)来自 globalThis.__carbadiaAccountSnapshot(函数型全局,发布器挂上;lead 裁决的例外):
// hub 零 DB、不能 import src/**,缺省时不发快照,客户端仍经 REST 水合。同一用户的快照查询在跑时并进去,查完冷却 2 s,冷却里的订阅并成一次。
// 快照缓存(盘口 / ticker)只在有人订阅、发布器还在喂它时保留(无人订阅期间发布器不派生,门控 ②):订阅数归零后,等退订那条连接的
// 合帧窗口结束仍无人订才淘汰(期间 presence 仍计 1、发布器照常喂;客户端回应 resync 的 unsubscribe + subscribe 因此不清缓存,见 held),
// 淘汰之后总线上晚到的消息也不进缓存。book 订阅时没有缓存,这条连接就等本 symbol 的下一条盘口消息(对它以整份快照发出),
// 并经 globalThis.__carbadiaBookRefresh(同样由发布器挂上)请发布器全量刷新,每个 symbol 每秒至多一次、连着 3 次没等来盘口消息或查无此 symbol 即停
// (读库有代价,见 requestBookRefresh)——客户端 store 只认 book.snapshot、WS 模式下不拉 REST 盘口,hub 必须给出一份快照;
// ticker 没有缓存时只回 subscribed,客户端保留 REST 值。
// trades 的环只收 hub 起来之后发布的成交:环没满、本进程还没为这个 symbol 预读过时,第一次订阅经 globalThis.__carbadiaRecentTrades
//(发布器挂上)读库里最近 64 笔接到环前面(seq 0),再以整份快照发给等着的连接(见 tradesWaiters;终审 P1-25a,同一写法)。
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";
import { IP_BUCKET_UNTRUSTED, clientIpFromHeaders, isSharedIpBucket } from "./client-ip.mjs";
import { readSessionCookie, verifySession } from "./session.mjs";
import { WS_HEARTBEAT_MS, WS_MAX_TOPICS, WS_PROTOCOL_VERSION, WS_TAPE_RING, clientOpSchema } from "./ws-schema.mjs";

/** @typedef {import("../src/shared/ws-protocol").Topic} Topic */
/** @typedef {import("../src/shared/ws-protocol").ServerEvent} ServerEvent */
/** @typedef {import("../src/shared/ws-protocol").WsErrorCode} WsErrorCode */
/** @typedef {import("../src/shared/bus").BusMessage} BusMessage */
/** @typedef {import("../src/shared/bus").CarbadiaBus} CarbadiaBus */
/** @typedef {import("../src/shared/bus").WsStats} WsStats */
/** @typedef {import("../src/shared/bus").Presence} Presence */
/** @typedef {import("../src/shared/bus").AccountEvent} AccountEvent */
/** @typedef {import("../src/shared/types").OrderBookSnapshot} OrderBookSnapshot */
/** @typedef {import("../src/shared/types").TapeEntry} TapeEntry */
/** @typedef {import("../src/shared/types").TickerUpdate} TickerUpdate */

/**
 * 核心只依赖 socket 的这几个成员(ws 的 WebSocket 与测试的假 socket 都满足)。
 * @typedef {object} HubSocket
 * @property {number} readyState
 * @property {number} bufferedAmount
 * @property {(data: string, cb?: (err?: Error) => void) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {() => void} terminate
 * @property {() => void} ping
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 */

/**
 * @typedef {object} Conn
 * @property {HubSocket} ws
 * @property {string | null} userId
 * @property {string} ip
 * @property {Set<Topic>} topics
 * @property {ServerEvent[]} pending
 * @property {number} pendingBytes pending 的字节估计(approxBytes 之和,flush 归零):订阅限流看 bufferedAmount + 它——
 *   bufferedAmount 在 50 ms 合帧 flush 之前一直不涨,只看它的话同一窗口里的突发订阅不受限
 * @property {Set<Topic>} answered 本合帧窗口里已经排好完整订阅回应(快照 / 回放 / 最后值,或已登记为等整份快照)的 book / trades / ticker topic;
 *   同一窗口里再订只回 subscribed,不排第二份快照。flush 清空,退订移除
 * @property {ReturnType<typeof setTimeout> | null} flushTimer
 * @property {Set<Topic>} stale 背压期间被跳过 delta 或订阅快照的 topic,缓冲降下来后发 resync
 * @property {Map<Topic, OwedReason>} owed 欠着订阅快照的 topic:快照补上(不受背压的重订阅)之前 stream() 不发它的任何事件;
 *   客户端重订阅 trades 时即使带 since 也补整份快照(它手里没有 tape)。值是欠下的原因,只用于计数(见 OwedReason)
 * @property {Set<Topic>} resyncSent 已为欠快照发过 resync、还没等到重订阅的 topic。退订不清(客户端对 book / ticker / account 的
 *   重订阅是 unsubscribe + subscribe),下一次订阅该 topic 时取走:那次订阅的限流线多给 RESYNC_ANSWER_HEADROOM_BYTES。
 *   客户端退订后不再订的,留到连接关闭(条目数不超过这条连接订过的不同 topic 数)
 * @property {Set<Topic>} releases 这条连接在本合帧窗口里退订、订阅数因此归零的 book / ticker topic(见 createHub 的 held):
 *   窗口结束(flush)或连接关闭时还没人接着订,才淘汰缓存、presence 减 1
 * @property {number | null} overSince bufferedAmount 首次超过 2 MB 的时刻
 * @property {number} opWindowStart
 * @property {number} opCount
 * @property {number} dropWindowStart
 * @property {number} dropCount
 * @property {number} badStreak
 * @property {number} unverifiedWindowStart 限流窗口(1 s)的起点,见 MAX_UNVERIFIED_SYMBOLS_PER_SECOND
 * @property {Set<string>} unverified 本窗口里放行的、没法核实存在与否的 symbol
 * @property {ReturnType<typeof setTimeout> | null} pongTimer
 * @property {ReturnType<typeof setTimeout> | null} graceTimer closeConn 后等对端回 close 帧的宽限计时,到期 terminate
 * @property {boolean} closing 已调用 ws.close()(1008 / 1013 / 1012),不再处理入站、不再重复关
 * @property {boolean} closed
 * @property {() => void} [onClose]
 */

/**
 * 为什么欠快照:"backpressure" = 订阅时连接已背压、快照被扣住(计 droppedDeltas / resyncs,计划 §9.2 D16);
 * "race" = account 快照连续 ACCOUNT_SNAPSHOT_ATTEMPTS 次被该用户的事件穿插(不是背压:不计入 droppedDeltas / resyncs,
 * 免得 ws-flood 这类按背压计数度量的测量被它抬高;单独计 snapshotRaces,另记一行日志)。
 * 两者对客户端一样:收到 resync{reason: "backpressure"}(协议的 reason 不变),重订阅拿快照。
 * @typedef {"backpressure" | "race"} OwedReason
 */

/** 默认放行的 Origin;非生产由 parseAllowedOrigins 额外加 LOCALHOST_ORIGIN */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze(["https://cbda.trade"]);
/** `:*` 结尾表示任意端口(含无端口) */
export const LOCALHOST_ORIGIN = "http://localhost:*";
export const DEFAULT_MAX_CONNECTIONS = 500;
export const DEFAULT_MAX_PER_IP = 8;
/**
 * "untrusted" 桶(设了 PROXY_SECRET、请求没经我们的 Worker:直连源站或 x-proxy-secret 不匹配)的连接上限。
 * 这个桶不是某个客户端的 IP,不能按 maxPerIp 限;但也不能豁免——豁免时一台主机直连源站就能占满 WS_MAX_CONNECTIONS,
 * 所有真实访客的 /ws 都回 503(终审 P1-25a)。真实浏览器流量在密钥一致时永远不落进这个桶;Worker 与源站的密钥漂移时
 * 所有人都落进来,/ws 在这 16 个之外降级为轮询(HTTP 限流那边同一个桶也已经坏了,/api/health?probe 能看出信任链断了)。
 * 代码内默认,可用 WS_MAX_UNTRUSTED 覆盖,不需要新的 Railway 变量(计划 D10)
 */
export const DEFAULT_MAX_UNTRUSTED = 16;

const WS_OPEN = 1;
const BATCH_MS = 50;
const PONG_TIMEOUT_MS = 10_000;
const BACKPRESSURE_SCAN_MS = 1_000;
const BACKPRESSURE_SKIP_BYTES = 256 * 1024;
const BACKPRESSURE_RESYNC_BYTES = 64 * 1024;
const BACKPRESSURE_CLOSE_BYTES = 2 * 1024 * 1024;
const BACKPRESSURE_CLOSE_AFTER_MS = 10_000;
/** 硬顶:不等 10 s,下一轮扫描立即 1013(控制事件不看 bufferedAmount,这是它们的兜底) */
const BACKPRESSURE_HARD_CLOSE_BYTES = 8 * 1024 * 1024;
const STATS_INTERVAL_MS = 60_000;
const MAX_OPS_PER_SECOND = 20;
const MAX_DROPPED_OPS_PER_MINUTE = 100;
const MAX_CONSECUTIVE_BAD_FRAMES = 5;
const MAX_PAYLOAD_BYTES = 4096;
/** 关闭码:1008 策略(限速 / 坏帧,客户端不重连)、1013 过载(背压,客户端 10 s 起退避) */
const CLOSE_POLICY = 1008;
const CLOSE_OVERLOAD = 1013;
/** closeGraceMs 的默认值:close() / closeConn() 后等待客户端回 close 帧的上限,超时 terminate(不等 ws 自己的 30 s);必须小于 lifecycle 的 3 s 排空 */
const CLOSE_GRACE_MS = 1_000;
/**
 * account 订阅快照最多查几次:查询期间该用户有事件流出(seq 变了)就重查,快照可能比那些事件旧;
 * 连着几次都被穿插就不发,把 topic 记为欠快照(owed),由背压扫描发 resync 让客户端重订阅
 */
const ACCOUNT_SNAPSHOT_ATTEMPTS = 3;
/**
 * 同一用户两次 account 快照查询之间的最小间隔(accountSnapshotCooldownMs 的默认值),从上一次查询结束(发出、放弃或失败)算起。
 * 每份快照是一个批量读事务,含该用户的全部挂单、持仓与整本成本账本;没有冷却时,一个 demo 登录 20 op/s × 8 条连接的重复订阅
 * 能让它连着跑(终审 P1-25a)。冷却里来的订阅(重复订阅、该用户的其它连接)并进冷却结束时的一次查询;正常客户端只在打开页面、
 * 重连与 resync 时订阅,至多多等 2 s,仍在 ws-client 等快照的 5 s 之内
 */
const ACCOUNT_SNAPSHOT_COOLDOWN_MS = 2_000;
/**
 * book 全量刷新的冷却(bookRefreshCooldownMs 的默认值):同一 symbol 的两次刷新(各是一次 50 档读库)至少隔这么久。
 * 冷却期间来的订阅者等下一条盘口消息,冷却结束时还没等到就补一次刷新(尾随)
 */
const BOOK_REFRESH_COOLDOWN_MS = 1_000;
/**
 * 同一 symbol 连着请了几次刷新都没等来它的盘口消息(钩子返回了却没发:发布器判定无兴趣、读取被较新的一次顶掉、读库失败……)就不再请,
 * 直到下一次订阅;发布器回 { found: false }(库里没有这个 symbol)则立即不再请。等着的连接不丢:之后只要来了这本簿的盘口消息,
 * 照样以整份快照发给它们。没有这道闸,一个不存在的 symbol 的订阅会让发布器每个冷却期查一次库,没有尽头
 */
const BOOK_REFRESH_MAX_MISSES = 3;
/**
 * 进程刚起、hub 还从没见过标的列表(__carbadiaInstrumentsCache)时,没法核实的 symbol 只能放行;每条连接每秒至多放行这么多个
 * 不同的这种 symbol,超出的 topic 回 error rate_limited。没有这道闸,一条匿名连接在 20 op/s 内订阅 / 退订 64 个随机 book 主题,
 * 每秒能引出约 640 次刷新(各一次 asset.findUnique),与撮合、机器人抢同一个 SQLite(终审 P1-25a)。
 * 正常客户端一次只订一个标的的几个 topic(同一 symbol 只占一个名额),快速切换标的也远到不了 8 个 / 秒
 */
const MAX_UNVERIFIED_SYMBOLS_PER_SECOND = 8;
/**
 * 同一件事的全 hub 额度(P1-25e,纵深防御):令牌桶,每秒回这么多个、最多攒这么多个,按「不同的 symbol」计 ——
 * 查库(盘口刷新、成交预读)按 symbol 去重,所以一秒内别的连接再订已放行过的 symbol 不占令牌。按连接的 8 个 / 秒挡不住多条连接
 *(未受信 IP 桶 16 条、每个 Cloudflare IP 8 条,合起来每秒上百次查库,P1-25a 复审)。这条路径只在进程刚起的一小段里走得到:
 * instrumentation 在 ensureInstruments 之后预读标的列表(listInstruments),但 listen 不等它(见 src/instrumentation.ts),
 * 预读完成之前到达的 /ws 订阅才会遇到没法核实的 symbol
 */
const MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB = 10;
/** 成交带预读(见 createHub 的 tradesWaiters)在途超过这么久就放行等着的连接,不让它们一直收不到这个 symbol 的成交 */
const TRADES_PRELOAD_TIMEOUT_MS = 3_000;
/** `[ws] book refresh failed` 每个 symbol 至多每这么久一行;期间的失败只计数,记在下一行里(读库持续失败时不刷屏) */
const REFRESH_FAIL_LOG_INTERVAL_MS = 60_000;
/**
 * 回应 resync 的重订阅在限流线(256 KB)之上多给的余量。扫描在 ≤ 256 KB 时对欠快照的 topic 发 resync,到客户端重订阅的这一个往返里
 * 缓冲还会涨;没有余量的话,停在 256 KB 附近的连接(慢消费者的常态:流事件按 256 KB 跳过,缓冲就围着它上下)会每秒循环一次
 * owed → resync → 被限流的重订阅 → owed,盘口 / 成交带一直空着。每次 resync 只放一次,一个窗口里多排的至多是这个余量
 */
const RESYNC_ANSWER_HEADROOM_BYTES = 64 * 1024;

// 待发事件的字节估计(approxBytes):不序列化、只按条目数算,取实际 JSON(连同帧里的一个逗号)的上沿。按真实尺寸量过
// (ws-hub.test.ts 的 approxBytes 用例):id 与 auditRef 里是 25 字符的 cuid,symbol 最长 14 字符(CCER-SCEN-2026),价格按 7 位分、数量按 6 位吨取上沿——
// 成交带条目约 180 字节(TAPE_ENTRY_BYTES 192),档位 {"price":1234567,"quantity":100000,"orders":12} 约 48 字节(BOOK_LEVEL_BYTES 48);
// 满 64 条的 trades 事件约 11.6 KB、50 档 book.snapshot 约 4.9 KB;全字段 ticker 在 `ticker:*` 上约 275 字节、按标的订阅(topic 带 14 字符 symbol,change24h 取 23 字符的小幅浮点、成交量 11 位)约 292 字节(TICKER_EVENT_BYTES 320),
// candle 约 200 字节,account 行至多约 450 字节(fill 带 4 个 ledgerRef),其余控制事件 ≤ 121 字节
const EVENT_BASE_BYTES = 128;
const BOOK_EVENT_BASE_BYTES = 160;
const BOOK_LEVEL_BYTES = 48;
const TAPE_ENTRY_BYTES = 192;
const TICKER_EVENT_BYTES = 320;
const CANDLE_EVENT_BYTES = 224;
const ACCOUNT_ROW_EVENT_BYTES = 512;

/**
 * 一条待发事件在帧里大约占多少字节(上沿);订阅快照的限流按它累计本窗口的待发字节。导出供测试核对常数不低于真实尺寸。
 * @param {ServerEvent} event
 * @returns {number}
 */
export function approxBytes(event) {
  switch (event.t) {
    case "book.snapshot":
    case "book.delta":
      return BOOK_EVENT_BASE_BYTES + (event.bids.length + event.asks.length) * BOOK_LEVEL_BYTES;
    case "trades":
      return EVENT_BASE_BYTES + event.trades.length * TAPE_ENTRY_BYTES;
    case "ticker":
      return TICKER_EVENT_BYTES;
    case "candle":
      return CANDLE_EVENT_BYTES;
    case "order":
    case "fill":
    case "position":
      return ACCOUNT_ROW_EVENT_BYTES;
    default:
      return EVENT_BASE_BYTES;
  }
}

/**
 * @param {boolean} enabled
 * @param {number} startedAt
 * @returns {WsStats}
 */
export function zeroWsStats(enabled, startedAt = Date.now()) {
  return {
    enabled,
    connections: 0,
    subscriptions: 0,
    framesOut: 0,
    bytesOut: 0,
    droppedDeltas: 0,
    resyncs: 0,
    rejected: 0,
    closedByBackpressure: 0,
    snapshotRaces: 0,
    startedAt,
  };
}

/**
 * WS_ALLOWED_ORIGINS(逗号分隔)覆盖默认的 https://cbda.trade;非生产额外放行 http://localhost:*。
 * @param {Record<string, string | undefined>} env
 * @param {boolean} dev
 * @returns {string[]}
 */
export function parseAllowedOrigins(env, dev) {
  const raw = env.WS_ALLOWED_ORIGINS;
  const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [...DEFAULT_ALLOWED_ORIGINS];
  if (dev && !list.includes(LOCALHOST_ORIGIN)) list.push(LOCALHOST_ORIGIN);
  return list;
}

/**
 * @param {string} origin 请求头原值
 * @param {readonly string[]} allowed 精确匹配,或 `:*` 结尾匹配任意端口
 */
export function originAllowed(origin, allowed) {
  const o = origin.trim().toLowerCase();
  for (const pat of allowed) {
    const p = pat.trim().toLowerCase();
    if (!p) continue;
    if (p.endsWith(":*")) {
      const base = p.slice(0, -2);
      if (o === base || o.startsWith(`${base}:`)) return true;
    } else if (o === p) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} topic 已过 topicSchema
 * @returns {{ kind: "book" | "trades" | "ticker" | "candles"; symbol: string } | { kind: "account" } | { kind: "ticker"; symbol: "*" }}
 */
function parseTopic(topic) {
  if (topic === "account") return { kind: "account" };
  if (topic === "ticker:*") return { kind: "ticker", symbol: "*" };
  const i = topic.indexOf(":");
  const kind = /** @type {"book" | "trades" | "ticker" | "candles"} */ (topic.slice(0, i));
  const rest = topic.slice(i + 1);
  if (kind === "candles") return { kind, symbol: rest.slice(0, rest.lastIndexOf(":")) };
  return { kind, symbol: rest };
}

/**
 * @typedef {object} HubOptions
 * @property {CarbadiaBus} [bus] 有则订阅,close() 时退订
 * @property {(line: string) => void} [log]
 * @property {number} [heartbeatMs] ws 层 ping 间隔(hello 里报告的仍是协议常量 WS_HEARTBEAT_MS)
 * @property {number} [pongTimeoutMs]
 * @property {number} [batchMs]
 * @property {number} [backpressureScanMs]
 * @property {number} [backpressureCloseAfterMs]
 * @property {number} [closeGraceMs] 服务端主动 close 后等对端回 close 帧的宽限,到期 terminate
 * @property {number} [statsIntervalMs]
 * @property {() => number} [now]
 * @property {(ws: HubSocket) => number} [bufferedAmountOf] 测试打桩 bufferedAmount
 * @property {(symbol: string) => boolean} [isKnownSymbol] 覆盖默认的「总线见过 ∪ __carbadiaInstrumentsCache」判定
 * @property {(userId: string) => AccountSnapshotResult | Promise<AccountSnapshotResult>} [accountSnapshot] account 订阅时的快照来源(测试注入);
 *   缺省时在每次订阅时读 globalThis.__carbadiaAccountSnapshot(由 src/lib/server/market-publisher.ts 加载时挂上,hub 零 DB、不 import src/**)
 * @property {(symbol: string) => BookRefreshOutcome | Promise<BookRefreshOutcome>} [bookRefresh] book 订阅时 hub 没有该簿缓存,
 *   请发布器全量刷新一次(测试注入);缺省时在每次需要时读 globalThis.__carbadiaBookRefresh(同样由发布器挂上)。
 *   刷新的盘口经总线回来(delta null 的整份快照);返回值只用来区分「库里没有这个 symbol」({ found: false },不再请)
 * @property {number} [bookRefreshCooldownMs] 同一 symbol 两次全量刷新的最小间隔(默认 1 s,见 BOOK_REFRESH_COOLDOWN_MS);成交带预读用同一冷却
 * @property {(symbol: string) => RecentTradesOutcome | Promise<RecentTradesOutcome>} [recentTrades] trades:SYM 订阅时 hub 的成交环没满、
 *   还没预读过,读库里最近 64 笔(测试注入);缺省时在每次需要时读 globalThis.__carbadiaRecentTrades(由发布器挂上)
 * @property {number} [accountSnapshotCooldownMs] 同一用户两次 account 快照查询的最小间隔(默认 2 s,见 ACCOUNT_SNAPSHOT_COOLDOWN_MS;≤ 0 不冷却)
 * @property {string} [bootId] hello 里的启动标识(测试注入);缺省在 createHub 时随机生成,见 newBootId
 */

/**
 * 刷新钩子的返回:发布器的 refreshBook 回 { found }(src/lib/server/market-publisher.ts 的 BookRefreshResult);
 * 测试桩可以什么都不回(undefined),按「找到了」处理。
 * @typedef {{ found: boolean } | void} BookRefreshOutcome
 */

/**
 * 成交带预读钩子的返回:发布器的 recentTrades 回 { found, trades }(时间升序的 TapeEntry,src/lib/server/market-publisher.ts 的 RecentTradesResult)。
 * @typedef {{ found: boolean; trades: TapeEntry[] }} RecentTradesOutcome
 */

/**
 * 快照来源可以直接给事件数组,也可以给 { balance, orders, positions }(发布器钩子的形状),hub 展开成 balance → 逐条 order → 逐条 position
 * (与 §3.3 的 account 段、poll-frames.framesFromAccount 同序)。
 * @typedef {AccountEvent[] | { balance: import("../src/shared/types").Balance; orders: import("../src/shared/types").Order[]; positions: import("../src/shared/types").Position[] }} AccountSnapshotResult
 */

/**
 * @param {AccountSnapshotResult} result
 * @returns {AccountEvent[]}
 */
function toAccountEvents(result) {
  if (Array.isArray(result)) return result;
  return [
    { t: "balance", balance: result.balance },
    ...result.orders.map((order) => /** @type {AccountEvent} */ ({ t: "order", order })),
    ...result.positions.map((position) => /** @type {AccountEvent} */ ({ t: "position", position })),
  ];
}

/**
 * hello.bootId 的缺省值:hub 创建时刻(36 进制)+ 8 位随机十六进制。进程只建一个 hub,所以它就是本进程的启动标识;
 * 客户端见它变了 = 服务端重启过(不论是不是 1012 的优雅重启),清掉各 topic 的 lastSeq、重订阅不带 since(客户端那半由 P1-25c 做)。
 * 带随机部分:同一毫秒起的两个进程(崩溃循环)也不会撞上。
 * @param {number} startedAt
 */
function newBootId(startedAt) {
  return `${startedAt.toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * 与传输无关的 hub 核心。
 * @param {HubOptions} [opts]
 */
export function createHub({
  bus,
  log = (line) => console.log(line),
  heartbeatMs = WS_HEARTBEAT_MS,
  pongTimeoutMs = PONG_TIMEOUT_MS,
  batchMs = BATCH_MS,
  backpressureScanMs = BACKPRESSURE_SCAN_MS,
  backpressureCloseAfterMs = BACKPRESSURE_CLOSE_AFTER_MS,
  closeGraceMs = CLOSE_GRACE_MS,
  statsIntervalMs = STATS_INTERVAL_MS,
  now = Date.now,
  bufferedAmountOf = (ws) => ws.bufferedAmount,
  isKnownSymbol,
  accountSnapshot,
  bookRefresh,
  bookRefreshCooldownMs = BOOK_REFRESH_COOLDOWN_MS,
  recentTrades,
  accountSnapshotCooldownMs = ACCOUNT_SNAPSHOT_COOLDOWN_MS,
  bootId = newBootId(now()),
} = {}) {
  const stats = zeroWsStats(true, now());
  /** @type {Presence} */
  const presence = { users: new Map(), topics: new Map() };
  /** @type {Map<Topic, number>} */
  const topicSeq = new Map();
  globalThis.__carbadiaWsStats = stats;
  globalThis.__carbadiaPresence = presence;
  globalThis.__carbadiaTopicSeq = topicSeq;

  /** @type {Set<Conn>} */
  const conns = new Set();
  /** @type {Map<Topic, Set<Conn>>} */
  const subscribers = new Map();
  /**
   * account 的 seq,按用户(计划 §9.2 D15)。只在该用户有 account 订阅时存在:最后一条订阅离开即删(removeSubscription),
   * 离线用户的事件不记 seq(publish),所以条目数不超过在线用户数(终审 P1-25a)。删掉是安全的:account 订阅从不带 since,
   * 客户端的基线取自 subscribed{seq}(重订阅回 0) @type {Map<string, number>}
   */
  const accountSeq = new Map();
  /** 正在查询的 account 快照:userId → 等这一份的连接(同一用户的重复订阅、其它连接都并进来,不另起查询) @type {Map<string, Set<Conn>>} */
  const accountSnapshotWaiters = new Map();
  /**
   * 刚查完、还在冷却里的用户(见 ACCOUNT_SNAPSHOT_COOLDOWN_MS):冷却期间来的订阅记进 waiters,冷却结束时还订着的一起查一次。
   * 条目只活一个冷却期 @type {Map<string, { timer: ReturnType<typeof setTimeout>; waiters: Set<Conn>; source: ((userId: string) => AccountSnapshotResult | Promise<AccountSnapshotResult>) | null }>}
   */
  const accountSnapshotCooling = new Map();
  /** 盘口快照缓存:只在 book:SYM 有订阅者时保留(见文件头) @type {Map<string, OrderBookSnapshot>} */
  const books = new Map();
  /**
   * 等整份快照的连接:订阅 book:SYM 时 hub 没有这本簿(无人订阅期间已淘汰 / 进程刚起),本 symbol 的下一条盘口消息对它们以整份快照发出。
   * 退订 / 断开 / 背压下重订阅时移除 @type {Map<string, Set<Conn>>}
   */
  const bookWaiters = new Map();
  /** 请发布器全量刷新、还没返回的 symbol → 那次刷新(返回前同一 symbol 不重复请;不随缓存淘汰清掉) @type {Map<string, Promise<BookRefreshOutcome>>} */
  const bookRefreshes = new Map();
  /** 刷新冷却中的 symbol → 冷却计时器(到期时还有人在等就补一次;不随缓存淘汰清掉) @type {Map<string, ReturnType<typeof setTimeout>>} */
  const bookRefreshCooldowns = new Map();
  /**
   * symbol → 自上次订阅(登记等待者)以来请了几次刷新,期间一条盘口消息都没等来;到 BOOK_REFRESH_MAX_MISSES 不再请,查无此 symbol 直接记满。
   * 只在该 symbol 有等待者时存在:订阅登记等待者时清零,等待者被盘口消息清空、全部退订 / 断开时删掉(dropBookWaiter、publish),
   * 所以条目数不超过 bookWaiters 的键数,不会因为有人订过一堆不存在的 symbol 而一直涨 @type {Map<string, number>}
   */
  const bookRefreshMisses = new Map();
  /**
   * `[ws] book refresh failed` / `[ws] trades preload failed` 的限频:"<what> <symbol>" → 上一行的时刻、之后被抑制的次数、最近一次的错误。
   * 统计定时器顺手清理:过了一分钟没有新失败的删掉;还有没报的次数先补一行汇总
   * @type {Map<string, { what: string; symbol: string; at: number; suppressed: number; lastError: string }>}
   */
  const refreshFailLog = new Map();
  /**
   * 成交带预读(终审 P1-25a;计划 D21 book 刷新的同一写法):trades:SYM 订阅时环没满(进程刚起、hub 起来之后这个标的的成交不够 64 笔)、
   * 本进程还没为它预读过,hub 经 globalThis.__carbadiaRecentTrades(发布器挂上)读库里最近 64 笔,接在环前面(seq 0,不占序号),
   * 再以整份快照发给等着的连接。每个 symbol 同时一次在途、每秒至多开始一次(冷却里来的订阅直接拿环里现有的),在途超过
   * TRADES_PRELOAD_TIMEOUT_MS 即放行等待者;找到过的 symbol 不再预读(tradesPreloaded,条目数 ≤ 真实标的数)。
   * tradesWaiters:等预读的连接(只回过 subscribed{seq: 0},期间这个 symbol 的增量先不发给它们,都在随后的快照里)
   * @type {Map<string, Set<Conn>>}
   */
  const tradesWaiters = new Map();
  /** 在途的预读:symbol → 那次预读 @type {Map<string, Promise<unknown>>} */
  const tradesPreloads = new Map();
  /** 预读冷却:symbol → 计时器(条目只活一个冷却期) @type {Map<string, ReturnType<typeof setTimeout>>} */
  const tradesPreloadCooldowns = new Map();
  /** 已经从库里预读到(找到了这个 symbol)的 symbol @type {Set<string>} */
  const tradesPreloaded = new Set();
  /**
   * 订阅数刚归零、还在保留期的 book / ticker topic → 退订它的那条连接。保留到那条连接的合帧窗口结束(flush)或连接关闭:
   * 期间 presence 仍按 1 计(发布器照常喂、不丢差分基线)、总线上的消息照常进缓存;同一窗口里有人再订(客户端回应 resync 的
   * unsubscribe + subscribe 两帧紧挨着到)就接过这个名额,直接拿缓存,不淘汰、不请发布器多读一次 50 档,回应 resync 的余量也照样生效。
   * 保留期结束仍无人订才淘汰缓存、presence 减 1。只推迟不超过一个合帧窗口(50 ms),所以「无人订阅就不喂、不留旧缓存」的语义不变
   * @type {Map<Topic, Conn>}
   */
  const held = new Map();
  /** ticker 最后值缓存:只在 ticker:SYM 或 ticker:* 有订阅者时保留;书顶两项另要 book:SYM 有订阅者(见 cacheTicker) @type {Map<string, TickerUpdate>} */
  const tickers = new Map();
  /** @type {Map<string, { seq: number; entry: TapeEntry }[]>} */
  const tapes = new Map();
  /** 总线上出现过的 symbol:与 __carbadiaInstrumentsCache 一起回答「symbol 存在吗」 */
  const seenSymbols = new Set();
  /**
   * 最后见过的标的列表(__carbadiaInstrumentsCache.value.instruments 的数组本身)与由它建的 symbol 集合。
   * 全局缓存被整个清掉(OTC 成交后的 invalidateInstrumentsCache;P1-25b 起改为只标过期、保留列表)时仍用这一份:
   * 标的只在启动时补齐(instrumentation 的 ensureInstruments),列表旧了也不会漏掉真实的 symbol。
   * 列表由 instrumentation 在 ensureInstruments 之后的预读(listInstruments)填上;listen 不等 register(),预读可能在 listen 之后
   * 几百毫秒才完成 —— 这段空窗里的没法核实的 symbol 由按连接(MAX_UNVERIFIED_SYMBOLS_PER_SECOND)与全 hub
   *(MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB)两道额度兜底
   * @type {{ list: unknown[]; symbols: Set<string> } | null}
   */
  let listed = null;
  /** 全 hub 放行额度的令牌桶(见 MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB):剩余令牌与上次结算时刻 */
  let unverifiedTokens = MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB;
  let unverifiedRefillAt = now();
  /** 最近放行过的没法核实的 symbol → 放行时刻(全 hub;1 s 内别的连接再订同一个不占令牌) @type {Map<string, number>} */
  const hubUnverified = new Map();
  let closed = false;

  // ---- seq ----
  /** @param {Topic} topic */
  const seqOf = (topic) => topicSeq.get(topic) ?? 0;
  /** @param {Topic} topic */
  function nextSeq(topic) {
    const n = seqOf(topic) + 1;
    topicSeq.set(topic, n);
    return n;
  }
  /** @param {string} userId */
  const accountSeqOf = (userId) => accountSeq.get(userId) ?? 0;
  /** @param {string} userId */
  function nextAccountSeq(userId) {
    const n = accountSeqOf(userId) + 1;
    accountSeq.set(userId, n);
    return n;
  }

  // ---- symbol 存在性 ----
  /**
   * 标的列表里的 symbol 集合:当前全局缓存有列表(不论过期与否)就用它并记下,没有就用最后见过的那份;从没见过则 null。
   * @returns {Set<string> | null}
   */
  function listedSymbols() {
    const list = globalThis.__carbadiaInstrumentsCache?.value?.instruments;
    if (Array.isArray(list) && list !== listed?.list) {
      /** @type {Set<string>} */
      const symbols = new Set();
      for (const item of list) {
        const symbol = item?.instrument?.symbol;
        if (typeof symbol === "string") symbols.add(symbol);
      }
      listed = { list, symbols };
    }
    return listed?.symbols ?? null;
  }

  /**
   * "known" = 总线见过或在标的列表里;"unknown" = 有列表而不在其中;"unverified" = 从没见过列表(进程刚起,还没有任何页面 SSR /
   * /api/market/instruments 调过 listInstruments)、总线也没见过:无从判断,放行但按连接限流(admitUnverified)。
   * 「总线见过」只当肯定信号:发布器上线后 bot 第一轮是一个标的一个标的地报价,若拿「见过别的、没见过这个」当否定信号,
   * 启动后头几秒订 book:VCS-FOR-2021 会被误判 unknown_topic(smoke:ws 就撞上过)。
   * @param {string} symbol
   * @returns {"known" | "unknown" | "unverified"}
   */
  function symbolVerdict(symbol) {
    if (isKnownSymbol) return isKnownSymbol(symbol) ? "known" : "unknown";
    if (seenSymbols.has(symbol)) return "known";
    const symbols = listedSymbols();
    if (symbols) return symbols.has(symbol) ? "known" : "unknown";
    return "unverified";
  }

  /**
   * 没法核实的 symbol 的放行额度:每条连接每秒至多 MAX_UNVERIFIED_SYMBOLS_PER_SECOND 个不同的 symbol(同一窗口里已放行的再订不占名额),
   * 另受全 hub 的额度约束(admitUnverifiedHub)。
   * @param {Conn} conn
   * @param {string} symbol
   * @returns {string | null} null = 放行;否则是回给客户端的 rate_limited 文案
   */
  function admitUnverified(conn, symbol) {
    const t = now();
    if (t - conn.unverifiedWindowStart >= 1_000) {
      conn.unverifiedWindowStart = t;
      conn.unverified.clear();
    }
    if (conn.unverified.has(symbol)) return null;
    if (conn.unverified.size >= MAX_UNVERIFIED_SYMBOLS_PER_SECOND) return `At most ${MAX_UNVERIFIED_SYMBOLS_PER_SECOND} unlisted symbols per second`;
    if (!admitUnverifiedHub(symbol, t)) return "Too many unlisted symbols across the server, retry shortly";
    conn.unverified.add(symbol);
    return null;
  }

  /**
   * 全 hub 的放行额度(MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB):最近 1 s 内已放行过的 symbol 直接过;否则从令牌桶取一个。
   * @param {string} symbol
   * @param {number} t
   */
  function admitUnverifiedHub(symbol, t) {
    const at = hubUnverified.get(symbol);
    if (at !== undefined && t - at >= 0 && t - at < 1_000) return true;
    unverifiedTokens = Math.min(MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB, unverifiedTokens + (Math.max(0, t - unverifiedRefillAt) * MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB) / 1_000);
    unverifiedRefillAt = t;
    if (unverifiedTokens < 1) return false;
    unverifiedTokens -= 1;
    // 表只在取到令牌时长(每秒至多 10 条);超过一定条数时顺手清掉 1 s 之前的
    if (hubUnverified.size >= 4 * MAX_UNVERIFIED_SYMBOLS_PER_SECOND_HUB) {
      for (const [s, seen] of hubUnverified) if (!(t - seen >= 0 && t - seen < 1_000)) hubUnverified.delete(s);
    }
    hubUnverified.set(symbol, t);
    return true;
  }

  // ---- 发送:合帧与背压 ----
  /** @param {Conn} conn */
  function flush(conn) {
    conn.flushTimer = null;
    conn.pendingBytes = 0;
    conn.answered.clear();
    releaseHolds(conn); // 合帧窗口结束:本窗口退订归零、没人接着订的 topic 这时才淘汰
    if (conn.pending.length === 0) return;
    const events = conn.pending;
    conn.pending = [];
    if (conn.closed || conn.ws.readyState !== WS_OPEN) return;
    const frame = JSON.stringify(events);
    try {
      conn.ws.send(frame, () => {});
    } catch {
      return; // socket 已死,close 事件会做清理
    }
    stats.framesOut += 1;
    stats.bytesOut += Buffer.byteLength(frame);
  }

  /**
   * 控制事件与订阅响应:总是入队。
   * @param {Conn} conn
   * @param {ServerEvent} event
   */
  function send(conn, event) {
    if (conn.closed || conn.closing) return; // close 帧已排队,后面的事件没人收
    conn.pending.push(event);
    conn.pendingBytes += approxBytes(event);
    if (conn.flushTimer === null) conn.flushTimer = setTimeout(() => flush(conn), batchMs);
  }

  /**
   * 这条连接已拥塞吗:已交给 socket 还没发出去的(bufferedAmount)+ 本窗口排着还没 flush 的(pendingBytes 估计)> 256 KB(+ headroom)。
   * 订阅快照逐个 topic 判:一个窗口里能排进去的快照总量因此有上界(≈ 256 KB + 余量 + 一份快照),不论同一窗口里来多少个订阅 op。
   * @param {Conn} conn
   * @param {number} [headroom] 回应 resync 的重订阅多给的余量(RESYNC_ANSWER_HEADROOM_BYTES)
   */
  const congested = (conn, headroom = 0) => bufferedAmountOf(conn.ws) + conn.pendingBytes > BACKPRESSURE_SKIP_BYTES + headroom;

  /**
   * 流事件(delta / trades / ticker / candle / account):bufferedAmount > 256 KB 时跳过并把 topic 标 stale。
   * 订阅快照被背压扣住(owed)的 topic 在快照补上之前一律跳过,不看缓冲:客户端手里只有 subscribed{seq}、没有快照,
   * 缓冲落在 64–256 KB 之间时放行的 delta 与那个 seq 正好连续,客户端看不出缺口,会把 delta 叠到空簿上,也没有信号去重订阅。
   * 这里不重标 stale:扣住时已标过,扫描在 ≤ 256 KB 时发一次 resync 就够;发过之后等客户端重订阅,不每秒重发。
   * 因快照竞态(race)欠下的 topic 同样跳过,但不计 droppedDeltas(不是背压)。
   * @param {Conn} conn
   * @param {Topic} topic
   * @param {ServerEvent} event
   */
  function stream(conn, topic, event) {
    if (conn.closed || conn.closing) return;
    const owed = conn.owed.get(topic);
    if (owed !== undefined) {
      if (owed === "backpressure") stats.droppedDeltas += 1;
      return;
    }
    if (bufferedAmountOf(conn.ws) > BACKPRESSURE_SKIP_BYTES) {
      conn.stale.add(topic);
      stats.droppedDeltas += 1;
      return;
    }
    send(conn, event);
  }

  /**
   * 等整份快照的连接(bookWaiters)收本 symbol 的这条盘口消息:背压下与订阅时被扣住的快照同样处理(owed)——之后的 delta 不发,
   * 扫描在 ≤ 256 KB 时发 resync。只标 stale 不够:客户端手里没有簿,subscribed{seq: 0} 之后放行的第一条 delta 会被它当成基线,
   * 看不出缺口,也就不会重订阅。
   * @param {Conn} conn
   * @param {Topic} topic
   * @param {ServerEvent} event 整份快照
   */
  function streamSnapshot(conn, topic, event) {
    if (conn.closed || conn.closing || conn.owed.has(topic) || bufferedAmountOf(conn.ws) <= BACKPRESSURE_SKIP_BYTES) {
      stream(conn, topic, event);
      return;
    }
    deferSnapshot(conn, topic);
  }

  /**
   * @param {Conn} conn
   * @param {WsErrorCode} code
   * @param {string} message
   * @param {Topic} [topic]
   */
  function sendError(conn, code, message, topic) {
    send(conn, topic === undefined ? { t: "error", code, message } : { t: "error", code, message, topic });
  }

  /**
   * 先把待发事件冲出去(错误提示要先于 close 帧到达),再关。幂等:背压扫描每秒都会再看到这条连接,不能重复关、重复计数。
   * 对端不回 close 帧(不读的对端,close 帧排在几 MB 缓冲后面)时 closeGraceMs 后 terminate,尽快释放缓冲,不等 ws 自己的 30 s。
   * @param {Conn} conn
   * @param {number} code
   * @param {string} reason
   */
  function closeConn(conn, code, reason) {
    if (conn.closed || conn.closing) return;
    conn.closing = true;
    if (conn.flushTimer !== null) clearTimeout(conn.flushTimer);
    flush(conn);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
      return;
    }
    conn.graceTimer = setTimeout(() => {
      conn.graceTimer = null;
      if (!conn.closed) conn.ws.terminate();
    }, closeGraceMs);
    conn.graceTimer.unref?.();
  }

  // ---- presence / 订阅簿 ----
  /**
   * @param {Map<string, number>} map
   * @param {string} key
   * @param {number} delta
   */
  function bump(map, key, delta) {
    const n = (map.get(key) ?? 0) + delta;
    if (n <= 0) map.delete(key);
    else map.set(key, n);
  }

  /**
   * @param {Conn} conn
   * @param {Topic} topic
   * @returns {boolean} 是否新增(重复订阅返回 false)
   */
  function addSubscription(conn, topic) {
    if (conn.topics.has(topic)) return false;
    conn.topics.add(topic);
    let set = subscribers.get(topic);
    if (!set) subscribers.set(topic, (set = new Set()));
    set.add(conn);
    const holder = held.get(topic);
    if (holder) {
      // 保留期里有人接着订:保留的那 1 就是这位订阅者的,presence 不再加
      held.delete(topic);
      holder.releases.delete(topic);
    } else {
      bump(presence.topics, topic, 1);
    }
    if (topic === "account" && conn.userId) bump(presence.users, conn.userId, 1);
    stats.subscriptions += 1;
    return true;
  }

  /**
   * 退订 / 连接关闭。book / ticker 的订阅数因退订归零时先进保留期(held),等这条连接的合帧窗口结束再淘汰;连接关闭则立即淘汰
   * (它不会再订,关闭前在保留期里的也由 teardown 释放)。
   * @param {Conn} conn
   * @param {Topic} topic
   */
  function removeSubscription(conn, topic) {
    if (!conn.topics.delete(topic)) return false;
    if (topic.startsWith("book:")) dropBookWaiter(conn, topic.slice("book:".length));
    else if (topic.startsWith("trades:")) dropTradesWaiter(conn, topic.slice("trades:".length));
    const set = subscribers.get(topic);
    let holding = false;
    if (set) {
      set.delete(conn);
      if (set.size === 0) {
        subscribers.delete(topic);
        holding = !conn.closed && !conn.closing && (topic.startsWith("book:") || topic.startsWith("ticker:"));
        if (holding) {
          held.set(topic, conn);
          conn.releases.add(topic);
        } else {
          evictIdle(topic);
        }
      }
    }
    if (!holding) bump(presence.topics, topic, -1);
    if (topic === "account" && conn.userId) {
      bump(presence.users, conn.userId, -1);
      if (!presence.users.has(conn.userId)) accountSeq.delete(conn.userId); // 该用户最后一条 account 订阅走了
    }
    conn.stale.delete(topic);
    conn.owed.delete(topic);
    conn.answered.delete(topic);
    stats.subscriptions -= 1;
    return true;
  }

  // ---- 快照缓存:只留发布器还在喂的 ----
  /**
   * 发布器还在喂这个 topic 吗:有订阅者,或在保留期里(presence 仍计 1,见 held)。订阅者集合空了即删键(removeSubscription)
   * @param {Topic} topic
   */
  const fed = (topic) => subscribers.has(topic) || held.has(topic);
  /** 发布器还在喂 SYM 的 ticker 吗(门控 ②:ticker:* 有订阅视为对所有 ticker:SYM 有兴趣,见 src/lib/server/presence.ts) @param {string} symbol */
  const tickerFed = (symbol) => fed(/** @type {Topic} */ (`ticker:${symbol}`)) || fed("ticker:*");

  /**
   * 书顶两项(bestBid / bestAsk)只在有人订 book:SYM 时才由发布器算出(flushBook 无盘口兴趣即返回),没人订时从缓存里去掉。
   * @param {TickerUpdate} ticker
   * @returns {TickerUpdate}
   */
  function withoutStaleTop(ticker) {
    if (fed(/** @type {Topic} */ (`book:${ticker.symbol}`)) || (!("bestBid" in ticker) && !("bestAsk" in ticker))) return ticker;
    const next = { ...ticker };
    delete next.bestBid;
    delete next.bestAsk;
    return next;
  }

  /**
   * 总线上的 ticker 并进最后值缓存;发布器已不再喂这个标的(无人订阅)时不进缓存并丢掉旧值:
   * 否则下一位订阅者拿到的是无人订阅期间停住的 lastPrice / change24h / 书顶,盖掉页面刚从 SSR / REST 拿到的新值。
   * @param {string} symbol
   * @param {TickerUpdate} update
   */
  function cacheTicker(symbol, update) {
    if (!tickerFed(symbol)) {
      tickers.delete(symbol);
      return;
    }
    tickers.set(symbol, withoutStaleTop({ ...tickers.get(symbol), ...update }));
  }

  /**
   * 这条连接的保留期结束(合帧窗口 flush / 连接关闭):它退订归零、期间没人接着订的 topic,presence 减 1 并淘汰缓存。
   * 已被别人接过去的(held 里不再是它)跳过。
   * @param {Conn} conn
   */
  function releaseHolds(conn) {
    if (conn.releases.size === 0) return;
    for (const topic of conn.releases) {
      if (held.get(topic) !== conn) continue;
      held.delete(topic);
      bump(presence.topics, topic, -1);
      evictIdle(topic);
    }
    conn.releases.clear();
  }

  /**
   * 某 topic 的订阅数归零(退订的保留期已过,或连接关闭):淘汰它的快照缓存(发布器从此不再喂它,留着只会越来越旧)。
   * book:SYM → 盘口缓存与该标的 ticker 里的书顶;ticker:SYM → 该标的的 ticker(ticker:* 还有人订就留着,发布器照样喂);
   * ticker:* → 没有 ticker:SYM 订阅者的全部标的。trades 的环不淘汰:发布器只看门控 ①,有 hub 就一直喂。
   * book 的在途刷新与刷新冷却不清:清掉的话,一条连接反复订阅 / 退订,每个周期都能让发布器再读一次库(见 requestBookRefresh)。
   * @param {Topic} topic
   */
  function evictIdle(topic) {
    if (topic === "account") return;
    const parsed = parseTopic(topic);
    if (parsed.kind === "book") {
      books.delete(parsed.symbol);
      const ticker = tickers.get(parsed.symbol);
      if (ticker) tickers.set(parsed.symbol, withoutStaleTop(ticker));
    } else if (parsed.kind === "ticker") {
      if (parsed.symbol === "*") {
        for (const symbol of [...tickers.keys()]) if (!tickerFed(symbol)) tickers.delete(symbol);
      } else if (!tickerFed(parsed.symbol)) {
        tickers.delete(parsed.symbol);
      }
    }
  }

  /**
   * @param {Conn} conn
   * @param {string} symbol
   */
  function dropBookWaiter(conn, symbol) {
    const waiters = bookWaiters.get(symbol);
    if (!waiters) return;
    waiters.delete(conn);
    if (waiters.size > 0) return;
    bookWaiters.delete(symbol);
    bookRefreshMisses.delete(symbol); // 没人在等了:次数闸随之作废,下一位订阅者从 0 计
  }

  /**
   * 有连接在等 symbol 的整份快照(bookWaiters):请发布器全量刷新一次。发布器同步丢掉差分基线再读库,所以刷新必有一条整份快照回到
   * publish(),即使盘口没变;在那之前到的任何盘口消息(比如别的读取算出的 delta)也已对等着的连接以整份快照发出。
   * 限频,每次刷新都是一次 50 档读库:
   *   - 在途时不再请;返回了却还有人在等(读库失败、发布器判定无兴趣……)再请一次(受冷却约束);
   *   - 上一次发出后 bookRefreshCooldownMs 内不再请,冷却结束时还有人在等就补一次(尾随)。
   * 于是每个 symbol 每个冷却期至多读一次库,与订阅 / 退订的频率、连接数无关。在途与冷却的记录不随缓存淘汰清掉:
   * 审查复现过一条匿名连接在限速内对 14 个标的订阅 / 退订 10 个来回,每个周期都淘汰缓存、再请一次,共 140 次刷新。
   * 另有次数闸(bookRefreshMisses):自上次订阅起连着请了 BOOK_REFRESH_MAX_MISSES 次还有人在等(盘口消息一来等待者就清空,
   * 所以「还在等」= 这几次都没产出盘口消息)就不再请,直到下一次订阅;发布器回 { found: false }(库里没有这个 symbol)立即不再请。
   * 否则一个不存在的 symbol(标的列表从没出现过时 symbolVerdict 放行,按连接限流)或读不出盘口的 symbol,只要有人订着就每秒查一次库,没有尽头。
   * 于是一次订阅至多引出 BOOK_REFRESH_MAX_MISSES 次读库(不存在的 symbol 是 1 次;冷却里来的订阅并进尾随的那一次)。
   * 等着的连接留着,不因查无此 symbol 就丢掉:它们已不会再引出读库,占的只是订阅本身(退订 / 断开即释放);
   * 之后若真来了这本簿的盘口消息,照样以整份快照发给它们,而不是一条叠不上去的 delta。
   * 钩子没挂(发布器还没被任何 bundle 加载):那就没有差分基线,它的第一次发布本来就是整份快照,等着即可。
   * 只在有等待者时调用(订阅登记之后、冷却到期或上一次返回时还有人在等)。
   * @param {string} symbol
   */
  function requestBookRefresh(symbol) {
    if (closed || bookRefreshes.has(symbol) || bookRefreshCooldowns.has(symbol)) return;
    const misses = bookRefreshMisses.get(symbol) ?? 0;
    if (misses >= BOOK_REFRESH_MAX_MISSES) return;
    const refresh = bookRefresh ?? globalThis.__carbadiaBookRefresh;
    if (!refresh) return;
    bookRefreshMisses.set(symbol, misses + 1);
    const cooldown = setTimeout(() => {
      bookRefreshCooldowns.delete(symbol);
      if (bookWaiters.has(symbol)) requestBookRefresh(symbol);
    }, bookRefreshCooldownMs);
    cooldown.unref?.();
    bookRefreshCooldowns.set(symbol, cooldown);
    /** @type {Promise<BookRefreshOutcome>} */
    let pending;
    try {
      pending = Promise.resolve(refresh(symbol)); // 同步调用:发布器丢基线必须先于这之后的任何发布
    } catch (err) {
      logRefreshFailure(symbol, err); // 冷却到期时还有人在等就再请
      return;
    }
    bookRefreshes.set(symbol, pending);
    /** @param {BookRefreshOutcome} outcome */
    const settle = (outcome) => {
      if (bookRefreshes.get(symbol) === pending) bookRefreshes.delete(symbol);
      if (!bookWaiters.has(symbol)) return; // 等来了盘口消息,或都退订了
      // 查无此 symbol:记满次数,直到下一次订阅不再请
      if (outcome && outcome.found === false) bookRefreshMisses.set(symbol, BOOK_REFRESH_MAX_MISSES);
      requestBookRefresh(symbol);
    };
    pending.then(settle, (err) => {
      logRefreshFailure(symbol, err);
      settle(undefined);
    });
  }

  /**
   * 刷新失败的日志:每个 symbol 至多每 REFRESH_FAIL_LOG_INTERVAL_MS 一行,期间的失败只计数,记在下一行里;
   * 失败停了、还有没报的次数,由统计定时器补一行(flushRefreshFailLog)。读库持续失败时不刷屏,也不丢次数。
   * @param {string} symbol
   * @param {unknown} err
   * @param {string} [what] 日志里的动作名:"book refresh"(默认)或 "trades preload"
   */
  function logRefreshFailure(symbol, err, what = "book refresh") {
    const message = err instanceof Error ? err.message : String(err);
    const t = now();
    const key = `${what} ${symbol}`;
    const entry = refreshFailLog.get(key);
    if (entry && t - entry.at < REFRESH_FAIL_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      entry.lastError = message;
      return;
    }
    const earlier = entry?.suppressed ?? 0;
    refreshFailLog.set(key, { what, symbol, at: t, suppressed: 0, lastError: message });
    log(`[ws] ${what} failed for ${symbol}: ${message}${earlier > 0 ? ` (${earlier} earlier ${earlier === 1 ? "failure" : "failures"} suppressed)` : ""}`);
  }

  /** 统计定时器里调用:一分钟没再出行的 symbol,有没报的次数就补一行汇总(之后一分钟照样限频),没有就删掉记录 */
  function flushRefreshFailLog() {
    const t = now();
    for (const [key, entry] of refreshFailLog) {
      if (t - entry.at < REFRESH_FAIL_LOG_INTERVAL_MS) continue;
      if (entry.suppressed === 0) {
        refreshFailLog.delete(key);
        continue;
      }
      const n = entry.suppressed;
      refreshFailLog.set(key, { ...entry, at: t, suppressed: 0 });
      log(`[ws] ${entry.what} failed for ${entry.symbol}: ${n} ${n === 1 ? "failure" : "failures"} suppressed since the last report (last error: ${entry.lastError})`);
    }
  }

  // ---- 成交带预读(见 tradesWaiters) ----
  /**
   * 这次 trades:SYM 订阅该不该等预读:环没满、本进程还没为它预读到过,而且(已在途,或现在能开始一次)。
   * 能开始:不在冷却里、钩子挂着、钩子没同步抛错。返回 false 时调用方照旧发环里现有的。
   * @param {string} symbol
   */
  function awaitTradesPreload(symbol) {
    if (closed || tradesPreloaded.has(symbol) || (tapes.get(symbol)?.length ?? 0) >= WS_TAPE_RING) return false;
    if (tradesPreloads.has(symbol)) return true;
    if (tradesPreloadCooldowns.has(symbol)) return false;
    const preload = recentTrades ?? globalThis.__carbadiaRecentTrades;
    if (!preload) return false;
    const cooldown = setTimeout(() => tradesPreloadCooldowns.delete(symbol), bookRefreshCooldownMs);
    cooldown.unref?.();
    tradesPreloadCooldowns.set(symbol, cooldown);
    /** @type {Promise<RecentTradesOutcome>} */
    let pending;
    try {
      pending = Promise.resolve(preload(symbol));
    } catch (err) {
      logRefreshFailure(symbol, err, "trades preload");
      return false;
    }
    tradesPreloads.set(symbol, pending);
    // 钩子一直不回:到时放行等着的连接(发环里现有的,之后照常收增量);晚到的结果仍会接进环里,给之后的订阅者
    const timeout = setTimeout(() => releaseTradesWaiters(symbol), TRADES_PRELOAD_TIMEOUT_MS);
    timeout.unref?.();
    pending
      .then(
        (outcome) => {
          if (!outcome || !outcome.found) return; // 查无此 symbol:不记,冷却过后下一次订阅可以再试(未知 symbol 的订阅已按连接限流)
          tradesPreloaded.add(symbol);
          mergeHistory(symbol, Array.isArray(outcome.trades) ? outcome.trades : []);
        },
        (err) => logRefreshFailure(symbol, err, "trades preload"),
      )
      .finally(() => {
        clearTimeout(timeout);
        if (tradesPreloads.get(symbol) === pending) tradesPreloads.delete(symbol);
        releaseTradesWaiters(symbol);
      });
    return true;
  }

  /**
   * 预读到的历史(时间升序)接到环前面:只取比环里最早一笔更早(或同一时刻)、环里还没有(按 id)的,seq 记 0(它们在 hub 起来之前,
   * 不占 topic 序号;since 回放按 seq > since 取,历史永远不会被当成缺的那几笔),总数仍截到 WS_TAPE_RING(先丢最旧的历史)。
   * @param {string} symbol
   * @param {TapeEntry[]} entries
   */
  function mergeHistory(symbol, entries) {
    const ring = tapes.get(symbol) ?? [];
    const known = new Set(ring.map((r) => r.entry.id));
    const oldest = ring.length > 0 ? ring[0].entry.ts : Infinity;
    const older = entries.filter((e) => e && typeof e.id === "string" && !known.has(e.id) && e.ts <= oldest).map((entry) => ({ seq: 0, entry }));
    if (older.length === 0) return;
    tapes.set(symbol, [...older, ...ring].slice(-WS_TAPE_RING));
  }

  /**
   * 预读结束(接上了、没找到、失败或超时):给还订着的等待者发整份快照(环里现有的全部,seq = 当前值;它们手里的基线是 subscribed{seq: 0},
   * 客户端把 0 当「无基线」,照单全收并以这个 seq 为基线)。背压下按欠快照处理(owed,缓冲回落后 resync)。
   * @param {string} symbol
   */
  function releaseTradesWaiters(symbol) {
    const waiters = tradesWaiters.get(symbol);
    if (!waiters) return;
    tradesWaiters.delete(symbol);
    const topic = /** @type {`trades:${string}`} */ (`trades:${symbol}`);
    /** @type {ServerEvent} */
    const event = { t: "trades", topic, seq: seqOf(topic), symbol, trades: (tapes.get(symbol) ?? []).map((r) => r.entry) };
    for (const conn of waiters) {
      if (conn.closed || conn.closing || !conn.topics.has(topic)) continue;
      if (bufferedAmountOf(conn.ws) > BACKPRESSURE_SKIP_BYTES) {
        deferSnapshot(conn, topic);
        continue;
      }
      send(conn, event);
    }
  }

  /**
   * @param {Conn} conn
   * @param {string} symbol
   */
  function dropTradesWaiter(conn, symbol) {
    const waiters = tradesWaiters.get(symbol);
    if (!waiters) return;
    waiters.delete(conn);
    if (waiters.size === 0) tradesWaiters.delete(symbol);
  }

  // ---- 订阅 ----
  /**
   * 背压下订阅只回 subscribed、不发快照 / 回放:把 topic 标 stale 并计 droppedDeltas,由背压扫描在缓冲降下来后发
   * resync{backpressure},客户端据此重订阅拿快照。send() 不看 bufferedAmount(控制事件必须送达),只靠 stream() 限流的话,
   * 20 op/s × 每 op 上百个 topic 的 subscribe 循环能把一条连接的出站缓冲推到几十 MB。
   * @param {Conn} conn
   * @param {Topic} topic
   */
  function deferSnapshot(conn, topic) {
    conn.stale.add(topic);
    conn.owed.set(topic, "backpressure");
    stats.droppedDeltas += 1;
  }

  /**
   * 给这条连接一份 account 快照。同一用户已有查询在跑时并进去等它,不另起一次:每份快照是一个批量读事务(含该用户的全部成本账本),
   * 20 op/s × 每用户 8 条连接的重复订阅若各查各的,就是每秒上百次。并进去是等价的:那次查询返回时仍要过 runAccountSnapshot 的 seq 检查,
   * 能发出去就说明从它开始读库到返回之间该用户没有事件流出,与在这次订阅时新起一次查询拿到的一样新。
   * @param {Conn} conn
   * @param {string} userId
   * @param {(userId: string) => AccountSnapshotResult | Promise<AccountSnapshotResult>} source
   */
  function requestAccountSnapshot(conn, userId, source) {
    const waiters = accountSnapshotWaiters.get(userId);
    if (waiters) {
      waiters.add(conn);
      return;
    }
    const cooling = accountSnapshotCooling.get(userId);
    if (cooling) {
      cooling.waiters.add(conn);
      cooling.source = source;
      return;
    }
    accountSnapshotWaiters.set(userId, new Set([conn]));
    runAccountSnapshot(userId, source, ACCOUNT_SNAPSHOT_ATTEMPTS);
  }

  /**
   * 该用户的一次快照请求结束了(发出、因竞态放弃、没人要了或失败):进冷却。冷却结束时,期间来订、到那时还订着(没断开、没退订、
   * 不欠快照)的连接一起查一次;没有就什么都不做。
   * @param {string} userId
   */
  function coolAccountSnapshot(userId) {
    if (closed || accountSnapshotCooldownMs <= 0) return;
    /** @type {{ timer: ReturnType<typeof setTimeout>; waiters: Set<Conn>; source: ((userId: string) => AccountSnapshotResult | Promise<AccountSnapshotResult>) | null }} */
    const entry = {
      waiters: new Set(),
      source: null,
      timer: setTimeout(() => {
        accountSnapshotCooling.delete(userId);
        const live = [...entry.waiters].filter((c) => !c.closed && c.topics.has("account") && !c.owed.has("account"));
        if (live.length === 0 || !entry.source) return;
        accountSnapshotWaiters.set(userId, new Set(live));
        runAccountSnapshot(userId, entry.source, ACCOUNT_SNAPSHOT_ATTEMPTS);
      }, accountSnapshotCooldownMs),
    };
    entry.timer.unref?.();
    accountSnapshotCooling.set(userId, entry);
  }

  /**
   * account 订阅快照:查询前记下该用户的 seq,返回时 seq 没变才发给所有在等的连接,并带这个 seq。
   * 发布器的 account 事件在读库之后才上总线。若查询期间有事件流出(seq 已 +1、事件已送达客户端),快照的读取可能早于那笔提交;
   * 带着新 seq 发出去,客户端按 seq === last 照常应用,旧的余额 / 挂单就盖掉了刚到的新事件(FILLED 的单变回 OPEN,之后再没有事件纠正)。
   * seq 没变 = 查询期间没有事件流出:此前送达的事件(seq ≤ 记下的值)都在查询开始之前读完了库,快照不会比它们旧。
   * seq 变了就重查;ACCOUNT_SNAPSHOT_ATTEMPTS 次都被穿插则不发,把 topic 记为欠快照(owed "race":其后的 account 事件先不发),
   * 下一轮扫描发 resync,客户端重订阅时再查。
   * @param {string} userId
   * @param {(userId: string) => AccountSnapshotResult | Promise<AccountSnapshotResult>} source
   * @param {number} attemptsLeft
   */
  function runAccountSnapshot(userId, source, attemptsLeft) {
    const seqBefore = accountSeqOf(userId);
    Promise.resolve()
      .then(() => source(userId))
      .then((result) => {
        const waiters = accountSnapshotWaiters.get(userId) ?? new Set();
        // 连接没了、已退订,或查询期间在背压下重订阅过(owed:扫描会发 resync、客户端会再订一次)→ 不发给它;
        // 留在等待集里:重查期间它若不受背压地重订阅了(owed 清掉),下一次返回时照样发给它
        const targets = [...waiters].filter((c) => !c.closed && c.topics.has("account") && !c.owed.has("account"));
        if (targets.length === 0) {
          accountSnapshotWaiters.delete(userId);
          coolAccountSnapshot(userId);
          return;
        }
        const seq = accountSeqOf(userId);
        if (seq !== seqBefore) {
          if (attemptsLeft > 1) {
            runAccountSnapshot(userId, source, attemptsLeft - 1);
            return;
          }
          accountSnapshotWaiters.delete(userId);
          coolAccountSnapshot(userId);
          for (const c of targets) {
            c.stale.add("account");
            c.owed.set("account", "race");
          }
          // 按连接计(每条连接各欠一份快照、各收一次 resync);/api/health 的 ws.snapshotRaces 直接带出
          stats.snapshotRaces += targets.length;
          log(`[ws] account snapshot for ${userId} raced ${ACCOUNT_SNAPSHOT_ATTEMPTS} times; deferred to resync`);
          return;
        }
        accountSnapshotWaiters.delete(userId);
        coolAccountSnapshot(userId);
        const events = toAccountEvents(result);
        for (const c of targets) for (const ev of events) send(c, /** @type {ServerEvent} */ ({ ...ev, topic: "account", seq }));
      })
      .catch((err) => {
        accountSnapshotWaiters.delete(userId);
        coolAccountSnapshot(userId);
        log(`[ws] account snapshot failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /**
   * @param {Conn} conn
   * @param {Topic[]} topics
   * @param {Partial<Record<Topic, number | undefined>> | undefined} since
   */
  function subscribe(conn, topics, since) {
    // 同一 op 里的重复 topic 只处理一次:重复订阅本是「幂等 + 再发一次快照」,但一帧里塞 180 个同名 topic 就是 180 份快照
    const unique = new Set(topics);
    for (const topic of unique) {
      const parsed = parseTopic(topic);
      if (parsed.kind === "account") {
        if (!conn.userId) {
          sendError(conn, "unauthorized", "Login required for the account topic", topic);
          continue;
        }
      } else if (parsed.symbol !== "*") {
        const verdict = symbolVerdict(parsed.symbol);
        if (verdict === "unknown") {
          sendError(conn, "unknown_topic", "Unknown topic", topic);
          continue;
        }
        const refused = verdict === "unverified" ? admitUnverified(conn, parsed.symbol) : null;
        if (refused) {
          sendError(conn, "rate_limited", refused, topic);
          continue;
        }
      }
      if (!conn.topics.has(topic) && conn.topics.size >= WS_MAX_TOPICS) {
        sendError(conn, "too_many_topics", `At most ${WS_MAX_TOPICS} topics per connection`, topic);
        continue;
      }
      addSubscription(conn, topic);
      // 这次订阅是在回应 resync 吗:取走标记(不论这次结果如何,再多给一次余量要等下一个 resync)
      const answeringResync = conn.resyncSent.delete(topic);
      // 同一合帧窗口里已经排好完整回应、其后的流事件也一条没跳过(不 stale、不欠快照):这一帧送到时客户端已追平到当前 seq,
      // 只回 subscribed{当前 seq},不再排第二份快照。审查复现过 20 个重复订阅 op 在一个窗口里排出 3.1 MB 的单帧。
      if (conn.answered.has(topic) && !conn.stale.has(topic) && !conn.owed.has(topic)) {
        // 等成交带预读的连接还没有基线:与第一次回的一样是 0(快照随后带当前 seq)
        const waitingTrades = parsed.kind === "trades" && tradesWaiters.get(parsed.symbol)?.has(conn);
        send(conn, { t: "subscribed", topic, seq: waitingTrades ? 0 : seqOf(topic) });
        continue;
      }
      // 订阅快照也受背压,逐个 topic 判:bufferedAmount 在本窗口 flush 之前不涨,所以把本窗口已排的字节(pendingBytes)一起算上;
      // 回应 resync 的那一次多给 RESYNC_ANSWER_HEADROOM_BYTES(扫描发 resync 到这次重订阅之间缓冲还会涨)
      const throttled = congested(conn, answeringResync ? RESYNC_ANSWER_HEADROOM_BYTES : 0);
      // 不受背压时,这次订阅本身就是完整的恢复(快照 / 最后值 / 回放,candles 与无快照来源的 account 则由客户端走 REST):
      // 先前跳过的 delta 与扣住的快照都被它取代。清 owed 让 stream() 恢复放行,清 stale 免得扫描再补一个多余的 resync。
      // trades 要先记下 owed:被扣过快照的客户端手里没有 tape,即使带 since 也补整份快照。
      const owedBefore = conn.owed.has(topic);
      if (!throttled) {
        conn.owed.delete(topic);
        conn.stale.delete(topic);
      }
      switch (parsed.kind) {
        case "book": {
          const seq = seqOf(topic);
          send(conn, { t: "subscribed", topic, seq });
          if (throttled) {
            dropBookWaiter(conn, parsed.symbol); // 欠快照:resync 之后的重订阅再说
            deferSnapshot(conn, topic);
            break;
          }
          conn.answered.add(topic);
          const snap = books.get(parsed.symbol);
          // 没有缓存(无人订阅期间已淘汰 / 进程刚起)就不发:空快照会把客户端的簿清空,旧快照会盖掉新值。
          // 这条连接等本 symbol 的下一条盘口消息(seq + 1,对它以整份快照发出,见 publish()),并请发布器刷新(限频,见 requestBookRefresh);
          // 新的订阅让次数闸重新计(冷却与在途照旧约束)
          if (!snap) {
            let waiters = bookWaiters.get(parsed.symbol);
            if (!waiters) bookWaiters.set(parsed.symbol, (waiters = new Set()));
            waiters.add(conn);
            bookRefreshMisses.delete(parsed.symbol);
            requestBookRefresh(parsed.symbol);
            break;
          }
          dropBookWaiter(conn, parsed.symbol);
          send(conn, { t: "book.snapshot", topic: /** @type {`book:${string}`} */ (topic), seq, symbol: parsed.symbol, bids: snap.bids, asks: snap.asks, ts: snap.ts });
          break;
        }
        case "trades": {
          const tradesTopic = /** @type {`trades:${string}`} */ (topic);
          const ring = tapes.get(parsed.symbol) ?? [];
          const current = seqOf(topic);
          const from = since?.[topic];
          if (throttled) {
            dropTradesWaiter(conn, parsed.symbol); // 欠快照:resync 之后的重订阅再说
            // 回客户端手里真实的基线:带了合法 since(0 < since ≤ current)就是 since,否则 0(ws-client 把 0 当「无基线」)。
            // 不能回 current:ws-client 会把它当 lastSeq,跨非 1012 重连以 since = current 重订阅,hub 当它已追平,
            // 那段 ≤ 64 笔的成交就永远缺了(对计划 §3.3「subscribed.seq = 当前值」的已批准偏离,见 P1-11b 报告)
            send(conn, { t: "subscribed", topic, seq: typeof from === "number" && from > 0 && from <= current ? from : 0 });
            deferSnapshot(conn, topic);
            break;
          }
          conn.answered.add(topic);
          // 上次的快照被背压扣住过(owed):客户端手里没有 tape,即使带 since 也补整份快照(环 ≤ 64 笔按 id 去重,是回放的超集)
          const replayable =
            !owedBefore &&
            typeof from === "number" &&
            from <= current &&
            current - from <= WS_TAPE_RING &&
            (from === current || (ring.length > 0 && ring[0].seq <= from + 1));
          if (replayable) {
            send(conn, { t: "subscribed", topic, seq: from });
            for (const { seq, entry } of ring) {
              if (seq > from) send(conn, { t: "trades", topic: tradesTopic, seq, symbol: parsed.symbol, trades: [entry] });
            }
          } else if (tradesWaiters.get(parsed.symbol)?.has(conn) || awaitTradesPreload(parsed.symbol)) {
            // 环没满、还没预读过(进程刚起):等预读,只回 subscribed{seq: 0}(无基线),预读回来后发整份快照(见 releaseTradesWaiters)
            send(conn, { t: "subscribed", topic, seq: 0 });
            let waiters = tradesWaiters.get(parsed.symbol);
            if (!waiters) tradesWaiters.set(parsed.symbol, (waiters = new Set()));
            waiters.add(conn);
          } else {
            send(conn, { t: "subscribed", topic, seq: current });
            send(conn, { t: "trades", topic: tradesTopic, seq: current, symbol: parsed.symbol, trades: ring.map((r) => r.entry) });
          }
          break;
        }
        case "ticker": {
          const seq = seqOf(topic);
          send(conn, { t: "subscribed", topic, seq });
          if (throttled) {
            deferSnapshot(conn, topic);
            break;
          }
          conn.answered.add(topic);
          // 缓存里只有发布器还在喂的标的(cacheTicker / evictIdle);没有就只回 subscribed,客户端保留 SSR / REST 值,下一笔成交再推
          if (parsed.symbol === "*") {
            for (const [symbol, ticker] of tickers) send(conn, { t: "ticker", topic: "ticker:*", seq, symbol, ticker });
          } else {
            const last = tickers.get(parsed.symbol);
            if (last) send(conn, { t: "ticker", topic: /** @type {`ticker:${string}`} */ (topic), seq, symbol: parsed.symbol, ticker: last });
          }
          break;
        }
        case "candles": {
          send(conn, { t: "subscribed", topic, seq: seqOf(topic) }); // 不发历史:客户端走 REST 再 mergeHistory
          break;
        }
        case "account": {
          const userId = /** @type {string} */ (conn.userId);
          send(conn, { t: "subscribed", topic, seq: accountSeqOf(userId) });
          // 每次订阅时才读钩子:发布器模块可能在 hub 之后才加载(dev 下 BOT_DISABLED=1 时要等第一个请求触及 matching)
          const source = accountSnapshot ?? globalThis.__carbadiaAccountSnapshot;
          // 背压下与其它 topic 一样扣住快照(owed + stale):stream() 跳过该 topic 的事件,缓冲回落后扫描发 resync。
          // 不进 answered:快照是异步查的,同一用户的重复订阅已由 requestAccountSnapshot 并进同一次查询
          if (source && throttled) {
            deferSnapshot(conn, topic);
            break;
          }
          if (source) requestAccountSnapshot(conn, userId, source);
          break;
        }
      }
    }
  }

  /**
   * @param {Conn} conn
   * @param {Topic[]} topics
   */
  function unsubscribe(conn, topics) {
    for (const topic of topics) {
      removeSubscription(conn, topic);
      send(conn, { t: "unsubscribed", topic }); // 幂等:没订阅过也回 unsubscribed,客户端不必区分
    }
  }

  // ---- 入站 ----
  /**
   * @param {Conn} conn
   * @param {unknown} data
   * @param {boolean} [isBinary]
   */
  function onMessage(conn, data, isBinary) {
    if (conn.closed || conn.closing) return;
    const t = now();
    if (t - conn.opWindowStart >= 1_000) {
      conn.opWindowStart = t;
      conn.opCount = 0;
    }
    conn.opCount += 1;
    if (conn.opCount > MAX_OPS_PER_SECOND) {
      if (t - conn.dropWindowStart >= 60_000) {
        conn.dropWindowStart = t;
        conn.dropCount = 0;
      }
      conn.dropCount += 1;
      if (conn.dropCount > MAX_DROPPED_OPS_PER_MINUTE) {
        closeConn(conn, CLOSE_POLICY, "rate limit");
        return;
      }
      sendError(conn, "rate_limited", `At most ${MAX_OPS_PER_SECOND} operations per second`);
      return;
    }
    /** @type {unknown} */
    let json;
    try {
      if (isBinary) throw new TypeError("binary frame");
      json = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      badFrame(conn);
      return;
    }
    const result = clientOpSchema.safeParse(json);
    if (!result.success) {
      badFrame(conn);
      return;
    }
    const op = result.data;
    switch (op.op) {
      case "subscribe":
        subscribe(conn, /** @type {Topic[]} */ (op.topics), /** @type {Partial<Record<Topic, number | undefined>> | undefined} */ (op.since));
        break;
      case "unsubscribe":
        unsubscribe(conn, /** @type {Topic[]} */ (op.topics));
        break;
      case "ping":
        send(conn, { t: "pong", t0: op.t0, serverTime: t });
        break;
    }
    conn.badStreak = 0; // 处理完才清零:处理中抛错的帧按坏帧累计(见 accept 的 message 监听)
  }

  /** @param {Conn} conn */
  function badFrame(conn) {
    conn.badStreak += 1;
    if (conn.badStreak >= MAX_CONSECUTIVE_BAD_FRAMES) {
      closeConn(conn, CLOSE_POLICY, "too many bad frames");
      return;
    }
    sendError(conn, "bad_request", "Frame is not a valid client op");
  }

  // ---- 连接生命周期 ----
  /** @param {Conn} conn */
  function teardown(conn) {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.flushTimer !== null) clearTimeout(conn.flushTimer);
    if (conn.pongTimer !== null) clearTimeout(conn.pongTimer);
    if (conn.graceTimer !== null) clearTimeout(conn.graceTimer);
    conn.flushTimer = null;
    conn.pongTimer = null;
    conn.graceTimer = null;
    conn.pending = [];
    releaseHolds(conn); // 退订后窗口还没结束连接就断了:保留期到此为止
    for (const topic of [...conn.topics]) removeSubscription(conn, topic); // closed:归零的立即淘汰,不再保留
    if (conns.delete(conn)) stats.connections -= 1;
    conn.onClose?.();
  }

  /**
   * 接管一条已完成握手的连接:发 hello、挂事件。
   * @param {HubSocket} ws
   * @param {{ userId: string | null; ip: string; onClose?: () => void }} info
   */
  function accept(ws, { userId, ip, onClose }) {
    const t = now();
    /** @type {Conn} */
    const conn = {
      ws,
      userId,
      ip,
      topics: new Set(),
      pending: [],
      pendingBytes: 0,
      answered: new Set(),
      flushTimer: null,
      stale: new Set(),
      owed: new Map(),
      resyncSent: new Set(),
      releases: new Set(),
      overSince: null,
      opWindowStart: t,
      opCount: 0,
      dropWindowStart: t,
      dropCount: 0,
      badStreak: 0,
      unverifiedWindowStart: t,
      unverified: new Set(),
      pongTimer: null,
      graceTimer: null,
      closing: false,
      closed: false,
      onClose,
    };
    if (closed) {
      conn.closed = true;
      ws.close(1012, "server restarting");
      onClose?.();
      return conn;
    }
    conns.add(conn);
    stats.connections += 1;
    ws.on("message", (data, isBinary) => {
      // 入站帧是不可信输入:处理中的任何意外抛错(本该不会有)都不能从 ws 的接收器里逃出去变成 uncaughtException。
      // 按坏帧计:记一行、回 bad_request,连续 MAX_CONSECUTIVE_BAD_FRAMES 次即 1008,能稳定触发它的客户端刷不了屏
      try {
        onMessage(conn, data, isBinary === true);
      } catch (err) {
        log(`[ws] message handler failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!conn.closed && !conn.closing) badFrame(conn);
      }
    });
    ws.on("pong", () => {
      if (conn.pongTimer !== null) clearTimeout(conn.pongTimer);
      conn.pongTimer = null;
    });
    ws.on("error", () => {}); // ws 在 error 后必发 close;这里只防 uncaughtException
    ws.on("close", () => teardown(conn));
    send(conn, { t: "hello", v: WS_PROTOCOL_VERSION, serverTime: t, heartbeatMs: WS_HEARTBEAT_MS, userId, maxTopics: WS_MAX_TOPICS, bootId });
    return conn;
  }

  // ---- 总线 → 事件 ----
  /**
   * @param {Topic} topic
   * @param {ServerEvent} event
   * @param {string} [userId] account 事件只发给该用户的连接
   */
  function fanout(topic, event, userId) {
    const set = subscribers.get(topic);
    if (!set) return;
    for (const conn of set) {
      if (userId !== undefined && conn.userId !== userId) continue;
      stream(conn, topic, event);
    }
  }

  /** @param {BusMessage} msg */
  function publish(msg) {
    if (closed || !msg || typeof msg !== "object") return;
    switch (msg.kind) {
      case "book": {
        const { symbol, snapshot, delta } = msg;
        seenSymbols.add(symbol);
        const topic = /** @type {`book:${string}`} */ (`book:${symbol}`);
        // 只在有人订阅(或在保留期里,见 held)时缓存(总线消息总带着整份快照,delta 也一样):无人订阅时发布器不再喂它,
        // 晚到的这一条之后就会越来越旧
        if (fed(topic)) books.set(symbol, snapshot);
        else books.delete(symbol);
        const seq = nextSeq(topic);
        /** @type {ServerEvent} */
        const full = { t: "book.snapshot", topic, seq, symbol, bids: snapshot.bids, asks: snapshot.asks, ts: snapshot.ts };
        /** @type {ServerEvent} */
        const event = delta ? { t: "book.delta", topic, seq, symbol, bids: delta.bids, asks: delta.asks, ts: delta.ts } : full;
        // 等整份快照的连接(订阅时 hub 没有这本簿)手里没有簿:这一条对它们以整份快照发出(同一 seq),不论发布器发的是不是 delta
        const waiters = bookWaiters.get(symbol);
        bookWaiters.delete(symbol);
        bookRefreshMisses.delete(symbol); // 等来了:次数闸随等待者一起清掉
        const set = subscribers.get(topic);
        if (!set) return;
        for (const conn of set) {
          if (waiters?.has(conn)) streamSnapshot(conn, topic, full);
          else stream(conn, topic, event);
        }
        return;
      }
      case "trades": {
        const { symbol } = msg;
        seenSymbols.add(symbol);
        const topic = /** @type {`trades:${string}`} */ (`trades:${symbol}`);
        let ring = tapes.get(symbol);
        if (!ring) tapes.set(symbol, (ring = []));
        // 每笔成交各占一个 seq:环与 since 回放都按笔计,客户端 expected = last + 1 才连续。
        // 等预读的连接(tradesWaiters)先不发:它们还没有基线,这些成交都会在随后的整份快照里
        const waiting = tradesWaiters.get(symbol);
        for (const entry of msg.trades) {
          const seq = nextSeq(topic);
          ring.push({ seq, entry });
          if (ring.length > WS_TAPE_RING) ring.shift();
          const set = subscribers.get(topic);
          if (!set) continue;
          /** @type {ServerEvent} */
          const event = { t: "trades", topic, seq, symbol, trades: [entry] };
          for (const conn of set) if (!waiting?.has(conn)) stream(conn, topic, event);
        }
        return;
      }
      case "ticker": {
        const { symbol, ticker } = msg;
        seenSymbols.add(symbol);
        cacheTicker(symbol, ticker);
        const topic = /** @type {`ticker:${string}`} */ (`ticker:${symbol}`);
        fanout(topic, { t: "ticker", topic, seq: nextSeq(topic), symbol, ticker });
        fanout("ticker:*", { t: "ticker", topic: "ticker:*", seq: nextSeq("ticker:*"), symbol, ticker });
        return;
      }
      case "candle": {
        const { symbol, interval, candle } = msg;
        seenSymbols.add(symbol);
        const topic = /** @type {`candles:${string}:${typeof interval}`} */ (`candles:${symbol}:${interval}`);
        fanout(topic, { t: "candle", topic, seq: nextSeq(topic), symbol, interval, candle });
        return;
      }
      case "account": {
        const { userId, event } = msg;
        // 该用户没有 account 订阅(发布器判定在线之后、发布之前他走了):没人收,也不记 seq(否则 accountSeq 随历史用户数一直涨)
        if (!presence.users.has(userId)) return;
        const seq = nextAccountSeq(userId);
        fanout("account", /** @type {ServerEvent} */ ({ ...event, topic: "account", seq }), userId);
        return;
      }
      default:
        return;
    }
  }

  const unsubscribeBus = bus ? bus.subscribe(publish) : () => {};

  // ---- 定时器:心跳、背压扫描、统计 ----
  const heartbeatTimer = setInterval(() => {
    for (const conn of conns) {
      if (conn.closed || conn.ws.readyState !== WS_OPEN) continue;
      if (conn.pongTimer !== null) continue; // 上一轮 ping 还没等到 pong,由它的超时决定命运
      try {
        conn.ws.ping();
      } catch {
        continue;
      }
      conn.pongTimer = setTimeout(() => {
        conn.pongTimer = null;
        if (!conn.closed) conn.ws.terminate();
      }, pongTimeoutMs);
    }
  }, heartbeatMs);
  heartbeatTimer.unref();

  const backpressureTimer = setInterval(() => {
    const t = now();
    for (const conn of conns) {
      if (conn.closed || conn.closing) continue;
      const buffered = bufferedAmountOf(conn.ws);
      if (buffered > BACKPRESSURE_HARD_CLOSE_BYTES) {
        stats.closedByBackpressure += 1;
        closeConn(conn, CLOSE_OVERLOAD, "backpressure");
        continue;
      }
      if (buffered > BACKPRESSURE_CLOSE_BYTES) {
        if (conn.overSince === null) conn.overSince = t;
        else if (t - conn.overSince >= backpressureCloseAfterMs) {
          stats.closedByBackpressure += 1;
          closeConn(conn, CLOSE_OVERLOAD, "backpressure");
          continue;
        }
      } else {
        conn.overSince = null;
      }
      for (const topic of [...conn.stale]) {
        if (!conn.topics.has(topic)) {
          conn.stale.delete(topic);
          continue;
        }
        const owed = conn.owed.get(topic);
        // 欠快照的 topic 在缓冲 ≤ 256 KB 时就发:只等 < 64 KB 的话,连接长期停在 64–256 KB 时这些 topic 永远是空盘口 / 空成交带,
        // 客户端也没有信号去降级。客户端回应这个 resync 的重订阅按 256 KB + RESYNC_ANSWER_HEADROOM_BYTES
        // 限流(resyncSent),不是恰好 256 KB:扫描时的缓冲不含本窗口待发的字节,到重订阅的一个往返里缓冲也还会涨。
        // 这只是余量、不是保证:往返里涨过 64 KB 时重订阅仍被限流,topic 重新欠下,下一轮扫描再发(每秒至多一次);
        // ws-client 在 subscribed 之后等不到快照(或又收到 resync)即按一次 resync 失败计,两次降级轮询,这个循环因此有尽头。
        // 只跳过了 delta 的 stale topic 手里有基线,仍按计划 §3.3 等 < 64 KB
        if (owed !== undefined ? buffered > BACKPRESSURE_SKIP_BYTES : buffered >= BACKPRESSURE_RESYNC_BYTES) continue;
        // 协议的 reason 只有 backpressure | restart;快照竞态(owed "race")也借 backpressure 让客户端重订阅,但不计入背压计数(另计 snapshotRaces)
        send(conn, { t: "resync", topic, reason: "backpressure" });
        if (owed !== "race") stats.resyncs += 1;
        if (owed !== undefined) conn.resyncSent.add(topic);
        conn.stale.delete(topic);
      }
    }
  }, backpressureScanMs);
  backpressureTimer.unref();

  const statsTimer = setInterval(() => {
    log(JSON.stringify({ src: "ws", ev: "stats", ...stats }));
    flushRefreshFailLog();
  }, statsIntervalMs);
  statsTimer.unref();

  /**
   * 向所有连接广播关闭码并等它们真正关掉(最多 closeGraceMs,之后 terminate)。
   * 截止时间与 closeConn() 的逐连接宽限用同一个 closeGraceMs:调大时不会被一个固定的 1 s 提前 terminate,调小时也不会多等。
   * @param {number} code
   * @param {string} reason
   */
  async function close(code, reason) {
    if (closed) return;
    closed = true;
    unsubscribeBus();
    clearInterval(heartbeatTimer);
    clearInterval(backpressureTimer);
    clearInterval(statsTimer);
    for (const timer of bookRefreshCooldowns.values()) clearTimeout(timer);
    bookRefreshCooldowns.clear();
    for (const { timer } of accountSnapshotCooling.values()) clearTimeout(timer);
    accountSnapshotCooling.clear();
    for (const timer of tradesPreloadCooldowns.values()) clearTimeout(timer);
    tradesPreloadCooldowns.clear();
    const open = [...conns];
    for (const conn of open) closeConn(conn, code, reason);
    if (open.length === 0) return;
    await new Promise((resolve) => {
      const deadline = setTimeout(() => {
        clearInterval(tick);
        for (const conn of open) {
          if (!conn.closed) {
            conn.ws.terminate();
            teardown(conn);
          }
        }
        resolve(undefined);
      }, closeGraceMs);
      const tick = setInterval(() => {
        if (open.every((c) => c.closed)) {
          clearTimeout(deadline);
          clearInterval(tick);
          resolve(undefined);
        }
      }, 5);
    });
  }

  return {
    accept,
    publish,
    close,
    stats: () => stats,
    size: () => conns.size,
  };
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {string} name 小写头名
 * @returns {string | null}
 */
function header(req, name) {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/**
 * upgrade 请求目标里的 path(去掉 ? 或 # 之后的部分),不经 WHATWG URL:`//`、`///`、`//[`、`//:99999` 这类合法的 origin-form 目标
 * 会让 new URL 抛 ERR_INVALID_URL,在 'upgrade' 监听器里抛出去就是 uncaughtException,socket 也成了没人管的孤儿(终审 P1-25a)。
 * 只认 origin-form(以 / 开头);absolute-form(http://host/ws)与 asterisk-form 返回 null,一律不算 /ws。
 * 不做百分号解码:/w%73 不是 /ws(与 WHATWG URL 的 pathname 一致)。导出供测试。
 * @param {string | undefined} target req.url
 * @returns {string | null}
 */
export function upgradePath(target) {
  if (typeof target !== "string" || !target.startsWith("/")) return null;
  const cut = target.search(/[?#]/);
  return cut < 0 ? target : target.slice(0, cut);
}

/** 被拒的 upgrade 写完响应后最多等这么久(对端读得慢、'finish' 迟迟不来)就 destroy */
const REJECT_LINGER_MS = 2_000;

/**
 * 握手阶段拒绝:写一段最小的 HTTP 响应,写完即 destroy(照 ws 的 abortHandshake)。
 * 不能只 end():'upgrade' 之后 Node 已把 socket 从 HTTP 的超时(headersTimeout、keepAlive、连接检查)上摘下来,socket 又是 allowHalfOpen、
 * 处于暂停状态,不回 FIN 的客户端能让服务端这一侧一直开着;被拒的连接也不计入任何上限,文件描述符可以无限累积(终审 P1-25a)。
 * @param {import("node:stream").Duplex} socket
 * @param {number} status
 * @param {string} statusText
 * @param {Record<string, string>} [headers]
 */
function rejectUpgrade(socket, status, statusText, headers = {}) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const lines = [`HTTP/1.1 ${status} ${statusText}`, "Connection: close", "Content-Length: 0"];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  const linger = setTimeout(() => socket.destroy(), REJECT_LINGER_MS);
  linger.unref?.();
  socket.once("close", () => clearTimeout(linger));
  socket.once("finish", () => socket.destroy());
  socket.end(`${lines.join("\r\n")}\r\n\r\n`);
}

/**
 * @typedef {HubOptions & {
 *   path?: string;
 *   secret?: string;
 *   proxySecret?: string;
 *   allowedOrigins?: readonly string[];
 *   maxConnections?: number;
 *   maxPerIp?: number;
 *   maxUntrusted?: number;
 *   disabled?: boolean;
 *   dev?: boolean;
 *   nextUpgrade?: (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void;
 * }} AttachOptions
 */

/**
 * 把 hub 挂到 http.Server 上。必须在 listen() 之前调用:Next 会在处理第一个请求时把自己的 upgrade 监听器懒挂到同一个 server,
 * 我们的监听器先注册就先执行;非 /ws 的 upgrade 在生产一律 socket.destroy()(不写 HTTP 响应,见 §3.3「鉴权与 upgrade 路由」),
 * dev 下转交 nextUpgrade(HMR)。disabled(WS_DISABLED=1)时不接 /ws,但仍初始化 enabled: false 的 __carbadiaWsStats。
 * @param {import("node:http").Server} httpServer
 * @param {AttachOptions} opts
 * @returns {{ close(code: number, reason: string): Promise<void>; stats(): WsStats }}
 */
export function attachWsHub(httpServer, opts) {
  const {
    path = "/ws",
    secret,
    proxySecret,
    allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
    maxConnections = DEFAULT_MAX_CONNECTIONS,
    maxPerIp = DEFAULT_MAX_PER_IP,
    maxUntrusted = DEFAULT_MAX_UNTRUSTED,
    disabled = false,
    dev = false,
    nextUpgrade,
    ...hubOpts
  } = opts;
  const log = hubOpts.log ?? ((line) => console.log(line));

  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:stream").Duplex} socket
   * @param {Buffer} head
   * @returns {boolean} 是否是 /ws
   */
  function routeOther(req, socket, head) {
    if (upgradePath(req.url) === path) return true;
    if (dev && nextUpgrade) {
      // Next 的 upgrade 处理器是 async:它的拒绝同样只关这条 socket、记一行,不留给 unhandledRejection
      Promise.resolve(nextUpgrade(req, socket, head)).catch((err) => upgradeFailed(socket, err));
    } else {
      socket.destroy();
    }
    return false;
  }

  /**
   * @param {import("node:stream").Duplex} socket
   * @param {unknown} err
   */
  function upgradeFailed(socket, err) {
    socket.destroy();
    log(`[ws] upgrade handler failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * 'upgrade' 监听器的外壳:先挂 error 监听(此后这条 socket 的任何错误都不会变成 uncaughtException;Node 在发 'upgrade' 之前
   * 已摘掉它自己的监听器),再在 try 里跑处理逻辑;任何意外抛错只 destroy 这条 socket 并记一行,不留孤儿 socket(终审 P1-25a)。
   * @param {(req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void} handler
   * @returns {(req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void}
   */
  const guarded = (handler) => (req, socket, head) => {
    socket.on("error", () => {});
    try {
      handler(req, socket, head);
    } catch (err) {
      upgradeFailed(socket, err);
    }
  };

  if (disabled) {
    const stats = zeroWsStats(false);
    globalThis.__carbadiaWsStats = stats;
    httpServer.on(
      "upgrade",
      guarded((req, socket, head) => {
        if (routeOther(req, socket, head)) socket.destroy();
      }),
    );
    return { close: async () => {}, stats: () => stats };
  }

  if (!secret) {
    // 生产下 SESSION_SECRET 缺失或等于公开的开发默认值(resolveSessionSecret 给 undefined):hub 照常起,但不验任何 cookie,
    // 全部连接按匿名处理(account 回 unauthorized),与 auth.ts 的拒绝一致;记一行,部署后在日志里能看到
    log("[ws] error: SESSION_SECRET is missing or is the public dev default; every /ws connection is treated as anonymous");
  }
  const hub = createHub({ ...hubOpts, log });
  const stats = hub.stats();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  /** @type {Map<string, number>} */
  const perIp = new Map();
  let closing = false;

  httpServer.on("upgrade", guarded((req, socket, head) => {
    if (!routeOther(req, socket, head)) return;
    if (closing) {
      socket.destroy();
      return;
    }
    const origin = header(req, "origin");
    if (origin !== null && !originAllowed(origin, allowedOrigins)) {
      stats.rejected += 1;
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (hub.size() >= maxConnections) {
      stats.rejected += 1;
      rejectUpgrade(socket, 503, "Service Unavailable", { "Retry-After": "30" });
      return;
    }
    const ip = clientIpFromHeaders((name) => header(req, name), proxySecret);
    // 每个桶的上限:真实 IP 按 maxPerIp;"untrusted"(直连源站)是所有直连共用的一个桶,按自己的小上限 maxUntrusted;
    // "local"(没配 PROXY_SECRET 的本机开发 / 冒烟,或经 Worker 却没有 IP 头)豁免,只受总上限约束——ws-flood 从本机开 300 个连接靠它
    const cap = ip === IP_BUCKET_UNTRUSTED ? maxUntrusted : isSharedIpBucket(ip) ? Infinity : maxPerIp;
    const countPerIp = Number.isFinite(cap);
    if (countPerIp && (perIp.get(ip) ?? 0) >= cap) {
      stats.rejected += 1;
      rejectUpgrade(socket, 503, "Service Unavailable", { "Retry-After": "30" });
      return;
    }
    const cookie = readSessionCookie(header(req, "cookie") ?? undefined);
    const userId = cookie !== null && secret ? verifySession(cookie, secret) : null;
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (countPerIp) perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
      hub.accept(/** @type {HubSocket} */ (/** @type {unknown} */ (ws)), {
        userId,
        ip,
        onClose: () => {
          if (!countPerIp) return;
          const n = (perIp.get(ip) ?? 1) - 1;
          if (n <= 0) perIp.delete(ip);
          else perIp.set(ip, n);
        },
      });
    });
  }));

  return {
    async close(code, reason) {
      closing = true;
      await hub.close(code, reason);
      wss.close();
    },
    stats: () => stats,
  };
}
