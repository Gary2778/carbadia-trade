#!/usr/bin/env node
// @ts-check
// /ws 冒烟(计划 §1.4、§3.4):node scripts/smoke-ws.mjs <wsUrl> <SYMBOL>
// 用 Node 全局 WebSocket(Node ≥ 22)连上去,订阅 book:<SYMBOL>,10 s 内收到 hello、subscribed 与至少一帧 book(snapshot 或 delta)
// 即 exit 0,否则 exit 1 并说明缺了什么。收到 error 事件(如 unknown_topic)立即 exit 1。
// 默认 ws://localhost:3000/ws 与 VCS-FOR-2021;npm run smoke:ws -- ws://localhost:3940/ws VCS-FOR-2021。
import process from "node:process";

const [url = "ws://localhost:3000/ws", symbol = "VCS-FOR-2021"] = process.argv.slice(2);
const TIMEOUT_MS = 10_000;
const topic = `book:${symbol}`;
const seen = { hello: false, subscribed: false, book: false };
let done = false;

/**
 * @param {number} code
 * @param {string} why
 */
function finish(code, why) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  const missing = Object.entries(seen)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  console.log(`[smoke-ws] ${code === 0 ? "PASS" : "FAIL"}: ${why}${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);
  try {
    ws.close(1000, "smoke done");
  } catch {
    // 已经关了
  }
  process.exit(code);
}

const timer = setTimeout(() => finish(1, `timeout after ${TIMEOUT_MS} ms`), TIMEOUT_MS);

if (typeof WebSocket !== "function") {
  console.error("[smoke-ws] global WebSocket is not available; use Node 22 or newer");
  process.exit(1);
}

console.log(`[smoke-ws] connecting ${url}, topic ${topic}`);
const ws = new WebSocket(url);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ op: "subscribe", topics: [topic] }));
});

ws.addEventListener("message", (ev) => {
  /** @type {unknown} */
  let frame;
  try {
    frame = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
  } catch {
    finish(1, "frame is not JSON");
    return;
  }
  if (!Array.isArray(frame)) {
    finish(1, "frame is not an array (ServerFrame = ServerEvent[])");
    return;
  }
  for (const event of frame) {
    const e = /** @type {{ t?: string; topic?: string; seq?: number; symbol?: string; code?: string; message?: string; userId?: string | null }} */ (event ?? {});
    console.log(`[smoke-ws] ${e.t}${e.topic ? ` ${e.topic}` : ""}${typeof e.seq === "number" ? ` seq=${e.seq}` : ""}${e.t === "hello" ? ` userId=${e.userId}` : ""}`);
    if (e.t === "hello") seen.hello = true;
    else if (e.t === "subscribed" && e.topic === topic) seen.subscribed = true;
    else if ((e.t === "book.snapshot" || e.t === "book.delta") && e.symbol === symbol) seen.book = true;
    else if (e.t === "error") {
      finish(1, `server error ${e.code}: ${e.message}`);
      return;
    }
  }
  if (seen.hello && seen.subscribed && seen.book) finish(0, "hello + subscribed + book received");
});

ws.addEventListener("error", () => finish(1, "socket error (is the server up, is the path /ws, is the Origin allowed?)"));
ws.addEventListener("close", (ev) => finish(1, `closed by peer with ${ev.code}${ev.reason ? ` (${ev.reason})` : ""}`));
