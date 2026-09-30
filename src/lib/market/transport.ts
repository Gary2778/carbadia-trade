// 传输管理器(计划 §3.2 降级路径、§3.6):在 ws-client 之上决定「现在是 WS 还是轮询」。
//   - mode "ws":连续 3 次连不上、2 次 resync 失败或收到 1008 policy → 停掉 ws-client、kind 切 "poll",
//     connection 报 { transport: "poll", state: "degraded" };此后每 30 s 后台试一次 WS(一次失败即停,等下一轮),
//     hello 成功即切回 "ws"。探测期间 ws-client 的 connecting / offline 中间态不外露,免得徽章闪烁;
//   - mode "poll"(NEXT_PUBLIC_MARKET_TRANSPORT=poll):从不创建 WebSocket,也不探测;
//   - start("poll")(运行期提示:服务端没有 /ws(transportModeForServer:START_MODE=next、本进程没有 hub、或 WS_DISABLED=1),由 /trade/[symbol] 的 server component 读出、经 TerminalShell
//     传到 MarketProvider):这一次 start 与强制轮询一样 —— 首帧就报 poll/degraded,不建 socket、不探测、reconnect 也不试;
//     stop 之后下一次 start 重新按提示 / 构建期模式来。next start 对 /ws 的 upgrade 既不升级也不关闭,不提示的话
//     客户端要等 3 次连接超时才降级(P1-23 发现 1:10 s 超时时实测 31–35 s;现为 8 s,最坏约 28 s);
//   - 订阅集在两种模式下都转交 ws-client 保存(轮询期间照记),切回 WS 时 hello 全量重订阅;
//   - ws-client 的事件全部透传给 onEvent;identity-mismatch(连接身份与账户 store 不一致)只透传,不算连接或 resync 失败;
//   - 轮询本身不在这里:MarketProvider 的三个 usePolling 在 connection.transport === "poll" 时打 REST,
//     经 poll-frames.ts 翻成 ServerFrame 喂同一 batcher。
// 管理器与 store 一样是模块级单例(由 MarketProvider 持有),永不随路由重建。
import type { ConnectionState, ServerFrame, Topic } from "@/shared";
import { createWsClient, type MarketTransport, type WsClientEvent, type WsClientOptions } from "./ws-client";

export type { MarketTransport, WsClientEvent } from "./ws-client";

export type TransportMode = "ws" | "poll";

/**
 * 传输管理器:MarketTransport 之外,start 可以带一个运行期模式(见 start 的说明)。
 * 不带参数的 start() 与 MarketTransport 相同,测试里的假 transport 照样可以当它用。
 */
export type TransportManager = Omit<MarketTransport, "start"> & {
  /** mode "poll" = 服务端没有 /ws(transportModeForServer:START_MODE=next、本进程没有 hub、或 WS_DISABLED=1):这一次 start 只轮询;缺省或 "ws" = 按构建期模式 */
  start(mode?: TransportMode): void;
};

export type TransportManagerOptions = {
  mode: TransportMode;
  wsUrl: string;
  onState: (state: ConnectionState) => void;
  /** 计划签名里没有它,但帧必须有去处:MarketProvider 传 batcher.push */
  onFrame: (frame: ServerFrame) => void;
  /** 透传 ws-client 的生命周期事件(PerfHud / 测试) */
  onEvent?: (event: WsClientEvent) => void;
  /** 默认 30 s */
  probeIntervalMs?: number;
  /** 默认 3 */
  connectFailuresToPoll?: number;
  /** 默认 2 */
  resyncFailuresToPoll?: number;
  /** ws-client 的可注入依赖(假 socket / 定时器 / 随机数 / 可见性)与超时 */
  ws?: Omit<WsClientOptions, "url" | "onFrame" | "onState" | "onEvent">;
};

export const WS_PROBE_INTERVAL_MS = 30_000;
export const WS_CONNECT_FAILURES_TO_POLL = 3;
export const WS_RESYNC_FAILURES_TO_POLL = 2;

/** 构建期变量 NEXT_PUBLIC_MARKET_TRANSPORT:只认 "poll",其余(含未设)都是 ws */
export function transportModeFromEnv(value: string | undefined): TransportMode {
  return value === "poll" ? "poll" : "ws";
}

/**
 * 服务端运行期变量 START_MODE → 这一页的传输提示:只有 "next"(docker-entrypoint.sh 的回滚分支:exec next start,没有 hub)是 "poll";
 * 缺省、"custom" 与其它值 → undefined(按构建期模式,行为不变)。判断与 entrypoint 的 [ "$START_MODE" = "next" ] 一致,区分大小写。
 */
export function transportModeForStartMode(startMode: string | undefined): TransportMode | undefined {
  return startMode === "next" ? "poll" : undefined;
}

/**
 * 终端页(page.tsx)给这一页的服务端传输提示:"poll" = 这台服务端接不了 /ws,终端首帧就轮询、不试 /ws
 *(否则要等 3 次连接超时 ≈ 31–35 s 才降级,P1-23 发现 1):
 *   - START_MODE=next(回滚,见 transportModeForStartMode);
 *   - 本进程没有 hub(hub = null:globalThis.__carbadiaWsStats 缺失,即 server.mjs 没跑 —— npm run start:plain / dev:plain 直跑 next,
 *     与 /api/health 推断 startMode 用的是同一个信号)或 hub 关着(WS_DISABLED=1,enabled: false)。
 *     NEXT_PUBLIC_WS_URL 把 /ws 指到别处时,本进程有没有 hub 说明不了什么,这一条不看,只看 START_MODE。
 * 其余 → undefined(按构建期模式,行为不变)。hub 统计在 server.mjs listen 之前就建好了(attachWsHub),请求到达时一定已经在。
 */
export function transportModeForServer(input: { startMode: string | undefined; hub: { enabled: boolean } | null; wsUrlOverride: string | undefined }): TransportMode | undefined {
  if (transportModeForStartMode(input.startMode)) return "poll";
  if (input.wsUrlOverride?.trim()) return undefined;
  return input.hub?.enabled ? undefined : "poll";
}

/** NEXT_PUBLIC_WS_URL 覆盖;默认同源 /ws,https → wss */
export function resolveWsUrl(override: string | undefined, location: { protocol: string; host: string }): string {
  if (override && override.trim()) return override.trim();
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

const pollState = (): ConnectionState => ({ transport: "poll", state: "degraded", lastMessageAt: null, rttMs: null });
const offlineState = (): ConnectionState => ({ transport: "none", state: "offline", lastMessageAt: null, rttMs: null });

export function createTransportManager(opts: TransportManagerOptions): TransportManager {
  const probeIntervalMs = opts.probeIntervalMs ?? WS_PROBE_INTERVAL_MS;
  const connectFailuresToPoll = opts.connectFailuresToPoll ?? WS_CONNECT_FAILURES_TO_POLL;
  const resyncFailuresToPoll = opts.resyncFailuresToPoll ?? WS_RESYNC_FAILURES_TO_POLL;
  const timers = opts.ws?.timers ?? {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };

  let kind: TransportMode = opts.mode;
  let started = false;
  /** 这一次 start 带了 "poll" 提示(服务端没有 /ws):不探测、reconnect 不试;stop 复位 */
  let pollOnly = false;
  let probing = false;
  let probeTimer: unknown = null;
  let connectFailures = 0;
  let resyncFailures = 0;

  const clearProbe = (): void => {
    if (probeTimer !== null) timers.clearTimeout(probeTimer);
    probeTimer = null;
  };

  const handleState = (state: ConnectionState): void => {
    if (kind === "ws") {
      opts.onState(state);
      return;
    }
    // 轮询中:后台探测的中间态不外露;hello(open)才切回 WS
    if (state.state === "open") {
      kind = "ws";
      probing = false;
      clearProbe();
      connectFailures = 0;
      resyncFailures = 0;
      opts.onState(state);
    }
  };

  const scheduleProbe = (): void => {
    clearProbe();
    probeTimer = timers.setTimeout(probe, probeIntervalMs);
  };

  const switchToPoll = (): void => {
    if (kind === "poll") return;
    kind = "poll";
    probing = false;
    connectFailures = 0;
    resyncFailures = 0;
    client?.stop();
    opts.onState(pollState());
    scheduleProbe();
  };

  const probeFailed = (): void => {
    if (!probing) return;
    probing = false;
    client?.stop();
    if (started) scheduleProbe();
  };

  const handleEvent = (event: WsClientEvent): void => {
    opts.onEvent?.(event);
    switch (event.type) {
      case "open":
        connectFailures = 0;
        resyncFailures = 0;
        break;
      case "connect-failed":
        if (kind === "poll") {
          probeFailed();
          break;
        }
        connectFailures++;
        if (connectFailures >= connectFailuresToPoll) switchToPoll();
        break;
      case "policy":
        if (kind === "poll") probeFailed();
        else switchToPoll();
        break;
      case "resync":
        if (event.ok) {
          resyncFailures = 0;
          break;
        }
        resyncFailures++;
        if (kind === "ws" && resyncFailures >= resyncFailuresToPoll) switchToPoll();
        break;
    }
  };

  // 强制轮询模式从不建 socket;否则 ws-client 常驻(降级期间只是 stop 掉)
  const client: MarketTransport | null =
    opts.mode === "ws" ? createWsClient({ ...opts.ws, url: opts.wsUrl, onFrame: opts.onFrame, onState: handleState, onEvent: handleEvent }) : null;

  function probe(): void {
    probeTimer = null;
    if (!started || pollOnly || kind !== "poll" || !client || probing) return;
    probing = true;
    client.start();
  }

  return {
    get kind() {
      return kind;
    },
    start(mode?: TransportMode) {
      if (started) return;
      started = true;
      // 强制轮询(没有 ws-client)或服务端提示没有 /ws:只报 poll/degraded,不探测。有 ws-client 且没有提示时 kind 此刻必是构建期的 "ws"
      // (降级只发生在 started 期间,stop 会把 kind 复位),所以没有「带着降级状态 start」的路径。
      if (!client || mode === "poll") {
        pollOnly = true;
        kind = "poll";
        opts.onState(pollState());
        return;
      }
      client.start();
    },
    stop() {
      if (!started) return;
      started = false;
      pollOnly = false;
      probing = false;
      clearProbe();
      client?.stop();
      // 下次 start 重新按构建期模式来(离开终端再回来,条件可能已变)
      kind = opts.mode;
      connectFailures = 0;
      resyncFailures = 0;
      opts.onState(offlineState());
    },
    subscribe(topic: Topic) {
      client?.subscribe(topic);
    },
    unsubscribe(topic: Topic) {
      client?.unsubscribe(topic);
    },
    reconnect() {
      if (!started || !client || pollOnly) return;
      connectFailures = 0;
      resyncFailures = 0;
      if (kind === "ws") {
        client.reconnect();
        return;
      }
      // 轮询中(如登录后):立刻探测一次,不等 30 s
      clearProbe();
      if (probing) client.reconnect();
      else probe();
    },
  };
}
