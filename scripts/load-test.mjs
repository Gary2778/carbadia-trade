// scripts/load-test.mjs — 用法: node scripts/load-test.mjs [baseUrl] [--only <名称片段>]
// 模拟发布波峰: 行情轮询为主(与前端 2s 轮询同型), 混合首页 HTML 与单标的行情;
// 2026-09 终端升级(计划 §7.5)加三个场景: 公开行情 /api/market/instruments c=200、/api/market/VCS-FOR-2021/book c=100、
// 终端页 /trade/VCS-FOR-2021 c=50。与既有三场景一起跑, 对比 2026-09-25 基线(p99 176 / 26 / 13 ms)。
// go/no-go 不变: 任一场景 p99 >= 2000 ms 或错误率 >= 1% → NO-GO(exit 1)。错误 = 连接错误 / 超时 + 非 2xx 响应。
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const onlyAt = args.indexOf("--only");
const only = onlyAt === -1 ? null : args[onlyAt + 1];
const positional = args.filter((a, i) => !a.startsWith("--") && (onlyAt === -1 || i !== onlyAt + 1));
const base = (positional[0] ?? "http://localhost:3000").replace(/\/+$/, "");
const P99_LIMIT_MS = 2000;
const ERROR_RATE_LIMIT = 0.01;
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
