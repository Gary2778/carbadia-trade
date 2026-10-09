import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "./messages/en";

// 静态扫描(docs/trade-upgrade-plan.md §4.8):终端 / ui 基础件 / Nav / 市场 hooks 里经 useT("<ns>") 派生的每条
// 文案引用都必须能在 en 上解析,解析不到即失败——后续波次的组件引用了不存在的键,不用等运行时就能发现。
// 支持的写法:const t = useT("terminal") 后的 t.a.b、t.a["1m"]、t("a.b");以及内联的 useT("ui").retry。
// 动态索引(t.tabs.status[status])只解析到静态前缀;叶子(字符串 / 函数)之后的段(.length、.toUpperCase)忽略。
// 键按合并后的完整对象(./messages/en = 核心 + terminal)解析;P2-01 起另有一条断言给 terminal 引用数设下限,扫描不会空转。
//
// 扫描器是正则 + 轻量词法,不是完整解析器,边界如下(消费方须知):
// - 注释按词法剥掉;字符串 / 模板 / 正则字面量里的 `//` `/*` 不当注释。正则字面量只按前一个记号判断
//   (`( , = : [ ! & | ? ; {` 或 return / typeof 等关键字之后),不跨行;JSX 里的 `</div>`、`{a}/{b}` 不会被当成正则,
//   JSX 文本里裸写的 `//` 仍会被当作行注释(该行其后的引用漏扫);JSX 文本里落单的撇号(Don't)会让同一行
//   其后的 `//` 注释不被剥掉(注释里的 t.x 会被当引用)。字符串 / 正则字面量与行注释都不跨行,误判最多波及当前行。
// - 解构 `const { book } = useT("terminal")` 不解析(漏扫,不误报);请用 `const t = useT("terminal")`。
// - `t` 在同一文件另有绑定(回调参数、解构参数里的整词 `t`、`const t` 重声明、函数类型 `(t: X) => void` 的形参)
//   一律报「rebound」让作者改名,不猜它指谁;对象模式里 `{ t: alias }` 的 `t` 是属性名,不算绑定。
// - 三元里并排的箭头函数 `ok ? () => a(t.x) : () => b()` 不算重绑定(返回类型注解不含 `( ) ?`)。

const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));
// §4.8 列出前三处;任务记录另加 src/lib/market(hooks / toast 文案也可能在这里取)
// Phase 2:资产页与注销对话框(components/account、app/trade)也读 terminal.*;资产页另读 account(P2-10);目录还不存在时 listSourceFiles 返回空
// Phase 3:市场总览页 /trade/markets 的组件(components/markets)读 terminal.markets.*;通知(P3-08,components/notices)读核心命名空间 notices
const SCAN_ROOTS = ["components/terminal", "components/ui", "components/Nav.tsx", "lib/market", "components/account", "components/markets", "components/notices", "app/trade"];
const SOURCE_EXT = /\.(ts|tsx)$/;
const TEST_FILE = /\.(test|spec)\.(ts|tsx)$/;

type KeyRef = { file: string; line: number; expr: string; path: string[] };
type ScanFailure = { file: string; line: number; expr: string; reason: string };

// ------------------------------------------------------------------ 文件发现
function listSourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return [root];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const full = join(root, name);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out.sort();
}

// ------------------------------------------------------------------ 源码预处理
// 逐字符走一遍:注释抹掉但保留换行(行号才对得上);字符串 / 模板 / 正则字面量原样保留,它们内部的 `//` `/*`
// 不当注释(href="//cdn"、"a//b"、/\/\//)。模板里的 ${ } 表达式当代码处理,里面的 t.x 照常收集。
// 正则字面量按「前一个有效记号」判断,并且不跨行,误判最多波及当前行;`}` `)` `]` `<` `>` 之后一律当除号,
// 这样 JSX 的 `</div>` 与 `{a}/{b}` 不会被吞掉。
const REGEX_AFTER_PUNCT = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "{"]);
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "instanceof", "new", "delete", "void", "throw", "yield", "await"]);
const regexAllowedAfter = (token: string): boolean => token === "" || REGEX_AFTER_PUNCT.has(token) || REGEX_AFTER_WORD.has(token);
const blankKeepNewlines = (s: string) => s.replace(/[^\n]/g, "");

function stripComments(source: string): string {
  const n = source.length;
  let out = "";
  let i = 0;
  let last = ""; // 上一个有效记号:标点是单字符,标识符 / 关键字是整词;"" = 文件开头
  let inTemplate = false;
  const frames: number[] = []; // 每层未闭合模板字面量里 ${ } 内部的花括号深度
  while (i < n) {
    const c = source[i];
    if (inTemplate) {
      if (c === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { out += c; i++; inTemplate = false; last = "`"; continue; }
      if (c === "$" && source[i + 1] === "{") { out += "${"; i += 2; frames.push(0); inTemplate = false; last = "{"; continue; }
      out += c; i++; continue;
    }
    const d = source[i + 1];
    if (c === "/" && d === "/") { const j = source.indexOf("\n", i); i = j === -1 ? n : j; continue; }
    if (c === "/" && d === "*") {
      const j = source.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out += blankKeepNewlines(source.slice(i, end)); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      if (source[j] === c) j++;
      out += source.slice(i, j); i = j; last = c; continue;
    }
    if (c === "`") { out += c; i++; inTemplate = true; continue; }
    if (c === "/" && regexAllowedAfter(last)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== "\n") {
        const ch = source[j];
        if (ch === "\\") { j += 2; continue; }
        if (inClass) { if (ch === "]") inClass = false; }
        else if (ch === "[") inClass = true;
        else if (ch === "/") break;
        j++;
      }
      if (source[j] === "/") { j++; while (j < n && /[a-z]/i.test(source[j])) j++; }
      out += source.slice(i, j); i = j; last = "/"; continue;
    }
    if (frames.length) {
      if (c === "{") frames[frames.length - 1]++;
      else if (c === "}") {
        if (frames[frames.length - 1] === 0) { frames.pop(); out += c; i++; inTemplate = true; continue; }
        frames[frames.length - 1]--;
      }
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      out += word; i = j; last = word; continue;
    }
    out += c; i++;
    if (!/\s/.test(c)) last = c;
  }
  return out;
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

// 属性链 `.a.b["1m"]['x']` → ["a", "b", "1m", "x"]
const CHAIN = String.raw`((?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[\s*"[^"\n]*"\s*\]|\s*\[\s*'[^'\n]*'\s*\])+)`;
function splitChain(chain: string): string[] {
  const segs: string[] = [];
  const re = /\.\s*([A-Za-z_$][\w$]*)|\[\s*"([^"\n]*)"\s*\]|\[\s*'([^'\n]*)'\s*\]/g;
  for (let m = re.exec(chain); m; m = re.exec(chain)) segs.push(m[1] ?? m[2] ?? m[3] ?? "");
  return segs;
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 同一个标识符在文件里另有绑定(箭头函数参数、const 重声明…)时,t.price 到底指谁无法用正则判定,
// 直接报出来让作者改名,而不是给出误导性的「terminal.price 不存在」。
function findRebinding(source: string, ident: string): number | null {
  const id = escapeRe(ident);
  const declared = new RegExp(String.raw`\b(?:const|let|var|function|class)\s+${id}\b(?!\s*=\s*useT\()`, "g");
  const singleArrow = new RegExp(String.raw`(?<![\w$.])${id}\s*=>`, "g");
  // 返回类型注解里不许出现 ( ) ?,否则三元 `ok ? () => a(t.x) : () => b()` 里 `(t.x) : () =>` 会被连成一个参数表
  const paramList = /\(([^()]*)\)\s*(?::[^=;{}()?]*)?=>|\bfunction\b[^(]*\(([^()]*)\)/g;
  // 普通参数:逐个按整词比对(允许类型注解 / 默认值 / 剩余参数)
  const plainParam = new RegExp(String.raw`^${id}(?![\w$])`);
  // 解构参数 `({ t })` `({ a: t })` `([t])`:整词出现且后面不是 `:`(对象模式里 `t:` 是属性名)、`.` `(` `[`(默认值里用到外层 t)
  const patternBinding = new RegExp(String.raw`(?<![\w$.])${id}(?![\w$]|\s*[:.(\[])`);
  for (const re of [declared, singleArrow]) {
    const m = re.exec(source);
    if (m) return lineOf(source, m.index);
  }
  for (let m = paramList.exec(source); m; m = paramList.exec(source)) {
    const raw = m[1] ?? m[2] ?? "";
    if (/[{[]/.test(raw)) {
      if (patternBinding.test(raw)) return lineOf(source, m.index);
      continue;
    }
    const params = raw.split(",").map((p) => p.trim().replace(/^\.\.\./, ""));
    if (params.some((p) => plainParam.test(p))) return lineOf(source, m.index);
  }
  return null;
}

// ------------------------------------------------------------------ 引用收集
function collectRefs(rawSource: string, file: string): { refs: KeyRef[]; failures: ScanFailure[] } {
  const source = stripComments(rawSource);
  const refs: KeyRef[] = [];
  const failures: ScanFailure[] = [];

  // 1. const t = useT("ns") 绑定(同名多次绑定不同命名空间时,任一命名空间可解析即通过)
  const bindings = new Map<string, Set<string>>();
  const bindRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useT\(\s*"([^"]+)"\s*\)/g;
  for (let m = bindRe.exec(source); m; m = bindRe.exec(source)) {
    if (!bindings.has(m[1])) bindings.set(m[1], new Set());
    bindings.get(m[1])!.add(m[2]);
  }

  // 2. 内联 useT("ns").a.b
  const inlineRe = new RegExp(String.raw`useT\(\s*"([^"]+)"\s*\)${CHAIN}`, "g");
  for (let m = inlineRe.exec(source); m; m = inlineRe.exec(source)) {
    refs.push({ file, line: lineOf(source, m.index), expr: m[0].replace(/\s+/g, ""), path: [m[1], ...splitChain(m[2])] });
  }

  // 3. 每个绑定标识符的 t.a.b / t["x"] / t("a.b")
  for (const [ident, namespaces] of bindings) {
    const rebound = findRebinding(source, ident);
    if (rebound !== null) {
      failures.push({ file, line: rebound, expr: ident, reason: `\`${ident}\` is bound by useT() and rebound elsewhere in this file; rename one of them so key references stay unambiguous` });
      continue;
    }
    const id = escapeRe(ident);
    const memberRe = new RegExp(String.raw`(?<![\w$.])${id}${CHAIN}`, "g");
    const callRe = new RegExp(String.raw`(?<![\w$.])${id}\(\s*"([^"]+)"\s*\)`, "g");
    for (const ns of namespaces) {
      for (let m = memberRe.exec(source); m; m = memberRe.exec(source)) {
        refs.push({ file, line: lineOf(source, m.index), expr: m[0].replace(/\s+/g, ""), path: [ns, ...splitChain(m[1])] });
      }
      for (let m = callRe.exec(source); m; m = callRe.exec(source)) {
        refs.push({ file, line: lineOf(source, m.index), expr: m[0], path: [ns, ...m[1].split(".")] });
      }
    }
  }
  return { refs, failures };
}

// ------------------------------------------------------------------ 解析
// 逐段下钻;到达字符串 / 函数即视为命中(其后的段是方法访问);段缺失则返回缺失的路径
function resolveKey(root: unknown, path: string[]): { ok: true } | { ok: false; missingAt: string } {
  let node: unknown = root;
  for (let i = 0; i < path.length; i++) {
    if (typeof node === "string" || typeof node === "function") return { ok: true };
    if (node === null || typeof node !== "object" || !Object.prototype.hasOwnProperty.call(node, path[i])) {
      return { ok: false, missingAt: path.slice(0, i + 1).join(".") };
    }
    node = (node as Record<string, unknown>)[path[i]];
  }
  return { ok: true };
}

// 同名标识符绑定了多个命名空间时,任一可解析即通过
function checkRefs(refs: KeyRef[]): ScanFailure[] {
  const byKey = new Map<string, KeyRef[]>();
  for (const r of refs) {
    const k = `${r.file}:${r.line}:${r.expr}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }
  const failures: ScanFailure[] = [];
  for (const group of byKey.values()) {
    const results = group.map((r) => ({ r, res: resolveKey(en, r.path) }));
    if (results.some((x) => x.res.ok)) continue;
    const { r, res } = results[0];
    failures.push({ file: r.file, line: r.line, expr: r.expr, reason: `${r.path.join(".")} is not defined in en (missing at ${res.ok ? "" : res.missingAt})` });
  }
  return failures;
}

function scanTree(): { files: string[]; refs: KeyRef[]; failures: ScanFailure[] } {
  const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(join(SRC_DIR, root)));
  const refs: KeyRef[] = [];
  const failures: ScanFailure[] = [];
  for (const full of files) {
    const rel = relative(SRC_DIR, full);
    const r = collectRefs(readFileSync(full, "utf8"), rel);
    refs.push(...r.refs);
    failures.push(...r.failures);
  }
  failures.push(...checkRefs(refs));
  return { files: files.map((f) => relative(SRC_DIR, f)), refs, failures };
}

const format = (f: ScanFailure) => `${f.file}:${f.line}  ${f.expr}  →  ${f.reason}`;

// ------------------------------------------------------------------ 扫描器自身的阳性 / 阴性对照
describe("terminal-keys scanner", () => {
  it("resolves valid references, including bracket keys, method access and dynamic suffixes", () => {
    const src = [
      'const t = useT("terminal");',
      "const a = t.book.title;",
      'const b = t.chart.intervals["1m"];',
      "const c = t.book.title.toUpperCase();",
      "const d = t.tabs.status[status];",
      "const e = t.order.errors[reason];",
      'const f = useT("ui").retry;',
      'const g = t("meta.notProvided");',
      "const h = t.instruments.count(3);",
    ].join("\n");
    const { refs, failures } = collectRefs(src, "fixture.tsx");
    expect(failures).toEqual([]);
    expect(refs.map((r) => r.path.join("."))).toEqual([
      "ui.retry",
      "terminal.book.title",
      "terminal.chart.intervals.1m",
      "terminal.book.title.toUpperCase",
      "terminal.tabs.status",
      "terminal.order.errors",
      "terminal.instruments.count",
      "terminal.meta.notProvided",
    ]);
    expect(checkRefs(refs)).toEqual([]);
  });

  it("reports every reference that does not resolve, with file and line", () => {
    const src = [
      'const t = useT("terminal");',
      "const a = t.book.title;",
      "const b = t.book.nope;",
      'const c = t.chart.intervals["2m"];',
      'const d = t("order.errors.missing");',
      'const e = useT("ui").nothing;',
      "const f = t.notAGroup.x;",
    ].join("\n");
    const { refs, failures } = collectRefs(src, "fixture.tsx");
    expect(failures).toEqual([]);
    const bad = checkRefs(refs).map(format);
    expect(bad).toEqual([
      "fixture.tsx:6  useT(\"ui\").nothing  →  ui.nothing is not defined in en (missing at ui.nothing)",
      "fixture.tsx:3  t.book.nope  →  terminal.book.nope is not defined in en (missing at terminal.book.nope)",
      'fixture.tsx:4  t.chart.intervals["2m"]  →  terminal.chart.intervals.2m is not defined in en (missing at terminal.chart.intervals.2m)',
      "fixture.tsx:7  t.notAGroup.x  →  terminal.notAGroup.x is not defined in en (missing at terminal.notAGroup)",
      'fixture.tsx:5  t("order.errors.missing")  →  terminal.order.errors.missing is not defined in en (missing at terminal.order.errors.missing)',
    ]);
  });

  it("ignores references inside comments and keeps line numbers intact", () => {
    const src = [
      'const t = useT("terminal"); // t.nothing.here',
      "/* t.also.nothing",
      "   t.still.nothing */",
      "const a = t.book.nope;",
      'const url = "https://example.test/x"; const b = t.tape.nope;',
    ].join("\n");
    const bad = checkRefs(collectRefs(src, "fixture.tsx").refs).map(format);
    expect(bad).toEqual([
      "fixture.tsx:4  t.book.nope  →  terminal.book.nope is not defined in en (missing at terminal.book.nope)",
      "fixture.tsx:5  t.tape.nope  →  terminal.tape.nope is not defined in en (missing at terminal.tape.nope)",
    ]);
  });

  it("does not treat `//` or `/*` inside string, template or regex literals as a comment", () => {
    const src = [
      'const t = useT("terminal");',
      'const s = "a//b"; const q = t.book.nope;',
      "const u = 'x /* y'; const r = t.tape.nope;",
      "const v = `//${t.chart.nope} and ${cond ? `${t.meta.nope}` : \"//\"}`; const w = t.order.nope;",
      "const re = /\\/\\//g; const x = t.tabs.nope;",
      "const div = a / b // real comment: t.nothing.here",
      '<a href="//cdn.example/x">{t.demo.nope}</a>',
      "<span>{t.tabs.colFilled}/{t.tabs.colQty}</span></div>",
      "const y = `${t.book.title}`; // t.nothing.here",
    ].join("\n");
    const { refs, failures } = collectRefs(src, "fixture.tsx");
    expect(failures).toEqual([]);
    expect(refs.map((r) => `${r.line}:${r.path.join(".")}`)).toEqual([
      "2:terminal.book.nope",
      "3:terminal.tape.nope",
      "4:terminal.chart.nope",
      "4:terminal.meta.nope",
      "4:terminal.order.nope",
      "5:terminal.tabs.nope",
      "7:terminal.demo.nope",
      "8:terminal.tabs.colFilled",
      "8:terminal.tabs.colQty",
      "9:terminal.book.title",
    ]);
    expect(checkRefs(refs).map((f) => `${f.file}:${f.line}  ${f.expr}`)).toEqual([
      "fixture.tsx:2  t.book.nope",
      "fixture.tsx:3  t.tape.nope",
      "fixture.tsx:4  t.chart.nope",
      "fixture.tsx:4  t.meta.nope",
      "fixture.tsx:4  t.order.nope",
      "fixture.tsx:5  t.tabs.nope",
      "fixture.tsx:7  t.demo.nope",
    ]);
  });

  it("flags a useT identifier that is rebound elsewhere in the same file instead of guessing", () => {
    const src = ['const t = useT("terminal");', "const rows = trades.map((t) => t.price);"].join("\n");
    const { failures } = collectRefs(src, "fixture.tsx");
    expect(failures.map(format)).toEqual([
      "fixture.tsx:2  t  →  `t` is bound by useT() and rebound elsewhere in this file; rename one of them so key references stay unambiguous",
    ]);
    // 命名规整后同一段代码通过
    const ok = collectRefs(['const t = useT("terminal");', "const rows = trades.map((tr) => tr.price);"].join("\n"), "fixture.tsx");
    expect(ok.failures).toEqual([]);
    expect(checkRefs(ok.refs)).toEqual([]);
  });

  it("does not mistake two arrow functions in a ternary for a rebinding", () => {
    const srcs = [
      'const t = useT("terminal"); const h = ok ? () => a(t.book.title) : () => b();',
      'const t = useT("terminal"); const h = busy ? () => f(t.book.title) : (e) => g(e);',
      ['const t = useT("terminal");', "const el = <button onClick={open", "  ? () => toast(t.book.title)", "  : () => setOpen(true)} />;"].join("\n"),
    ];
    for (const src of srcs) {
      const { refs, failures } = collectRefs(src, "fixture.tsx");
      expect(failures, src).toEqual([]);
      expect(refs.map((r) => r.path.join(".")), src).toEqual(["terminal.book.title"]);
      expect(checkRefs(refs), src).toEqual([]);
    }
  });

  it("recognises a destructured parameter as a rebinding, but not an object-pattern property name", () => {
    const rebound = [
      "rows.map(({ t }) => t.price)",
      "rows.map(({ trade: t }) => t.price)",
      "rows.map(([t]) => t.price)",
      "rows.map(({ t }: Row, i) => t.price)",
      "rows.map((t: Trade) => t.price)",
      "rows.map((...t) => t.length)",
      "function f({ t = 1 }) { return t; }",
    ];
    for (const line of rebound) {
      const { failures } = collectRefs(['const t = useT("terminal");', line].join("\n"), "fixture.tsx");
      expect(failures.map((f) => `${f.line}:${f.expr}`), line).toEqual(["2:t"]);
    }
    const notRebound = [
      "rows.map(({ t: tr }) => tr.price)",
      "rows.map(({ label = t.book.title }) => label)",
      "rows.map(({ tr }) => tr.price)",
      "rows.map((tr: Trade, [x]) => tr.price)",
    ];
    for (const line of notRebound) {
      const { failures, refs } = collectRefs(['const t = useT("terminal");', line].join("\n"), "fixture.tsx");
      expect(failures, line).toEqual([]);
      expect(checkRefs(refs), line).toEqual([]);
    }
  });

  it("accepts a reference when any of the identifier's namespaces resolves it", () => {
    const src = ['function A() { const t = useT("nav"); return t.login; }', 'function B() { const t = useT("terminal"); return t.order.login; }'].join("\n");
    const { refs, failures } = collectRefs(src, "fixture.tsx");
    expect(failures).toEqual([]);
    expect(checkRefs(refs)).toEqual([]);
  });
});

// ------------------------------------------------------------------ 真实扫描
describe("terminal i18n keys used in src resolve in en", () => {
  it("every useT-derived key reference under the scanned roots exists in en", () => {
    const { files, refs, failures } = scanTree();
    // Nav 的 t.menu 确实被收集(nav 命名空间);terminal 命名空间的下限在下一条
    expect(files).toContain("components/Nav.tsx");
    expect(refs.some((r) => r.file === "components/Nav.tsx" && r.path.join(".") === "nav.menu")).toBe(true);
    expect(failures.map(format)).toEqual([]);
  });

  // P2-01:终端文案拆出核心包之后,这里再钉一条「扫描没有空转」。useT 改名、取词改成扫描器不认的写法、或扫描根挪了位置,
  // 引用数都会掉到 0 而上一条照样通过;所以给 terminal 命名空间的引用数、涉及的文件数与分组数各设一个下限
  // (写这条时实测 287 条引用、35 个文件、13 个分组;后续任务只会往上加)。
  it("actually finds the terminal references: counts stay above a floor, so a rename cannot leave the scan running on nothing", () => {
    const { refs } = scanTree();
    const terminalRefs = refs.filter((r) => r.path[0] === "terminal");
    expect(terminalRefs.length).toBeGreaterThan(200);
    expect(new Set(terminalRefs.map((r) => r.file)).size).toBeGreaterThanOrEqual(25);
    expect(new Set(terminalRefs.map((r) => r.path[1])).size).toBeGreaterThanOrEqual(12);
    // 终端之外也用的四条文案已挪进核心命名空间(nav / ui),消费方的引用同样被扫到并解析
    const seen = new Set(refs.map((r) => `${r.file} ${r.path.join(".")}`));
    for (const ref of [
      "components/terminal/DemoBadge.tsx nav.demoTooltip",
      "components/ui/Dialog.tsx ui.dialogClose",
      "components/ui/VirtualList.tsx ui.listHint",
      "components/terminal/CarbonMetaPanel.tsx ui.simulatedUnverified",
    ]) {
      expect(seen.has(ref), ref).toBe(true);
    }
  });

  // P2-10:资产页的文案自成 account 命名空间(src/i18n/messages/account/*),组件照样写 const a = useT("account") 后 a.x.y;
  // 扫描按命名空间在合并对象上解析,这里钉住「确实扫到了、而且不少」,免得取词写法变了扫描空转(写这条时实测约 60 条、6 个文件)
  it("finds the portfolio page's account references too (components/account), not zero", () => {
    const { refs } = scanTree();
    const accountRefs = refs.filter((r) => r.path[0] === "account");
    expect(accountRefs.length).toBeGreaterThan(40);
    expect(new Set(accountRefs.map((r) => r.file)).size).toBeGreaterThanOrEqual(5);
    expect(accountRefs.every((r) => r.file.startsWith("components/account/"))).toBe(true);
    // 同一批文件里复用的终端文案(与终端持仓页签同义的列名、按钮)也被扫到并解析
    const reused = new Set(refs.filter((r) => r.file.startsWith("components/account/") && r.path[0] === "terminal").map((r) => r.path.join(".")));
    for (const key of ["terminal.retire.lockedBy", "terminal.tabs.retire", "terminal.order.sell", "terminal.tabs.colPnl"]) expect(reused.has(key), key).toBe(true);
  });

  // P3-05:市场总览页的组件(components/markets)读 terminal.markets.*,另复用终端的 24h 涨跌 / 成交量列名与「情景」标记;扫描要扫到它们
  it("finds the market overview page's references (components/markets), including the terminal strings it reuses", () => {
    const { refs } = scanTree();
    const own = refs.filter((r) => r.file.startsWith("components/markets/") && r.path[0] === "terminal");
    const keys = new Set(own.map((r) => r.path.join(".")));
    for (const key of ["terminal.markets.title", "terminal.markets.members", "terminal.markets.gainers", "terminal.markets.scenariosNote", "terminal.markets.stale", "terminal.markets.rowLabel", "terminal.header.change24h", "terminal.tabs.scenarioTag"]) {
      expect(keys.has(key), key).toBe(true);
    }
    expect(own.filter((r) => r.path[1] === "markets").length).toBeGreaterThan(15);
  });

  // P3-08:通知的铃铛与面板(components/notices)读核心命名空间 notices(铃铛的名字、标题、加载失败的提示)与 ui 的加载 / 重试 / 加载更多;
  // 扫描要扫到它们、并在合并对象上解析。通知的句子与面板里的其它文案在 messages/notices/(不是 core、不走 useT,由 notice-copy.ts 取),
  // 它们的键由类型检查(NoticeCopy)与 messages.test.ts 把关
  it("finds the notification centre's references (components/notices), not zero", () => {
    const { files, refs } = scanTree();
    expect(files).toContain("components/notices/NoticeBell.tsx");
    const own = refs.filter((r) => r.file.startsWith("components/notices/"));
    const keys = new Set(own.map((r) => `${r.file} ${r.path.join(".")}`));
    for (const key of [
      "components/notices/NoticeBell.tsx notices.bell",
      "components/notices/NoticeBell.tsx notices.title",
      "components/notices/NoticeBell.tsx notices.error",
      "components/notices/NoticeBell.tsx ui.loading",
      "components/notices/NoticePanel.tsx notices.error",
      "components/notices/NoticePanel.tsx ui.loadMore",
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
    // 铃铛在 Nav 里,不读终端文案(它在每个页面,那里没有终端的 Provider)
    expect(own.some((r) => r.path[0] === "terminal" || r.path[0] === "account")).toBe(false);
  });
});
