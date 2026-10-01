#!/usr/bin/env node
// @ts-check
// 注销 → 持仓更新的时延(计划 §6.2「Phase 2 验收标准」:注销后持仓在 ≤ 1 帧(WS)或 ≤ 5 s(轮询)内更新;P2-11)。
// 对着已经在跑的本地生产构建(机器人开)运行;会在该服务的库里建一个演示账号(POST /api/auth/demo,每 IP 每小时 3 个),
// 所以只对本地开发库或它的副本跑,不要对生产跑。脚本只认本地地址(localhost、127.0.0.1、[::1]、*.localhost、*.test),
// 别的主机一律拒绝(exit 2);确实要对别处跑时显式加 --allow-remote:
//
//   node scripts/perf/retire-latency.mjs http://localhost:3982 --mode ws                # custom 模式(node server.mjs):WS 推送
//   node scripts/perf/retire-latency.mjs http://localhost:3982 --mode poll              # START_MODE=next(next start):账户轮询,随机相位
//   node scripts/perf/retire-latency.mjs http://localhost:3982 --mode poll --phase worst  # 同上,每次注销都落在最坏相位
//   选项:--runs N(默认 20)、--gap-ms N(两次注销的间隔,默认 3200:注销接口每用户每分钟 20 次)、
//         --phase random|worst(只对 poll,默认 random,见下)、
//         --limit literal|relaxed(退出码按哪个上限判,默认 literal,见下)、--allow-remote、--json
//
// 步骤:演示账号 → 市价买入 runs + 5 吨(一个非情景、有最新价的标的)→ 每轮注销 1 吨(请求体与 RetireDialog 同形)。
//   · ws:带会话 cookie 连 /ws 并订阅 account(与终端一样);记录「请求发出」t0、「响应到达」t1、「该标的的 position 事件
//     (retired 等于这一轮之后的累计)到达」t2。报 t2 − t1(事件可能先于响应到达,此时为负)与 t2 − t0 的中位数与最大值。
//     服务端每连接 50 ms 合帧(server/ws-hub.mjs 的 BATCH_MS),所以事件到达最迟约在提交之后一个合帧窗口加一次持仓读取;
//     客户端 batcher 在收到之后的下一帧 rAF 一次 flush(计划 §7.1),界面在事件到达后 ≤ 1 帧更新。
//   · poll:照终端的账户轮询起一条轮询,调度与请求都和真实客户端一样:
//     - 调度同 src/hooks/usePolling.ts 的 startPolling:一轮**结束之后**才排下一轮,隔 POLL_ACCOUNT_MS(5 s),
//       所以两轮的开始相隔 5 s + 一轮的往返,不是固定 5 s;
//     - 一轮同 src/lib/market/MarketProvider.tsx 的 pollAccount:GET /api/account/positions 与开放委托翻页
//       (account-bridge 的 fetchOpenOrders:/api/account/orders?status=open&limit=100 按 nextCursor 翻完)并行,两者都回来才算这一轮读到
//       (pollAccount 这时才把快照推给 batcher,界面再过 ≤ 1 帧 rAF 更新;这里记的是两个响应都到的时刻,不含那 1 帧)。
//     注销的相位:random(默认)每轮注销前随机等 0–5 s,落在轮询周期的随机位置;worst 每轮等下一轮轮询**刚发出**请求就注销,
//     这一轮读到的是注销之前的状态,界面要等下一轮:约 5 s + 一轮往返,是真实客户端的最坏情形。
//     每轮注销后记录「响应到达」到「第一次读到新的 retired 的那一轮结束」的间隔(界面的更新时刻),另核对响应之后立即 GET 一次就能读到
//     (提交后 REST 即可见,轮询模式的时延只来自轮询调度)。
// 判定:两种上限都算、都打印,退出码只按 --limit 选的那一种(exit 1 = 不达标):
//   · literal(默认,计划 §6.2 验收的字面):ws 模式 t2 − t1 的最大值 ≤ 1 帧(16.7 ms);poll 模式每一轮 ≤ 5 s。
//     真实客户端的轮询最坏情形是 5 s + 一轮往返,所以 --phase worst 下字面上限按设计就过不了(超出的就是那一轮往返)。
//   · relaxed(只是一种候选口径,是否采用由 lead / 用户定,见 docs/perf-report.md「Phase 2 · 2026-10-01」§9 第 5 条):
//     ws 模式 ≤ 合帧窗口 50 ms + 一帧(66.7 ms);poll 模式 ≤ 5 s + 一轮往返的余量 0.5 s(5.5 s)。
//   两种口径都要求:每一轮都收到更新(ws 2 s 内收到事件;poll 5 s + 1 s 内读到),poll 模式注销后立即 GET 全部可见。
//   exit 2 = 环境问题(服务不通、非本地地址、演示账号限流、买不到持仓)。
import { randomUUID } from "node:crypto";
import process from "node:process";
import WebSocket from "ws";
import { isLocalBase, refuseRemoteMessage } from "./local-base.mjs";

const FRAME_MS = 1000 / 60;
const WS_BATCH_MS = 50; // server/ws-hub.mjs 的 BATCH_MS
const POLL_ACCOUNT_MS = 5_000; // src/lib/market/MarketProvider.tsx 的 POLL_ACCOUNT_MS
const POLL_SLACK_MS = 500;
const EVENT_TIMEOUT_MS = 2_000;
/** 两种上限(见文件头「判定」):literal = 计划验收的字面,relaxed = 候选口径 */
const LIMITS = {
  literal: { ws: FRAME_MS, poll: POLL_ACCOUNT_MS, label: { ws: "字面 ≤ 1 帧", poll: "字面 ≤ 5 s" } },
  relaxed: { ws: WS_BATCH_MS + FRAME_MS, poll: POLL_ACCOUNT_MS + POLL_SLACK_MS, label: { ws: "合帧 50 ms + 1 帧(候选口径)", poll: "5 s + 0.5 s 往返余量(候选口径)" } },
};
/** 开放委托翻页,与 src/lib/market/account-bridge.ts 的 OPEN_ORDERS_URL / OPEN_ORDERS_PAGE_LIMIT / OPEN_ORDERS_MAX_PAGES 相同 */
const OPEN_ORDERS_URL = "/api/account/orders?status=open";
const OPEN_ORDERS_PAGE_LIMIT = 100;
const OPEN_ORDERS_MAX_PAGES = 20;

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[retire-latency] ${msg}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = {
    base: "http://localhost:3982",
    mode: /** @type {"ws" | "poll"} */ ("ws"),
    runs: 20,
    gapMs: 3_200,
    json: false,
    limit: /** @type {"literal" | "relaxed"} */ ("literal"),
    phase: /** @type {"random" | "worst"} */ ("random"),
    allowRemote: false,
  };
  let phaseGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? die(`${a} needs a value`);
    const int = (/** @type {string} */ v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) die(`${a} must be a positive integer, got ${v}`);
      return n;
    };
    if (a === "--mode") {
      const m = value();
      if (m !== "ws" && m !== "poll") die(`--mode must be ws or poll, got ${m}`);
      o.mode = m;
    } else if (a === "--runs") o.runs = int(value());
    else if (a === "--gap-ms") o.gapMs = int(value());
    else if (a === "--limit") {
      const l = value();
      if (l !== "literal" && l !== "relaxed") die(`--limit must be literal or relaxed, got ${l}`);
      o.limit = l;
    } else if (a === "--phase") {
      const p = value();
      if (p !== "random" && p !== "worst") die(`--phase must be random or worst, got ${p}`);
      o.phase = p;
      phaseGiven = true;
    } else if (a === "--allow-remote") o.allowRemote = true;
    else if (a === "--json") o.json = true;
    else if (!a.startsWith("-")) o.base = a.replace(/\/+$/, "");
    else die(`unknown argument ${a}`);
  }
  if (phaseGiven && o.mode !== "poll") die("--phase only applies to --mode poll");
  // 会建演示账号、买入、记 20 次注销:只对本地跑,除非显式 --allow-remote(在发任何请求之前拒绝)
  if (!isLocalBase(o.base) && !o.allowRemote) die(refuseRemoteMessage(o.base));
  return o;
}

const o = parseArgs(process.argv.slice(2));
const log = (/** @type {string} */ msg) => {
  if (!o.json) console.error(`[retire-latency] ${msg}`);
};
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

let cookie = "";
/** @param {string} path @param {RequestInit} [init] */
async function call(path, init = {}) {
  const res = await fetch(o.base + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(/** @type {Record<string, string>} */ (init.headers ?? {})) },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return res;
}
/** @param {string} path @param {RequestInit} [init] @returns {Promise<{ status: number; data: any }>} */
async function json(path, init) {
  const res = await call(path, init);
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (!body?.ok) die(`${init?.method ?? "GET"} ${path} → ${res.status} ${body?.error ?? "(no envelope)"}`);
  return { status: res.status, data: body.data };
}

/** @param {number[]} xs */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const r1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;

async function main() {
  const health = await fetch(`${o.base}/api/health`)
    .then((r) => r.json())
    .catch(() => die(`${o.base}/api/health is not reachable`));
  const startMode = health?.data?.startMode;
  log(`health: startMode ${startMode}, bot ${health?.data?.bot}, ws ${health?.data?.ws ? "on" : "off"}`);
  if (o.mode === "ws" && startMode !== "custom") die(`--mode ws needs the custom server (node server.mjs), this one is ${startMode}`);

  await json("/api/auth/demo", { method: "POST" });
  if (!cookie) die("demo login did not set a session cookie");
  const { data: inst } = await json("/api/market/instruments");
  /** @type {{ id: string; symbol: string; isScenario: boolean; lastPrice: number | null }[]} */
  const list = inst.instruments.map((/** @type {any} */ i) => i.instrument);
  const pick = list.find((i) => !i.isScenario && i.lastPrice != null);
  if (!pick) die("no non-scenario instrument with a last price");
  const buyQty = o.runs + 5;
  await json("/api/orders", { method: "POST", body: JSON.stringify({ assetId: pick.id, side: "BUY", type: "MARKET", quantity: buyQty, clientOrderId: randomUUID() }) });
  /** @returns {Promise<any>} */
  const positionOf = async () => (await json("/api/account/positions")).data.positions.find((/** @type {any} */ p) => p.assetId === pick.id);
  let pos = null;
  for (let i = 0; i < 20 && !(pos?.available >= o.runs); i++) {
    pos = await positionOf();
    if (!(pos?.available >= o.runs)) await sleep(250);
  }
  if (!(pos?.available >= o.runs)) die(`bought ${buyQty} t of ${pick.symbol} but only ${pos?.available ?? 0} t are available (thin book?)`);
  log(`demo account holds ${pos.quantity} t of ${pick.symbol} (available ${pos.available}); ${o.runs} retirements of 1 t, ${o.gapMs} ms apart, mode ${o.mode}${o.mode === "poll" ? `, phase ${o.phase}` : ""}`);

  /** @type {{ at: number; retired: number }[]} */
  const events = [];
  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {{ at: number; retired: number }[]} */
  const polls = [];
  let polling = true;
  /** @type {Promise<void> | null} */
  let pollLoop = null;
  /** --phase worst:等下一轮轮询发出请求的注销 @type {(() => void)[]} */
  const pollStartWaiters = [];
  /** 开放委托翻页(同 account-bridge 的 fetchOpenOrders:按 nextCursor 翻完,最多 20 页) */
  const openOrderPages = async () => {
    /** @type {string | null} */
    let cursor = null;
    for (let page = 0; page < OPEN_ORDERS_MAX_PAGES; page++) {
      const { data } = await json(`${OPEN_ORDERS_URL}&limit=${OPEN_ORDERS_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      cursor = data.nextCursor ?? null;
      if (!cursor) return;
    }
  };
  /** 一轮账户轮询(同 MarketProvider 的 pollAccount):持仓与开放委托并行,两者都回来才算读到;返回该标的的持仓行 @returns {Promise<any>} */
  const pollAccountRound = async () => {
    const [positions] = await Promise.all([json("/api/account/positions"), openOrderPages()]);
    return positions.data.positions.find((/** @type {any} */ p) => p.assetId === pick.id);
  };

  if (o.mode === "ws") {
    const ws = new WebSocket(`${o.base.replace(/^http/, "ws")}/ws`, { headers: { Cookie: cookie } });
    socket = ws;
    ws.on("error", (e) => die(`ws error: ${e.message}`));
    let subscribed = false;
    ws.on("message", (raw) => {
      const at = performance.now();
      const frame = JSON.parse(String(raw));
      for (const ev of Array.isArray(frame) ? frame : [frame]) {
        if (ev.t === "subscribed" && ev.topic === "account") subscribed = true;
        if (ev.t === "error") log(`ws error event ${ev.code ?? ""} ${ev.topic ?? ""}`);
        if (ev.t === "position" && ev.position?.assetId === pick.id) events.push({ at, retired: ev.position.retired });
      }
    });
    await new Promise((resolve) => ws.once("open", resolve));
    ws.send(JSON.stringify({ op: "subscribe", topics: ["account"] }));
    for (let i = 0; i < 40 && !subscribed; i++) await sleep(50);
    if (!subscribed) die("no subscribed ack for the account topic (session cookie not accepted by /ws?)");
    await sleep(500); // 快照先过去
  } else {
    // 与终端的账户轮询一样(文件头 poll):startPolling 挂载时立即跑一轮,之后每轮**结束之后**再隔 5 s 排下一轮
    // (setTimeout 在 finally 里,两轮开始相隔 5 s + 一轮往返);一轮 = pollAccount 的持仓与开放委托并行、都回来才算读到。
    // 先随机等 0–5 s 再开始,相当于页面在随机时刻打开
    await sleep(Math.random() * POLL_ACCOUNT_MS);
    pollLoop = (async () => {
      while (polling) {
        const round = pollAccountRound();
        // 这一轮的请求已经发出:放行 --phase worst 下等着的注销(它读到的是注销之前的状态)
        for (const release of pollStartWaiters.splice(0)) release();
        const p = await round;
        polls.push({ at: performance.now(), retired: p?.retired ?? 0 });
        if (polling) await sleep(POLL_ACCOUNT_MS);
      }
    })();
  }

  /** @type {{ run: number; sendToEvent: number | null; responseToEvent: number | null; immediate: boolean | null }[]} */
  const rows = [];
  let retired = pos.retired ?? 0;
  for (let run = 1; run <= o.runs; run++) {
    // poll 模式的相位:random 每轮先随机等 0–5 s,让注销落在轮询周期里的随机位置;worst 等下一轮轮询刚发出请求就注销
    if (o.mode === "poll") {
      if (o.phase === "worst") await new Promise((resolve) => pollStartWaiters.push(() => resolve(undefined)));
      else await sleep(Math.random() * POLL_ACCOUNT_MS);
    }
    const startedAt = performance.now();
    const body = { assetId: pick.id, quantity: 1, reason: "Event Offset", beneficiary: "P2-11 latency script", purpose: `Latency run ${run}`, publicMessage: "", idempotencyKey: randomUUID(), acknowledged: true };
    const t0 = performance.now();
    const res = await call("/api/retirements", { method: "POST", body: JSON.stringify(body) });
    const t1 = performance.now();
    if (res.status !== 201) die(`retirement ${run} → ${res.status} ${await res.text()}`);
    retired += 1;
    if (o.mode === "ws") {
      let hit = events.find((e) => e.retired === retired);
      while (!hit && performance.now() - t1 < EVENT_TIMEOUT_MS) {
        await sleep(2);
        hit = events.find((e) => e.retired === retired);
      }
      rows.push({ run, sendToEvent: hit ? hit.at - t0 : null, responseToEvent: hit ? hit.at - t1 : null, immediate: null });
    } else {
      const now = await positionOf();
      const immediate = now?.retired === retired;
      // 第一轮在注销发出之后结束、且读到新 retired 的轮询(那一轮结束时界面更新;若它在响应之前结束,时延为负)
      let hit = polls.find((p) => p.at > t0 && p.retired === retired);
      while (!hit && performance.now() - t1 < POLL_ACCOUNT_MS + 2 * POLL_SLACK_MS) {
        await sleep(20);
        hit = polls.find((p) => p.at > t0 && p.retired === retired);
      }
      rows.push({ run, sendToEvent: hit ? hit.at - t0 : null, responseToEvent: hit ? hit.at - t1 : null, immediate });
    }
    const last = rows[rows.length - 1];
    log(`run ${run}: response→${o.mode === "ws" ? "event" : "poll"} ${last.responseToEvent === null ? "MISSED" : `${r1(last.responseToEvent)} ms`}${last.immediate === false ? " (immediate GET did not see it)" : ""}`);
    const wait = o.gapMs - (performance.now() - startedAt);
    if (run < o.runs && wait > 0) await sleep(wait);
  }
  polling = false;
  await pollLoop;
  socket?.close();

  const seen = rows.filter((r) => r.responseToEvent !== null).map((r) => /** @type {number} */ (r.responseToEvent));
  const sent = rows.filter((r) => r.sendToEvent !== null).map((r) => /** @type {number} */ (r.sendToEvent));
  const missed = rows.length - seen.length;
  const before = seen.filter((x) => x < 0).length;
  const immediateMisses = rows.filter((r) => r.immediate === false).length;
  const maxSeen = seen.length ? Math.max(...seen) : null;
  const complete = missed === 0 && seen.length > 0 && immediateMisses === 0;
  /** 两种上限各自的判定;退出码只看 o.limit 那一种 */
  const verdicts = /** @type {const} */ (["literal", "relaxed"]).map((kind) => {
    const limitMs = LIMITS[kind][o.mode];
    return { kind, label: LIMITS[kind].label[o.mode], limitMs: r1(limitMs), pass: complete && maxSeen !== null && maxSeen <= limitMs, gate: kind === o.limit };
  });
  const summary = {
    mode: o.mode,
    phase: o.mode === "poll" ? o.phase : null,
    symbol: pick.symbol,
    runs: rows.length,
    missed,
    responseToUpdate: seen.length ? { median: r1(median(seen)), max: r1(Math.max(...seen)), min: r1(Math.min(...seen)) } : null,
    sendToUpdate: sent.length ? { median: r1(median(sent)), max: r1(Math.max(...sent)) } : null,
    eventBeforeResponse: before,
    immediateGetMisses: o.mode === "poll" ? immediateMisses : null,
    gateLimit: o.limit,
    verdicts,
  };
  const pass = /** @type {{ pass: boolean }} */ (verdicts.find((v) => v.gate)).pass;
  if (o.json) console.log(JSON.stringify({ ...summary, rows, pass }, null, 2));
  else {
    const label = o.mode === "ws" ? "响应 → position 事件" : "响应 → 第一次读到新值的轮询";
    const v = (/** @type {"literal" | "relaxed"} */ kind) => {
      const x = /** @type {(typeof verdicts)[number]} */ (verdicts.find((y) => y.kind === kind));
      return `${x.pass ? "PASS" : "FAIL"}(≤ ${x.limitMs} ms)`;
    };
    console.log(`| 模式 | 次数 | 未到 | ${label}(中位 / 最大 / 最小) | 请求发出 → 更新(中位 / 最大) | ${o.mode === "ws" ? "事件先于响应" : "响应后立即 GET 未见"} | ${LIMITS.literal.label[o.mode]} | ${LIMITS.relaxed.label[o.mode]} |`);
    console.log("|---|---|---|---|---|---|---|---|");
    const s = summary.responseToUpdate;
    const t = summary.sendToUpdate;
    console.log(
      `| ${o.mode === "poll" ? `poll(${o.phase})` : o.mode} | ${summary.runs} | ${missed} | ${s ? `${s.median} / ${s.max} / ${s.min} ms` : "—"} | ${t ? `${t.median} / ${t.max} ms` : "—"} | ${o.mode === "ws" ? before : immediateMisses} | ${v("literal")} | ${v("relaxed")} |`,
    );
    for (const x of verdicts) {
      console.log(`[retire-latency] ${x.pass ? "PASS" : "FAIL"} ${o.mode} ${x.kind}(${x.label}): max ${s ? `${s.max} ms` : "—"}(上限 ${x.limitMs} ms),未到 ${missed} 次${x.gate ? " ← 退出码按这一条(--limit " + x.kind + ")" : "(只报告)"}`);
    }
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => die(e instanceof Error ? (e.stack ?? e.message) : String(e)));
