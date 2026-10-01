#!/usr/bin/env node
// @ts-check
// Lighthouse 单页多次运行的逐次明细(只报告,不作门禁;P2-11)。两个用处:
//   ① 回滚模式(START_MODE=next)的测量:页面每 2 s 轮询,真实节流下 Lighthouse 算不出 TTI / TBT
//      (NO_TTI_NETWORK_IDLE_PERIOD),`npm run perf:lh` 把缺指标当失败(exit 2);这里缺的指标照实打印审计的错误码。
//   ② 「整页慢一拍」(LCP = FCP ≈ 2.68 s)的排查:每次打印 DOMContentLoaded、首次绘制、两者之差与其间的主线程任务,
//      区分「页面真的慢」与「无头 Chrome 在 DevTools 节流下没有及时出帧」(docs/perf-report.md「Phase 2 · 2026-10-01」§2)。
//
//   node scripts/perf/lh-runs.mjs http://localhost:3982/trade/VCS-FOR-2021 --form devtools --runs 3
//   node scripts/perf/lh-runs.mjs http://localhost:3982/trade/account --runs 3 --cookie-file <文件>          # 已登录态
//   node scripts/perf/lh-runs.mjs http://localhost:3982/trade/account --runs 3 --headers-file <JSON 文件>    # 任意请求头
//   node scripts/perf/lh-runs.mjs --analyze <report.json> [<report.json> …]                                # 只分析已保留的报告
//   选项:--form devtools|simulate|desktop(默认 devtools,即移动真实节流)、--runs N(默认 3)、--keep-dir <目录>(保留每次的
//         Lighthouse JSON,默认用完即删)、--json(输出 JSON)
//
// 调用方式与 scripts/perf/lighthouse.mjs 相同:`npx --yes lighthouse@12 <url> --only-categories=performance --output=json
// --chrome-flags=--headless=new` 加上形态参数;--cookie-file 的 Cookie 头写进临时目录里的 JSON(0600)再经 --extra-headers 传路径。
// Lighthouse 会把 --extra-headers 的内容抄进每份报告的 configSettings.extraHeaders:带了 --cookie-file / --headers-file 时,
// 每次读回报告就删掉这一项并重写文件,再核对文件里没有请求头的值(有就删掉这份报告、exit 2),所以 --keep-dir 留下的报告里没有 cookie。
// 「整页慢一拍」的判定:首次绘制 − DOMContentLoaded > 1000 ms,且这段时间里主线程没有 > 50 ms 的任务。
// 退出码:0 跑完(不看预算);2 参数错误或 Lighthouse 失败。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LIGHTHOUSE = "lighthouse@12";
/** @type {Record<string, string[]>} */
const FORM_FLAGS = {
  devtools: ["--throttling-method=devtools"],
  simulate: ["--throttling-method=simulate"],
  desktop: ["--preset=desktop"],
};
const STALL_MS = 1000;
const LONG_TASK_MS = 50;

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[lh-runs] ${msg}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = {
    url: "",
    form: "devtools",
    runs: 3,
    cookieFile: /** @type {string | null} */ (null),
    headersFile: /** @type {string | null} */ (null),
    keepDir: /** @type {string | null} */ (null),
    analyze: /** @type {string[]} */ ([]),
    json: false,
  };
  let analyzing = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--analyze") analyzing = true;
    else if (a === "--form") o.form = value();
    else if (a === "--runs") o.runs = Number(value());
    else if (a === "--cookie-file") o.cookieFile = value();
    else if (a === "--headers-file") o.headersFile = value();
    else if (a === "--keep-dir") o.keepDir = value();
    else if (a === "--json") o.json = true;
    else if (!a.startsWith("-")) {
      if (analyzing) o.analyze.push(a);
      else o.url = a;
    } else die(`unknown argument ${a}`);
  }
  if (analyzing) {
    if (!o.analyze.length) die("--analyze needs at least one Lighthouse JSON report");
    return o;
  }
  if (!o.url) die("usage: node scripts/perf/lh-runs.mjs <url> [--form devtools|simulate|desktop] [--runs N] [--cookie-file F | --headers-file F] [--keep-dir D] [--json]");
  if (!FORM_FLAGS[o.form]) die(`--form must be devtools, simulate or desktop, got ${o.form}`);
  if (!Number.isInteger(o.runs) || o.runs < 1) die(`--runs must be a positive integer`);
  if (o.cookieFile && o.headersFile) die("pass either --cookie-file or --headers-file, not both");
  return o;
}

/**
 * 一份报告 → 逐次明细。时间都相对导航开始(ms)。
 * @param {any} lhr
 * @param {string} label
 */
function analyze(lhr, label) {
  const audits = lhr.audits ?? {};
  /** 数值或审计的错误(缺指标时照实报) @param {string} id */
  const metric = (id) => {
    const a = audits[id];
    if (typeof a?.numericValue === "number") return { value: a.numericValue, error: null };
    return { value: null, error: `${a?.scoreDisplayMode ?? "missing"}${a?.errorMessage ? `: ${String(a.errorMessage).slice(0, 48)}` : ""}` };
  };
  const observed = audits.metrics?.details?.items?.[0] ?? {};
  const dcl = typeof observed.observedDomContentLoaded === "number" ? observed.observedDomContentLoaded : null;
  const firstPaint = typeof observed.observedFirstPaint === "number" ? observed.observedFirstPaint : null;
  /** @type {{ startTime: number; duration: number }[]} */
  const tasks = audits["main-thread-tasks"]?.details?.items ?? [];
  const between = dcl !== null && firstPaint !== null ? tasks.filter((t) => t.startTime >= dcl && t.startTime < firstPaint) : [];
  const longest = between.reduce((m, t) => Math.max(m, t.duration), 0);
  const paintAfterDcl = dcl !== null && firstPaint !== null ? firstPaint - dcl : null;
  /** @type {any[]} */
  const requests = audits["network-requests"]?.details?.items ?? [];
  const doc = requests.find((r) => r.resourceType === "Document");
  return {
    label,
    url: lhr.finalDisplayedUrl ?? lhr.requestedUrl ?? null,
    throttlingMethod: lhr.configSettings?.throttlingMethod ?? null,
    formFactor: lhr.configSettings?.formFactor ?? null,
    lcp: metric("largest-contentful-paint"),
    fcp: metric("first-contentful-paint"),
    tbt: metric("total-blocking-time"),
    cls: metric("cumulative-layout-shift"),
    tti: metric("interactive"),
    dcl,
    firstPaint,
    paintAfterDcl,
    tasksBetween: { count: between.length, totalMs: between.reduce((s, t) => s + t.duration, 0), longestMs: longest },
    requests: requests.length,
    document: doc ? { startMs: doc.networkRequestTime ?? null, endMs: doc.networkEndTime ?? null, status: doc.statusCode ?? null } : null,
    stall: paintAfterDcl !== null && paintAfterDcl > STALL_MS && longest <= LONG_TASK_MS,
  };
}

/**
 * 跑一次 Lighthouse,报告写到 out。Lighthouse 把 --extra-headers 的内容原样抄进报告的 configSettings.extraHeaders
 * (12.8.2 core/runner.js 的 `configSettings: settings`),所以带了请求头时,读回报告后先删掉这一项、重写文件,
 * 再确认文件里不再出现任何一个请求头的值;还出现就删掉这份报告并报错。这样 --keep-dir 保留下来的报告里没有会话 cookie。
 * @param {string} url @param {string} form @param {string} out @param {string | null} headersFile @param {string[]} secrets 请求头的值
 */
function runLighthouse(url, form, out, headersFile, secrets) {
  const args = ["--yes", LIGHTHOUSE, url, "--only-categories=performance", "--output=json", `--output-path=${out}`, "--quiet", "--chrome-flags=--headless=new", ...FORM_FLAGS[form]];
  if (headersFile) args.push(`--extra-headers=${headersFile}`);
  const r = spawnSync("npx", args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`lighthouse failed for ${url} (${form}), exit ${r.status}: ${(r.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`);
  const lhr = JSON.parse(fs.readFileSync(out, "utf8"));
  if (headersFile) {
    if (lhr.configSettings) delete lhr.configSettings.extraHeaders;
    const text = JSON.stringify(lhr);
    fs.writeFileSync(out, text);
    if (secrets.some((v) => text.includes(v))) {
      fs.rmSync(out, { force: true });
      throw new Error(`the Lighthouse report for ${url} (${form}) still contains a request-header value after removing configSettings.extraHeaders; deleted it`);
    }
  }
  if (lhr.runtimeError) throw new Error(`lighthouse runtime error for ${url} (${form}): ${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
  return lhr;
}

/** 请求头文件里的值(用来核对报告里没有它们);太短的值(< 8 个字符)不查,免得误报 @param {string} file @returns {string[]} */
function headerValues(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`--headers-file ${file} is not a JSON object of header names to values`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`--headers-file ${file} is not a JSON object of header names to values`);
  return Object.values(parsed)
    .map((v) => String(v))
    .filter((v) => v.length >= 8);
}

/** @param {ReturnType<typeof analyze>[]} rows */
function print(rows) {
  const ms = (/** @type {number | null} */ v) => (v === null ? "—" : `${Math.round(v)}`);
  const m = (/** @type {{ value: number | null; error: string | null }} */ x, /** @type {(v: number) => string} */ f) => (x.value === null ? `(${x.error})` : f(x.value));
  console.log("| 次 | 口径 | LCP | FCP | TBT | CLS | TTI | DCL | 首次绘制 | 绘制 − DCL | 其间主线程任务(个 / 合计 / 最长 ms) | 请求数 | 整页慢一拍 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const t = r.tasksBetween;
    console.log(
      `| ${r.label} | ${r.formFactor ?? "?"} / ${r.throttlingMethod ?? "?"} | ${m(r.lcp, (v) => `${Math.round(v)}`)} | ${m(r.fcp, (v) => `${Math.round(v)}`)} | ${m(r.tbt, (v) => `${Math.round(v)}`)} | ${m(r.cls, (v) => v.toFixed(3))} | ${m(r.tti, (v) => `${Math.round(v)}`)} | ${ms(r.dcl)} | ${ms(r.firstPaint)} | ${ms(r.paintAfterDcl)} | ${t.count} / ${Math.round(t.totalMs)} / ${Math.round(t.longestMs)} | ${r.requests} | ${r.stall ? "**是**" : "否"} |`,
    );
  }
  const stalls = rows.filter((r) => r.stall).length;
  console.log(`[lh-runs] ${rows.length} 次里 ${stalls} 次「整页慢一拍」(首次绘制 − DCL > ${STALL_MS} ms,且其间没有 > ${LONG_TASK_MS} ms 的主线程任务)`);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.analyze.length) {
    const rows = o.analyze.map((file) => {
      let lhr;
      try {
        lhr = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        die(`${file} is not a readable Lighthouse JSON report`);
      }
      return analyze(lhr, path.basename(file, ".json"));
    });
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else print(rows);
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "carbadia-lh-runs-"));
  const outDir = o.keepDir ? path.resolve(o.keepDir) : tmp;
  /** @type {ReturnType<typeof analyze>[]} */
  const rows = [];
  /** @type {string | null} */
  let failure = null;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    /** @type {string | null} */
    let headersFile = o.headersFile ? path.resolve(o.headersFile) : null;
    /** 请求头的值:报告写出后核对里面没有它们(见 runLighthouse) @type {string[]} */
    let secrets = headersFile ? headerValues(headersFile) : [];
    if (o.cookieFile) {
      const cookie = fs.readFileSync(o.cookieFile, "utf8").trim();
      if (!cookie || cookie.includes("\n")) throw new Error(`--cookie-file ${o.cookieFile} must hold one non-empty line (the Cookie header value)`);
      // 传给 Lighthouse 的请求头文件放临时目录(用完即删,不放 --keep-dir);Lighthouse 会把请求头抄进每份报告的
      // configSettings.extraHeaders,runLighthouse 在读回报告后删掉它并重写,保留下来的报告里没有 cookie
      headersFile = path.join(tmp, "extra-headers.json");
      fs.writeFileSync(headersFile, JSON.stringify({ Cookie: cookie }), { mode: 0o600 });
      secrets = [cookie, ...cookie.split(";").map((part) => part.trim()).filter((part) => part.length >= 8)];
    }
    for (let n = 1; n <= o.runs; n++) {
      const lhr = runLighthouse(o.url, o.form, path.join(outDir, `${o.form}-${n}.json`), headersFile, secrets);
      const row = analyze(lhr, `#${n}`);
      rows.push(row);
      if (!o.json) console.error(`[lh-runs] #${n}: LCP ${row.lcp.value === null ? row.lcp.error : Math.round(row.lcp.value)} · 绘制 − DCL ${row.paintAfterDcl === null ? "—" : Math.round(row.paintAfterDcl)} ms${row.stall ? " · 整页慢一拍" : ""}`);
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failure !== null) die(failure);
  if (o.json) console.log(JSON.stringify({ url: o.url, form: o.form, loggedIn: o.cookieFile !== null, keptIn: o.keepDir ? outDir : null, runs: rows }, null, 2));
  else {
    print(rows);
    if (o.keepDir) console.log(`[lh-runs] 报告保留在 ${outDir}`);
  }
}

main();
