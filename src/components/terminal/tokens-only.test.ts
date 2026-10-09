import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tokens-only 门禁(计划 §4.6):终端组件、ui 基础件、资产页组件(P2-10)、市场总览页组件(P3-05)、通知组件(P3-08)、terminal.css 与 chart-adapter.ts 只引用 token,不写原始值;
// 进 npm run test,即 Dockerfile 的 RUN npm run test && npm run lint —— 违规的镜像构不出来。不引 stylelint / eslint 插件(§9.1 第 29 条)。
//
// 逐行规则(整行扫描,注释也算:注释里写原始值同样会被人照抄,Nav.ssr.test.ts 对 DemoBadge 是同一口径):
//   hex 色、rgb( / rgba( / hsl( / hsla(、\d+px(terminal.css 只放行 1px 边框)、Tailwind 调色板类(含 black / white)、
//   任意值 text-[ / min-h-[ / w-[<数字> / h-[<数字> / z-[。断点一律 rem,允许 var(--…)、rem、%、calc()、color-mix()。
// 整文件规则(先剥注释,字符串原样保留):
//   - 不 import motion / framer-motion(终端零 motion 导入,闪烁走 CSS);
//   - 不许有叫 ref 的 prop(类型成员 ref: / ref?:、参数解构里的 ref);审计引用一律叫 auditRef;
//   - 渲染期不调 marketActions.set*(SSR 首屏规则 §6.1):调用点必须落在 useEffect / useLayoutEffect / useCallback、
//     JSX 的 on*={…} 事件属性、或 handle* / on* 命名的处理函数里;落在组件或 hook 的函数体(含 useMemo)、模块顶层即违规。
//     这是按花括号 / 圆括号栈向外找作用域头的启发式,不是完整解析器;下面的自检用例钉住它认得的写法。

const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));
// P2-10:资产页 /trade/account 的组件(components/account,含共用的注销对话框)同样只引 token;资产页的样式在 terminal.css 里,已在扫描之列
// P3-05:市场总览页 /trade/markets 的组件(components/markets)同样只引 token
// P3-08:Nav 的通知铃铛、面板与 Toast 触发器(components/notices)同样只引 token(Nav.tsx 本身不在扫描内)
const SCAN_DIRS = ["components/terminal", "components/ui", "components/account", "components/markets", "components/notices"];
const SCAN_FILES = ["app/terminal.css", "lib/market/chart-adapter.ts"];
const SOURCE_EXT = /\.(ts|tsx|css)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;

// ------------------------------------------------------------------ 逐行规则
type LineRule = { name: string; re: RegExp };
const PALETTE =
  "amber|red|green|blue|slate|gray|zinc|neutral|stone|emerald|rose|sky|indigo|orange|yellow|lime|teal|cyan|violet|purple|fuchsia|pink";
const LINE_RULES: LineRule[] = [
  { name: "hex colour", re: /#[0-9a-fA-F]{3,8}\b/ },
  { name: "rgb()/hsl() colour", re: /\b(?:rgba?|hsla?)\(/ },
  { name: "Tailwind palette class", re: new RegExp(String.raw`\b(?:text|bg|border|ring|fill|stroke|from|to|via|outline|decoration|shadow|accent|caret|divide)-(?:(?:${PALETTE})-\d|(?:black|white)\b)`) },
  { name: "arbitrary text size", re: /\btext-\[/ },
  { name: "arbitrary min-height", re: /\bmin-h-\[/ },
  { name: "arbitrary width", re: /\bw-\[\d/ },
  { name: "arbitrary height", re: /\bh-\[\d/ },
  { name: "arbitrary z-index", re: /\bz-\[/ },
];
const PX = /\b\d+(?:\.\d+)?px\b/g;

type Violation = { file: string; line: number; rule: string; text: string };

function lineViolations(file: string, source: string): Violation[] {
  const out: Violation[] = [];
  const pxAllowed = file.endsWith("terminal.css") ? new Set(["1px"]) : new Set<string>();
  source.split("\n").forEach((text, i) => {
    for (const rule of LINE_RULES) if (rule.re.test(text)) out.push({ file, line: i + 1, rule: rule.name, text: text.trim() });
    for (const m of text.matchAll(PX)) {
      if (!pxAllowed.has(m[0])) out.push({ file, line: i + 1, rule: `px literal ${m[0]}`, text: text.trim() });
    }
  });
  return out;
}

// ------------------------------------------------------------------ 源码预处理
// 注释抹成空格(换行保留,行号对得上);字符串与模板字面量原样保留、且不跨行(JSX 文本里落单的撇号最多波及一行)。
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const d = source[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== c && (c === "`" || source[j] !== "\n")) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 与 stripComments 同源的字符串遮罩:字面量内容换成空格,括号栈不被字符串里的 { ( 打乱 */
function maskStrings(code: string): string {
  return code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (s) => s[0] + s.slice(1, -1).replace(/[^\n]/g, " ") + s[s.length - 1]);
}

const lineOf = (source: string, index: number): number => source.slice(0, index).split("\n").length;

// ------------------------------------------------------------------ 整文件规则
const MOTION_IMPORT = /\bfrom\s+["'](?:motion|framer-motion)(?:\/[^"']*)?["']|\bimport\s*\(\s*["'](?:motion|framer-motion)(?:\/[^"']*)?["']|\brequire\(\s*["'](?:motion|framer-motion)/g;
// 类型成员 / 对象键 `ref:` `ref?:`,以及参数解构 `({ a, ref })` `({ ref = x })`。
// 前缀只认行首或 { ; , ( 之后(可隔空白):三元 `cond ? ref : other`、`case ref:` 里 ref 前面是 ? 或关键字,不算类型成员
const REF_MEMBER = /(?:^|[{;,(])\s*ref\??\s*:/gm;
const REF_DESTRUCTURE = /\(\s*\{[^()]*?[\s{,]ref\s*[,}=]/g;

/** 括号栈:扫描到 index 为止仍未闭合的 { 与 ( 的位置,由外到内 */
function openBrackets(code: string, index: number): number[] {
  const stack: number[] = [];
  for (let i = 0; i < index; i++) {
    const c = code[i];
    if (c === "{" || c === "(" || c === "[") stack.push(i);
    else if (c === "}" || c === ")" || c === "]") stack.pop();
  }
  return stack.filter((i) => code[i] !== "[");
}

/** 从 index(不含)往回跳过一对平衡的 ( … ),返回 ( 的位置;不是 ) 结尾返回 -1 */
function matchParenBackward(code: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    if (code[i] === ")") depth++;
    else if (code[i] === "(" && --depth === 0) return i;
  }
  return -1;
}

/**
 * 某个开括号的「作用域头」:它前面那段决定它是什么的文本。
 *   `{` 是箭头函数体 → 跳过 `=>`、可选返回类型、参数表;`{` 是 function / 方法体 → 跳过参数表;
 *   然后取到上一个 ; { } 为止的一段(声明名、调用名都在这段里;JSX 属性名由 classify 另看紧邻的前文)。
 */
function headerOf(code: string, bracket: number): string {
  let j = bracket - 1;
  const skipWs = () => {
    while (j >= 0 && /\s/.test(code[j])) j--;
  };
  skipWs();
  if (code[bracket] === "{") {
    if (code[j] === ">" && code[j - 1] === "=") {
      j -= 2;
      skipWs();
      // 可选返回类型 `): Foo =>`
      const typed = /\)\s*:\s*[\w$<>[\]|.,\s]+$/.exec(code.slice(Math.max(0, j - 120), j + 1));
      if (typed) j = j - (typed[0].length - 1);
      if (code[j] === ")") j = matchParenBackward(code, j) - 1;
      else while (j >= 0 && /[\w$]/.test(code[j])) j--; // 单参数 `x => {`
    } else if (code[j] === ")") {
      j = matchParenBackward(code, j) - 1; // function name(…) { / name(…) {
    }
  }
  const end = j + 1;
  let start = end;
  while (start > 0 && !/[;{}]/.test(code[start - 1])) start--;
  return code.slice(start, end);
}

type ScopeKind = "deferred" | "render" | "neutral";

const DEFERRED_CALL = /\b(?:useEffect|useLayoutEffect|useInsertionEffect|useCallback|startTransition|setTimeout|setInterval|requestAnimationFrame|queueMicrotask|addEventListener)\s*(?:<[^()]*>)?\s*$/;
const EVENT_ATTR = /\bon[A-Z]\w*\s*=\s*$/;
const HANDLER_DECL = /(?:\b(?:const|let|var|function)\s+|^\s*|[{,]\s*)(?:handle[A-Z0-9_$]\w*|on[A-Z]\w*)\b\s*(?::[^=]*)?(?:=|\(|$)/m;
const COMPONENT_OR_HOOK = /(?:\bfunction\s+|\b(?:const|let|var)\s+)(?:[A-Z]\w*|use[A-Z]\w*)\b|\b(?:memo|forwardRef)\s*\(\s*(?:function\b)?/;
const RENDER_CALL = /\b(?:useMemo|useState|useReducer|useSyncExternalStore)\s*(?:<[^()]*>)?\s*$/;

function classify(code: string, bracket: number): ScopeKind {
  const header = headerOf(code, bracket);
  if (code[bracket] === "(") {
    const before = code.slice(Math.max(0, bracket - 80), bracket);
    if (DEFERRED_CALL.test(before)) return "deferred";
    if (RENDER_CALL.test(before)) return "render";
    return "neutral";
  }
  const before = code.slice(Math.max(0, bracket - 80), bracket);
  if (EVENT_ATTR.test(before)) return "deferred";
  if (HANDLER_DECL.test(header)) return "deferred";
  if (COMPONENT_OR_HOOK.test(header)) return "render";
  return "neutral";
}

const MARKET_SET = /\bmarketActions\s*\.\s*set\w*\s*\(/g;

function renderTimeWrites(code: string): number[] {
  const masked = maskStrings(code);
  const bad: number[] = [];
  for (const m of masked.matchAll(MARKET_SET)) {
    const scopes = openBrackets(masked, m.index);
    let verdict: ScopeKind = "render"; // 模块顶层:导入即写 store,同样违规
    let sawFunction = false;
    for (let k = scopes.length - 1; k >= 0; k--) {
      const kind = classify(masked, scopes[k]);
      if (kind !== "neutral") {
        verdict = kind;
        break;
      }
      if (masked[scopes[k]] === "{" && /(?:=>|\))\s*$/.test(masked.slice(Math.max(0, scopes[k] - 40), scopes[k]))) sawFunction = true;
    }
    // 只在普通小写辅助函数里(不在组件 / hook 内):调用方是谁静态看不出,放行
    if (verdict === "render" && sawFunction && !scopes.some((s) => classify(masked, s) === "render")) verdict = "deferred";
    if (verdict === "render") bad.push(m.index);
  }
  return bad;
}

function fileViolations(file: string, source: string): Violation[] {
  if (file.endsWith(".css")) return [];
  const code = stripComments(source);
  const out: Violation[] = [];
  const push = (index: number, rule: string) => out.push({ file, line: lineOf(code, index), rule, text: source.split("\n")[lineOf(code, index) - 1].trim() });
  for (const m of code.matchAll(MOTION_IMPORT)) push(m.index, "motion import");
  const masked = maskStrings(code);
  for (const m of masked.matchAll(REF_MEMBER)) {
    // 最内层未闭合的是 ( → 形参表或调用实参(回调 ref `(ref: HTMLDivElement | null) =>` 合法);只有 { 里的才是类型成员 / 对象键
    const inner = openBrackets(masked, m.index + m[0].indexOf("ref")).at(-1);
    if (inner !== undefined && masked[inner] === "(") continue;
    push(m.index, "prop named ref (use auditRef etc.)");
  }
  for (const m of masked.matchAll(REF_DESTRUCTURE)) push(m.index, "prop named ref (use auditRef etc.)");
  for (const index of renderTimeWrites(code)) push(index, "marketActions.set* outside an effect / event handler");
  return out;
}

// ------------------------------------------------------------------ 文件发现
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else if (SOURCE_EXT.test(name) && !TEST_FILE.test(name)) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const files = SCAN_DIRS.flatMap((d) => listFiles(join(SRC_DIR, d)));
  for (const f of SCAN_FILES) if (existsSync(join(SRC_DIR, f))) files.push(join(SRC_DIR, f));
  return files.sort();
}

const report = (violations: Violation[]) => violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`);

describe("tokens-only (plan §4.6)", () => {
  const files = scannedFiles();

  it("scans the terminal, ui and terminal.css files", () => {
    const rel = files.map((f) => relative(SRC_DIR, f));
    expect(rel).toContain("app/terminal.css");
    expect(rel).toContain("components/terminal/TerminalShell.tsx");
    expect(rel).toContain("components/ui/Skeleton.tsx");
    expect(rel).toContain("components/account/Holdings.tsx");
    expect(rel).toContain("components/account/RetireDialog.tsx");
    expect(rel).toContain("components/markets/MarketsPage.tsx");
    expect(rel).toContain("components/markets/RankedLists.tsx");
    expect(rel).toContain("components/notices/NoticeBell.tsx");
    expect(rel).toContain("components/notices/NoticePanel.tsx");
  });

  it("has no raw colours, px literals, palette classes or arbitrary values", () => {
    const violations = files.flatMap((f) => lineViolations(relative(SRC_DIR, f), readFileSync(f, "utf8")));
    expect(report(violations)).toEqual([]);
  });

  it("imports no motion, names no prop ref, and never writes marketActions during render", () => {
    const violations = files.flatMap((f) => fileViolations(relative(SRC_DIR, f), readFileSync(f, "utf8")));
    expect(report(violations)).toEqual([]);
  });
});

// 自检:规则本身认得出违规、也不误伤常见的合法写法
describe("tokens-only rules (self-check)", () => {
  const lines = (file: string, text: string) => lineViolations(file, text).map((v) => v.rule);
  const whole = (text: string) => fileViolations("components/terminal/Fixture.tsx", text).map((v) => v.rule);

  it("flags raw values line by line and lets tokens through", () => {
    expect(lines("x.tsx", `className="text-[11px]"`)).toEqual(["arbitrary text size", "px literal 11px"]);
    expect(lines("x.tsx", `className="bg-emerald-500/10 text-white"`)).toHaveLength(1);
    expect(lines("x.tsx", `className="backdrop:bg-black/40"`)).toEqual(["Tailwind palette class"]);
    expect(lines("x.tsx", `style={{ color: "#fb7185" }}`)).toEqual(["hex colour"]);
    expect(lines("x.tsx", `background: rgba(0, 0, 0, 0.4);`)).toEqual(["rgb()/hsl() colour"]);
    expect(lines("x.tsx", `className="z-[60] min-h-[44px] w-[12rem] h-[2rem]"`)).toEqual(
      expect.arrayContaining(["arbitrary z-index", "arbitrary min-height", "arbitrary width", "arbitrary height", "px literal 44px"]),
    );
    expect(lines("terminal.css", `border-top: 1px solid var(--terminal-border);`)).toEqual([]);
    expect(lines("terminal.css", `padding: 2px;`)).toEqual(["px literal 2px"]);
    expect(lines("x.tsx", `border-top: 1px solid var(--border);`)).toEqual(["px literal 1px"]);
    for (const ok of [
      `className="text-t-sm bg-(--terminal-panel) text-up bg-down/15 gap-gap h-row z-(--z-toast) w-[calc(100%_-_2*var(--spacing-gutter))]"`,
      `@media (width >= 80rem) { grid-template-columns: 17.5rem minmax(0, 1fr) 20rem; }`,
      `background: color-mix(in srgb, var(--up) 12%, transparent);`,
      `<a href="#book">`,
    ]) {
      expect(lines("terminal.css", ok), ok).toEqual([]);
    }
  });

  it("flags motion imports and props named ref", () => {
    expect(whole(`import { motion } from "motion/react";`)).toEqual(["motion import"]);
    expect(whole(`const m = await import("framer-motion");`)).toEqual(["motion import"]);
    expect(whole(`type P = { price: number; ref?: string };`)).toEqual(["prop named ref (use auditRef etc.)"]);
    expect(whole(`function Row({ price, ref }: P) { return null; }`)).toEqual(["prop named ref (use auditRef etc.)"]);
    // 真正的 ref 用法与 auditRef 不误伤
    expect(whole(`function Row({ auditRef }: { auditRef: string }) { const ref = useRef(null); return <div ref={ref} title={auditRef} />; }`)).toEqual([]);
    expect(whole(`// motion 的 "motion/react" 只在站点级组件里\nconst ok = 1;`)).toEqual([]);
    // 多行类型成员仍认得出
    expect(whole(`type P = {\n  price: number;\n  ref?: string;\n};`)).toEqual(["prop named ref (use auditRef etc.)"]);
    // 形参的类型字面量里的 ref 成员仍是 prop
    expect(whole(`function Row(props: { price: number; ref: string }) { return null; }`)).toEqual(["prop named ref (use auditRef etc.)"]);
    // 三元与 switch 里的 ref 变量不是类型成员
    for (const ok of [
      `function useEl(external: boolean) { const innerRef = useRef(null); const ref = useRef(null); const el = external ? ref : innerRef; return el; }`,
      `const el = external\n  ? ref\n  : innerRef;`,
      `switch (target) {\n  case ref:\n    break;\n}`,
      // 回调 ref 的形参、多形参里叫 ref 的位置参数都不是 prop
      `const setEl = useCallback((ref: HTMLDivElement | null) => { el.current = ref; }, []);`,
      `function attach(node: Node, ref: MutableRefObject<Node | null>) { ref.current = node; }`,
    ]) {
      expect(whole(ok), ok).toEqual([]);
    }
  });

  it("allows marketActions.set* only in effects, callbacks and event handlers", () => {
    const allowed = [
      `export function A({ items }: P) {\n  useEffect(() => {\n    marketActions.setInstruments(items, { onlyIfEmpty: true });\n  }, [items]);\n  return null;\n}`,
      `export function B() {\n  useEffect(() => marketActions.setConnection(c), []);\n  return null;\n}`,
      `export function C({ symbol }: P) {\n  const handleSide = (side: Side) => {\n    marketActions.setDraft({ symbol, side });\n  };\n  return <button onClick={() => handleSide("BUY")} />;\n}`,
      `export function D({ symbol }: P) {\n  return <button type="button" onClick={() => marketActions.setDraft({ symbol, side: "SELL" })}>x</button>;\n}`,
      `export const E = memo(function E({ price }: P) {\n  const onPick = useCallback((p: number) => marketActions.setDraft({ price: p }), []);\n  return <div onClick={() => onPick(price)} />;\n});`,
      `function handleSide(side: Side) {\n  marketActions.setDraft({ side });\n}`,
      `export function F() {\n  const handleX = ({ a }: { a: string }): void => {\n    marketActions.setDraft({ symbol: a });\n  };\n  return <input onChange={(e) => { if (e.target.value) marketActions.setDraft({ symbol: e.target.value }); }} />;\n}`,
    ];
    for (const src of allowed) expect(whole(src), src).toEqual([]);

    const rejected = [
      `export function G() {\n  marketActions.setDraft({ side: "BUY" });\n  return null;\n}`,
      `export const H = memo(function H({ items }: P) {\n  marketActions.setInstruments(items);\n  return <div />;\n});`,
      `export function I() {\n  const x = useMemo(() => {\n    marketActions.setDraft({});\n    return 1;\n  }, []);\n  return x;\n}`,
      `marketActions.setWatchlist([]);`,
      `export function useThing() {\n  marketActions.setDraft({});\n}`,
      `export const J = ({ ok }: P) => {\n  if (ok) marketActions.setDraft({});\n  return null;\n};`,
    ];
    for (const src of rejected) expect(whole(src), src).toEqual(["marketActions.set* outside an effect / event handler"]);
  });
});
