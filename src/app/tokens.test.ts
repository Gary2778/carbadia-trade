import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, type TerminalPrefs } from "@/lib/market/prefs";

// §4 设计规范的静态门禁:token 名与所在块、涨跌轴规则、玻璃退出、错误色迁移与首访 dark 的三处镜像。
// 只读文件、逐块断言,不引 jsdom;原始值只允许出现在 globals.css。

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const GLOBALS = read("./globals.css");
const TERMINAL = read("./terminal.css");
const LAYOUT = read("./layout.tsx");
const TEMPLATE = read("./template.tsx");
const EXCHANGE_CSS = read("./exchange.css");
const PRIVACY = read("./privacy/page.tsx");
const SIMPLE_TRADE = read("../components/exchange/SimpleTrade.tsx");
const SPOT_TABLE = read("../components/exchange/SpotTable.tsx");
const ACCOUNT_DATA = read("../components/exchange/AccountData.tsx");

/** src/ 的绝对路径;仓库级扫描以它为根,报错时打印相对路径 */
const SRC = fileURLToPath(new URL("../", import.meta.url));
const rel = (file: string) => relative(SRC, file);
/** 递归列出目录下的 .ts / .tsx / .css 源文件,跳过测试文件 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
}

type Block = { selector: string; body: string; parents: string[]; index: number };

/** 按花括号配对切出每个规则块:selector 是块前的文本,body 含嵌套块的原文,parents 是外层 at-rule / 选择器 */
function parseBlocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const stack: { selector: string; start: number }[] = [];
  let last = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      stack.push({ selector: src.slice(last, i).trim().replace(/\s+/g, " "), start: i + 1 });
      last = i + 1;
    } else if (ch === "}") {
      const open = stack.pop();
      if (!open) throw new Error(`unbalanced "}" at ${i}`);
      blocks.push({ selector: open.selector, body: src.slice(open.start, i), parents: stack.map((s) => s.selector), index: open.start });
      last = i + 1;
    } else if (ch === ";") {
      last = i + 1;
    }
  }
  if (stack.length) throw new Error("unbalanced \"{\"");
  return blocks;
}

const G = parseBlocks(GLOBALS);
const T = parseBlocks(TERMINAL);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** body 里是否有 `token:` 声明(带冒号,`--up:` 不会误中 `--up-soft:`) */
const declares = (body: string, token: string) => new RegExp(`(^|[\\s;{])${escapeRe(token)}\\s*:`).test(body);
/** 取声明值(第一处) */
const valueOf = (body: string, token: string) => body.match(new RegExp(`(?:^|[\\s;{])${escapeRe(token)}\\s*:\\s*([^;]+);`))?.[1].trim();
const blocksOf = (blocks: Block[], selector: string, parent?: string) =>
  blocks.filter((b) => b.selector === selector && (parent === undefined ? b.parents.length === 0 : b.parents.includes(parent)));
const only = (blocks: Block[], selector: string, parent?: string) => {
  const found = blocksOf(blocks, selector, parent);
  expect(found.length, `expected exactly one block \`${selector}\`${parent ? ` inside ${parent}` : ""}`).toBe(1);
  return found[0];
};
const expectDeclared = (block: Block, tokens: string[]) => {
  const missing = tokens.filter((t) => !declares(block.body, t));
  expect(missing, `missing in \`${block.selector}\``).toEqual([]);
};

type Specificity = [number, number, number];
/** 单个复合选择器的特异性 [id, 类 / 属性 / 伪类, 类型 / 伪元素];:not / :is / :has 取参数里最高的一项,:where 记 0(本文件的选择器够用) */
function specificity(selector: string): Specificity {
  let rest = selector;
  const total: Specificity = [0, 0, 0];
  for (let m = rest.match(/:(not|is|has|where)\(/); m && m.index !== undefined; m = rest.match(/:(not|is|has|where)\(/)) {
    let i = m.index + m[0].length;
    for (let depth = 1; depth > 0; i++) depth += rest[i] === "(" ? 1 : rest[i] === ")" ? -1 : 0;
    if (m[1] !== "where") {
      const inner = rest.slice(m.index + m[0].length, i - 1).split(",").map((s) => specificity(s.trim()));
      inner.sort(compareSpecificity).at(-1)?.forEach((n, k) => (total[k] += n));
    }
    rest = `${rest.slice(0, m.index)} ${rest.slice(i)}`;
  }
  const count = (re: RegExp) => {
    const n = rest.match(re)?.length ?? 0;
    rest = rest.replace(re, " ");
    return n;
  };
  total[1] += count(/\[[^\]]*\]/g);
  total[2] += count(/::[\w-]+/g);
  total[1] += count(/:[\w-]+/g) + count(/\.[\w-]+/g);
  total[0] += count(/#[\w-]+/g);
  total[2] += count(/(?<![\w-])[a-zA-Z][\w-]*/g);
  return total;
}
const compareSpecificity = (a: Specificity, b: Specificity) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// ── §4 token 名清单 ────────────────────────────────────────────────
const DIRECTION = ["--palette-green", "--palette-red", "--up", "--down", "--up-soft", "--down-soft"];
const SEMANTIC = ["--danger", "--danger-soft", "--success", "--success-soft", "--warning", "--warning-soft", "--info", "--info-soft", "--focus"];
const SURFACE = ["--surface-solid", "--surface-overlay", "--border-strong", "--muted-2"];
const SERIES = ["--series-2", "--series-3", "--series-4"];
const TEXT = ["--text-t-2xs", "--text-t-xs", "--text-t-sm", "--text-t-base", "--text-t-md", "--text-t-lg", "--text-t-xl", "--text-t-2xl", "--leading-t-tight", "--leading-t-base"];
const SPACING = ["--spacing-gap", "--spacing-panel", "--spacing-gutter", "--spacing-row", "--spacing-row-dense", "--spacing-touch", "--spacing-header"];
const RADIUS = ["--radius-chip", "--radius-control", "--radius-panel", "--radius-dialog", "--radius-pill"];
const SHADOW = ["--shadow-overlay", "--shadow-focus"];
const MOTION = ["--motion-fast", "--motion-base", "--motion-slow", "--motion-flash", "--ease-standard", "--ease-out"];
const Z = ["--z-below", "--z-base", "--z-readout", "--z-sticky", "--z-nav", "--z-menu", "--z-toast", "--z-dialog", "--z-popover"];
const TERMINAL_TOKENS = ["--terminal-bg", "--terminal-panel", "--terminal-panel-2", "--terminal-border", "--terminal-row-hover", "--terminal-selected", "--terminal-mine"];
/** 终端文字的原料色(盘口次要列、盘口价格、终端别处的涨跌文字;P1-25e / P1-26):两种外观各写一份,别名只在无前缀的块里 */
const TERMINAL_TEXT_RAW = ["--terminal-book-muted", "--terminal-book-green", "--terminal-book-red", "--terminal-green", "--terminal-red"];
/** 随主题变化、dark 必须重定义的 */
const DARK_OVERRIDES = ["--palette-green", "--palette-red", "--up-soft", "--down-soft", ...SEMANTIC, "--border-strong", "--muted-2", ...SERIES, "--shadow-overlay"];

const ROOT = only(G, ":root");
const DARK = only(G, ':root[data-theme="dark"]');
const THEME = only(G, "@theme inline");

describe("globals.css design tokens (§4)", () => {
  it("declares every token with its light value in :root", () => {
    expectDeclared(ROOT, [...DIRECTION, ...SEMANTIC, ...SURFACE, ...SERIES, ...TEXT, ...SPACING, ...RADIUS, ...SHADOW, ...MOTION, ...Z]);
  });

  it("redefines the theme-dependent tokens and the starfield surfaces in the one dark block", () => {
    expectDeclared(DARK, [...DARK_OVERRIDES, "--background", "--surface", "--surface-2", "--border", "--surface-solid", "--surface-overlay"]);
  });

  it("selects the two looks by data-theme alone: every theme rule is light (unprefixed) or html[data-theme=\"dark\"]", () => {
    for (const css of [GLOBALS, EXCHANGE_CSS]) {
      for (const block of parseBlocks(css).filter((b) => b.selector.includes("data-theme"))) {
        // 顶层逗号才分隔选择器(:is(…) 里的逗号不算)
        for (const selector of block.selector.split(/,(?![^(]*\))/)) {
          expect(selector.trim(), block.selector).toMatch(/^(:root|html)\[data-theme="dark"\](?![\w[:-])/);
        }
      }
    }
  });

  it("keeps --up / --down as aliases of the palette so the axis can flip", () => {
    for (const block of G) {
      const up = valueOf(block.body.replace(/\{[\s\S]*?\}/g, ""), "--up");
      const down = valueOf(block.body.replace(/\{[\s\S]*?\}/g, ""), "--down");
      if (up !== undefined) expect(up, `\`--up\` in \`${block.selector}\``).toMatch(/^var\(--palette-(green|red)\)$/);
      if (down !== undefined) expect(down, `\`--down\` in \`${block.selector}\``).toMatch(/^var\(--palette-(green|red)\)$/);
    }
    expect(valueOf(ROOT.body, "--up")).toBe("var(--palette-green)");
    expect(valueOf(ROOT.body, "--down")).toBe("var(--palette-red)");
    // 深色块只定义原料色,不再直接写 --up / --down(否则 (0,2,0) 的特异性会压过翻转规则)
    expect(declares(DARK.body, "--up")).toBe(false);
    expect(declares(DARK.body, "--down")).toBe(false);
  });

  it("writes the red-up rule after every theme block", () => {
    const redUp = only(G, 'html[data-updown="red-up"]');
    expect(valueOf(redUp.body, "--up")).toBe("var(--palette-red)");
    expect(valueOf(redUp.body, "--down")).toBe("var(--palette-green)");
    const lastThemeBlock = Math.max(...G.filter((b) => b.selector.includes("data-theme")).map((b) => b.index));
    expect(redUp.index).toBeGreaterThan(lastThemeBlock);
  });

  it("gives the terminal its own palette in both looks", () => {
    expectDeclared(only(G, "[data-terminal]"), [...TERMINAL_TOKENS, ...TERMINAL_TEXT_RAW, "--terminal-book-up", "--terminal-book-down", "--terminal-up", "--terminal-down"]);
    expectDeclared(only(G, 'html[data-theme="dark"] [data-terminal]'), [...TERMINAL_TOKENS, ...TERMINAL_TEXT_RAW]);
  });

  it("puts the terminal's red-up flip after, and at least as specific as, every [data-terminal] look block", () => {
    // 翻转规则只换别名(--terminal-book-up / -down、--terminal-up / -down);外观块只写原料。
    // dark 块 html[data-theme="dark"] [data-terminal] 与翻转规则同为 (0,2,1),无前缀的 [data-terminal] 是 (0,1,0):
    // 翻转规则写在它们之后、特异性不低于它们,别名在两种外观里都翻得过来(contrast.test.ts 按声明链逐个验证)
    const flip = only(G, 'html[data-updown="red-up"] [data-terminal]');
    const looks = G.filter((b) => b !== flip && b.parents.length === 0 && b.selector.includes("[data-terminal]") && /--terminal-/.test(b.body));
    expect(looks.map((b) => b.selector)).toEqual(["[data-terminal]", 'html[data-theme="dark"] [data-terminal]']);
    expect(specificity(flip.selector)).toEqual([0, 2, 1]);
    for (const look of looks) {
      expect(flip.index, look.selector).toBeGreaterThan(look.index);
      expect(compareSpecificity(specificity(flip.selector), specificity(look.selector)), look.selector).toBeGreaterThanOrEqual(0);
    }
  });

  it("lets the terminal leave the liquid glass (data-glass=\"off\")", () => {
    const off = only(G, 'html[data-theme="dark"] [data-glass="off"]');
    expectDeclared(off, ["--surface", "--surface-2", "--border", "--surface-overlay", "--shadow-card", "--shadow-soft"]);
    expect(valueOf(off.body, "--surface")).toBe("var(--terminal-panel)");
    expect(valueOf(off.body, "--shadow-card")).toBe("none");
    expect(valueOf(only(G, '[data-glass="off"] .shadow-card').body, "--tw-shadow")).toBe("none");
  });

  it("bridges the new tokens into Tailwind without touching the default font sizes", () => {
    for (const size of ["--text-xs", "--text-sm", "--text-base", "--text-lg", "--text-xl", "--text-2xl"]) {
      expect(declares(THEME.body, size), `${size} must not be redefined in @theme`).toBe(false);
    }
    expectDeclared(THEME, [
      "--color-danger", "--color-danger-soft", "--color-success", "--color-success-soft", "--color-warning", "--color-warning-soft",
      "--color-info", "--color-info-soft", "--color-focus", "--color-up-soft", "--color-down-soft",
      "--color-series-2", "--color-series-3", "--color-series-4",
      "--color-surface-solid", "--color-surface-overlay", "--color-border-strong", "--color-muted-2",
      ...TEXT, ...SPACING, ...RADIUS, ...SHADOW, "--ease-standard", "--ease-out",
    ]);
    // Tailwind 的 --font-mono 栈补 Windows / Linux 的等宽字体,不引 web 字体
    expect(valueOf(THEME.body, "--font-mono")).toMatch(/Consolas, "Liberation Mono", "Roboto Mono", monospace$/);
  });

  it("zeroes the motion tokens under prefers-reduced-motion and defines the flash keyframes", () => {
    const reduced = only(G, ":root", "@media (prefers-reduced-motion: reduce)");
    for (const token of ["--motion-fast", "--motion-base", "--motion-slow", "--motion-flash"]) expect(valueOf(reduced.body, token)).toBe("0ms");
    expect(blocksOf(G, "@keyframes t-flash-up")).toHaveLength(1);
    expect(blocksOf(G, "@keyframes t-flash-down")).toHaveLength(1);
    expect(only(G, ".flash-up").body).toMatch(/t-flash-up var\(--motion-flash\) var\(--ease-out\)/);
    expect(only(G, ".flash-down").body).toMatch(/t-flash-down var\(--motion-flash\) var\(--ease-out\)/);
  });
});

// ── P1-26:终端浅色的涨跌文字换成深一级(§9.1 第 43 条「只改终端」),主站配色不动 ─────────────────────
// 主站(非 /trade)的方向色取值钉在这里:原料、别名、染色、Tailwind 桥与红涨翻转都与 P1-26 之前逐字相同;
// 终端的深一级涨跌色只以 --terminal-* 的名字存在、只在 [data-terminal] 的规则块里声明,终端也不改写站点的方向 token
// (所以买卖按钮的底、K 线、深度条与闪烁底在终端里也还是站点色)。
describe("the main site's direction colours are unchanged by the terminal's darker direction text (P1-26)", () => {
  it("pins the site palette, the --up / --down aliases, their washes and the Tailwind bridge to their pre-P1-26 values", () => {
    expect(valueOf(ROOT.body, "--palette-green")).toBe("#00a15f");
    expect(valueOf(ROOT.body, "--palette-red")).toBe("#e0352b");
    expect(valueOf(ROOT.body, "--up")).toBe("var(--palette-green)");
    expect(valueOf(ROOT.body, "--down")).toBe("var(--palette-red)");
    expect(valueOf(ROOT.body, "--up-soft")).toBe("color-mix(in srgb, var(--up) 12%, transparent)");
    expect(valueOf(ROOT.body, "--down-soft")).toBe("color-mix(in srgb, var(--down) 12%, transparent)");
    expect(valueOf(DARK.body, "--palette-green")).toBe("#34d399");
    expect(valueOf(DARK.body, "--palette-red")).toBe("#fb7185");
    expect(valueOf(DARK.body, "--up-soft")).toBe("color-mix(in srgb, var(--up) 14%, transparent)");
    expect(valueOf(DARK.body, "--down-soft")).toBe("color-mix(in srgb, var(--down) 14%, transparent)");
    // 方向 token 只在浅色 :root、dark 块(只有原料与染色)和红涨翻转规则里声明
    const declaring = G.filter((b) => DIRECTION.some((t) => declares(b.body.replace(/\{[\s\S]*?\}/g, ""), t))).map((b) => b.selector);
    expect(declaring).toEqual([":root", ':root[data-theme="dark"]', 'html[data-updown="red-up"]']);
    expect(valueOf(THEME.body, "--color-up")).toBe("var(--up)");
    expect(valueOf(THEME.body, "--color-down")).toBe("var(--down)");
    expect(valueOf(THEME.body, "--color-up-soft")).toBe("var(--up-soft)");
    expect(valueOf(THEME.body, "--color-down-soft")).toBe("var(--down-soft)");
    const redUp = only(G, 'html[data-updown="red-up"]');
    expect(redUp.body.match(/--[\w-]+(?=\s*:)/g)).toEqual(["--up", "--down"]);
  });

  it("declares --terminal-* only in [data-terminal] blocks, and no [data-terminal] block redefines a site direction token", () => {
    const SITE_DIRECTION = [...DIRECTION, "--color-up", "--color-down", "--color-up-soft", "--color-down-soft"];
    const terminalBlocks: string[] = [];
    for (const block of G) {
      const own = block.body.replace(/\{[\s\S]*?\}/g, "");
      const terminalTokens = [...own.matchAll(/(?:^|[\s;{])(--terminal-[\w-]+)\s*:/g)].map((m) => m[1]);
      if (terminalTokens.length) {
        expect(block.selector, `${terminalTokens.join(", ")} declared outside [data-terminal]`).toContain("[data-terminal]");
        terminalBlocks.push(block.selector);
      }
      if (block.selector.includes("[data-terminal]")) {
        expect(SITE_DIRECTION.filter((t) => declares(own, t)), block.selector).toEqual([]);
      }
    }
    expect(terminalBlocks).toEqual([
      "[data-terminal]",
      'html[data-theme="dark"] [data-terminal]',
      'html[data-updown="red-up"] [data-terminal]',
    ]);
  });
});

describe("terminal.css only consumes tokens under [data-terminal]", () => {
  it("scopes every rule to [data-terminal] and sets the base type, background and tabular numerals", () => {
    const rules = T.filter((b) => !b.selector.startsWith("@") && !b.parents.some((p) => p.startsWith("@keyframes")));
    for (const rule of rules) expect(rule.selector, `\`${rule.selector}\` is not scoped`).toContain("[data-terminal]");
    const base = only(T, "[data-terminal]");
    expect(valueOf(base.body, "background")).toBe("var(--terminal-bg)");
    expect(valueOf(base.body, "font-size")).toBe("var(--text-t-base)");
    expect(valueOf(base.body, "line-height")).toBe("var(--leading-t-base)");
    expect(valueOf(base.body, "font-variant-numeric")).toBe("tabular-nums");
  });

  it("holds no raw colours or pixel sizes (1px borders excepted)", () => {
    const src = TERMINAL.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(rgb|rgba|hsl)\(/);
    const px = [...src.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].map((m) => m[1]).filter((n) => n !== "1");
    expect(px).toEqual([]);
  });
});

describe("error states no longer borrow the direction colours (§4.1.2)", () => {
  it("drops the amber utilities and the three hard-coded ambers", () => {
    for (const [name, src] of [["SimpleTrade.tsx", SIMPLE_TRADE], ["SpotTable.tsx", SPOT_TABLE], ["exchange.css", EXCHANGE_CSS]] as const) {
      expect(src, `${name} still has amber-`).not.toMatch(/amber-/);
      for (const hex of ["#b08028", "#ae873c", "#c99b3f"]) expect(src, `${name} still has ${hex}`).not.toContain(hex);
    }
  });

  it("keeps exchange.css's unlayered .exchange-content defaults out of the terminal; the terminal's copy sits in @layer base", () => {
    const X = parseBlocks(EXCHANGE_CSS);
    // 未分层、会作用到元素上的 .exchange-content 规则(容器本身的 min-width 除外)
    const unlayered = X.filter((b) => b.parents.length === 0 && b.selector.startsWith(".exchange-content") && b.selector !== ".exchange-content");
    expect(unlayered.length).toBeGreaterThanOrEqual(4);
    for (const b of unlayered) expect(b.selector, b.selector).toContain(":not(:where([data-terminal] *))");
    // 终端里的同一组默认值在 @layer base(低于 utilities,终端组件的工具类压得过)
    const layered = X.filter((b) => b.parents.includes("@layer base") && b.selector.startsWith("[data-terminal]"));
    expect(layered.map((b) => b.selector)).toEqual(unlayered.map((b) => b.selector.replace(/^\.exchange-content\s*/, "[data-terminal] ").replace(":not(:where([data-terminal] *))", "")));
    // 文件里别处没有未分层的 [data-terminal] 规则
    expect(X.filter((b) => b.parents.length === 0 && b.selector.includes("[data-terminal]") && !b.selector.includes(":not(:where([data-terminal] *))"))).toEqual([]);
  });

  it("moves .ex-error, .ex-status-tag.open and .saved to --danger / --warning", () => {
    const X = parseBlocks(EXCHANGE_CSS);
    const error = only(X, ".ex-error");
    expect(error.body).not.toContain("var(--down)");
    expect(error.body).toContain("var(--danger)");
    expect(valueOf(only(X, ".ex-status-tag.open").body, "color")).toBe("var(--warning)");
    expect(valueOf(only(X, ".ex-icon-button.saved").body, "color")).toBe("var(--warning)");
  });

  it("leaves no error / alert line on text-down or border-down in the migrated files", () => {
    for (const [name, src] of [["SimpleTrade.tsx", SIMPLE_TRADE], ["SpotTable.tsx", SPOT_TABLE], ["AccountData.tsx", ACCOUNT_DATA], ["exchange.css", EXCHANGE_CSS]] as const) {
      const hits = src.split("\n").filter((line) => /text-down|border-down/.test(line) && /error|invalid|fail|alert/i.test(line));
      expect(hits, `${name}`).toEqual([]);
    }
  });

  // ── P1-02b:站内其它页面的收尾 ────────────────────────────────
  // 方向色只表示涨跌/买卖,html[data-updown="red-up"] 下 --down 会变绿;
  // 错误、失败、校验不通过、告警与破坏性动作(撤单)一律走 --danger / --warning(§4.1.2)。
  const DOWN_CLASS = /\b(?:text|border|bg)-down\b/;
  const ERROR_WORD = /error|invalid|fail|alert|danger|warn|\berr\b/i;
  const downLines = (src: string) => src.split("\n").flatMap((line, i) => (DOWN_CLASS.test(line) ? [i + 1] : []));
  /** 带 down 色类、且本行或相邻一行有错误字眼的行号。JSX 常把 `{err && (`、`role="alert"` 与 className 拆到相邻行,
   *  只看本行会漏掉(retirement 的两个 role="alert" 容器、market 的 candleErr 角标就是这样漏过第一轮的)。 */
  const downErrorLines = (src: string) => {
    const lines = src.split("\n");
    return downLines(src).filter((n) => ERROR_WORD.test(lines.slice(Math.max(0, n - 2), n + 1).join("\n")));
  };

  it("pairs no down colour with an error word anywhere in src/app or src/components/exchange", () => {
    const files = [...sourceFiles(join(SRC, "app")), ...sourceFiles(join(SRC, "components/exchange"))];
    const hits = files.flatMap((file) => downErrorLines(readFileSync(file, "utf8")).map((n) => `${rel(file)}:${n}`));
    expect(hits).toEqual([]);
  });

  it("leaves no error line on a down colour in the files this pass migrated", () => {
    for (const name of [
      "app/login/page.tsx", "app/register/page.tsx", "app/feedback/page.tsx", "app/otc/page.tsx", "app/retirement/page.tsx",
      "app/market/[symbol]/MarketContent.tsx",
    ]) {
      expect(downErrorLines(readFileSync(join(SRC, name), "utf8")), name).toEqual([]);
    }
  });

  it("keeps no down colour at all in the pages whose only down usage was an error state", () => {
    // 这五页原本只在错误文案、错误容器和撤销按钮上借过 --down,迁移后整文件清零。
    // 若日后这些页真的要显示涨跌 / 买卖,把它从这份清单挪去上一条的按行门禁。
    for (const name of ["app/login/page.tsx", "app/register/page.tsx", "app/feedback/page.tsx", "app/otc/page.tsx", "app/retirement/page.tsx"]) {
      expect(downLines(readFileSync(join(SRC, name), "utf8")), name).toEqual([]);
    }
  });

  it("hovers cancel controls to --danger instead of the direction colour", () => {
    // 撤单 / 撤挂单是破坏性动作,不是卖出
    // 旧 /portfolio 的撤单 / 撤牌按钮随页面删掉了(P2-10);资产页的撤牌按钮同样悬停到 --danger
    for (const name of ["app/otc/page.tsx", "app/market/[symbol]/MarketContent.tsx", "components/account/OtcListings.tsx"]) {
      expect(readFileSync(join(SRC, name), "utf8"), name).not.toMatch(/hover:text-down/);
    }
  });
});

describe("first-visit dark and the up/down axis are mirrored in the inline script and template", () => {
  it("THEME_INIT reads carbadia-updown and derives dark from the /trade prefix without writing storage", () => {
    const init = LAYOUT.match(/const THEME_INIT = `([\s\S]*?)`;/)?.[1] ?? "";
    expect(init).toContain('"carbadia-updown"');
    expect(init).toContain('"data-updown"');
    expect(init).toContain("location.pathname");
    expect(init).toContain('"/trade"');
    expect(init).not.toContain("setItem");
  });

  it("template.tsx renders /trade without the fade-in", () => {
    expect(TEMPLATE).toMatch(/startsWith\("\/trade"\)/);
  });

  it("/privacy lists the four storage keys and says what the time-zone key stores", () => {
    for (const key of ["carbadia-theme", "carbadia-updown", "carbadia-terminal-prefs", "carbadia-tz"]) expect(PRIVACY).toContain(key);
    // P3-09:carbadia-tz 存的是显示时间用的时区(浏览器的 / 北京 / UTC);键名与说明在同一句
    const sentence = PRIVACY.slice(PRIVACY.indexOf("carbadia-tz ("), PRIVACY.indexOf(")", PRIVACY.indexOf("carbadia-tz (")));
    for (const phrase of ["time zone", "this browser's", "Beijing", "UTC"]) expect(sentence, phrase).toContain(phrase);
  });

  it("/privacy names the data Phase 3 stores (conditional orders, price alerts, in-app notifications) and that notifications are deleted after 30 days", () => {
    const section = (n: number) => PRIVACY.slice(PRIVACY.indexOf(`"${n}. `), PRIVACY.indexOf(`"${n + 1}. `));
    for (const phrase of ["Conditional orders", "price alerts", "in-app notifications"]) expect(section(1), phrase).toContain(phrase);
    expect(section(5)).toContain("In-app notifications are deleted after 30 days.");
    // 清理每几个小时跑一次,不是到点即删:不写「创建 30 天后」(P3-11)
    expect(section(5)).not.toContain("30 days after they are created");
  });

  it("/privacy names every field stored under carbadia-terminal-prefs", () => {
    // Record<keyof TerminalPrefs, …>:偏好加字段而这里没加说明时 tsc 先报错,提醒同步隐私页 §4
    const disclosed: Record<keyof TerminalPrefs, string> = {
      interval: "chart interval",
      agg: "order-book grouping",
      depth: "depth",
      bottomTab: "bottom tab",
      indicators: "indicators",
      lastSymbol: "last symbol",
      density: "row density", // P3-10
    };
    const sentence = PRIVACY.slice(PRIVACY.indexOf("carbadia-terminal-prefs ("), PRIVACY.indexOf(");", PRIVACY.indexOf("carbadia-terminal-prefs (")));
    for (const [field, phrase] of Object.entries(disclosed)) expect(sentence, field).toContain(phrase);
    expect(Object.keys(disclosed).sort()).toEqual(Object.keys(DEFAULT_PREFS).sort());
  });
});
