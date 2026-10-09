#!/usr/bin/env node
// @ts-check
// 首屏 JS 体积门禁(计划 §7.1「路由级分割、图表懒加载」、§7.2;P1-24)。构建后运行:
//
//   npm run build && npm run perf:chunks            # 表格 + 断言,任一不满足 exit 1
//   npm run perf:chunks -- --json                   # 同样的断言,输出 JSON(各路由的文件表、大小、标记命中)
//   node scripts/perf/chunk-report.mjs --dir <另一个 .next 目录>   # 对别的构建产物跑(例如检查旧构建会不会被放过)
//
// Turbopack 生产构建没有 .next/app-build-manifest.json。本脚本读两种产物,缺一即 exit 1 并打印缺失路径(绝不静默跳过):
//   - .next/build-manifest.json 的 rootMainFiles(每个路由都带的运行时);
//   - 每个目标路由的 .next/server/app/<route>/page_client-reference-manifest.js:一条
//     globalThis.__RSC_MANIFEST["/<route>/page"] = {...} 赋值,用 node:vm 在只有空 __RSC_MANIFEST 的沙箱里求值,
//     取 entryJSFiles 各键(layout / template / page / 根级 metadata / global-error …)的并集。
// 集合(与 HTML 里的 <script> 一致:/ 的预渲染 HTML 引用的正好是 rootMainFiles ∪ 全部 entryJSFiles,外加一个 nomodule 的 polyfill):
//   首屏 = rootMainFiles ∪ 全部 entryJSFiles;
//   底价 floor = rootMainFiles ∪ entry(src/app/layout) ∪ entry(src/app/template)(每个页面都带);
//   路由自有 = 首屏 − floor;
//   懒加载组 = 首屏 chunk 里 Turbopack 动态导入加载器 `Promise.all(["static/chunks/…"].map(…))` 列出的 chunk 组(next/dynamic)。
// 体积:node:zlib gzip level 9(断言用);brotli 只报告。1 KB = 1024 字节。
// 库检测用压缩后仍存在的属性名(压缩后的 chunk 里没有 node_modules 路径,按路径检测会空通过,见计划 R25),一个标记命中即算:
//   motion = whileHover / layoutId / reducedMotion;lightweight-charts = lastValueVisible / priceLineVisible;
//   市场 store(src/lib/market/store.ts)= tickersVersion / instrumentsVersion / evictSymbol(它的状态键与 action 名);
//   终端文案(src/i18n/messages/terminal/*,P2-01)= 其中三条文案的原文(字符串字面量压缩后原样保留):
//   "Includes your order"、"Resting on the book"(英文)与「含你的委托」(中文);改这三条文案时同步改这里的标记;
//   资产页文案(src/i18n/messages/account/*,P2-10)= "Retirements and certificates"、"Minimum fill (t)"(英文)与「注销记录与证书」(中文),
//   改这三条文案时同样同步改这里;
//   通知句子与面板文案(src/i18n/messages/notices/*,P3-08 修订;终审修复轮换了第二条)= "Your trades, triggered orders"、"your alert price"(英文)与「你的成交、条件单触发」(中文),
//   改这三条文案时同样同步改这里(别选终端文案里也有的句子:终端的 "No one was buying" 就在 /trade 的自有 chunk 里)。
// 断言(预算:Phase 1 收尾按实测重定;P2-01 把终端文案移出全站公共包后按新实测 + 约 3 KB 下调 floor 与受它影响的首屏数;
// Phase 3 收尾(P3-11)按最终实测 + 约 2 KB 定了一次,此后只下调不上调;理由见 docs/perf-report.md 与计划 §7.1、§9.1 第 61 条):
//   floor ≤ 201 KB;/ 首屏 ≤ 219 KB 且自有 ≤ 20 KB;/market/[symbol] 首屏 ≤ 223 KB;
//   /trade/[symbol] 自有 ≤ 77 KB 且首屏 ≤ 278 KB(= floor 预算 + 自有预算);图表懒加载组 ≤ 64 KB;
//   /trade/account 自有 ≤ 48 KB 且首屏 ≤ 249 KB(= floor 预算 + 自有预算);
//   /trade/markets 自有 ≤ 33 KB 且首屏 ≤ 234 KB(= floor 预算 + 自有预算;市场总览页,P3-05);
//   lightweight-charts 不在任何路由的首屏集合;motion 不在 /trade/[symbol] 与 /trade/markets 的自有集合;
//   市场 store 不在 /trade 以外任何路由(/、/market/[symbol])的首屏集合(计划 §7.1:它只在 /trade 的自有 chunk 里);
//   终端文案不在 /trade 以外任何路由(/、/market/[symbol])的首屏集合(计划 §6.2.2 C9:它只随 /trade 的 chunk 加载);
//   资产页文案不在 /、/market/[symbol]、/trade/[symbol] 的首屏集合(P2-10:它只随 /trade/account 的 chunk 加载,终端首屏不背它);
//   通知文案不在任何路由的首屏集合(含 floor:Nav 的铃铛每页都有,但句子只随懒加载的通知面板与首条实时通知才加载的 Toast 文案 chunk 走)。
// 资产页 /trade/account 也在读取之列(P2-10):表格里照常列出、lightweight-charts 的断言照样覆盖它;体积预算见上(P2-11)。
// 市场总览页 /trade/markets(P3-05)同理;它不读资产页文案,所以下面「资产页文案不在 …」的断言也覆盖它。
// 市场 store 与终端文案的「不在」断言只针对 /trade 之外的路由(资产页挂着 AccountFeed、在 /trade 布局之下,两者都在它的首屏里是预期)。
// 阳性对照(失败即打印「检测失效」并 exit 1,说明标记过期或清单读错):
//   / 的首屏集合必须检出 motion;/trade 的懒加载组里必须有一组检出 lightweight-charts;/trade 的自有集合必须检出市场 store;
//   /trade 的自有集合必须检出终端文案;/trade/account 的自有集合必须检出资产页文案;/ 的某个懒加载组必须检出通知文案(通知面板)。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import zlib from "node:zlib";

const KB = 1024;

/** 目标路由:清单里的键 → 相对 .next/server/app 的清单文件 */
const ROUTES = /** @type {const} */ ([
  { key: "/page", manifest: "page_client-reference-manifest.js" },
  { key: "/market/[symbol]/page", manifest: "market/[symbol]/page_client-reference-manifest.js" },
  { key: "/trade/[symbol]/page", manifest: "trade/[symbol]/page_client-reference-manifest.js" },
  { key: "/trade/account/page", manifest: "trade/account/page_client-reference-manifest.js" },
  { key: "/trade/markets/page", manifest: "trade/markets/page_client-reference-manifest.js" },
]);
const HOME = "/page";
const MARKET = "/market/[symbol]/page";
const TRADE = "/trade/[symbol]/page";
const ACCOUNT = "/trade/account/page";
const MARKETS = "/trade/markets/page";
/** /trade 下的路由(终端页、资产页与市场总览页):市场 store 与终端文案都在它们的首屏里是预期 */
const underTrade = (/** @type {string} */ key) => key.startsWith("/trade/");

/** 底价的两个入口(根布局与根模板) */
const FLOOR_ENTRIES = ["[project]/src/app/layout", "[project]/src/app/template"];

const MARKERS = /** @type {const} */ ({
  motion: ["whileHover", "layoutId", "reducedMotion"],
  lightweightCharts: ["lastValueVisible", "priceLineVisible"],
  marketStore: ["tickersVersion", "instrumentsVersion", "evictSymbol"],
  terminalCopy: ["Includes your order", "Resting on the book", "含你的委托"],
  accountCopy: ["Retirements and certificates", "Minimum fill (t)", "注销记录与证书"],
  noticeCopy: ["Your trades, triggered orders", "your alert price", "你的成交、条件单触发"],
});
/** @typedef {keyof typeof MARKERS} Lib */
const LIBS = /** @type {Lib[]} */ (Object.keys(MARKERS));

/**
 * 预算(gzip KB)。P2-01(终端文案移出全站公共包)实测 floor 198.2、/ 首屏 214.3、/market/[symbol] 首屏 218.2,
 * 三项按实测 + 约 3 KB 下调(原 211 / 228 / 231);/trade 自有不变,/trade 首屏取 floor 预算 + 自有预算(原 290)。
 * 资产页(P2-11,Phase 2 收尾实测自有 39.0、首屏 237.1):自有按实测 + 约 3 KB,首屏同 /trade 的取法 = floor 预算 + 自有预算。
 * 市场总览页(P3-05,计划 §6.3.3):自有 ≤ 30、首屏 ≤ 243(= floor 预算 201 + 42,与资产页同一个首屏上限)。
 * Phase 3 期间上调过(计划 §9.1 第 61 条,P3-07 实测):条件单界面让 /trade 三条路由共用的终端文案多 1.9 KB、终端页另多约 3.3 KB,
 * 三项自有预算先到 74 / 45 / 32,P3-09 之后再给 1 KB(75 / 46);首屏按「floor 预算 + 自有预算」取。
 * P3-11 收尾按最终实测 + 约 2 KB(取整到 KB)定一次(构建 7f3a716 + 预算提交;实测 gzip):
 *   /trade/[symbol] 自有 74.56 → 77、首屏 275.40 → 278;/trade/account 自有 45.66 → 48、首屏 246.50 → 249;
 *   /trade/markets 自有 30.74 → 33、首屏 231.58 → 234(原 246,下调);/ 首屏 217.00 → 219(Nav 铃铛约 2.4 KB 进了每页的包,
 *   原预算只剩几个字节);/market/[symbol] 首屏 220.89 → 223。/trade 三条路由的首屏 = floor 预算 201 + 自有预算,与之前的取法一致。
 *   floor 201、/ 自有 20、图表懒加载组 64 不动(这三项只许下调)。从此所有预算只下调、不上调;真正的验收是 Lighthouse 的 LCP。
 */
const BUDGET = {
  floor: 201,
  homeFirst: 219,
  homeOwn: 20,
  marketFirst: 223,
  tradeOwn: 77,
  tradeFirst: 278,
  accountOwn: 48,
  accountFirst: 249,
  marketsOwn: 33,
  marketsFirst: 234,
  chartLazy: 64,
};

/**
 * @typedef {{ file: string; raw: number; gzip: number; brotli: number; floor: boolean; markers: Record<Lib, string[]> }} ChunkInfo
 * @typedef {{ files: string[]; raw: number; gzip: number; brotli: number; detected: Record<Lib, boolean> }} SetInfo
 */

/** 工作目录内的路径打印成相对路径,之外的原样打印 @param {string} f */
const show = (f) => {
  const r = path.relative(process.cwd(), f);
  return r === "" ? "." : r.startsWith("..") ? f : r;
};

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { dir: ".next", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--dir") o.dir = argv[++i] ?? "";
    else if (a.startsWith("--dir=")) o.dir = a.slice(6);
    else {
      console.error(`[chunk-report] unknown argument ${a}`);
      process.exit(2);
    }
  }
  if (!o.dir) {
    console.error("[chunk-report] --dir needs a value");
    process.exit(2);
  }
  return o;
}

/**
 * 求值一个 page_client-reference-manifest.js,返回它唯一那条清单
 * @param {string} file
 * @returns {{ key: string; entryJSFiles: Record<string, string[]>; entryCSSFiles: Record<string, unknown[]> }}
 */
function readClientManifest(file) {
  /** @type {Record<string, any>} */
  const sandbox = { __RSC_MANIFEST: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file, timeout: 5_000 });
  const entries = Object.entries(sandbox.__RSC_MANIFEST);
  if (entries.length !== 1) throw new Error(`${file}: expected one __RSC_MANIFEST entry, got ${entries.length}`);
  const [key, value] = entries[0];
  if (!value || typeof value.entryJSFiles !== "object") throw new Error(`${file}: no entryJSFiles`);
  return { key, entryJSFiles: value.entryJSFiles, entryCSSFiles: value.entryCSSFiles ?? {} };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = path.resolve(o.dir);
  const buildManifest = path.join(dir, "build-manifest.json");
  const manifestFiles = ROUTES.map((r) => ({ ...r, file: path.join(dir, "server", "app", r.manifest) }));

  // ---- 1. 定位产物:缺一即失败 ----
  const missing = [buildManifest, ...manifestFiles.map((m) => m.file)].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error("[chunk-report] FAIL missing build output (run `npm run build` first; this script expects the Turbopack production layout):");
    for (const f of missing) console.error(`  - ${show(f)}`);
    process.exit(1);
  }
  /** @type {string[]} */
  const rootMainFiles = JSON.parse(fs.readFileSync(buildManifest, "utf8")).rootMainFiles ?? [];
  if (!Array.isArray(rootMainFiles) || rootMainFiles.length === 0) {
    console.error(`[chunk-report] FAIL ${show(buildManifest)} has no rootMainFiles`);
    process.exit(1);
  }

  // ---- 2. 逐 chunk 体积与标记(带缓存) ----
  /** @type {Map<string, ChunkInfo>} */
  const chunks = new Map();
  /** @param {string} rel @returns {ChunkInfo} */
  const chunk = (rel) => {
    let info = chunks.get(rel);
    if (info) return info;
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
      console.error(`[chunk-report] FAIL chunk listed in a manifest is missing: ${rel}`);
      process.exit(1);
    }
    const buf = fs.readFileSync(abs);
    const text = buf.toString("utf8");
    info = {
      file: rel,
      raw: buf.length,
      gzip: zlib.gzipSync(buf, { level: 9 }).length,
      brotli: zlib.brotliCompressSync(buf).length,
      floor: false,
      markers: /** @type {Record<Lib, string[]>} */ (Object.fromEntries(LIBS.map((lib) => [lib, MARKERS[lib].filter((m) => text.includes(m))]))),
    };
    chunks.set(rel, info);
    return info;
  };
  /** @param {Iterable<string>} files @returns {SetInfo} */
  const measure = (files) => {
    const list = [...new Set(files)].sort();
    const infos = list.map(chunk);
    return {
      files: list,
      raw: infos.reduce((s, c) => s + c.raw, 0),
      gzip: infos.reduce((s, c) => s + c.gzip, 0),
      brotli: infos.reduce((s, c) => s + c.brotli, 0),
      detected: /** @type {Record<Lib, boolean>} */ (Object.fromEntries(LIBS.map((lib) => [lib, infos.some((c) => c.markers[lib].length > 0)]))),
    };
  };

  // ---- 3. 每路由的集合 ----
  /** @type {Record<string, { manifest: string; entries: Record<string, number>; firstLoad: SetInfo; own: SetInfo; floor: SetInfo; lazy: SetInfo[]; css: string[] }>} */
  const routes = {};
  /** @type {Set<string> | null} */
  let floorFiles = null;
  for (const m of manifestFiles) {
    let parsed;
    try {
      parsed = readClientManifest(m.file);
    } catch (e) {
      console.error(`[chunk-report] FAIL cannot read ${show(m.file)}: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    if (parsed.key !== m.key) {
      console.error(`[chunk-report] FAIL ${show(m.file)} holds ${parsed.key}, expected ${m.key}`);
      process.exit(1);
    }
    const missingEntries = FLOOR_ENTRIES.filter((k) => !parsed.entryJSFiles[k]);
    if (missingEntries.length) {
      console.error(`[chunk-report] FAIL ${m.key}: entryJSFiles has no ${missingEntries.join(", ")}`);
      process.exit(1);
    }
    const first = new Set([...rootMainFiles, ...Object.values(parsed.entryJSFiles).flat()]);
    const floor = new Set([...rootMainFiles, ...FLOOR_ENTRIES.flatMap((k) => parsed.entryJSFiles[k])]);
    // 三个路由的底价应当是同一组文件(同一个根布局);不一致说明清单或集合定义出了问题
    if (floorFiles && [...floor].sort().join() !== [...floorFiles].sort().join()) {
      console.error(`[chunk-report] FAIL ${m.key}: root layout/template chunks differ from the other routes`);
      process.exit(1);
    }
    floorFiles = floor;
    const own = [...first].filter((f) => !floor.has(f));
    // 懒加载组:首屏 chunk 里 Turbopack 动态导入加载器列出的 chunk 组
    /** @type {string[][]} */
    const lazyGroups = [];
    const seen = new Set();
    for (const f of first) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      for (const match of text.matchAll(/Promise\.all\(\[((?:"static\/chunks\/[^"]+\.js",?)+)\]\.map/g)) {
        const group = [...match[1].matchAll(/"(static\/chunks\/[^"]+\.js)"/g)].map((g) => g[1]).filter((g) => !first.has(g));
        const key = group.slice().sort().join();
        if (group.length && !seen.has(key)) {
          seen.add(key);
          lazyGroups.push(group);
        }
      }
    }
    routes[m.key] = {
      manifest: path.relative(dir, m.file),
      entries: Object.fromEntries(Object.entries(parsed.entryJSFiles).map(([k, v]) => [k.replace("[project]/", ""), v.length])),
      firstLoad: measure(first),
      own: measure(own),
      floor: measure(floor),
      lazy: lazyGroups.map(measure),
      css: [...new Set(Object.values(parsed.entryCSSFiles).flat().map((c) => (typeof c === "string" ? c : /** @type {any} */ (c)?.path)).filter(Boolean))].sort(),
    };
  }
  for (const f of floorFiles ?? []) chunk(f).floor = true;

  // ---- 4. 断言与阳性对照 ----
  const home = routes[HOME];
  const market = routes[MARKET];
  const trade = routes[TRADE];
  const account = routes[ACCOUNT];
  const markets = routes[MARKETS];
  const chartGroups = trade.lazy.filter((g) => g.detected.lightweightCharts);
  const kb = (/** @type {number} */ b) => Math.round((b / KB) * 10) / 10;
  /** @type {{ label: string; pass: boolean; control?: boolean }[]} */
  const checks = [
    { label: `floor ${kb(home.floor.gzip)} KB <= ${BUDGET.floor} KB`, pass: home.floor.gzip <= BUDGET.floor * KB },
    { label: `/ first load ${kb(home.firstLoad.gzip)} KB <= ${BUDGET.homeFirst} KB`, pass: home.firstLoad.gzip <= BUDGET.homeFirst * KB },
    { label: `/ own ${kb(home.own.gzip)} KB <= ${BUDGET.homeOwn} KB`, pass: home.own.gzip <= BUDGET.homeOwn * KB },
    { label: `/market/[symbol] first load ${kb(market.firstLoad.gzip)} KB <= ${BUDGET.marketFirst} KB`, pass: market.firstLoad.gzip <= BUDGET.marketFirst * KB },
    { label: `/trade/[symbol] own ${kb(trade.own.gzip)} KB <= ${BUDGET.tradeOwn} KB`, pass: trade.own.gzip <= BUDGET.tradeOwn * KB },
    { label: `/trade/[symbol] first load ${kb(trade.firstLoad.gzip)} KB <= ${BUDGET.tradeFirst} KB`, pass: trade.firstLoad.gzip <= BUDGET.tradeFirst * KB },
    { label: `/trade/account own ${kb(account.own.gzip)} KB <= ${BUDGET.accountOwn} KB`, pass: account.own.gzip <= BUDGET.accountOwn * KB },
    { label: `/trade/account first load ${kb(account.firstLoad.gzip)} KB <= ${BUDGET.accountFirst} KB`, pass: account.firstLoad.gzip <= BUDGET.accountFirst * KB },
    { label: `/trade/markets own ${kb(markets.own.gzip)} KB <= ${BUDGET.marketsOwn} KB`, pass: markets.own.gzip <= BUDGET.marketsOwn * KB },
    { label: `/trade/markets first load ${kb(markets.firstLoad.gzip)} KB <= ${BUDGET.marketsFirst} KB`, pass: markets.firstLoad.gzip <= BUDGET.marketsFirst * KB },
    ...chartGroups.map((g) => ({ label: `chart lazy group ${g.files.join(" + ")} ${kb(g.gzip)} KB <= ${BUDGET.chartLazy} KB`, pass: g.gzip <= BUDGET.chartLazy * KB })),
    ...Object.entries(routes).map(([key, r]) => ({ label: `lightweight-charts not in ${key} first load`, pass: !r.firstLoad.detected.lightweightCharts })),
    { label: "motion not in /trade/[symbol] own chunks", pass: !trade.own.detected.motion },
    { label: "motion not in /trade/markets own chunks", pass: !markets.own.detected.motion },
    // 市场 store 只允许出现在 /trade 下路由的自有 chunk 里(floor 属于每个路由的首屏,所以也一并排除了 floor)
    ...Object.entries(routes)
      .filter(([key]) => !underTrade(key))
      .map(([key, r]) => ({ label: `market store not in ${key} first load`, pass: !r.firstLoad.detected.marketStore })),
    // 终端文案只随 /trade 加载(计划 §6.2.2 C9):别的路由的首屏(含 floor)里一条都不该有
    ...Object.entries(routes)
      .filter(([key]) => !underTrade(key))
      .map(([key, r]) => ({ label: `terminal copy not in ${key} first load`, pass: !r.firstLoad.detected.terminalCopy })),
    // 资产页文案只随 /trade/account 加载(P2-10):终端页的首屏也不背它
    ...Object.entries(routes)
      .filter(([key]) => key !== ACCOUNT)
      .map(([key, r]) => ({ label: `portfolio page copy not in ${key} first load`, pass: !r.firstLoad.detected.accountCopy })),
    // 通知句子与面板文案只随懒加载的 chunk 走(P3-08 修订):任何路由的首屏(含 floor)里一条都不该有
    ...Object.entries(routes).map(([key, r]) => ({ label: `notice copy not in ${key} first load`, pass: !r.firstLoad.detected.noticeCopy })),
    { label: "control: motion detected in / first load", pass: home.firstLoad.detected.motion, control: true },
    { label: "control: lightweight-charts detected in a /trade lazy group", pass: chartGroups.length > 0, control: true },
    { label: "control: market store detected in /trade own chunks", pass: trade.own.detected.marketStore, control: true },
    { label: "control: terminal copy detected in /trade own chunks", pass: trade.own.detected.terminalCopy, control: true },
    { label: "control: portfolio page copy detected in /trade/account own chunks", pass: account.own.detected.accountCopy, control: true },
    { label: "control: notice copy detected in a lazy group of /", pass: home.lazy.some((g) => g.detected.noticeCopy), control: true },
  ];
  const failed = checks.filter((c) => !c.pass);
  const controlFailed = failed.some((c) => c.control);

  if (o.json) {
    const out = {
      dir: show(dir),
      units: { size: "bytes", gzipLevel: 9 },
      budgetsKB: BUDGET,
      markers: MARKERS,
      rootMainFiles,
      routes: Object.fromEntries(
        Object.entries(routes).map(([key, r]) => [
          key,
          {
            manifest: r.manifest,
            entries: r.entries,
            files: r.firstLoad.files.map((f) => {
              const c = chunk(f);
              return { file: f, raw: c.raw, gzip: c.gzip, brotli: c.brotli, floor: c.floor, markers: c.markers };
            }),
            firstLoad: { raw: r.firstLoad.raw, gzip: r.firstLoad.gzip, brotli: r.firstLoad.brotli, detected: r.firstLoad.detected },
            floor: { gzip: r.floor.gzip, brotli: r.floor.brotli },
            own: { files: r.own.files, gzip: r.own.gzip, brotli: r.own.brotli, detected: r.own.detected },
            lazy: r.lazy.map((g) => ({ files: g.files, gzip: g.gzip, brotli: g.brotli, detected: g.detected })),
            css: r.css,
          },
        ]),
      ),
      checks,
      ok: failed.length === 0,
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    const pad = (/** @type {string} */ s, /** @type {number} */ n) => s.padEnd(n);
    const num = (/** @type {number} */ b) => kb(b).toFixed(1).padStart(7);
    console.log(`[chunk-report] ${show(dir)} · gzip -9 / brotli, KB = 1024 B`);
    console.log(`${pad("route", 24)} ${pad("", 8)}   floor     own   first   (brotli first)`);
    for (const [key, r] of Object.entries(routes)) {
      console.log(`${pad(key, 24)} ${pad("gzip", 8)} ${num(r.floor.gzip)} ${num(r.own.gzip)} ${num(r.firstLoad.gzip)}   (${kb(r.firstLoad.brotli).toFixed(1)})`);
      console.log(`${pad("", 24)} own: ${r.own.files.map((f) => `${path.basename(f)} ${kb(chunk(f).gzip)}`).join(", ") || "—"}`);
      for (const g of r.lazy) console.log(`${pad("", 24)} lazy: ${g.files.map((f) => path.basename(f)).join(" + ")} ${kb(g.gzip)} KB${g.detected.lightweightCharts ? " (lightweight-charts)" : ""}`);
    }
    console.log(`rootMainFiles ${kb(measure(rootMainFiles).gzip)} KB · floor files ${home.floor.files.length}`);
    const top = [...chunks.values()].filter((c) => routes[TRADE].firstLoad.files.includes(c.file) || routes[HOME].firstLoad.files.includes(c.file)).sort((a, b) => b.gzip - a.gzip).slice(0, 15);
    console.log("top first-load chunks (gzip KB · floor? · markers):");
    for (const c of top) {
      const hits = LIBS.filter((lib) => c.markers[lib].length).map((lib) => `${lib}[${c.markers[lib].join("/")}]`);
      console.log(`  ${pad(path.basename(c.file), 26)} ${num(c.gzip)} ${c.floor ? "floor" : "     "} ${hits.join(" ")}`);
    }
    console.log(`css (report only): ${[...new Set(Object.values(routes).flatMap((r) => r.css))].map((f) => `${path.basename(f)} ${fs.existsSync(path.join(dir, f)) ? kb(zlib.gzipSync(fs.readFileSync(path.join(dir, f)), { level: 9 }).length) : "?"} KB`).join(", ")}`);
    for (const c of checks) console.log(`[chunk-report] ${c.pass ? "PASS" : "FAIL"} ${c.label}`);
  }
  if (controlFailed) console.error("[chunk-report] 检测失效:阳性对照没有命中(标记过期或清单读错),体积与库断言不可信");
  process.exit(failed.length ? 1 : 0);
}

main();
