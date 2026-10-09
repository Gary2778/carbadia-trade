// WebSocket 客户端(计划 §3.2 客户端 realm、§3.3 客户端语义)。浏览器侧唯一直接持有 socket 的地方:
//   - 退避:1 s → 30 s(×2,±30% 抖动);hello 才算连上(攒到 3 次连不上由 transport.ts 切轮询);
//   - hello 后按当前订阅集全量重订阅,trades 带 since = 已收最大 seq(hub 缺口 ≤ 64 时回放,否则回快照),
//     随后清空 seq 表,由 subscribed{seq} 重设基线;stop() 也清 seq 表,所以轮询切回 WS 时不带 since;
//   - 序号:expected = last + 1,相等应用、更小丢弃、更大即缺口;trades 带 since = last 重订阅,其它 topic
//     unsubscribe + subscribe;seq === 0 表示无序号,不检测。缺口那条与其后到 subscribed 之前的同 topic 事件:
//     book / ticker / trades 不应用(等回放 / 快照),account / candles 照常应用(整行 / 按键覆盖,hub 不回放,扣住就丢了);
//   - 缺口 / resync 引发的重订阅,5 s 内要等到 subscribed,book / trades / ticker / account 还要在 subscribed 之后 5 s 内等到自己的快照
//     (见 snapshotOf);超时、error、或快照没来之前又收到该 topic 的 resync / 缺口(hub 又把它扣住了),都按一次 resync 失败上报,
//     transport 攒到 2 次切轮询。只看 subscribed 的话,被 hub 限流的重订阅(只回 subscribed、快照欠着)也算成功,永远不降级;
//   - 关闭码:1012 清空 seq 表(重启后 seq 归零,重连的 hello 不带 since)、等 2–5 s 再退避;1013 退避抖动后仍 ≥ 10 s;
//     1008 / 1009 不重连并上报 policy;其余走普通退避;
//   - 心跳:hello 后每 20 s 应用层 ping{ t0 },pong 记 rttMs;连续 2 次无 pong 就地放弃这条连接(不等浏览器的 close 事件 ——
//     半开的 TCP 上关闭握手可能拖 60 s,期间徽标还显示 Live):立即报 connecting、按退避重连,旧 socket 迟到的回调一律丢弃;
//   - 身份:hello.userId 与账户 store 的已知身份(expectedUserId)不同,或 account 收到 error unauthorized —— 别的标签页登录 / 登出 / 换人、
//     会话过期 —— 这条连接不订 account(另一个人的账户数据不能落进本页的 store),上报 identity-mismatch,由 MarketProvider 让账户 store
//     重新 hydrate;身份真的变了的话 store 会请求重连,新连接的 hello 一致后照常订上;
//   - hello.bootId(hub 进程的启动标识)与上一次连接的不同 = 服务端重启过(不一定先发了 1012,例如崩溃):清掉全部 lastSeq,重订阅不带 since;
//   - 可见性:document.hidden 超过 30 s 退订市场 topic(account 保留),回前台重订阅;
//   - lastMessageAt 每帧更新,但对外最多每秒通知一次,免得 ConnectionBadge 每帧重渲染;
//   - account 订阅快照的边界:识别出一份快照就把帧在快照末尾切开 —— 快照及之前的部分交给 onFrame,随即上报 account-snapshot
//     (快照里的挂单 id / 持仓 assetId / 未完结条件单 id),同一帧里快照之后的事件在上报之后才交给 onFrame;MarketProvider 据此收口
//     (快照只能覆盖,表达不了断线期间已成交 / 已撤的单、卖光的持仓与已触发 / 已撤的条件单)。识别规则见 accountWatch。
// 全部外部依赖(WebSocket 构造器、定时器、随机数、可见性)可注入,测试用假 socket + vitest 假定时器,不需要 jsdom。
// 帧本身不校验 schema(信任同源 hub,省掉 zod 进客户端 bundle);非数组 / 非 JSON 的帧直接忽略。
import type { ClientOp, ConnectionState, Order, ServerEvent, ServerFrame, Topic } from "@/shared";

/** ws-client 与 transport.ts 共用的传输接口;kind 在 transport 管理器上随降级 / 恢复变化 */
export type MarketTransport = {
  start(): void;
  stop(): void;
  subscribe(topic: Topic): void;
  unsubscribe(topic: Topic): void;
  /** 登录 / 登出后调用:断开并立即重连,新连接在 upgrade 时重新验签 cookie */
  reconnect(): void;
  readonly kind: "ws" | "poll";
};

export type WsTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  now: () => number;
};

/** 可见性来源;默认读 document.visibilityState,无 document(node / 测试)视为永远可见 */
export type Visibility = {
  hidden: () => boolean;
  onChange: (listener: () => void) => () => void;
};

/**
 * 给 transport 管理器(降级判定)与 PerfHud 的生命周期事件;account-snapshot 给 MarketProvider 做账户快照收口
 * (帧在快照末尾切开:快照及之前的事件已交给 onFrame、同一帧里快照之后的事件还没交 —— 收口时 flush batcher 只会应用到快照为止;
 * orderIds / assetIds / triggerIds = 快照里的挂单 id / 持仓 assetId / 未完结条件单 id,orderIds 再减去订阅之后、快照之前的增量里已终结(FILLED / CANCELLED)的挂单;
 * 快照之前的增量碰过、快照里却没有的 id 不在其中,见 createWsClient 里的 accountWatch)。
 */
export type WsClientEvent =
  | { type: "open" }
  | { type: "connect-failed"; attempt: number }
  | { type: "policy"; code: number; reason: string }
  | { type: "resync"; topic: Topic; ok: boolean }
  | { type: "account-snapshot"; orderIds: ReadonlySet<string>; assetIds: ReadonlySet<string>; triggerIds: ReadonlySet<string> }
  /**
   * 这条连接的身份与账户 store 的不一致:reason "hello" = hello.userId(userId)不等于 expectedUserId;"unauthorized" = account 被 hub 拒绝
   * (连接是匿名的)。每条连接至多一次;此后这条连接不再订 account,直到重连后的 hello 一致。
   */
  | { type: "identity-mismatch"; userId: string | null; reason: "hello" | "unauthorized" };

export type WsClientOptions = {
  url: string;
  onFrame: (frame: ServerFrame) => void;
  onState: (state: ConnectionState) => void;
  onEvent?: (event: WsClientEvent) => void;
  wsImpl?: typeof WebSocket;
  timers?: WsTimers;
  /** 默认 Math.random;测试注入固定值以断言抖动边界 */
  random?: () => number;
  visibility?: Visibility;
  /** 默认 20 s */
  pingIntervalMs?: number;
  /** new WebSocket 到 hello 的上限,默认 10 s;超时按连不上处理 */
  connectTimeoutMs?: number;
  /** 重订阅后等 subscribed、subscribed 之后等该 topic 的快照,各自的上限,默认 5 s;超时上报 resync 失败 */
  resyncTimeoutMs?: number;
  /** 后台多久退订市场 topic,默认 30 s */
  hiddenGraceMs?: number;
  /**
   * 账户 store 的已知身份(用户 id;null = 确认的未登录;undefined = 还不知道,不比对)。hello 时、以及订 account 时与连接的身份比,
   * 不同则这条连接不订 account 并上报 identity-mismatch。不传 = 不比对(测试、没有账户 store 的场合)。
   */
  expectedUserId?: () => string | null | undefined;
};

export const WS_BACKOFF_MIN_MS = 1_000;
export const WS_BACKOFF_MAX_MS = 30_000;
export const WS_BACKOFF_JITTER = 0.3;
export const WS_PING_INTERVAL_MS = 20_000;
// 8 s:/ws 升级被挂起(例如回滚前打开的页面、或代理挂住 upgrade)时,3 次尝试 + 两次退避最坏约 28 s,落在 §7.1 的 30 s 降级预算内(P1-23 实测 10 s 时 31–35 s)
export const WS_CONNECT_TIMEOUT_MS = 8_000;
export const WS_RESYNC_TIMEOUT_MS = 5_000;
export const WS_HIDDEN_GRACE_MS = 30_000;
/** 1012 服务重启:等 2–5 s 再进入退避 */
export const WS_RESTART_WAIT_MS: readonly [number, number] = [2_000, 5_000];
/** 1013 过载:退避从 10 s 起 */
export const WS_OVERLOAD_MIN_MS = 10_000;
/** 连续无 pong 次数达到即主动断开重连 */
export const WS_MAX_MISSED_PONGS = 2;
/** 看门狗就地放弃连接时交给 handleClose 的关闭码(私有范围 4000–4999,不与服务端的码冲突;走普通退避分支) */
const WS_WATCHDOG_CLOSE_CODE = 4000;
/**
 * account 订阅之后、快照到达之前记下的已终结挂单 id 的上限:hub 没有快照来源(只回 subscribed)或快照被背压扣住时窗口一直开着,
 * 超过即关窗、放弃这次收口 —— 宁可留着旧单,也不无限记账。
 */
export const ACCOUNT_SNAPSHOT_WATCH_MAX = 1_000;

/** account 快照观察窗口里记下的 id(见 createWsClient 的 accountWatch):只有窗口里已终结的挂单 */
type AccountWatch = { closedOrderIds: Set<string> };
const newAccountWatch = (): AccountWatch => ({ closedOrderIds: new Set() });
/** 正在识别的一份快照:它自己的挂单 id / 持仓 assetId / 条件单 id(收口只保留这些),外加窗口里记下的已终结挂单(排除) */
type SnapshotIds = { orderIds: Set<string>; assetIds: Set<string>; triggerIds: Set<string>; closedOrderIds: Set<string>; seq: number };
const isOpenOrder = (order: Order): boolean => order.status === "OPEN" || order.status === "PARTIAL";

const OPEN = 1;

/** ±30% 抖动 */
export function jitter(ms: number, random: () => number): number {
  return Math.round(ms * (1 + (random() * 2 - 1) * WS_BACKOFF_JITTER));
}

/**
 * 第 attempt 次(从 0 起)失败后的等待:min(1 s × 2^attempt, 30 s) 再抖动;floorMs 为 1013 之后的下限,
 * 抖动之后再夹一次,向下的抖动也不会低于它(1013 → 等待 ≥ 10 s,只向上散开)
 */
export function backoffDelay(attempt: number, random: () => number, floorMs = 0): number {
  const base = Math.min(WS_BACKOFF_MIN_MS * 2 ** attempt, WS_BACKOFF_MAX_MS);
  return Math.max(jitter(Math.max(base, floorMs), random), floorMs);
}

export const isMarketTopic = (topic: Topic): boolean => topic !== "account";
export const isTradesTopic = (topic: Topic): topic is `trades:${string}` => topic.startsWith("trades:");
/**
 * 缺口期间照常应用的 topic:account(order 整行按 id、balance 覆盖、position 按 assetId、fill 前插;hub 不回放,
 * 重订阅的快照也不含 fill,扣住等于丢掉)与 candles(按 t upsert 幂等;hub 不回放历史)。
 * book(delta 叠在缺档的簿上)、ticker(部分字段合并)、trades(回放会重复且 tape 乱序)则扣到 subscribed 为止。
 */
export const appliesAcrossGap = (topic: Topic): boolean => topic === "account" || topic.startsWith("candles:");

type DataEvent = Extract<ServerEvent, { seq: number; topic: Topic }>;
const isDataEvent = (ev: ServerEvent): ev is DataEvent => ev.t !== "hello" && ev.t !== "unsubscribed" && ev.t !== "pong" && ev.t !== "error" && ev.t !== "resync" && ev.t !== "subscribed";

/** 重订阅回来要等快照的 topic:candles 没有订阅快照(hub 不发历史,客户端走 REST),subscribed 即算恢复 */
const expectsSnapshot = (topic: Topic): boolean => !topic.startsWith("candles:");

/**
 * 这条(已按序号应用的)事件是不是它所在 topic 的订阅快照(§3.3 snapshot-on-subscribe 各自的形态):
 *   book → book.snapshot(hub 有缓存时紧跟 subscribed;没有时等发布器刷新,本 symbol 的下一条盘口消息以整份快照发来);
 *   trades → trades(整份快照,或 since 回放的第一条);
 *   ticker → 该 topic 的 ticker(最后值;hub 没有缓存时只回 subscribed,之后的第一条增量同样说明它恢复了流动);
 *   account → 不推进序号的 balance(快照开头,识别规则同 accountWatch)。
 * seqBefore = 应用这条之前该 topic 的 lastSeq(subscribed 设的基线)。
 */
function isSnapshotEvent(ev: DataEvent, seqBefore: number | undefined): boolean {
  switch (ev.t) {
    case "book.snapshot":
    case "trades":
    case "ticker":
      return true;
    case "balance":
      return seqBefore !== undefined && ev.seq === seqBefore;
    default:
      return false;
  }
}

/**
 * 缺口 / resync 重订阅的等待:"subscribed" = 已发出重订阅、等 subscribed;"snapshot" = subscribed 已到、等该 topic 的快照
 * (hub 被背压限流时只回 subscribed、快照欠着,那不算恢复)。timer 到期即上报失败。
 */
type PendingResync = { phase: "subscribed" | "snapshot"; timer: unknown };

const defaultTimers = (): WsTimers => ({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});

const defaultVisibility = (): Visibility => ({
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
  onChange: (listener) => {
    if (typeof document === "undefined") return () => {};
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
});

export function createWsClient(opts: WsClientOptions): MarketTransport {
  const timers = opts.timers ?? defaultTimers();
  const random = opts.random ?? Math.random;
  const visibility = opts.visibility ?? defaultVisibility();
  const WsCtor = opts.wsImpl ?? (typeof WebSocket === "function" ? WebSocket : undefined);
  const pingIntervalMs = opts.pingIntervalMs ?? WS_PING_INTERVAL_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? WS_CONNECT_TIMEOUT_MS;
  const resyncTimeoutMs = opts.resyncTimeoutMs ?? WS_RESYNC_TIMEOUT_MS;
  const hiddenGraceMs = opts.hiddenGraceMs ?? WS_HIDDEN_GRACE_MS;

  /** MarketProvider 维护的订阅集;连接断开也保留,hello 后全量重订阅 */
  const desired = new Set<Topic>();
  /** 每 topic 已应用的最大 seq;subscribed 重设,stop / hello / 1012 清空 */
  const lastSeq = new Map<Topic, number>();
  /** 已发出重订阅、还没恢复(subscribed + 快照)的 topic → 等到哪一步与超时定时器 */
  const pendingResync = new Map<Topic, PendingResync>();
  /**
   * account 快照的观察窗口。§3.3:subscribe account → subscribed{seq},随后快照 = balance → 逐条 order → 逐条 position → 逐条 trigger
   * (未完结的条件单,P3-03),全部带当前 seq(快照不推进序号)。hub 的顺序保证(server/ws-hub.mjs runAccountSnapshot):查询前记下该用户的 seq,返回时 seq 变了就重查,
   * 只有查询期间没有账户事件流出才发快照、带的是那时的 seq —— 所以快照不会比它前面任何一条账户增量旧,窗口里的增量也不会比快照新;
   * 连续几次都被穿插就不发快照,改发 resync 让客户端重订阅。
   * 快照事件由 hub 一次同步入队,落在同一个合帧里、彼此相邻。识别:
   *   - subscribed{account} 开窗(订阅集里有 account 才开;窗口已开着 —— 快照未到就又重订阅了 —— 则沿用,不丢已记的 id),
   *     窗口里只记快照到达前的增量里已终结(FILLED / CANCELLED)的挂单,收口时排除。有了上面的顺序保证这条不会改变结果
   *     (快照读在终结之后,本就不含它);留着只是兜底:终结不可逆,排除掉不会错删。
   *     窗口里的增量碰过、快照里却没有的挂单 / 持仓不保留:快照比它们新,快照里没有就是已经没了。跨 bundle 的发布器
   *     (instrumentation 与路由各一份)可能把同一持仓相邻两次提交的事件以相反顺序送上总线(先到 qty 0、后到更旧的 qty 5),
   *     若按「窗口碰过」保留,更旧的那行会一直留在 store 里,直到该用户该标的的下一条事件;
   *   - 窗口里第一条被应用且不推进序号(seq === 应用前的 lastSeq["account"])的 balance 即快照开头,关窗;
   *     同一帧里紧随其后、同 seq 的 order / position / trigger 属于快照,遇到任何别的事件或帧尾即结束
   *     (快照里的 trigger 都是未完结的行,它们的 id 进收口集合;推进序号的 trigger 是增量,seq 不同,把快照结束);
   *   - 帧在快照末尾切开交付(见 handleMessage 的 segments):快照之后同一帧里的增量比快照新、不进收口集合,
   *     它们在 account-snapshot 上报(MarketProvider 收口)之后才交给 onFrame,所以收口删不到它们;一帧里有两份快照时同理各切一刀。
   * 推进序号的 balance 是增量;被当旧事件丢掉的快照不认;hello / stop / 退订 account 关窗。
   * 持仓与余额没有「不可逆」的状态,客户端不做新旧判断,以后到的为准 —— 快照的权威性由 hub 的上述顺序保证提供,
   * 不要在这里用窗口里的增量去覆盖快照(那会把旧值盖在新值上)。
   */
  let accountWatch: AccountWatch | null = null;

  let socket: WebSocket | null = null;
  /** 每次 connect +1;旧 socket 的回调按 generation 丢弃 */
  let generation = 0;
  let started = false;
  let hello = false;
  /** 连续连不上的次数,hello 归零 */
  let attempt = 0;
  /** 1013 之后的退避下限,hello 归零 */
  let floorMs = 0;
  let reconnectTimer: unknown = null;
  let connectTimer: unknown = null;
  let pingTimer: unknown = null;
  let hiddenTimer: unknown = null;
  let stateTimer: unknown = null;
  let awaitingPong = false;
  let missedPongs = 0;
  let marketPaused = false;
  let unsubscribeVisibility: (() => void) | null = null;
  /** 自己发起的 close 的原因;handleClose 据此决定是否重连 */
  let closingFor: "stop" | "reconnect" | "timeout" | null = null;
  /** 当前连接 hello 里的身份 */
  let helloUserId: string | null = null;
  /** 当前连接已上报过身份不一致:不再订 account、不再重复上报(新连接的 hello 复位) */
  let identityMismatch = false;
  /** 上一次 hello 的 bootId(hub 进程的启动标识);没带过为 undefined */
  let lastBootId: string | undefined;
  let state: ConnectionState = { transport: "ws", state: "offline", lastMessageAt: null, rttMs: null };

  const clear = (id: unknown): void => {
    if (id !== null) timers.clearTimeout(id);
  };

  const emitState = (patch: Partial<ConnectionState>): void => {
    state = { ...state, ...patch };
    if (stateTimer !== null) {
      timers.clearTimeout(stateTimer);
      stateTimer = null;
    }
    opts.onState({ ...state });
  };

  /** lastMessageAt 每帧更新,对外每秒最多通知一次 */
  const touchLastMessage = (): void => {
    state = { ...state, lastMessageAt: timers.now() };
    if (stateTimer !== null) return;
    stateTimer = timers.setTimeout(() => {
      stateTimer = null;
      opts.onState({ ...state });
    }, 1_000);
  };

  const send = (op: ClientOp): void => {
    if (!socket || socket.readyState !== OPEN || !hello) return;
    socket.send(JSON.stringify(op));
  };

  const reportIdentity = (reason: "hello" | "unauthorized", userId: string | null): void => {
    if (identityMismatch) return;
    identityMismatch = true;
    accountWatch = null;
    opts.onEvent?.({ type: "identity-mismatch", userId, reason });
  };
  /**
   * 这条连接能不能订 account:已上报过不一致的不能;账户 store 的已知身份与 hello 的不同也不能(随即上报)。
   * 身份未知(undefined)或没接 expectedUserId 时不比对。
   */
  const accountAllowed = (): boolean => {
    if (identityMismatch) return false;
    const expected = opts.expectedUserId?.();
    if (expected === undefined || expected === helloUserId) return true;
    reportIdentity("hello", helloUserId);
    return false;
  };

  const clearPending = (topic: Topic): boolean => {
    const pending = pendingResync.get(topic);
    if (pending === undefined) return false;
    timers.clearTimeout(pending.timer);
    pendingResync.delete(topic);
    return true;
  };
  const clearAllPending = (): void => {
    for (const pending of pendingResync.values()) timers.clearTimeout(pending.timer);
    pendingResync.clear();
  };
  /** 进入(或换到)重订阅等待的某一步,resyncTimeoutMs 内没走完就上报失败 */
  const armPending = (topic: Topic, phase: PendingResync["phase"]): void => {
    clearPending(topic);
    pendingResync.set(topic, {
      phase,
      timer: timers.setTimeout(() => {
        pendingResync.delete(topic);
        opts.onEvent?.({ type: "resync", topic, ok: false });
      }, resyncTimeoutMs),
    });
  };
  /** 结束 topic 的重订阅等待并上报结果;不在等的 topic 什么都不做 */
  const settlePending = (topic: Topic, ok: boolean): void => {
    if (clearPending(topic)) opts.onEvent?.({ type: "resync", topic, ok });
  };
  /** 快照还没来,hub 又对这个 topic 发 resync / 出了缺口:上一次重订阅被扣住了(或又丢了事件),记一次失败,好让调用方再订一次 */
  const failIfAwaitingSnapshot = (topic: Topic): void => {
    if (pendingResync.get(topic)?.phase === "snapshot") settlePending(topic, false);
  };

  const marketTopics = (): Topic[] => [...desired].filter(isMarketTopic);
  const topicActive = (topic: Topic): boolean => !(marketPaused && isMarketTopic(topic));

  /**
   * 缺口 / resync 重订阅:trades 带 since(hub 回放缺失的成交),其它 topic unsubscribe + subscribe(hub 回快照)。
   * 同一 topic 在恢复(subscribed + 快照,见 PendingResync)之前只发一次;每一步超时都上报 resync 失败。
   */
  const resubscribe = (topic: Topic, since: number | undefined): void => {
    if (!desired.has(topic) || !topicActive(topic) || pendingResync.has(topic)) return;
    if (!socket || !hello) return;
    if (topic === "account" && !accountAllowed()) return;
    if (isTradesTopic(topic) && since !== undefined && since > 0) {
      send({ op: "subscribe", topics: [topic], since: { [topic]: since } });
    } else {
      send({ op: "unsubscribe", topics: [topic] });
      send({ op: "subscribe", topics: [topic] });
    }
    armPending(topic, "subscribed");
  };

  // ---- 心跳 ----
  const stopPing = (): void => {
    clear(pingTimer);
    pingTimer = null;
    awaitingPong = false;
    missedPongs = 0;
  };
  const pingTick = (): void => {
    pingTimer = null;
    if (!socket || !hello) return;
    if (awaitingPong) {
      missedPongs++;
      if (missedPongs >= WS_MAX_MISSED_PONGS) {
        abandonSocket();
        return;
      }
    }
    awaitingPong = true;
    send({ op: "ping", t0: timers.now() });
    pingTimer = timers.setTimeout(pingTick, pingIntervalMs);
  };
  const startPing = (): void => {
    stopPing();
    pingTimer = timers.setTimeout(pingTick, pingIntervalMs);
  };

  // ---- 可见性 ----
  const pauseMarket = (): void => {
    hiddenTimer = null;
    if (marketPaused) return;
    marketPaused = true;
    const topics = marketTopics();
    for (const topic of topics) {
      lastSeq.delete(topic);
      clearPending(topic);
    }
    if (topics.length) send({ op: "unsubscribe", topics });
  };
  const resumeMarket = (): void => {
    if (!marketPaused) return;
    marketPaused = false;
    const topics = marketTopics();
    if (topics.length) send({ op: "subscribe", topics });
  };
  const onVisibility = (): void => {
    if (visibility.hidden()) {
      if (hiddenTimer === null && !marketPaused) hiddenTimer = timers.setTimeout(pauseMarket, hiddenGraceMs);
    } else {
      clear(hiddenTimer);
      hiddenTimer = null;
      resumeMarket();
    }
  };

  // ---- 连接 ----
  const scheduleReconnect = (delay: number): void => {
    clear(reconnectTimer);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  /** hello 之前断开(含 upgrade 被拒、超时、无 WebSocket 实现):计一次失败并退避 */
  const connectFailed = (): void => {
    attempt++;
    emitState({ transport: "ws", state: "connecting" });
    opts.onEvent?.({ type: "connect-failed", attempt });
    if (!started) return; // onEvent 里可能已 stop()(transport 切轮询)
    scheduleReconnect(backoffDelay(attempt - 1, random, floorMs));
  };

  const onHello = (ev: Extract<ServerEvent, { t: "hello" }>): void => {
    hello = true;
    accountWatch = null;
    attempt = 0;
    floorMs = 0;
    clear(connectTimer);
    connectTimer = null;
    helloUserId = typeof ev.userId === "string" ? ev.userId : null;
    identityMismatch = false;
    // 服务端重启过(bootId 变了):seq 归零,旧基线全部作废 —— 带着 since 重订阅的话,hub 可能按 since 回 subscribed 而不回放,
    // 之后更小的 seq 全被当旧的丢掉(与 1012 的处理相同)。没带 bootId 的 hub(旧版)无从比较,照旧
    if (typeof ev.bootId === "string" && ev.bootId) {
      if (lastBootId !== undefined && lastBootId !== ev.bootId) lastSeq.clear();
      lastBootId = ev.bootId;
    }
    emitState({ transport: "ws", state: "open" });
    opts.onEvent?.({ type: "open" });
    if (!started) return;
    // 身份比对(不一致时 accountAllowed 顺带上报):不一致就不订 account。没想订 account 也比这一次 ——
    // store 是确认的 anon、hello 却是 B(别的标签页登录了),同样要让 store 重新 hydrate
    const accountOk = accountAllowed();
    // 全量重订阅:trades 带 since = 已收最大 seq;之后清空 seq 表,subscribed{seq} 重设基线
    const topics = [...desired].filter((topic) => topicActive(topic) && (topic !== "account" || accountOk));
    if (topics.length) {
      const since: Partial<Record<Topic, number>> = {};
      let hasSince = false;
      for (const topic of topics) {
        const last = lastSeq.get(topic);
        if (isTradesTopic(topic) && last !== undefined && last > 0) {
          since[topic] = last;
          hasSince = true;
        }
      }
      send(hasSince ? { op: "subscribe", topics, since } : { op: "subscribe", topics });
    }
    lastSeq.clear();
    startPing();
  };

  const onPong = (t0: number): void => {
    awaitingPong = false;
    missedPongs = 0;
    emitState({ rttMs: Math.max(0, timers.now() - t0) });
  };

  /** 序号裁决;gap 时返回重订阅要带的 since(trades 用) */
  const judge = (ev: DataEvent): "apply" | "drop" | { gap: number | undefined } => {
    if (ev.seq === 0) return "apply";
    const last = lastSeq.get(ev.topic);
    if (last === undefined || last === 0) {
      lastSeq.set(ev.topic, ev.seq);
      return "apply";
    }
    if (ev.seq === last || ev.seq === last + 1) {
      lastSeq.set(ev.topic, ev.seq);
      return "apply";
    }
    if (ev.seq < last) return "drop";
    return { gap: last };
  };

  const handleMessage = (raw: unknown): void => {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(frame)) return;
    touchLastMessage();
    const gaps = new Map<Topic, number | undefined>();
    // 帧在每份 account 快照(见 accountWatch)的末尾切段:段交给 onFrame,紧接着上报这份快照,再交下一段。
    // hub 把一个合帧窗口里的事件全放进一帧,快照后面可能还跟着更新的增量(新开的单、新持仓)乃至下一份快照;
    // MarketProvider 收口前会 flush batcher,整帧一起交出去的话,这些更新的事件会先落进 store、再被这次收口按旧快照删掉。
    const segments: { events: ServerEvent[]; snapshot: { orderIds: Set<string>; assetIds: Set<string>; triggerIds: Set<string> } | null }[] = [];
    let out: ServerEvent[] = [];
    let snapshot: SnapshotIds | null = null;
    const endSnapshot = (): void => {
      if (!snapshot) return;
      segments.push({ events: out, snapshot: { orderIds: snapshot.orderIds, assetIds: snapshot.assetIds, triggerIds: snapshot.triggerIds } });
      out = [];
      snapshot = null;
    };
    for (const ev of frame as ServerEvent[]) {
      if (!ev || typeof ev !== "object" || typeof ev.t !== "string") continue;
      // 快照只由同 seq 的 account order / position / trigger 延续,别的事件一律把它结束
      if (snapshot && !((ev.t === "order" || ev.t === "position" || ev.t === "trigger") && ev.topic === "account" && ev.seq === snapshot.seq)) endSnapshot();
      switch (ev.t) {
        case "hello":
          onHello(ev);
          out.push(ev);
          break;
        case "subscribed":
          lastSeq.set(ev.topic, ev.seq);
          if (pendingResync.get(ev.topic)?.phase === "subscribed") {
            // 重订阅的回执到了;有快照形态的 topic 还要等到快照才算恢复(hub 限流时只回 subscribed)
            if (expectsSnapshot(ev.topic)) armPending(ev.topic, "snapshot");
            else settlePending(ev.topic, true);
          }
          if (ev.topic === "account") accountWatch = desired.has("account") ? (accountWatch ?? newAccountWatch()) : null;
          out.push(ev);
          break;
        case "pong":
          onPong(ev.t0);
          out.push(ev);
          break;
        case "error":
          if (ev.topic) settlePending(ev.topic, false);
          // 连接是匿名的(会话过期、别的标签页登出了),本页却还当自己登录着:让账户 store 重新确认身份
          if (ev.code === "unauthorized" && ev.topic === "account") reportIdentity("unauthorized", null);
          out.push(ev);
          break;
        case "resync":
          failIfAwaitingSnapshot(ev.topic);
          if (!gaps.has(ev.topic)) gaps.set(ev.topic, lastSeq.get(ev.topic));
          out.push(ev);
          break;
        case "unsubscribed":
          out.push(ev);
          break;
        default: {
          if (!isDataEvent(ev)) break;
          const before = lastSeq.get(ev.topic);
          const verdict = judge(ev);
          if (verdict === "drop") break;
          if (verdict !== "apply") {
            // 缺口:一律重订阅(pending 时不重复发;已在等快照的先记一次失败);book / ticker / trades 本条与其后到 subscribed 之前的事件不应用,
            // 等回放 / 快照;account / candles 照常应用并推进基线(见 appliesAcrossGap)
            failIfAwaitingSnapshot(ev.topic);
            if (!gaps.has(ev.topic)) gaps.set(ev.topic, verdict.gap);
            if (!appliesAcrossGap(ev.topic)) break;
            lastSeq.set(ev.topic, ev.seq);
          } else if (pendingResync.get(ev.topic)?.phase === "snapshot" && isSnapshotEvent(ev, before)) {
            settlePending(ev.topic, true); // 重订阅的快照到了:恢复
          }
          out.push(ev);
          if (ev.topic !== "account") break;
          if (snapshot) {
            // 快照的延续(不属于它的事件在循环开头已把它结束);窗口里已终结的单不算(终结不可逆,兜底,见 accountWatch)
            if (ev.t === "order") {
              if (!snapshot.closedOrderIds.has(ev.order.id)) snapshot.orderIds.add(ev.order.id);
            } else if (ev.t === "position") snapshot.assetIds.add(ev.position.assetId);
            else if (ev.t === "trigger") snapshot.triggerIds.add(ev.trigger.id);
            break;
          }
          if (!accountWatch) break;
          if (ev.t === "balance" && verdict === "apply" && before !== undefined && ev.seq === before) {
            // 收口集合只从快照自己的行开始:窗口里的增量比快照旧,碰过的 id 不保留(见 accountWatch)
            snapshot = { orderIds: new Set(), assetIds: new Set(), triggerIds: new Set(), closedOrderIds: accountWatch.closedOrderIds, seq: ev.seq };
            accountWatch = null;
            break;
          }
          // 快照之前的增量:只记下已终结的挂单(终结不可逆,收口时排除,见 accountWatch)
          if (ev.t === "order" && !isOpenOrder(ev.order)) {
            accountWatch.closedOrderIds.add(ev.order.id);
            if (accountWatch.closedOrderIds.size > ACCOUNT_SNAPSHOT_WATCH_MAX) accountWatch = null;
          }
        }
      }
      if (!started) return;
    }
    endSnapshot();
    segments.push({ events: out, snapshot: null });
    for (const segment of segments) {
      if (segment.events.length) opts.onFrame(segment.events);
      if (!segment.snapshot) continue;
      opts.onEvent?.({ type: "account-snapshot", orderIds: segment.snapshot.orderIds, assetIds: segment.snapshot.assetIds, triggerIds: segment.snapshot.triggerIds });
      if (!started) return; // 回调里停掉了:本帧余下的段作废(同循环里的处理)
    }
    for (const [topic, since] of gaps) resubscribe(topic, since);
  };

  const handleClose = (code: number, reason: string): void => {
    const wasHello = hello;
    const why = closingFor;
    closingFor = null;
    socket = null;
    hello = false;
    accountWatch = null;
    clear(connectTimer);
    connectTimer = null;
    stopPing();
    clearAllPending();
    if (!started || why === "stop") return;
    if (why === "reconnect") {
      connect();
      return;
    }
    if (!wasHello) {
      connectFailed();
      return;
    }
    switch (code) {
      case 1008:
      case 1009:
        emitState({ transport: "ws", state: "offline", rttMs: null });
        opts.onEvent?.({ type: "policy", code, reason });
        return;
      case 1012:
        // 服务重启:seq 表归零,1012 本身即全量重订阅信号(§3.3)。清掉基线,重连的 hello 不带 since —— 否则 since 大于
        // 重启后的当前 seq,hub 若按 since 回 subscribed 而不回放,之后更小的 seq 全被当旧的丢掉
        lastSeq.clear();
        emitState({ transport: "ws", state: "connecting", rttMs: null });
        scheduleReconnect(WS_RESTART_WAIT_MS[0] + Math.round(random() * (WS_RESTART_WAIT_MS[1] - WS_RESTART_WAIT_MS[0])));
        return;
      case 1013:
        floorMs = WS_OVERLOAD_MIN_MS;
        emitState({ transport: "ws", state: "connecting", rttMs: null });
        scheduleReconnect(backoffDelay(attempt, random, floorMs));
        return;
      default:
        emitState({ transport: "ws", state: "connecting", rttMs: null });
        scheduleReconnect(backoffDelay(attempt, random, floorMs));
    }
  };

  /**
   * 看门狗:连续 WS_MAX_MISSED_PONGS 次无 pong。半开的连接上浏览器的 close 事件可能要等关闭握手超时(Chromium 约 60 s),
   * 不能等它:先让旧 socket 的回调失效(generation +1、摘掉 onmessage / onclose),再按一次普通断线处理(报 connecting、按退避重连),
   * 最后对旧 socket 发 close() —— 它什么时候真正关掉都无所谓了。
   */
  const abandonSocket = (): void => {
    const ws = socket;
    if (!ws) return;
    generation++;
    ws.onmessage = null;
    ws.onclose = null;
    handleClose(WS_WATCHDOG_CLOSE_CODE, "watchdog");
    try {
      ws.close();
    } catch {
      /* 已经在关 */
    }
  };

  const connect = (): void => {
    if (!started || socket) return;
    clear(reconnectTimer);
    reconnectTimer = null;
    const gen = ++generation;
    if (!WsCtor) {
      connectFailed();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WsCtor(opts.url);
    } catch {
      connectFailed();
      return;
    }
    socket = ws;
    hello = false;
    closingFor = null;
    emitState({ transport: "ws", state: "connecting" });
    connectTimer = timers.setTimeout(() => {
      connectTimer = null;
      if (gen !== generation || hello) return;
      closingFor = "timeout";
      ws.close();
    }, connectTimeoutMs);
    ws.onopen = null; // hello 才算连上
    ws.onerror = null; // close 随后到
    ws.onmessage = (ev) => {
      if (gen === generation) handleMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (gen === generation) handleClose(ev.code, ev.reason);
    };
  };

  const closeSocket = (why: "stop" | "reconnect"): void => {
    if (!socket) return;
    const ws = socket;
    closingFor = why;
    if (why === "stop") {
      // 旧 socket 的 onclose 不再关心
      generation++;
      socket = null;
      hello = false;
    }
    ws.onmessage = null;
    ws.close(1000, why);
  };

  const client: MarketTransport = {
    kind: "ws",
    start() {
      if (started) return;
      started = true;
      unsubscribeVisibility = visibility.onChange(onVisibility);
      onVisibility();
      connect();
    },
    stop() {
      if (!started) return;
      started = false;
      unsubscribeVisibility?.();
      unsubscribeVisibility = null;
      clear(reconnectTimer);
      clear(connectTimer);
      clear(hiddenTimer);
      clear(stateTimer);
      reconnectTimer = connectTimer = hiddenTimer = stateTimer = null;
      stopPing();
      clearAllPending();
      lastSeq.clear();
      accountWatch = null;
      marketPaused = false;
      attempt = 0;
      floorMs = 0;
      closeSocket("stop");
      emitState({ transport: "none", state: "offline", rttMs: null });
    },
    subscribe(topic) {
      if (desired.has(topic)) return;
      desired.add(topic);
      if (!topicActive(topic)) return;
      // 还没 hello 时只记下(hello 时再比对身份);已连上的话订 account 前先比对。
      // 连接正在被替换(reconnect 已关旧 socket、close 事件还没到)时同样只记下:旧连接的身份已经过时 —— 典型是终端里登录后
      // becomeReady 请求重连,紧接着 meId effect 订 account,拿新身份比旧连接的匿名 hello 会报一次假的不一致(P1-25c 复审)。
      // 新连接的 hello 会按当时的身份重新比对、全量重订阅。
      if (topic === "account" && socket && hello && closingFor !== "reconnect" && !accountAllowed()) return;
      send({ op: "subscribe", topics: [topic] });
    },
    unsubscribe(topic) {
      if (!desired.delete(topic)) return;
      lastSeq.delete(topic);
      clearPending(topic);
      if (topic === "account") accountWatch = null;
      // 身份不一致的连接上 account 本来就没订上(没发,或被 hub 拒了):不发退订
      if (topic === "account" && identityMismatch) return;
      if (topicActive(topic)) send({ op: "unsubscribe", topics: [topic] });
    },
    reconnect() {
      if (!started) {
        client.start();
        return;
      }
      attempt = 0;
      floorMs = 0;
      if (socket) closeSocket("reconnect");
      else connect();
    },
  };
  return client;
}
