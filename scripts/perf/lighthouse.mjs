#!/usr/bin/env node
// @ts-check
// Lighthouse 首屏度量(计划 §7.1「首屏 LCP」、§7.2;P1-24,P1-26 改移动门禁口径)。对着已经在跑的生产构建(`node server.mjs`,bot 开)运行:
//
//   npm run perf:lh -- http://localhost:3940                  # 默认两页 × 移动真实节流 3 次 + 移动模拟节流 3 次 + 桌面 3 次
//   npm run perf:lh -- http://localhost:3940 --runs 3 --sim-runs 0 --desktop-runs 1 --paths /trade/VCS-FOR-2021,/ [--json]
//   npm run perf:lh -- --help
//
// 每次调用 `npx --yes lighthouse@12 <url> --only-categories=performance --output=json --chrome-flags="--headless=new"`
// (不加依赖,npx 临时取;需要本机装有 Chrome)。三种形态 · 口径:
//   · 移动 · 真实节流(门禁):`--throttling-method=devtools`。4G 参数就是 Lighthouse 移动默认的那一组(mobileSlow4G 的 DevTools 值:
//     请求延迟 562.5 ms = 150 ms RTT × 3.75、下行 1474.56 Kbps = 1.6 Mbps × 0.9、上行 675 Kbps、CPU 4× 减速),浏览器真的按这个速度加载。
//   · 移动 · 模拟节流(只报告):Lighthouse 默认的 Lantern 模拟(150 ms RTT / 1.6 Mbps / CPU 4×,即「模拟 4G」),照常跑、照常打印,
//     不断言 —— 用户决定(计划 §9.1 第 46 条,2026-09-30):本地的移动 LCP 按真实节流判定,Lantern 把本机加载时文字画出之前
//     已下载并执行的请求都算进 LCP(docs/perf-report.md §2「Lantern 核对」),它的数字留作对照。
//   · 桌面(门禁):`--preset=desktop`(Lighthouse 默认的桌面模拟节流),与 P1-24 相同。
// 每次运行后核对报告里的 configSettings(throttlingMethod、formFactor)与所要的一致,不一致按 Lighthouse 失败处理,
// 以免参数被静默改掉;表头打印实际生效的节流参数。
// 每页每种形态对 LCP / FCP / TBT / CLS / Speed Index **各自**取中位数(偶数次取较大的中间值,偏保守),门禁形态按各项中位数断言;
// 性能分与 LCP 元素选择器只报告,取 LCP 中位数的那一次。
// 预算(计划 §7.1,移动与桌面同一套):LCP < 2.0 s、TBT < 200 ms、CLS < 0.1;门禁形态的任一中位数超出 exit 1(模拟节流超出只打印 INFO)。
// Lighthouse 自身失败(非零退出、runtimeError、缺指标、节流口径不符)exit 2;临时目录在任何情况下都会删掉(先抛错、finally 清理、再退出)。
// 本地没有 Cloudflare 边缘与 brotli,数字偏保守;部署后对线上地址再跑一遍记入 docs/perf-report.md。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_BASE = "http://localhost:3940";
const DEFAULT_PATHS = ["/trade/VCS-FOR-2021", "/"];
const BUDGET = { lcpMs: 2000, tbtMs: 200, cls: 0.1 };
const LIGHTHOUSE = "lighthouse@12";

/**
 * 三种形态 · 口径。gate = 是否按预算断言(决定退出码);method / formFactor 用来核对 Lighthouse 报告里实际生效的设置。
 * @typedef {"mobile-devtools" | "mobile-simulate" | "desktop"} Form
 * @type {Record<Form, { label: string; flags: string[]; method: "devtools" | "simulate"; formFactor: "mobile" | "desktop"; gate: boolean }>}
 */
const FORMS = {
  "mobile-devtools": { label: "移动 · 真实节流", flags: ["--throttling-method=devtools"], method: "devtools", formFactor: "mobile", gate: true },
  "mobile-simulate": { label: "移动 · 模拟节流(Lantern)", flags: ["--throttling-method=simulate"], method: "simulate", formFactor: "mobile", gate: false },
  desktop: { label: "桌面", flags: ["--preset=desktop"], method: "simulate", formFactor: "desktop", gate: true },
};

const HELP = `用法:npm run perf:lh -- [baseUrl] [选项]

对 baseUrl(默认 ${DEFAULT_BASE})上的每个页面跑 Lighthouse 12 的性能类别,打印 Markdown 表并断言预算
(LCP < ${BUDGET.lcpMs / 1000} s、TBT < ${BUDGET.tbtMs} ms、CLS < ${BUDGET.cls},按各项中位数)。

形态 · 口径:
  移动 · 真实节流(门禁)       --throttling-method=devtools,Lighthouse 移动默认的 4G 参数
                                (请求延迟 562.5 ms、下行 1474.56 Kbps、上行 675 Kbps、CPU 4×)
  移动 · 模拟节流(只报告)     Lighthouse 默认的 Lantern 模拟(150 ms RTT、1.6 Mbps、CPU 4×),照常打印,不断言
  桌面(门禁)                 --preset=desktop

选项:
  --runs N           每页移动真实节流的次数(门禁),默认 3,至少 1
  --sim-runs N       每页移动模拟节流的次数(只报告),默认 3;0 = 不跑
  --desktop-runs N   每页桌面的次数(门禁),默认 3;0 = 不跑
  --paths a,b        页面路径,逗号分隔,默认 ${DEFAULT_PATHS.join(",")}
  --json             输出 JSON(含每次运行、各项中位数、实际节流设置、门禁断言与只报告的对照)
  -h, --help         打印本说明

退出码:0 门禁全过;1 门禁有超预算(模拟节流不计);2 参数错误或 Lighthouse 自身失败(含节流口径与所要的不符)。
口径依据:计划 §7.1、§7.2 与 §9.1 第 46 条(用户 2026-09-30 决定本地移动 LCP 按真实节流判定)。`;

/**
 * @typedef {{ lcp: number; fcp: number; tbt: number; cls: number; si: number; score: number; lcpElement: string | null; throttling: Record<string, unknown> }} Run
 * @typedef {{ lcp: number; fcp: number; tbt: number; cls: number; si: number }} Medians
 * @typedef {{ path: string; form: Form; gate: boolean; throttlingMethod: string; throttling: Record<string, unknown>; runs: Run[]; median: Medians; lcpRun: Run }} Result
 */

/** 单次 Lighthouse 失败:runOnce 抛出,main 在 finally 清掉临时目录之后 exit 2(process.exit 会跳过 finally) */
class LighthouseError extends Error {}

/** 参数错误:只在 parseArgs 里用(那时临时目录还没建,直接退出不会漏删) @param {string} msg */
function die(msg) {
  console.error(`[lighthouse] ${msg}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { base: DEFAULT_BASE, runs: 3, simRuns: 3, desktopRuns: 3, paths: DEFAULT_PATHS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => inline ?? argv[++i] ?? die(`${flag} needs a value`);
    const int = (/** @type {string} */ v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) die(`${flag} must be a non-negative integer, got ${v}`);
      return n;
    };
    if (flag === "-h" || flag === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (flag === "--json") o.json = true;
    else if (flag === "--runs") o.runs = int(value());
    else if (flag === "--sim-runs") o.simRuns = int(value());
    else if (flag === "--desktop-runs") o.desktopRuns = int(value());
    else if (flag === "--paths") o.paths = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (!a.startsWith("-")) o.base = a.replace(/\/+$/, "");
    else die(`unknown argument ${a} (see --help)`);
  }
  if (o.runs < 1) die("--runs must be >= 1 (the mobile gate needs real-throttling runs)");
  return o;
}

/** LCP 元素:v12 的 largest-contentful-paint-element 细节是一组表,第一张表第一行的 node */
function lcpSelector(/** @type {any} */ lhr) {
  const details = lhr.audits?.["largest-contentful-paint-element"]?.details;
  const tables = details?.type === "list" ? details.items : [details];
  for (const table of tables ?? []) {
    const node = table?.items?.[0]?.node;
    if (node) return `${node.selector ?? "?"}${node.snippet ? ` ${String(node.snippet).slice(0, 80)}` : ""}`;
  }
  return null;
}

/** @param {string} url @param {Form} form @param {string} outDir @param {number} n @returns {Run} */
function runOnce(url, form, outDir, n) {
  const spec = FORMS[form];
  const out = path.join(outDir, `${form}-${n}.json`);
  const args = ["--yes", LIGHTHOUSE, url, "--only-categories=performance", "--output=json", `--output-path=${out}`, "--quiet", "--chrome-flags=--headless=new", ...spec.flags];
  const r = spawnSync("npx", args, { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"], timeout: 180_000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new LighthouseError(`lighthouse failed for ${url} (${form}), exit ${r.status}: ${(r.stderr ?? "").trim().split("\n").slice(-5).join(" | ")}`);
  const lhr = JSON.parse(fs.readFileSync(out, "utf8"));
  if (lhr.runtimeError) throw new LighthouseError(`lighthouse runtime error for ${url} (${form}): ${lhr.runtimeError.code} ${lhr.runtimeError.message}`);
  // 口径核对:报告里实际生效的节流方式与形态必须是所要的(真实节流的门禁不能静默退回模拟)
  const settings = lhr.configSettings ?? {};
  if (settings.throttlingMethod !== spec.method || settings.formFactor !== spec.formFactor) {
    throw new LighthouseError(`lighthouse ran ${url} as ${settings.formFactor}/${settings.throttlingMethod}, expected ${spec.formFactor}/${spec.method} (${form})`);
  }
  const num = (/** @type {string} */ id) => {
    const v = lhr.audits?.[id]?.numericValue;
    if (typeof v !== "number") throw new LighthouseError(`lighthouse result for ${url} (${form}) has no ${id}`);
    return v;
  };
  return {
    lcp: num("largest-contentful-paint"),
    fcp: num("first-contentful-paint"),
    tbt: num("total-blocking-time"),
    cls: num("cumulative-layout-shift"),
    si: num("speed-index"),
    score: Math.round((lhr.categories?.performance?.score ?? 0) * 100),
    lcpElement: lcpSelector(lhr),
    throttling: settings.throttling ?? {},
  };
}

/** 中位数;偶数个取较大的中间值(这些指标越小越好,取较大者偏保守) @param {number[]} values */
function upperMedian(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 各项指标分别取中位数(断言用),另留 LCP 中位数的那一次(只用于报告性能分与 LCP 元素) @param {Run[]} runs */
function summarize(runs) {
  /** @type {Medians} */
  const median = {
    lcp: upperMedian(runs.map((r) => r.lcp)),
    fcp: upperMedian(runs.map((r) => r.fcp)),
    tbt: upperMedian(runs.map((r) => r.tbt)),
    cls: upperMedian(runs.map((r) => r.cls)),
    si: upperMedian(runs.map((r) => r.si)),
  };
  const lcpRun = [...runs].sort((a, b) => a.lcp - b.lcp)[Math.floor(runs.length / 2)];
  return { median, lcpRun };
}

/** 实际生效的节流参数,一行:真实节流看 DevTools 那组,模拟节流看 Lantern 那组 @param {Result} r */
function describeThrottling(r) {
  const raw = /** @type {Record<string, number>} */ (r.throttling);
  // 1.6 × 1024 × 0.9 这类乘积带浮点尾巴(1474.5600000000002),按两位小数打印
  const t = (/** @type {string} */ key) => (typeof raw[key] === "number" ? String(Math.round(raw[key] * 100) / 100) : "?");
  return r.throttlingMethod === "devtools"
    ? `devtools:请求延迟 ${t("requestLatencyMs")} ms、下行 ${t("downloadThroughputKbps")} Kbps、上行 ${t("uploadThroughputKbps")} Kbps、CPU ${t("cpuSlowdownMultiplier")}×`
    : `simulate(Lantern):RTT ${t("rttMs")} ms、${t("throughputKbps")} Kbps、CPU ${t("cpuSlowdownMultiplier")}×`;
}

/** 预算三项;gate 决定它们是门禁还是只报告 @param {Result} r */
function budgetChecks(r) {
  const at = `${r.path} ${r.form}`;
  return [
    { label: `${at} LCP ${Math.round(r.median.lcp)} ms < ${BUDGET.lcpMs} ms`, pass: r.median.lcp < BUDGET.lcpMs, gate: r.gate },
    { label: `${at} TBT ${Math.round(r.median.tbt)} ms < ${BUDGET.tbtMs} ms`, pass: r.median.tbt < BUDGET.tbtMs, gate: r.gate },
    { label: `${at} CLS ${r.median.cls.toFixed(3)} < ${BUDGET.cls}`, pass: r.median.cls < BUDGET.cls, gate: r.gate },
  ];
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "carbadia-lh-"));
  /** @type {Result[]} */
  const results = [];
  /** @type {string | null} */
  let failure = null;
  /** @type {[Form, number][]} */
  const plan = [["mobile-devtools", o.runs], ["mobile-simulate", o.simRuns], ["desktop", o.desktopRuns]];
  try {
    for (const p of o.paths) {
      for (const [form, count] of plan) {
        if (count === 0) continue;
        /** @type {Run[]} */
        const runs = [];
        for (let n = 1; n <= count; n++) {
          const run = runOnce(`${o.base}${p}`, form, outDir, n);
          runs.push(run);
          if (!o.json) console.error(`[lighthouse] ${p} ${form} #${n}: LCP ${Math.round(run.lcp)} ms · FCP ${Math.round(run.fcp)} ms · TBT ${Math.round(run.tbt)} ms · CLS ${run.cls.toFixed(3)} · SI ${Math.round(run.si)} ms · score ${run.score}`);
        }
        const spec = FORMS[form];
        results.push({ path: p, form, gate: spec.gate, throttlingMethod: spec.method, throttling: runs[0].throttling, runs, ...summarize(runs) });
      }
    }
  } catch (err) {
    // Lighthouse 失败与意外错误都走 exit 2;先让 finally 删掉临时目录
    failure = err instanceof LighthouseError ? err.message : `unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  if (failure !== null) {
    console.error(`[lighthouse] ${failure}`);
    process.exit(2);
  }

  const all = results.flatMap(budgetChecks);
  const checks = all.filter((c) => c.gate);
  const reports = all.filter((c) => !c.gate);
  const failed = checks.filter((c) => !c.pass);
  if (o.json) {
    console.log(JSON.stringify({ base: o.base, lighthouse: LIGHTHOUSE, budget: BUDGET, forms: FORMS, results, checks, reports, ok: failed.length === 0 }, null, 2));
  } else {
    const s = (/** @type {number} */ ms) => `${(ms / 1000).toFixed(2)} s`;
    // 每种形态实际生效的节流参数(取自 Lighthouse 报告的 configSettings,同一形态各页相同,打印第一页的)
    for (const form of /** @type {Form[]} */ (Object.keys(FORMS))) {
      const r = results.find((x) => x.form === form);
      if (r) console.log(`[lighthouse] ${FORMS[form].label}(${FORMS[form].gate ? "门禁" : "只报告,不作门禁"}):${describeThrottling(r)}`);
    }
    // LCP 到 Speed Index 是各项中位数;性能分与 LCP 元素取 LCP 中位数的那一次
    console.log(`| 页面 | 形态 · 口径 | 门禁 | 次数 | LCP | FCP | TBT | CLS | Speed Index | 性能分(LCP 中位那次) | LCP 元素(同) |`);
    console.log(`|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const r of results) {
      const m = r.median;
      console.log(`| \`${r.path}\` | ${FORMS[r.form].label} | ${r.gate ? "**门禁**" : "只报告"} | ${r.runs.length} | ${s(m.lcp)} | ${s(m.fcp)} | ${Math.round(m.tbt)} ms | ${m.cls.toFixed(3)} | ${s(m.si)} | ${r.lcpRun.score} | \`${(r.lcpRun.lcpElement ?? "—").replace(/\|/g, "\\|")}\` |`);
    }
    for (const c of checks) console.log(`[lighthouse] ${c.pass ? "PASS" : "FAIL"} ${c.label}`);
    for (const c of reports) console.log(`[lighthouse] INFO(模拟节流,不作门禁)${c.pass ? "在预算内" : "超预算"} ${c.label}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main();
