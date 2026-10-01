// scripts/load-test.mjs — 用法: node scripts/load-test.mjs [baseUrl] [--only <名称片段>] [--cookie-file <文件> [--server-log <文件>]
//                                                          [--heavy-seconds 60] [--idle-seconds 15]
//                                                          [--overview-workers 20] [--csv-workers 2] [--overview-backoff] [--allow-remote]]
// 模拟发布波峰: 行情轮询为主(与前端 2s 轮询同型), 混合首页 HTML 与单标的行情;
// 2026-09 终端升级(计划 §7.5)加三个场景: 公开行情 /api/market/instruments c=200、/api/market/VCS-FOR-2021/book c=100、
// 终端页 /trade/VCS-FOR-2021 c=50。与既有三场景一起跑, 对比 2026-09-25 基线(p99 176 / 26 / 13 ms)。
// go/no-go 不变: 任一场景 p99 >= 2000 ms 或错误率 >= 1% → NO-GO(exit 1)。错误 = 连接错误 / 超时 + 非 2xx 响应。
//
// 第七个场景 account-heavy(计划 §6.2 P2-11,只在给了 --cookie-file 时跑): 一个大账本用户(本地副本上用
// scripts/perf/big-ledger.mjs 造 ≥ 5 万行)同时有 20 路 /api/account/overview 连续请求与 2 路 /api/transactions.csv 导出,
// 期间同一用户每 1.1 s 挂一张远离市价的 1 吨限价买单并立即撤掉, 量 POST /api/orders 的 p50 / p99;先只下单 --idle-seconds 秒
// 作对照, 再加上总览与导出跑 --heavy-seconds 秒。--cookie-file 里是该用户的 Cookie 请求头值(一行, 如 cx_session=…)。
// 节奏按限流取: 下单每用户 60 次 / 分钟(1.1 s 一张), CSV 每用户 10 次 / 分钟(每路至少隔 15 s 才开下一次, 两路合计每分钟 ≤ 8 次);
// 总览 P2-13 起每用户 30 次 / 分钟: 20 路不退避地连续请求(模拟滥用), 超出的 429 单独计数(不算错误, 也不进 p50 / p99),
// 表里另报 429 的次数与每秒次数。--overview-backoff:收到 429 就按 Retry-After 等(守规矩的客户端;默认不等,模拟滥用)。给了 --server-log(服务端日志文件)就读 {"src":"bot","ev":"stats"} 的 tickMs(每 60 s 一行), 报场景前后对照。
// --overview-workers / --csv-workers 改并发路数(默认 20 / 2;perf-report「Phase 2 · 2026-10-01」§6b 的「随总览并发变化」
// 一表就是 --only account-heavy --overview-workers 1 与 4、--csv-workers 0、--idle-seconds 3、--heavy-seconds 20 各跑一次)。
// account-heavy 会往目标服务的库里写(挂限价买单、撤单;撤不掉的单冻结现金), 所以只对本地开发主机跑(localhost、127.0.0.1、
// [::1]、*.localhost、*.test, 与 scripts/perf/local-base.mjs 同一判定), 别的主机在发出任何请求之前 exit 2, 除非显式 --allow-remote。
// 前六个场景只读(GET), 不受这条限制。
// 每张测试单挂上即撤: 撤单(DELETE /api/orders/<id>)不是 200 时隔 250 ms 重试一次(负载下可能 503 Busy 或 429),
// 场景结束、负载停下后再把仍没撤掉的补撤一次;撤单失败次数与最后仍挂着的单号都打印出来(挂着的限价买单会冻结现金)。
// 判定: 下单的 p99 < 2000 ms 且错误率 < 1%;总览同样(只看 200 的耗时与非 429 的失败;--overview-workers 0 时不看);
// CSV 每次都是 200(--csv-workers 0 时不看)。
// 不加依赖(Node 自带 fetch)。
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isLocalBase, refuseRemoteMessage } from "./perf/local-base.mjs";

const args = process.argv.slice(2);
const opts = { only: null, cookieFile: null, serverLog: null, heavySeconds: 60, idleSeconds: 15, overviewWorkers: 20, csvWorkers: 2, overviewBackoff: false, allowRemote: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => {
    const v = args[++i];
    if (v === undefined) {
      console.error(`${a} needs a value`);
      process.exit(2);
    }
    return v;
  };
  if (a === "--only") opts.only = value();
  else if (a === "--cookie-file") opts.cookieFile = value();
  else if (a === "--server-log") opts.serverLog = value();
  else if (a === "--heavy-seconds") opts.heavySeconds = Number(value());
  else if (a === "--idle-seconds") opts.idleSeconds = Number(value());
  else if (a === "--overview-workers") opts.overviewWorkers = Number(value());
  else if (a === "--csv-workers") opts.csvWorkers = Number(value());
  else if (a === "--overview-backoff") opts.overviewBackoff = true;
  else if (a === "--allow-remote") opts.allowRemote = true;
  else if (a.startsWith("--")) {
    console.error(`unknown argument ${a}`);
    process.exit(2);
  } else positional.push(a);
}
const only = opts.only;
for (const [flag, v, min] of [["--heavy-seconds", opts.heavySeconds, 1], ["--idle-seconds", opts.idleSeconds, 0], ["--overview-workers", opts.overviewWorkers, 0], ["--csv-workers", opts.csvWorkers, 0]]) {
  if (!Number.isInteger(v) || v < min) {
    console.error(`${flag} must be an integer >= ${min}, got ${v}`);
    process.exit(2);
  }
}
const base = (positional[0] ?? "http://localhost:3000").replace(/\/+$/, "");
const P99_LIMIT_MS = 2000;
const ERROR_RATE_LIMIT = 0.01;
const HEAVY_NAME = `account-heavy(大账本:${opts.overviewWorkers} 路总览${opts.overviewBackoff ? "(429 按 Retry-After 退避)" : ""} + ${opts.csvWorkers} 路流水导出 + 下单)`;
const heavyWanted = only === null || HEAVY_NAME.includes(only);
// account-heavy 会写库(挂单、撤单):要跑它时, 非本地主机在发出任何请求(含前六个场景)之前就拒绝, 除非 --allow-remote
if (heavyWanted && opts.cookieFile && !isLocalBase(base) && !opts.allowRemote) {
  console.error(`[load-test] account-heavy: ${refuseRemoteMessage(base)}`);
  process.exit(2);
}
const scenarios = [
  { name: "assets-poll(列表轮询)", url: `${base}/api/assets`, connections: 200, duration: 30 },
  { name: "symbol-poll(标的页轮询)", url: `${base}/api/assets/VCS-FOR-2021`, connections: 100, duration: 30 },
  { name: "home-html(首页)", url: `${base}/`, connections: 50, duration: 30 },
  { name: "market-instruments(终端标的列表)", url: `${base}/api/market/instruments`, connections: 200, duration: 30 },
  { name: "market-book(终端盘口轮询)", url: `${base}/api/market/VCS-FOR-2021/book`, connections: 100, duration: 30 },
  { name: "terminal-html(终端页)", url: `${base}/trade/VCS-FOR-2021`, connections: 50, duration: 30 },
].filter((s) => only === null || s.name.includes(only));

const rows = [];
for (const s of scenarios) {
  console.log(`=== ${s.name} · c=${s.connections} · ${s.duration}s · ${s.url}`);
  // --json: 结果以一行 JSON 打到 stdout(不画进度条与表格),下面自己汇总
  const r = spawnSync("npx", ["-y", "autocannon", "-c", String(s.connections), "-d", String(s.duration), "--json", s.url], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  let res;
  try {
    res = JSON.parse(line ?? "");
  } catch {
    console.log(`    autocannon produced no JSON (exit ${r.status})`);
    rows.push({ name: s.name, ok: false });
    continue;
  }
  const failures = (res.errors ?? 0) + (res.non2xx ?? 0);
  const attempts = (res.requests?.total ?? 0) + (res.errors ?? 0);
  const errorRate = attempts ? failures / attempts : 1;
  const row = {
    name: s.name,
    c: s.connections,
    rps: Math.round(res.requests?.average ?? 0),
    p50: res.latency?.p50,
    p99: res.latency?.p99,
    max: res.latency?.max,
    total: res.requests?.total ?? 0,
    errors: res.errors ?? 0,
    timeouts: res.timeouts ?? 0,
    non2xx: res.non2xx ?? 0,
    errorRate,
  };
  row.ok = typeof row.p99 === "number" && row.p99 < P99_LIMIT_MS && errorRate < ERROR_RATE_LIMIT;
  rows.push(row);
  console.log(
    `    req/s ${row.rps} · p50 ${row.p50} ms · p99 ${row.p99} ms · max ${row.max} ms · total ${row.total} · ` +
      `errors ${row.errors} (timeouts ${row.timeouts}) · non2xx ${row.non2xx} · error rate ${(errorRate * 100).toFixed(2)}% · ${row.ok ? "ok" : "NO-GO"}`,
  );
}

// ---- account-heavy ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 百分位(最近秩) */
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]);
};
/** 一组请求的统计:ms = 成功请求的耗时;errors = 连接错误 + 非 2xx */
// max 用 reduce 而不是 Math.max(...ms):总览的 429 不退避,几十万个样本展开会爆调用栈
const stats = (ms, errors) => ({ total: ms.length + errors, p50: pct(ms, 50), p99: pct(ms, 99), max: ms.length ? Math.round(ms.reduce((a, b) => (b > a ? b : a), -Infinity)) : null, errors });
/** 服务端日志里的 bot stats 行(ws-flood 同一写法) */
const botLines = (text) =>
  text
    .split("\n")
    .filter((l) => l.startsWith('{"src":"bot","ev":"stats"'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
const logSize = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
};

async function accountHeavy() {
  // 上面参数检查已拦过;这里再守一次, 保证本函数的第一个请求之前一定判过本地主机
  if (!isLocalBase(base) && !opts.allowRemote) throw new Error(refuseRemoteMessage(base));
  const cookie = readFileSync(opts.cookieFile, "utf8").trim();
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  const get = (path) => fetch(base + path, { headers });

  // 前置:会话有效、找一个非情景标的挂远离市价的买单
  const me = await get("/api/account/overview");
  if (me.status !== 200) throw new Error(`/api/account/overview → ${me.status} (is the cookie valid for this server?)`);
  await me.arrayBuffer();
  const inst = await (await get("/api/market/instruments")).json();
  const pick = inst.data.instruments.map((i) => i.instrument).find((i) => !i.isScenario && i.lastPrice != null);
  if (!pick) throw new Error("no non-scenario instrument with a last price");
  const tick = Math.max(1, pick.tickSize);
  const price = Math.max(tick, Math.floor((pick.lastPrice * 0.5) / tick) * tick);
  const quantity = Math.max(1, pick.minQty);

  // 下单采样:挂单 → 立即撤单,只计 POST /api/orders 的耗时
  const orders = { idle: { ms: [], errors: 0 }, heavy: { ms: [], errors: 0 } };
  // 撤单:attempts = 撤单请求数,failed = 不是 200 的次数(含重试),statuses = 非 200 的状态分布,leftover = 重试后仍没撤掉的单号
  const cancels = { attempts: 0, failed: 0, statuses: {}, leftover: [] };
  /** 撤一次;200 = 撤掉 */
  const cancelOnce = async (id) => {
    cancels.attempts++;
    try {
      const res = await fetch(`${base}/api/orders/${id}`, { method: "DELETE", headers });
      await res.arrayBuffer();
      if (res.ok) return true;
      cancels.statuses[res.status] = (cancels.statuses[res.status] ?? 0) + 1;
    } catch {
      cancels.statuses.network = (cancels.statuses.network ?? 0) + 1;
    }
    cancels.failed++;
    return false;
  };
  let phase = "idle";
  let placing = true;
  const placer = (async () => {
    while (placing) {
      const started = performance.now();
      const bucket = orders[phase];
      try {
        const res = await fetch(`${base}/api/orders`, {
          method: "POST",
          headers,
          body: JSON.stringify({ assetId: pick.id, side: "BUY", type: "LIMIT", price, quantity, clientOrderId: randomUUID() }),
        });
        const body = await res.json().catch(() => null);
        if (res.ok && body?.ok) {
          bucket.ms.push(performance.now() - started);
          const id = body.data.order.id;
          // 负载下撤单可能 503 Busy(D24(5))或 429:隔 250 ms 重试一次,仍不行就记下单号,场景结束后补撤
          if (!(await cancelOnce(id))) {
            await sleep(250);
            if (!(await cancelOnce(id))) cancels.leftover.push(id);
          }
        } else bucket.errors++;
      } catch {
        bucket.errors++;
      }
      await sleep(Math.max(0, 1100 - (performance.now() - started)));
    }
  })();

  console.log(`    orders only for ${opts.idleSeconds}s (LIMIT BUY ${quantity} t of ${pick.symbol} at ${price} cents, cancelled right away)…`);
  await sleep(opts.idleSeconds * 1000);

  const logOffset = opts.serverLog ? logSize(opts.serverLog) : null;
  phase = "heavy";
  const heavyUntil = performance.now() + opts.heavySeconds * 1000;
  // limited = 429(每用户限流, P2-13):单独计数, 不算错误、不进耗时统计
  const overview = { ms: [], errors: 0, limited: 0, limitedMs: [] };
  const csv = { ms: [], errors: 0, rows: [], statuses: {} };
  const overviewWorker = async () => {
    while (performance.now() < heavyUntil) {
      const started = performance.now();
      try {
        const res = await get("/api/account/overview");
        await res.arrayBuffer();
        if (res.ok) overview.ms.push(performance.now() - started);
        else if (res.status === 429) {
          overview.limited++;
          overview.limitedMs.push(performance.now() - started);
          if (opts.overviewBackoff) {
            const wait = Number(res.headers.get("Retry-After")) * 1000 || 1000;
            await sleep(Math.min(wait, Math.max(0, heavyUntil - performance.now())));
          }
        } else overview.errors++;
      } catch {
        overview.errors++;
      }
    }
  };
  const csvWorker = async () => {
    while (performance.now() < heavyUntil) {
      const started = performance.now();
      try {
        const res = await get("/api/transactions.csv");
        const text = await res.text();
        csv.statuses[res.status] = (csv.statuses[res.status] ?? 0) + 1;
        if (res.ok) {
          csv.ms.push(performance.now() - started);
          csv.rows.push(text.split("\n").filter(Boolean).length - 1);
        } else csv.errors++;
      } catch {
        csv.errors++;
      }
      const wait = 15_000 - (performance.now() - started);
      if (performance.now() + wait >= heavyUntil) break;
      await sleep(Math.max(0, wait));
    }
  };
  console.log(`    + ${opts.overviewWorkers} × /api/account/overview and ${opts.csvWorkers} × /api/transactions.csv for ${opts.heavySeconds}s…`);
  // 负载段至少持续 --heavy-seconds(两个路数都是 0 时只剩下单,也要跑满这么久,否则负载段 0 秒、没有样本)
  await Promise.all([
    ...Array.from({ length: opts.overviewWorkers }, overviewWorker),
    ...Array.from({ length: opts.csvWorkers }, csvWorker),
    sleep(Math.max(0, heavyUntil - performance.now())),
  ]);
  placing = false;
  await placer;
  // 负载停下之后补撤一次(每用户撤单 60 次 / 分钟,间隔 1.1 s 以免撞限流)
  const stillOpen = [];
  for (const id of cancels.leftover) {
    if (!(await cancelOnce(id))) stillOpen.push(id);
    await sleep(1100);
  }

  let bot = null;
  if (opts.serverLog) {
    const text = readFileSync(opts.serverLog);
    const cut = logOffset ?? 0;
    bot = { before: botLines(text.subarray(0, cut).toString("utf8")).slice(-3), during: botLines(text.subarray(cut).toString("utf8")) };
  }

  const o = stats(overview.ms, overview.errors);
  const c = stats(csv.ms, csv.errors);
  const idle = stats(orders.idle.ms, orders.idle.errors);
  const heavy = stats(orders.heavy.ms, orders.heavy.errors);
  const t = (v) => (v === null ? "—" : `${v} ms`);
  console.log("\n| account-heavy | 请求数 | p50 | p99 | 最大 | 错误 | 备注 |");
  console.log("|---|---|---|---|---|---|---|");
  const limited = stats(overview.limitedMs, 0);
  console.log(
    `| /api/account/overview × ${opts.overviewWorkers} 路 | ${o.total} | ${t(o.p50)} | ${t(o.p99)} | ${t(o.max)} | ${o.errors} | ${Math.round(o.total / opts.heavySeconds)} req/s;` +
      `另有 429 ${overview.limited} 次(${Math.round(overview.limited / opts.heavySeconds)} req/s,p50 / p99 ${t(limited.p50)} / ${t(limited.p99)}) |`,
  );
  console.log(
    `| /api/transactions.csv × ${opts.csvWorkers} 路 | ${c.total} | ${t(c.p50)} | ${t(c.p99)} | ${t(c.max)} | ${c.errors} | 每次行数 ${[...new Set(csv.rows)].join(" / ") || "—"};状态 ${JSON.stringify(csv.statuses)} |`,
  );
  console.log(`| POST /api/orders(只下单,对照) | ${idle.total} | ${t(idle.p50)} | ${t(idle.p99)} | ${t(idle.max)} | ${idle.errors} | ${opts.idleSeconds} s |`);
  console.log(`| POST /api/orders(负载期间) | ${heavy.total} | ${t(heavy.p50)} | ${t(heavy.p99)} | ${t(heavy.max)} | ${heavy.errors} | ${opts.heavySeconds} s |`);
  console.log(
    `撤单:${cancels.attempts} 次请求,失败 ${cancels.failed} 次${cancels.failed ? `(${JSON.stringify(cancels.statuses)})` : ""};` +
      `重试后仍挂着 ${cancels.leftover.length} 张,负载停下后补撤仍失败 ${stillOpen.length} 张${stillOpen.length ? `:${stillOpen.join(", ")}(限价买单冻结着现金,请手动撤掉)` : ""}`,
  );
  if (bot) {
    const fmt = (xs) => xs.map((x) => `${x.tickMs} ms(p99 ${x.p99Ms})`).join("、") || "—";
    console.log(`bot tickMs:场景前最后 ${bot.before.length} 行 ${fmt(bot.before)};场景期间 ${bot.during.length} 行 ${fmt(bot.during)}`);
  }
  const rate = (s) => (s.total ? s.errors / s.total : 1);
  // --overview-workers 0 / --csv-workers 0 时那一路没有请求, 不进判定(否则 p99 为 null、恒判 NO-GO)
  const ok =
    (opts.overviewWorkers === 0 || (o.p99 !== null && o.p99 < P99_LIMIT_MS && rate(o) < ERROR_RATE_LIMIT)) &&
    heavy.p99 !== null && heavy.p99 < P99_LIMIT_MS && rate(heavy) < ERROR_RATE_LIMIT &&
    (opts.csvWorkers === 0 || (c.total > 0 && c.errors === 0));
  return { name: HEAVY_NAME, c: opts.overviewWorkers + opts.csvWorkers, rps: Math.round(o.total / opts.heavySeconds), p50: o.p50 ?? heavy.p50, p99: Math.max(o.p99 ?? 0, heavy.p99 ?? 0), max: Math.max(o.max ?? 0, heavy.max ?? 0), total: o.total + c.total + heavy.total, errors: o.errors + c.errors + heavy.errors, timeouts: 0, non2xx: 0, errorRate: (o.errors + c.errors + heavy.errors) / Math.max(1, o.total + c.total + heavy.total), ok, bot, cancels: { ...cancels, stillOpen }, overviewLimited: overview.limited };
}

if (heavyWanted) {
  if (!opts.cookieFile) {
    if (only !== null) {
      console.error("account-heavy needs --cookie-file");
      process.exit(2);
    }
    console.log(`=== ${HEAVY_NAME}: skipped (no --cookie-file)`);
  } else {
    console.log(`=== ${HEAVY_NAME} · ${base}`);
    try {
      rows.push(await accountHeavy());
    } catch (e) {
      console.log(`    account-heavy failed: ${e instanceof Error ? e.message : e}`);
      rows.push({ name: HEAVY_NAME, ok: false });
    }
  }
}

console.log("\n| 场景 | 并发 | Req/s | p50 | p99 | 最大 | 请求总数 | 错误/超时/非2xx | 错误率 | 结论 |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  if (r.p99 === undefined) {
    console.log(`| ${r.name} | - | - | - | - | - | - | - | - | NO-GO(无结果) |`);
    continue;
  }
  console.log(
    `| ${r.name} | ${r.c} | ${r.rps} | ${r.p50} ms | ${r.p99} ms | ${r.max} ms | ${r.total} | ${r.errors}/${r.timeouts}/${r.non2xx} | ${(r.errorRate * 100).toFixed(2)}% | ${r.ok ? "GO" : "NO-GO"} |`,
  );
}
const go = rows.length > 0 && rows.every((r) => r.ok);
console.log(`\n${go ? "GO" : "NO-GO"}: p99 < ${P99_LIMIT_MS} ms 且错误率 < ${ERROR_RATE_LIMIT * 100}%(${rows.length} 个场景)`);
process.exit(go ? 0 : 1);
