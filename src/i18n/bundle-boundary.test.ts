import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 终端文案的打包边界(docs/trade-upgrade-plan.md §6.2.2 C9;P2-01)。
// terminal 命名空间两种语言约 6 KB gzip,只许随 /trade 的 chunk 加载。这里按源码的静态引入关系守三件事:
//   1. 从根布局 / 根模板可达的运行时模块,不引入合并后的文案对象(messages/en.ts、zh-CN.ts),也不引入终端文案模块;
//   2. /trade 之外的任何路由文件可达的模块同样不引入它们,并且不调用 useT("terminal")(那里没有 Provider,调用即抛错);
//   3. 谁可以直接引入这些模块是写死的名单(合并对象只给类型与测试;终端文案只经 TerminalMessages.tsx;Provider 只由 /trade 的布局挂)。
// 构建产物一侧的对应检查在 scripts/perf/chunk-report.mjs(终端文案的特征字符串不在 / 与 /market/[symbol] 的首屏文件里)。
// P2-10 起资产页 /trade/account 的文案(account 命名空间)按同一办法再守一层:只随 /trade/account 的布局加载 ——
// 不进根布局、不进 /trade 之外的路由、也不进终端页 /trade/[symbol];只有资产页可达的模块调用 useT("account")。
//
// 扫描是正则,不是完整解析器:`import type … from` 与 `export type … from` 算类型引入(编译后消失),不跟;
// 其余 import / export … from / import() / require() 都算运行时引入并跟进去(动态 import 也算:懒加载的 chunk 照样会在那个路由上被拉下来)。
// 注释不剥:注释里写了一条 import 语句会被当真,只会多报,不会漏报。带内联 `type` 修饰的混合引入(`import a, { type B }`)按运行时算。

const SRC = fileURLToPath(new URL("../", import.meta.url));
const rel = (abs: string) => relative(SRC, abs).split("\\").join("/");
const SOURCE = /\.(ts|tsx|mts|mjs|js|jsx)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

const MERGED = ["i18n/messages/en.ts", "i18n/messages/zh-CN.ts"];
const TERMINAL_COPY = ["i18n/messages/terminal/en.ts", "i18n/messages/terminal/zh-CN.ts"];
const PROVIDER = "i18n/TerminalMessages.tsx";
const TEST_SUPPORT = "i18n/test-support.ts";
const ACCOUNT_COPY = ["i18n/messages/account/en.ts", "i18n/messages/account/zh-CN.ts"];
const ACCOUNT_PROVIDER = "i18n/AccountMessages.tsx";
/** /trade 之外不得出现在可达集合里的模块 */
const TRADE_ONLY = [...MERGED, ...TERMINAL_COPY, PROVIDER, TEST_SUPPORT, ...ACCOUNT_COPY, ACCOUNT_PROVIDER];
/** /trade/account 之外(含终端页)不得出现在可达集合里的模块 */
const ACCOUNT_ONLY = [...ACCOUNT_COPY, ACCOUNT_PROVIDER];

// ------------------------------------------------------------------ 引入关系
/** 源码里的运行时引入(模块说明符,按出现顺序,不去重) */
function runtimeImports(source: string): string[] {
  const out: Array<[index: number, spec: string]> = [];
  // import x from "y" / import { a, b } from "y" / import * as n from "y" / import "y";`import type …` 整条跳过
  const importRe = /(?<![\w$.])import\s+(type\s+(?=[\w${*]))?(?:[\w$*{][^'"`;()]*?\bfrom\s*)?["']([^"'\n]+)["']/g;
  for (let m = importRe.exec(source); m; m = importRe.exec(source)) if (!m[1]) out.push([m.index, m[2]]);
  // export * from "y" / export * as n from "y" / export { a } from "y";`export type … from` 跳过
  const exportRe = /(?<![\w$.])export\s+(type\s+)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"'\n]+)["']/g;
  for (let m = exportRe.exec(source); m; m = exportRe.exec(source)) if (!m[1]) out.push([m.index, m[2]]);
  // import("y") / require("y");`typeof import("y")` 是类型查询,跳过
  const callRe = /(?<![\w$.])(?<!typeof\s)(?:import|require)\(\s*["']([^"'\n]+)["']\s*\)/g;
  for (let m = callRe.exec(source); m; m = callRe.exec(source)) out.push([m.index, m[1]]);
  return out.sort((a, b) => a[0] - b[0]).map(([, spec]) => spec);
}

/** Prisma 生成的客户端(不进版本库,`prisma generate` 产出):当作外部包,不扫、不跟 */
const GENERATED = "generated/";

/** "@/…" 与相对路径解析到 src 里的文件;包名与生成目录返回 null;解析不到的记进 unresolved(断言它为空,扫描才不是瞎的) */
const unresolved = new Set<string>();
function resolveImport(fromAbs: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromAbs), spec);
  else return null;
  if (rel(base).startsWith(GENERATED)) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  unresolved.add(`${rel(fromAbs)} → ${spec}`);
  return null;
}

const importCache = new Map<string, string[]>();
/** 一个源文件直接引入(运行时)的 src 内文件,绝对路径 */
function directImports(abs: string): string[] {
  let found = importCache.get(abs);
  if (!found) {
    found = SOURCE.test(abs)
      ? [...new Set(runtimeImports(readFileSync(abs, "utf8")).map((spec) => resolveImport(abs, spec)).filter((f): f is string => f !== null && f !== abs))]
      : [];
    importCache.set(abs, found);
  }
  return found;
}

/** 从一组入口出发可达的全部文件(相对 src 的路径 → 引入它的那个文件,入口自己是 null) */
function reachable(entries: string[]): Map<string, string | null> {
  const via = new Map<string, string | null>();
  const queue: string[] = [];
  for (const e of entries) {
    const abs = join(SRC, e);
    if (!existsSync(abs)) throw new Error(`entry ${e} does not exist`);
    via.set(e, null);
    queue.push(abs);
  }
  for (let abs = queue.pop(); abs; abs = queue.pop()) {
    for (const next of directImports(abs)) {
      if (via.has(rel(next))) continue;
      via.set(rel(next), rel(abs));
      queue.push(next);
    }
  }
  return via;
}

/** 失败时打印的引入链:入口 → … → 目标 */
function chain(via: Map<string, string | null>, target: string): string {
  const steps = [target];
  for (let at = via.get(target); at; at = via.get(at)) steps.unshift(at);
  return steps.join(" → ");
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!`${rel(full)}/`.startsWith(GENERATED)) out.push(...listFiles(full));
    }
    else if (SOURCE.test(name) && !TEST_FILE.test(name)) out.push(rel(full));
  }
  return out.sort();
}

/**
 * 去掉注释后是否调用了 useT("terminal")。块注释整段去掉;行注释从 `//` 起去掉,前一个字符是 `:` 或引号的不算(URL 与字符串);
 * 紧跟在引号后面的 useT( 是字符串里的字样(LangProvider 的报错文案),不算调用。
 */
function callsNamespaceT(abs: string, ns: "terminal" | "account"): boolean {
  const code = readFileSync(abs, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  return new RegExp(String.raw`(?<!["'\`])\buseT\(\s*["']${ns}["']\s*\)`).test(code);
}
const callsTerminalT = (abs: string): boolean => callsNamespaceT(abs, "terminal");
const callsAccountT = (abs: string): boolean => callsNamespaceT(abs, "account");

const ALL_SOURCES = listFiles(SRC);
const APP_FILES = ALL_SOURCES.filter((f) => f.startsWith("app/"));
const OUTSIDE_TRADE = APP_FILES.filter((f) => !f.startsWith("app/trade/"));
const ACCOUNT_ROUTE = APP_FILES.filter((f) => f.startsWith("app/trade/account/"));
const OUTSIDE_ACCOUNT = APP_FILES.filter((f) => !f.startsWith("app/trade/account/"));
const ROOT_ENTRIES = ["app/layout.tsx", "app/template.tsx"];

// ------------------------------------------------------------------ 扫描器自身
describe("bundle-boundary scanner", () => {
  it("follows value imports, re-exports, side-effect and dynamic imports, and skips type-only ones", () => {
    const src = [
      'import a from "./a";',
      'import type { B } from "./b";',
      'import c, { type C } from "./c";',
      "import {",
      "  d,",
      "  e,",
      '} from "@/d";',
      'import * as f from "./f";',
      'import "./g.css";',
      'export * from "./h";',
      'export { i } from "./i";',
      'export type { J } from "./j";',
      'const k = await import("./k");',
      'type L = typeof import("./l");',
      'const m = require("./m");',
      'import type N from "./n";',
      'const o = dynamic(() => import("@/o"), { ssr: false });',
    ].join("\n");
    expect(runtimeImports(src)).toEqual(["./a", "./c", "@/d", "./f", "./g.css", "./h", "./i", "./k", "./m", "@/o"]);
  });

  it("resolves every '@/' and relative import it meets to a file under src", () => {
    reachable(ALL_SOURCES);
    expect([...unresolved]).toEqual([]);
  });
});

// ------------------------------------------------------------------ 边界
describe("terminal copy stays out of everything outside /trade (§6.2.2 C9)", () => {
  it("is not reachable from the root layout or the root template, which only pull the core namespaces", () => {
    const via = reachable(ROOT_ENTRIES);
    // 扫描确实走进了根布局的依赖:LangProvider、核心文案、Nav 与它渲染的 Demo 徽标都在
    for (const expected of ["i18n/LangProvider.tsx", "i18n/index.ts", "i18n/messages/core/en.ts", "i18n/messages/core/zh-CN.ts", "components/Nav.tsx", "components/terminal/DemoBadge.tsx"]) {
      expect(via.has(expected), expected).toBe(true);
    }
    expect(via.size).toBeGreaterThan(30);
    expect(TRADE_ONLY.filter((f) => via.has(f)).map((f) => chain(via, f))).toEqual([]);
  });

  it("is not reachable from any route file outside /trade, and nothing reachable from there calls useT(\"terminal\")", () => {
    expect(OUTSIDE_TRADE).toContain("app/page.tsx");
    expect(OUTSIDE_TRADE).toContain("app/market/[symbol]/page.tsx");
    const via = reachable(OUTSIDE_TRADE);
    expect(TRADE_ONLY.filter((f) => via.has(f)).map((f) => chain(via, f))).toEqual([]);
    const callers = [...via.keys()].filter((f) => SOURCE.test(f) && callsTerminalT(join(SRC, f)));
    expect(callers.map((f) => chain(via, f))).toEqual([]);
  });

  it("reaches /trade through its shared layout only (positive control for the two checks above)", () => {
    const layout = reachable(["app/trade/layout.tsx"]);
    for (const f of [PROVIDER, ...TERMINAL_COPY]) expect(layout.has(f), f).toBe(true);
    // 合并对象连 /trade 也不引入:它只给类型与测试
    const trade = reachable(APP_FILES.filter((f) => f.startsWith("app/trade/")));
    expect([...MERGED, TEST_SUPPORT].filter((f) => trade.has(f)).map((f) => chain(trade, f))).toEqual([]);
    // useT("terminal") 的检测有效:终端页可达的模块里有几十个调用方
    expect([...trade.keys()].filter((f) => SOURCE.test(f) && callsTerminalT(join(SRC, f))).length).toBeGreaterThan(25);
  });

  it("lets only the listed modules import the merged objects, the terminal copy and its provider", () => {
    const importers = (target: string) => ALL_SOURCES.filter((f) => directImports(join(SRC, f)).some((dep) => rel(dep) === target));
    // 合并对象:运行时代码一个都不引入(测试文件不在 ALL_SOURCES 里;test-support 是测试专用)
    for (const merged of MERGED) expect(importers(merged), merged).toEqual([]);
    expect(importers(TEST_SUPPORT)).toEqual([]);
    // 终端文案:Provider 与两个合并对象
    expect(importers("i18n/messages/terminal/en.ts")).toEqual([PROVIDER, "i18n/messages/en.ts"]);
    expect(importers("i18n/messages/terminal/zh-CN.ts")).toEqual([PROVIDER, "i18n/messages/zh-CN.ts"]);
    // Provider:/trade 的共用布局(test-support 在测试里替它包一层)
    expect(importers(PROVIDER)).toEqual(["app/trade/layout.tsx", TEST_SUPPORT]);
    // 资产页文案(P2-10):同样只经自己的 Provider 与两个合并对象;Provider 只由资产页的布局挂
    expect(importers("i18n/messages/account/en.ts")).toEqual([ACCOUNT_PROVIDER, "i18n/messages/en.ts"]);
    expect(importers("i18n/messages/account/zh-CN.ts")).toEqual([ACCOUNT_PROVIDER, "i18n/messages/zh-CN.ts"]);
    expect(importers(ACCOUNT_PROVIDER)).toEqual(["app/trade/account/layout.tsx", TEST_SUPPORT]);
  });
});

// ------------------------------------------------------------------ 资产页文案(P2-10)
describe("portfolio page copy (account namespace) stays inside /trade/account", () => {
  it("is not reachable from any route file outside /trade/account (the terminal page included), and nothing reachable from there calls useT(\"account\")", () => {
    expect(OUTSIDE_ACCOUNT).toContain("app/trade/[symbol]/page.tsx");
    expect(OUTSIDE_ACCOUNT).toContain("app/trade/layout.tsx");
    const via = reachable(OUTSIDE_ACCOUNT);
    expect(ACCOUNT_ONLY.filter((f) => via.has(f)).map((f) => chain(via, f))).toEqual([]);
    const callers = [...via.keys()].filter((f) => SOURCE.test(f) && callsAccountT(join(SRC, f)));
    expect(callers.map((f) => chain(via, f))).toEqual([]);
  });

  it("reaches the portfolio page through its own layout, which the page's components read (positive control)", () => {
    expect(ACCOUNT_ROUTE).toEqual(expect.arrayContaining(["app/trade/account/layout.tsx", "app/trade/account/page.tsx"]));
    const layout = reachable(["app/trade/account/layout.tsx"]);
    for (const f of ACCOUNT_ONLY) expect(layout.has(f), f).toBe(true);
    const page = reachable(ACCOUNT_ROUTE);
    // 资产页可达的模块里确实有 useT("account") 的调用方(上一条的检测不是空转)
    expect([...page.keys()].filter((f) => SOURCE.test(f) && callsAccountT(join(SRC, f))).length).toBeGreaterThanOrEqual(4);
    // 合并对象与测试辅助照样不进资产页
    expect([...MERGED, TEST_SUPPORT].filter((f) => page.has(f)).map((f) => chain(page, f))).toEqual([]);
  });
});
