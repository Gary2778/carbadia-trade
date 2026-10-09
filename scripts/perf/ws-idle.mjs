#!/usr/bin/env node
// @ts-check
// /ws 空闲连接观测(计划 §9.1 第 58 条;P3-11):量一条什么都不订阅、不发应用层 ping 的连接能活多久,
// 用来记录 Cloudflare(或任何中间层)怎样对待安静的 WebSocket。
//
//   node scripts/perf/ws-idle.mjs [--url ws://localhost:3000/ws] [--origin https://cbda.trade] [--minutes 10]
//   npm run perf:ws-idle -- --url wss://cbda.trade/ws --origin https://cbda.trade --minutes 10
//
// 只开一条连接;收到 hello 之后什么都不发(不订阅、不发 {op:"ping"}),对服务端的协议层 ping 照常回 pong
// (`ws` 包自动回,与浏览器一样),所以可以对着生产跑:一条连接、零订阅、零写入。
// 输出:握手结果、hello 的 heartbeatMs、每次收到服务端 ping 的时刻,结束时一行结论 + 一行 JSON 汇总:
//   - 到了 --minutes 仍然开着 → 「still open」,本脚本以 1000 正常关闭,exit 0;
//   - 中途被对端(服务端或中间层)关闭或出错 → 关闭码、原因、已连接时长与之前看到的 ping 次数,exit 1;
//   - 连不上(握手被拒、超时、地址不对)或参数不对 → exit 2。
// Ctrl+C 提前结束时同样打印汇总(结论「interrupted」,exit 130)。
// 用 `ws` 包而不是 Node 全局 WebSocket:只有它把协议层 ping 暴露成事件(全局 WebSocket 自动回 pong 但看不见),
// 也能带 Origin 头、拿到被拒 upgrade 的 HTTP 状态码。
import process from "node:process";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const DEFAULT_URL = "ws://localhost:3000/ws";
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[ws-idle] ${msg}`);
  process.exit(2);
}

/** @type {{ values: { url?: string; origin?: string; minutes?: string; help?: boolean } }} */
let parsed;
try {
  parsed = parseArgs({
    options: { url: { type: "string" }, origin: { type: "string" }, minutes: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: false,
  });
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
if (parsed.values.help) {
  console.log("usage: node scripts/perf/ws-idle.mjs [--url ws(s)://host/ws] [--origin <Origin header>] [--minutes <n, default 10>]");
  process.exit(0);
}
const url = parsed.values.url ?? DEFAULT_URL;
if (!/^wss?:\/\//.test(url)) die(`--url must start with ws:// or wss:// (got ${url})`);
const minutes = parsed.values.minutes === undefined ? 10 : Number(parsed.values.minutes);
if (!Number.isFinite(minutes) || minutes <= 0) die(`--minutes must be a positive number (got ${parsed.values.minutes})`);
const origin = parsed.values.origin ?? null;
const holdMs = Math.round(minutes * 60_000);

const t0 = Date.now();
/** 自脚本开始的秒数,一位小数 */
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (/** @type {string} */ msg) => console.log(`[ws-idle] +${at()} ${msg}`);

let openedAt = /** @type {number | null} */ (null);
let helloAt = /** @type {number | null} */ (null);
let heartbeatMs = /** @type {number | null} */ (null);
let pings = 0;
let lastPingAt = /** @type {number | null} */ (null);
/** hello 之后又收到的应用层消息(什么都没订阅,应为 0) */
let otherMessages = 0;
let finished = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let holdTimer;

/**
 * @param {"still open" | "closed by peer" | "error" | "not connected" | "interrupted"} outcome
 * @param {{ code?: number; reason?: string; error?: string }} [detail]
 */
function finish(outcome, detail = {}) {
  if (finished) return;
  finished = true;
  clearTimeout(holdTimer);
  const connectedMs = openedAt === null ? 0 : Date.now() - openedAt;
  const summary = {
    url,
    origin,
    minutes,
    outcome,
    closeCode: detail.code ?? null,
    closeReason: detail.reason || null,
    error: detail.error ?? null,
    connectedSeconds: Math.round(connectedMs / 100) / 10,
    helloHeartbeatMs: heartbeatMs,
    serverPings: pings,
    secondsSinceLastPing: lastPingAt === null ? null : Math.round((Date.now() - lastPingAt) / 100) / 10,
    otherMessages,
  };
  const how =
    outcome === "still open"
      ? `still open after ${minutes} min; server pings seen ${pings}`
      : outcome === "closed by peer"
        ? `closed by peer after ${summary.connectedSeconds} s with code ${detail.code}${detail.reason ? ` (${detail.reason})` : ""}; server pings seen ${pings}`
        : `${outcome}${detail.error ? `: ${detail.error}` : ""} after ${summary.connectedSeconds} s connected; server pings seen ${pings}`;
  log(how);
  console.log(JSON.stringify(summary));
  const code = outcome === "still open" ? 0 : outcome === "interrupted" ? 130 : outcome === "not connected" ? 2 : 1;
  if (outcome === "still open" && ws.readyState === WebSocket.OPEN) {
    ws.once("close", () => process.exit(code));
    ws.close(1000, "idle check done");
    setTimeout(() => process.exit(code), 3_000).unref();
    return;
  }
  try {
    ws.terminate();
  } catch {
    // 已经关了
  }
  process.exit(code);
}

log(`connecting ${url}${origin ? ` (Origin ${origin})` : ""}; will hold ${minutes} min, no subscriptions, no application pings`);
const ws = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: HANDSHAKE_TIMEOUT_MS, ...(origin ? { headers: { Origin: origin } } : {}) });

ws.on("unexpected-response", (_req, res) => {
  const retry = res.headers["retry-after"];
  finish("not connected", { error: `upgrade refused: HTTP ${res.statusCode}${retry ? ` retry-after=${retry}` : ""}` });
});
ws.on("open", () => {
  openedAt = Date.now();
  log("open");
  holdTimer = setTimeout(() => finish("still open"), holdMs);
});
ws.on("message", (data) => {
  /** @type {unknown} */
  let frame;
  try {
    frame = JSON.parse(String(data));
  } catch {
    otherMessages += 1;
    log("non-JSON message");
    return;
  }
  for (const event of Array.isArray(frame) ? frame : [frame]) {
    const e = /** @type {{ t?: string; heartbeatMs?: number; userId?: string | null }} */ (event ?? {});
    if (e.t === "hello" && helloAt === null) {
      helloAt = Date.now();
      heartbeatMs = typeof e.heartbeatMs === "number" ? e.heartbeatMs : null;
      log(`hello (heartbeatMs ${heartbeatMs}, userId ${e.userId ?? null}); now staying quiet`);
    } else {
      otherMessages += 1;
      log(`message ${e.t ?? "?"}`);
    }
  }
});
ws.on("ping", () => {
  pings += 1;
  const since = lastPingAt === null ? "" : `, ${((Date.now() - lastPingAt) / 1000).toFixed(1)} s after the previous one`;
  lastPingAt = Date.now();
  log(`server ping #${pings} (pong sent automatically${since})`);
});
ws.on("close", (code, reason) => {
  if (openedAt === null) finish("not connected", { code, reason: String(reason), error: "closed before open" });
  else finish("closed by peer", { code, reason: String(reason) });
});
ws.on("error", (err) => {
  // 本机 localhost 双栈连不上时是 AggregateError,message 为空,看 code(ECONNREFUSED 等)
  const what = err.message || /** @type {NodeJS.ErrnoException} */ (err).code || String(err);
  if (openedAt === null) finish("not connected", { error: what });
  else finish("error", { error: what });
});
process.on("SIGINT", () => finish("interrupted"));
