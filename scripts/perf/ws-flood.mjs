#!/usr/bin/env node
// @ts-check
// /ws 压测(计划 §7.1「服务端」、§7.5;P1-23 集成与运维验证)。
//
//   node scripts/perf/ws-flood.mjs --url ws://localhost:3940/ws --clients 300 --seconds 60 \
//     --topics 'book:VCS-FOR-2021,trades:VCS-FOR-2021,ticker:*' [--pid <服务端 PID>] [--server-log <服务端日志文件>] \
//     [--ramp-ms 1000] [--http <HTTP 基址>] [--max-rejected 0] [--allow-no-ws]
//   也接受计划 §7.5 的位置参数:node scripts/perf/ws-flood.mjs <wsUrl> [clients=300] [seconds=60]
//
// 默认 topic 是 §7.5 的五个:book:VCS-FOR-2021、trades:VCS-FOR-2021、trades:CCER-SOL-2023、trades:GS-WIND-2022、ticker:*。
// topic 先过 server/ws-schema.mjs 的 topicSchema(与 hub 同一份):协议只有 ticker:* 一个通配,trades:* 不存在;
// account 要登录 cookie,本脚本是匿名客户端,不接受。
//
// 客户端用 `ws` 包(已是运行时依赖)而不是 Node 全局 WebSocket:被拒的 upgrade(503 + Retry-After / 403)只有它能拿到
// HTTP 状态码与响应头;它也不带 Origin 头,hub 对无 Origin 的脚本客户端放行(计划 §3.3)。
// 本地没有 PROXY_SECRET 时 hub 把所有连接记在 "local" 桶,不受 WS_MAX_PER_IP 限,只受 WS_MAX_CONNECTIONS(默认 500)约束。
//
// (--topics 的值要加引号:zsh 下未加引号的 `*` 会报 no matches found。)
//
// 每个客户端按 src/lib/market/ws-client.ts 的规则收发:连上即订阅;按 expected = last + 1 裁决 seq(相等或 +1 应用、更小丢弃、
// 更大即缺口);缺口与 resync 都重订阅(trades 带 since = last,其它 unsubscribe + subscribe),同一 topic 恢复之前只发一次;
// 重订阅的成败按计划 §9.2 D22(3) 判定:5 s 内要收到 subscribed,之后 5 s 内要收到该 topic 的快照(book.snapshot / trades /
// ticker;candles 只要 subscribed),超时、该 topic 的 error、或快照之前又来 resync / 缺口都算一次失败(ws-client 两次失败就
// 降级轮询,所以门禁要求失败 = 0);ws 层 ping 由 `ws` 自动回 pong。与 ws-client 的差别:不做 account(匿名客户端)、
// 不做 hidden 退订与重连,缺口时本条事件照样计入帧数。
//
// 输出(一行一项,最后一行是 JSON 汇总):connected、rejected(按状态码)、framesPerSec、p50 / p99 帧间隔、resync 次数与占订阅数比例、
// seq 缺口、error 事件、closeCodes 分布(运行中被服务端关掉的单列)、/api/health 的 ws 统计前后差;
// 另每 5 s 取一次每个 book topic 的 /api/market/<SYM>/book,记 bestBid ≥ bestAsk 的次数(自成交防护,§9.1 第 41 条,应为 0);
// --pid 给了就用 ps 采服务端 RSS(前 / 峰值 / 后);--server-log 给了就从日志里读 {"src":"bot","ev":"stats"} 的 tickMs,
// 比较压测开始前最后三行的均值与压测期间写入各行的均值(bot 每 60 s 一行,窗口与压测不对齐;要让「期间」的行完整落在压测里,
// 在一行 bot stats 刚写出时开压,或把 --seconds 拉到 130 以上)。
// 门禁一律「取不到数据即失败」(go/no-go 不能在什么都没测到时报 GO):
// - /api/health 的 ws 为 null(START_MODE=next)或 enabled:false(WS_DISABLED=1)时 /ws 不会应答,直接 exit 2;
//   确实要对着这种服务跑(看它怎么挂起)加 --allow-no-ws,此时下面的连接检查照常判 FAIL。
// - 连接:connected ≥ 1 且 = clients − 升级被拒数(没连上、仍挂着的都算失败)、connect errors = 0、每个连上的都收到 hello。
// - 被拒:按计划 §7.5「被拒(503/1013)」计 = 升级被拒(HTTP 状态码)+ 运行中被服务端以 1013(过载)/ 1008(策略)关闭,
//   ≤ --max-rejected(默认 0);运行中被服务端以其它码关闭(1006、1011、1012…)另计,必须为 0。
// - resync:(resync 事件 + seq 缺口)/ 订阅数 < 1%;重订阅失败(D22(3))= 0;服务端 error 事件 = 0;抽检帧的 schema 违例 = 0;
//   盘口交叉 = 0 且至少取到一次、没有取失败;压测后 /api/health 仍应答。
// - 给了 --pid 而 RSS 采不到、给了 --server-log 而压测前或压测期间没有 bot stats 行,都判 FAIL 而不是 SKIP。
// framesPerSec / kbPerSec 只数保持期(连满之后到开始关闭之前)收到的帧与 UTF-8 字节,除以保持期时长。
// 任一检查不满足 exit 1,脚本自身出错(含 ws 不可用)exit 2。
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { WS_MAX_TOPICS, serverFrameSchema, topicSchema } from "../../server/ws-schema.mjs";

const DEFAULT_URL = "ws://localhost:3000/ws";
const DEFAULT_TOPICS = ["book:VCS-FOR-2021", "trades:VCS-FOR-2021", "trades:CCER-SOL-2023", "trades:GS-WIND-2022", "ticker:*"];
const BOOK_CHECK_MS = 5_000;
const HEALTH_MID_MS = 10_000; // 连满后多久读一次 /api/health(connections 应等于 clients)
const RSS_SAMPLE_MS = 2_000;
const CLOSE_WAIT_MS = 3_000;
const HTTP_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** 连接全部发起后最多等多久握手结束:比握手超时多 2 s,让最后发起的那个也能超时落定 */
const HANDSHAKE_WAIT_MS = HANDSHAKE_TIMEOUT_MS + 2_000;
/** 按计划 §7.5 计入「被拒」的关闭码:1013 过载(背压)、1008 策略(限速 / 坏帧) */
const REJECT_CLOSE_CODES = new Set(["1013", "1008"]);
/** 每个客户端前几帧全量过 serverFrameSchema,之后每 SCHEMA_SAMPLE_EVERY 帧抽一帧 */
const SCHEMA_FIRST_FRAMES = 3;
const SCHEMA_SAMPLE_EVERY = 50;
const LIMITS = { resyncPct: 1, rssDeltaMb: 100, botTickIncreasePct: 20 };
const BOT_BASELINE_LINES = 3;
/** 重订阅每一步(等 subscribed、等快照)的上限,同 ws-client 的 WS_RESYNC_TIMEOUT_MS */
const RESYNC_TIMEOUT_MS = 5_000;
/** 扫描重订阅超时的间隔 */
const RESYNC_SWEEP_MS = 250;

const execFileAsync = promisify(execFile);

/**
 * @typedef {{ url: string; clients: number; seconds: number; topics: string[]; rampMs: number; pid: number | null;
 *   serverLog: string | null; http: string | null; maxRejected: number; allowNoWs: boolean }} Options
 */

/** 不带值的开关 */
const FLAGS = new Set(["allow-no-ws"]);

/** @param {string} msg */
function die(msg) {
  console.error(`[ws-flood] ${msg}`);
  process.exit(2);
}

/**
 * @param {string} name
 * @param {string | undefined} raw
 * @param {number} min
 */
function intArg(name, raw, min) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) die(`--${name} must be an integer >= ${min}, got ${raw}`);
  return n;
}

/**
 * @param {string[]} argv
 * @returns {Options}
 */
function parseArgs(argv) {
  /** @type {Options} */
  const o = { url: DEFAULT_URL, clients: 300, seconds: 60, topics: DEFAULT_TOPICS, rampMs: 1_000, pid: null, serverLog: null, http: null, maxRejected: 0, allowNoWs: false };
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (FLAGS.has(key)) {
      if (eq !== -1) die(`--${key} takes no value`);
      if (key === "allow-no-ws") o.allowNoWs = true;
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) die(`--${key} needs a value`);
    switch (key) {
      case "url":
        o.url = value;
        break;
      case "clients":
        o.clients = intArg(key, value, 1);
        break;
      case "seconds":
        o.seconds = intArg(key, value, 1);
        break;
      case "topics":
        o.topics = value.split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "ramp-ms":
        o.rampMs = intArg(key, value, 0);
        break;
      case "pid":
        o.pid = intArg(key, value, 1);
        break;
      case "server-log":
        o.serverLog = value;
        break;
      case "http":
        o.http = value.replace(/\/+$/, "");
        break;
      case "max-rejected":
        o.maxRejected = intArg(key, value, 0);
        break;
      default:
        die(`unknown option --${key}`);
    }
  }
  if (positional[0] !== undefined) o.url = positional[0];
  if (positional[1] !== undefined) o.clients = intArg("clients", positional[1], 1);
  if (positional[2] !== undefined) o.seconds = intArg("seconds", positional[2], 1);
  if (o.topics.length === 0) die("--topics is empty");
  if (o.topics.length > WS_MAX_TOPICS) die(`at most ${WS_MAX_TOPICS} topics per connection`);
  for (const t of o.topics) {
    if (t === "account") die("topic account needs a signed-in cookie; ws-flood connects anonymously");
    if (!topicSchema.safeParse(t).success) {
      die(`topic ${t} is not in the protocol (book:<SYM>, trades:<SYM>, ticker:<SYM>, ticker:*, candles:<SYM>:<interval>; there is no trades:*)`);
    }
  }
  if (!/^wss?:\/\//.test(o.url)) die(`--url must start with ws:// or wss://, got ${o.url}`);
  return o;
}

/** @param {string} wsUrl */
function httpBaseOf(wsUrl) {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  return `${u.protocol}//${u.host}`;
}

/**
 * @param {number[]} sorted 升序
 * @param {number} q 0..1
 */
function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @returns {Promise<any>} 信封里的 data;失败返回 null
 */
async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok === true ? body.data : null;
  } catch {
    return null;
  }
}

/**
 * 服务端 RSS(MB),ps 取不到(进程不在、非 Unix)返回 null
 * @param {number} pid
 */
async function rssMb(pid) {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}

/** @param {string} path */
async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * 日志里的 {"src":"bot","ev":"stats",...} 行,按压测开始时的文件偏移分成「之前」与「期间」
 * @param {string} path
 * @param {number} offset
 */
async function botStats(path, offset) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  /** @param {string} text */
  const parse = (text) =>
    text
      .split("\n")
      .filter((line) => line.startsWith('{"src":"bot","ev":"stats"'))
      .map((line) => {
        try {
          return /** @type {{ tickMs: number; ticks: number; p99Ms: number; assets: number }} */ (JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((x) => x !== null);
  return { before: parse(buf.subarray(0, offset).toString("utf8")), during: parse(buf.subarray(offset).toString("utf8")) };
}

/** 每个 WsStats 计数字段的差(after − before) */
const STAT_KEYS = /** @type {const} */ (["framesOut", "bytesOut", "droppedDeltas", "resyncs", "rejected", "closedByBackpressure", "snapshotRaces"]);

/**
 * @param {Record<string, number> | null} a
 * @param {Record<string, number> | null} b
 */
function statsDelta(a, b) {
  if (!a || !b) return null;
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of STAT_KEYS) if (typeof a[k] === "number" && typeof b[k] === "number") out[k] = b[k] - a[k];
  return out;
}

/**
 * @typedef {{ t?: string; topic?: string; seq?: number; code?: string; reason?: string }} Ev
 * @typedef {{
 *   ws: WebSocket; openedAt: number | null; hello: boolean; frames: number; lastFrameAt: number | null;
 *   lastSeq: Map<string, number>; closed: boolean; rejected: boolean; closedEarly: boolean;
 *   pendingResync: Map<string, { phase: "subscribed" | "snapshot"; deadline: number }>;
 * }} Client
 */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const httpBase = o.http ?? httpBaseOf(o.url);
  const bookSymbols = o.topics.filter((t) => t.startsWith("book:")).map((t) => t.slice("book:".length));
  console.log(`[ws-flood] ${o.url} · clients ${o.clients} · ${o.seconds}s · topics ${o.topics.join(",")} · ramp ${o.rampMs} ms`);

  // ---- 基线 ----
  const healthBefore = await getJson(`${httpBase}/api/health`);
  if (!healthBefore) die(`GET ${httpBase}/api/health failed; is the server up?`);
  const wsAvailable = Boolean(healthBefore.ws) && healthBefore.ws.enabled !== false;
  if (!wsAvailable) {
    const why = healthBefore.ws ? "ws.enabled is false (WS_DISABLED=1)" : `ws is null (startMode ${healthBefore.startMode})`;
    if (!o.allowNoWs) die(`/api/health says ${why}: /ws will not answer, nothing to measure (pass --allow-no-ws to run anyway)`);
    console.log(`[ws-flood] warning: /api/health says ${why}; running anyway (--allow-no-ws), the connection checks will fail`);
  }
  const logOffset = o.serverLog ? await fileSize(o.serverLog) : 0;
  const rssBefore = o.pid ? await rssMb(o.pid) : null;
  let rssPeak = rssBefore;
  console.log(
    `[ws-flood] before: startMode ${healthBefore.startMode} · bot ${healthBefore.bot} · ws.connections ${healthBefore.ws?.connections ?? "-"}` +
      (rssBefore !== null ? ` · rss ${rssBefore} MB` : ""),
  );

  // ---- 计数 ----
  /** @type {number[]} */
  const intervals = []; // 同一连接相邻两帧的间隔(ms)
  /** @type {number[]} */
  const openMs = []; // 发起到 open
  /** @type {Map<string, number>} */
  const rejectedBy = new Map(); // "503 retry-after=30" → n
  /** @type {Map<string, number>} */
  const closeCodes = new Map();
  /** @type {Map<string, number>} */
  const closeCodesEarly = new Map();
  /** @type {Map<string, number>} */
  const errorsByCode = new Map();
  /** @type {Map<string, number>} */
  const eventsByType = new Map();
  /** holdFrames / holdBytes 只在保持期内累计(measuring 为真时),给 framesPerSec / kbPerSec 用 */
  const counts = {
    resyncs: 0, gaps: 0, resyncOk: 0, resyncFailed: 0, connectErrors: 0, schemaChecked: 0, schemaViolations: 0, holdFrames: 0, holdBytes: 0,
  };
  /** @param {Map<string, number>} m @param {string} k */
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  /** @type {Client[]} */
  const clients = [];
  let stopping = false;
  /** 保持期:连满之后到开始关闭之前;帧率、字节率、帧间隔只统计这段 */
  let measuring = false;

  /**
   * trades 带 since 重订阅(hub 回放缺的成交),其它 unsubscribe + subscribe(hub 回快照)
   * @param {Client} c @param {string} topic
   */
  const resubscribe = (c, topic) => {
    if (c.ws.readyState !== WebSocket.OPEN || c.pendingResync.has(topic)) return;
    c.pendingResync.set(topic, { phase: "subscribed", deadline: Date.now() + RESYNC_TIMEOUT_MS });
    const last = c.lastSeq.get(topic);
    c.lastSeq.delete(topic);
    if (topic.startsWith("trades:") && last !== undefined && last > 0) {
      c.ws.send(JSON.stringify({ op: "subscribe", topics: [topic], since: { [topic]: last } }));
    } else {
      c.ws.send(JSON.stringify({ op: "unsubscribe", topics: [topic] }));
      c.ws.send(JSON.stringify({ op: "subscribe", topics: [topic] }));
    }
  };

  /** 结束一次重订阅等待并计成败;没有在等就什么都不做 @param {Client} c @param {string} topic @param {boolean} ok */
  const settleResync = (c, topic, ok) => {
    if (!c.pendingResync.delete(topic)) return;
    if (ok) counts.resyncOk += 1;
    else counts.resyncFailed += 1;
  };
  /** 快照还没来又被 resync / 缺口:上一次重订阅被扣住了,记一次失败(之后照常再订) @param {Client} c @param {string} topic */
  const failIfAwaitingSnapshot = (c, topic) => {
    if (c.pendingResync.get(topic)?.phase === "snapshot") settleResync(c, topic, false);
  };

  /** @param {Client} c @param {Ev} ev @param {Set<string>} resub */
  const onEvent = (c, ev, resub) => {
    const t = ev.t ?? "?";
    bump(eventsByType, t);
    if (t === "hello") {
      c.hello = true;
      return;
    }
    if (t === "subscribed" && ev.topic) {
      c.lastSeq.set(ev.topic, ev.seq ?? 0);
      const pending = c.pendingResync.get(ev.topic);
      if (pending?.phase === "subscribed") {
        // candles 没有订阅快照,subscribed 即恢复;其它 topic 还要等快照(hub 限流时只回 subscribed)
        if (ev.topic.startsWith("candles:")) settleResync(c, ev.topic, true);
        else c.pendingResync.set(ev.topic, { phase: "snapshot", deadline: Date.now() + RESYNC_TIMEOUT_MS });
      }
      return;
    }
    if (t === "error") {
      bump(errorsByCode, ev.code ?? "?");
      if (ev.topic) settleResync(c, ev.topic, false);
      return;
    }
    if (t === "resync" && ev.topic) {
      counts.resyncs += 1;
      failIfAwaitingSnapshot(c, ev.topic);
      resub.add(ev.topic);
      return;
    }
    if (!ev.topic || typeof ev.seq !== "number" || t === "unsubscribed" || t === "pong") return;
    // 序号裁决,同 ws-client.ts 的 judge
    if (ev.seq === 0) return;
    const last = c.lastSeq.get(ev.topic);
    if (last === undefined || last === 0 || ev.seq === last || ev.seq === last + 1) {
      c.lastSeq.set(ev.topic, ev.seq);
      // 重订阅之后该 topic 的快照形态(book.snapshot / trades 整份或回放 / ticker 最后值)到了:恢复
      if (c.pendingResync.get(ev.topic)?.phase === "snapshot" && (t === "book.snapshot" || t === "trades" || t === "ticker")) {
        settleResync(c, ev.topic, true);
      }
    } else if (ev.seq > last + 1 && !resub.has(ev.topic)) {
      counts.gaps += 1;
      failIfAwaitingSnapshot(c, ev.topic);
      resub.add(ev.topic);
    }
  };

  /** @param {number} i */
  const connect = (i) => {
    const startedAt = Date.now();
    const ws = new WebSocket(o.url, { perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
    /** @type {Client} */
    const c = {
      ws, openedAt: null, hello: false, frames: 0, lastFrameAt: null, lastSeq: new Map(), closed: false, rejected: false, closedEarly: false,
      pendingResync: new Map(),
    };
    clients[i] = c;
    ws.on("unexpected-response", (req, res) => {
      c.rejected = true;
      const retry = res.headers["retry-after"];
      bump(rejectedBy, `${res.statusCode}${retry ? ` retry-after=${retry}` : ""}`);
      res.resume();
      req.destroy();
    });
    ws.on("open", () => {
      c.openedAt = Date.now();
      openMs.push(c.openedAt - startedAt);
      ws.send(JSON.stringify({ op: "subscribe", topics: o.topics }));
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const now = Date.now();
      const text = data.toString();
      // 线上字节数:默认 binaryType 下 data 是 Buffer;text.length 是 UTF-16 码元,中文会少算
      const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(text, "utf8");
      c.frames += 1;
      if (measuring) {
        counts.holdFrames += 1;
        counts.holdBytes += bytes;
        if (c.lastFrameAt !== null) intervals.push(now - c.lastFrameAt);
      }
      c.lastFrameAt = now;
      /** @type {unknown} */
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        counts.schemaViolations += 1;
        return;
      }
      if (c.frames <= SCHEMA_FIRST_FRAMES || c.frames % SCHEMA_SAMPLE_EVERY === 0) {
        counts.schemaChecked += 1;
        if (!serverFrameSchema.safeParse(frame).success) counts.schemaViolations += 1;
      }
      if (!Array.isArray(frame)) return;
      /** @type {Set<string>} */
      const resub = new Set();
      for (const ev of frame) onEvent(c, /** @type {Ev} */ (ev ?? {}), resub);
      for (const topic of resub) resubscribe(c, topic);
    });
    ws.on("error", () => {
      if (!c.rejected && c.openedAt === null) counts.connectErrors += 1;
    });
    ws.on("close", (code) => {
      c.closed = true;
      if (c.rejected || c.openedAt === null) return;
      bump(closeCodes, String(code));
      if (!stopping) {
        c.closedEarly = true;
        bump(closeCodesEarly, String(code));
      }
    });
  };

  // 重订阅超时扫描(D22(3)):每一步 5 s 没走完算一次失败;收尾关闭前停
  const resyncSweep = setInterval(() => {
    const now = Date.now();
    for (const c of clients) {
      if (!c) continue;
      for (const [topic, pending] of c.pendingResync) if (now >= pending.deadline) settleResync(c, topic, false);
    }
  }, RESYNC_SWEEP_MS);

  // ---- 连接(ramp 内均匀发起) ----
  const t0 = Date.now();
  for (let i = 0; i < o.clients; i += 1) {
    connect(i);
    if (o.rampMs > 0 && i < o.clients - 1) {
      const due = t0 + Math.round(((i + 1) * o.rampMs) / o.clients);
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  // 等握手结束(open 或被拒 / 出错),最多握手超时 + 2 s
  for (let waited = 0; waited < HANDSHAKE_WAIT_MS; waited += 100) {
    if (clients.every((c) => c.openedAt !== null || c.rejected || c.closed)) break;
    await sleep(100);
  }
  const connected = clients.filter((c) => c.openedAt !== null).length;
  const rejectedAtUpgrade = clients.filter((c) => c.rejected).length;
  const pending = clients.filter((c) => c.openedAt === null && !c.rejected && !c.closed).length;
  console.log(
    `[ws-flood] connected ${connected}/${o.clients} in ${Date.now() - t0} ms · rejected ${rejectedAtUpgrade} · connect errors ${counts.connectErrors}` +
      (pending ? ` · still pending ${pending}` : ""),
  );

  // ---- 保持 seconds 秒:盘口交叉检查、RSS 采样、中途读一次 health ----
  const holdStart = Date.now();
  measuring = true;
  const holdEnd = holdStart + o.seconds * 1000;
  const book = { checks: 0, crossed: 0, failed: 0 };
  /** @type {any} */
  let healthMid = null;
  let nextBookAt = holdStart;
  let nextRssAt = holdStart;
  const midAt = holdStart + Math.min(HEALTH_MID_MS, o.seconds * 500);
  while (Date.now() < holdEnd) {
    const now = Date.now();
    if (now >= nextBookAt) {
      nextBookAt += BOOK_CHECK_MS;
      for (const sym of bookSymbols) {
        const snap = await getJson(`${httpBase}/api/market/${encodeURIComponent(sym)}/book?depth=50`);
        if (!snap) {
          book.failed += 1;
          continue;
        }
        book.checks += 1;
        const bid = snap.bids?.[0]?.price;
        const ask = snap.asks?.[0]?.price;
        if (typeof bid === "number" && typeof ask === "number" && bid >= ask) {
          book.crossed += 1;
          console.log(`[ws-flood] crossed book ${sym}: bestBid ${bid} >= bestAsk ${ask}`);
        }
      }
    }
    if (o.pid && now >= nextRssAt) {
      nextRssAt += RSS_SAMPLE_MS;
      const r = await rssMb(o.pid);
      if (r !== null && (rssPeak === null || r > rssPeak)) rssPeak = r;
    }
    if (healthMid === null && now >= midAt) healthMid = (await getJson(`${httpBase}/api/health`)) ?? false;
    // 下一次醒来取最近的一件事;中途的 /api/health 读取(midAt)也要算进来,否则 seconds 很短时它会被 holdEnd 越过、永远不读
    await sleep(Math.max(10, Math.min(nextBookAt, o.pid ? nextRssAt : Infinity, healthMid === null ? midAt : Infinity, holdEnd) - Date.now()));
  }
  measuring = false;
  const heldMs = Date.now() - holdStart;

  // ---- 收尾:1000 关闭,等回执 ----
  clearInterval(resyncSweep);
  // 压测结束时还在等的重订阅:未到时限,不算成败,单列
  const resyncUnsettled = clients.reduce((n, c) => n + (c ? c.pendingResync.size : 0), 0);
  stopping = true;
  for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.close(1000, "ws-flood done");
  for (let waited = 0; waited < CLOSE_WAIT_MS; waited += 100) {
    if (clients.every((c) => c.closed || c.ws.readyState === WebSocket.CLOSED)) break;
    await sleep(100);
  }
  for (const c of clients) if (!c.closed) c.ws.terminate();
  await sleep(500);
  const healthAfter = await getJson(`${httpBase}/api/health`);
  const rssAfter = o.pid ? await rssMb(o.pid) : null;
  const bot = o.serverLog ? await botStats(o.serverLog, logOffset) : null;

  // ---- 汇总 ----
  intervals.sort((a, b) => a - b);
  openMs.sort((a, b) => a - b);
  const opened = clients.filter((c) => c.openedAt !== null);
  const helloReceived = opened.filter((c) => c.hello).length;
  const heldSec = heldMs / 1000;
  const subscriptions = connected * o.topics.length;
  // resync 事件与客户端自己发现的 seq 缺口都会让该 topic 重订阅,一起计入 1% 门槛
  const resyncPct = subscriptions ? ((counts.resyncs + counts.gaps) / subscriptions) * 100 : null;
  // 计划 §7.5 的「被拒(503/1013)」= 升级被拒 + 运行中被 1013 / 1008 关闭;其它码的服务端关闭单列
  let rejectedByClose = 0;
  let closedByServerOther = 0;
  for (const [code, n] of closeCodesEarly) {
    if (REJECT_CLOSE_CODES.has(code)) rejectedByClose += n;
    else closedByServerOther += n;
  }
  const rejected = rejectedAtUpgrade + rejectedByClose;
  const errorEvents = [...errorsByCode.values()].reduce((s, n) => s + n, 0);
  /** @param {{ tickMs: number }[]} xs */
  const meanTick = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x.tickMs, 0) / xs.length) : null);
  // 基线取压测前最后 BOT_BASELINE_LINES 行的均值:单行 60 s 窗口的均值本身有 ±10% 的起伏
  const botBaseline = bot ? bot.before.slice(-BOT_BASELINE_LINES) : [];
  const botBefore = meanTick(botBaseline);
  const botDuring = bot ? meanTick(bot.during) : null;
  const botIncreasePct = botBefore !== null && botDuring !== null && botBefore > 0 ? ((botDuring - botBefore) / botBefore) * 100 : null;
  const rssDelta = rssBefore !== null && rssPeak !== null ? rssPeak - rssBefore : null;
  const summary = {
    url: o.url,
    clients: o.clients,
    seconds: o.seconds,
    topics: o.topics,
    connected,
    rejected,
    rejectedAtUpgrade,
    rejectedByClose,
    rejectedBy: Object.fromEntries(rejectedBy),
    connectErrors: counts.connectErrors,
    pending,
    helloReceived,
    openMs: { p50: quantile(openMs, 0.5), p99: quantile(openMs, 0.99) },
    heldMs,
    framesPerSec: heldSec > 0 ? Math.round(counts.holdFrames / heldSec) : 0,
    framesPerSecPerClient: connected && heldSec > 0 ? Math.round((counts.holdFrames / heldSec / connected) * 10) / 10 : 0,
    kbPerSec: heldSec > 0 ? Math.round(counts.holdBytes / 1024 / heldSec) : 0,
    frameIntervalMs: { p50: quantile(intervals, 0.5), p99: quantile(intervals, 0.99), max: intervals.length ? intervals[intervals.length - 1] : null },
    events: Object.fromEntries([...eventsByType].sort((a, b) => b[1] - a[1])),
    resyncs: counts.resyncs,
    seqGaps: counts.gaps,
    resubscribe: { ok: counts.resyncOk, failed: counts.resyncFailed, unsettledAtEnd: resyncUnsettled },
    resyncPctOfSubscriptions: resyncPct === null ? null : Math.round(resyncPct * 1000) / 1000,
    errors: Object.fromEntries(errorsByCode),
    closeCodes: Object.fromEntries(closeCodes),
    closedByServerDuringRun: Object.fromEntries(closeCodesEarly),
    schema: { checked: counts.schemaChecked, violations: counts.schemaViolations },
    bookCross: book,
    health: {
      before: healthBefore.ws ?? null,
      midConnections: healthMid ? (healthMid.ws?.connections ?? null) : null,
      afterAnswered: healthAfter !== null,
      afterConnections: healthAfter?.ws?.connections ?? null,
      delta: statsDelta(healthBefore.ws, healthAfter?.ws ?? null),
    },
    rssMb: o.pid ? { before: rssBefore, peak: rssPeak, after: rssAfter, delta: rssDelta } : null,
    botTickMs: bot ? { before: botBefore, beforeLines: botBaseline.length, during: botDuring, duringLines: bot.during.length, increasePct: botIncreasePct === null ? null : Math.round(botIncreasePct * 10) / 10 } : null,
  };

  console.log(`[ws-flood] held ${heldMs} ms · framesPerSec ${summary.framesPerSec} (${summary.framesPerSecPerClient}/client) · ${summary.kbPerSec} KB/s`);
  console.log(`[ws-flood] frame interval p50 ${summary.frameIntervalMs.p50} ms · p99 ${summary.frameIntervalMs.p99} ms · max ${summary.frameIntervalMs.max} ms`);
  console.log(`[ws-flood] resyncs ${counts.resyncs} + seq gaps ${counts.gaps} (${summary.resyncPctOfSubscriptions ?? "n/a"}% of ${subscriptions} subscriptions) · errors ${JSON.stringify(summary.errors)}`);
  console.log(`[ws-flood] resubscribes ok ${counts.resyncOk} · failed ${counts.resyncFailed} · unsettled at end ${resyncUnsettled}`);
  console.log(`[ws-flood] closeCodes ${JSON.stringify(summary.closeCodes)} · closed by server during run ${JSON.stringify(summary.closedByServerDuringRun)}`);
  console.log(`[ws-flood] book cross checks ${book.checks} · crossed ${book.crossed} · failed ${book.failed} · schema ${counts.schemaChecked} checked / ${counts.schemaViolations} bad`);
  console.log(`[ws-flood] health ws: connections mid ${summary.health.midConnections} after ${summary.health.afterConnections} · delta ${JSON.stringify(summary.health.delta)}`);
  if (summary.rssMb) console.log(`[ws-flood] rss MB before ${rssBefore} · peak ${rssPeak} · after ${rssAfter} · delta ${rssDelta}`);
  if (summary.botTickMs) console.log(
      `[ws-flood] bot tickMs before ${botBefore} (mean of ${botBaseline.length} lines) · during ${botDuring} (${bot?.during.length ?? 0} lines) · increase ${summary.botTickMs.increasePct}%`,
    );

  // 给了 --pid / --server-log 却拿不到数据:判 FAIL 并说明缺什么,不当作 SKIP
  const rssCheck = /** @type {[string, boolean | null]} */ (
    !o.pid
      ? [`rss delta (no --pid)`, null]
      : rssDelta === null
        ? [`rss delta: no RSS sample for pid ${o.pid} (process gone, wrong pid, or no ps)`, false]
        : [`rss delta ${rssDelta} MB < ${LIMITS.rssDeltaMb} MB`, rssDelta < LIMITS.rssDeltaMb]
  );
  const botCheck = /** @type {[string, boolean | null]} */ (
    !o.serverLog
      ? [`bot tick increase (no --server-log)`, null]
      : !bot
        ? [`bot tick increase: cannot read ${o.serverLog}`, false]
        : botBefore === null
          ? [`bot tick increase: no bot stats line before the run (let the server run >= 60 s first, bot on)`, false]
          : botDuring === null
            ? [`bot tick increase: no bot stats line during the run (use --seconds >= 60; >= 130 for a full window)`, false]
            : [`bot tick increase ${summary.botTickMs?.increasePct}% < ${LIMITS.botTickIncreasePct}%`, botIncreasePct !== null && botIncreasePct < LIMITS.botTickIncreasePct]
  );
  /** @type {[string, boolean | null][]} */
  const checks = [
    [`connected ${connected} = clients ${o.clients} - rejected at upgrade ${rejectedAtUpgrade} (and >= 1)`, connected >= 1 && connected === o.clients - rejectedAtUpgrade],
    [`connect errors ${counts.connectErrors} = 0`, counts.connectErrors === 0],
    [`hello ${helloReceived} = connected ${connected}`, helloReceived === connected],
    [`rejected ${rejected} (upgrade ${rejectedAtUpgrade} + closed 1013/1008 ${rejectedByClose}) <= ${o.maxRejected}`, rejected <= o.maxRejected],
    [`other server closes during run ${closedByServerOther} = 0`, closedByServerOther === 0],
    [
      `resync + gaps ${summary.resyncPctOfSubscriptions ?? "n/a"}% < ${LIMITS.resyncPct}%`,
      // 一个都没连上时没有订阅可算,由上面的 connected 检查判失败
      resyncPct === null ? null : resyncPct < LIMITS.resyncPct,
    ],
    [`resubscribe failures (D22(3): subscribed + snapshot within 5 s each) ${counts.resyncFailed} = 0`, counts.resyncFailed === 0],
    [`server error events ${errorEvents} = 0`, errorEvents === 0],
    [`schema violations ${counts.schemaViolations} = 0`, counts.schemaViolations === 0],
    [
      `crossed books ${book.crossed} = 0 (${book.checks} checks, ${book.failed} failed fetches)`,
      // 一次都没取到盘口、或有取失败的,都不算「没交叉」
      bookSymbols.length ? book.checks > 0 && book.failed === 0 && book.crossed === 0 : null,
    ],
    [`/api/health answered after the run`, healthAfter !== null],
    rssCheck,
    botCheck,
  ];
  let failed = false;
  for (const [label, pass] of checks) {
    if (pass === false) failed = true;
    console.log(`[ws-flood] ${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"} ${label}`);
  }
  console.log(`[ws-flood] summary ${JSON.stringify(summary)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
