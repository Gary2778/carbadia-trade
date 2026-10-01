import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changeTone } from "./InstrumentRow";
import { pnlTone, sideTone } from "./TabTable";

// 终端文字对比度门禁(WCAG 2.x 相对亮度;P1-25d 终审修复,P1-26 扩到全部涨跌文字):按两种外观(浅色、dark)解析 globals.css 的声明链,
// 断言终端文字 token 在终端的三种面(面板、二级面板、对话框)上都 ≥ 4.5:1;再把半透明染色(选中、悬停、深度条、闪烁底)叠到面板上,
// 按真正压在上面的文字查一遍(WASHES),绿涨红跌与红涨绿跌两种涨跌轴各查一遍。
// 涨跌文字只用终端 token(下方源码断言):盘口价格 --terminal-book-up / -down,终端别处(成交带、头部、标的列表、底部 Tab、
// 成交详情、确认框)--terminal-up / -down(P1-26,用户决定 §9.1 第 43 条:浅色与盘口价格列同一套深一级同色相,主站配色不动)。
// 闪烁底按 keyframes 的起点(整层 --up-soft / --down-soft)算,盘口行里它叠在悬停底与深度条上 —— 没有豁免项。
// 只读 globals.css 的顶层规则块(@media 里的块不参与:减弱透明度只换 dark 的站点面,终端面板本来就不透明)。

const GLOBALS = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

/** 顶层规则块:selector → body(同一 selector 出现多次时按出现顺序拼接,后者覆盖前者) */
function topLevelBlocks(css: string): Map<string, string> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = new Map<string, string>();
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = 0;
  let selector = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = src.slice(selectorStart, i).trim().replace(/\s+/g, " ");
        bodyStart = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth < 0) throw new Error(`unbalanced "}" at ${i}`);
      if (depth === 0) {
        blocks.set(selector, `${blocks.get(selector) ?? ""}\n${src.slice(bodyStart, i)}`);
        selectorStart = i + 1;
      }
    } else if (ch === ";" && depth === 0) {
      selectorStart = i + 1; // @import "…"; 这类顶层语句
    }
  }
  if (depth !== 0) throw new Error('unbalanced "{"');
  return blocks;
}

const BLOCKS = topLevelBlocks(GLOBALS);
const block = (selector: string): string => {
  const body = BLOCKS.get(selector);
  if (body === undefined) throw new Error(`globals.css has no top-level block \`${selector}\``);
  return body;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** body 里最后一处 `token: value;` 的值(`--muted:` 不会误中 `--muted-2:`) */
function valueOf(body: string, token: string): string | undefined {
  const all = [...body.matchAll(new RegExp(`(?:^|[\\s;{])${escapeRe(token)}\\s*:\\s*([^;]+);`, "g"))];
  return all.length ? all[all.length - 1][1].trim() : undefined;
}

/**
 * 每种外观按层叠顺序排好的声明块(后者覆盖前者);data-terminal 与 data-glass="off" 同挂在 TerminalShell 根上。
 * 无外观前缀的 [data-terminal] 在两种外观里都生效(dark 块覆盖它声明过的 token),盘口价格的别名只在它里面定义。
 */
const LOOKS: { look: string; chain: string[] }[] = [
  { look: "light", chain: [block(":root"), block("[data-terminal]")] },
  {
    look: "dark",
    chain: [
      block(":root"),
      block(':root[data-theme="dark"]'),
      block("[data-terminal]"),
      block('html[data-theme="dark"] [data-terminal]'),
      block('html[data-theme="dark"] [data-glass="off"]'),
    ],
  },
];
/** 涨跌轴:红涨绿跌时再叠上文件末尾的两条翻转规则(只换别名的指向,外观块不声明这些别名,见下方源码断言) */
const RED_UP = [block('html[data-updown="red-up"]'), block('html[data-updown="red-up"] [data-terminal]')];
const AXES: { axis: string; extra: string[] }[] = [
  { axis: "green-up", extra: [] },
  { axis: "red-up", extra: RED_UP },
];

/** 在一条声明链里解析 token:从最后一块往前找,var(--x) 递归解析 */
function resolveToken(chain: readonly string[], token: string, seen: readonly string[] = []): string {
  if (seen.includes(token)) throw new Error(`var() cycle: ${[...seen, token].join(" → ")}`);
  for (let i = chain.length - 1; i >= 0; i--) {
    const value = valueOf(chain[i], token);
    if (value === undefined) continue;
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    return ref ? resolveToken(chain, ref[1], [...seen, token]) : value;
  }
  throw new Error(`${token} is not declared in this look`);
}

function srgbOf(color: string): [number, number, number] {
  const m = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) throw new Error(`expected an opaque hex colour, got \`${color}\``);
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}
const linear = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: [number, number, number]) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** WCAG 2.x 对比度 */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(srgbOf(a)), luminance(srgbOf(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Rgb = [number, number, number];
/** 一层颜色:不透明色 alpha = 1;rgba(…) 与 color-mix(in srgb, <色> N%, transparent)(= 该色、alpha N%)是半透明染色 */
function layerOf(chain: readonly string[], value: string): { rgb: Rgb; alpha: number } {
  const ref = value.match(/^var\((--[\w-]+)\)$/);
  if (ref) return layerOf(chain, resolveToken(chain, ref[1]));
  const rgba = value.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  const mix = value.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/);
  if (mix) {
    const inner = layerOf(chain, mix[1]);
    return { rgb: inner.rgb, alpha: inner.alpha * (Number(mix[2]) / 100) };
  }
  return { rgb: srgbOf(value), alpha: 1 };
}
/** 从 base 起,按顺序把各层半透明染色叠上去(sRGB 里的 source-over),得到文字真正压着的不透明底色 */
function composite(chain: readonly string[], base: string, layers: readonly string[]): string {
  let rgb = layerOf(chain, resolveToken(chain, base)).rgb;
  for (const token of layers) {
    const { rgb: top, alpha } = layerOf(chain, resolveToken(chain, token));
    rgb = rgb.map((c, i) => c * (1 - alpha) + top[i] * alpha) as Rgb;
  }
  return `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}


/** 终端的源码:src/components/terminal、src/app/trade 与资产页组件 src/components/account(P2-10)下的 .tsx(不含测试);name 是相对各自目录的路径 */
function tsxUnder(dir: string, prefix: string): { name: string; src: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return tsxUnder(join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [{ name: `${prefix}${entry.name}`, src: readFileSync(join(dir, entry.name), "utf8") }];
  });
}
const TERMINAL_SOURCES = [
  ...tsxUnder(fileURLToPath(new URL("./", import.meta.url)), ""),
  ...tsxUnder(fileURLToPath(new URL("../../app/trade/", import.meta.url)), "app/trade/"),
  ...tsxUnder(fileURLToPath(new URL("../account/", import.meta.url)), "components/account/"),
];

/** 终端文字坐在这三种面上:面板、二级面板(输入框、下拉、买卖切换)、对话框(ui/Dialog 的 --surface-overlay) */
const PANEL = "--terminal-panel";
const OVERLAY = "--surface-overlay";
const SURFACES = [PANEL, "--terminal-panel-2", OVERLAY];
const HOVER = "--terminal-row-hover";
const SELECTED = "--terminal-selected";
/** 终端里承载文字的三级灰阶 */
const TEXT = ["--foreground", "--muted", "--muted-2"];
/** 终端别处的涨跌文字(P1-26):成交带价格、头部最新价 / 24h 涨跌 / 买一卖一、标的列表的涨跌幅、底部 Tab 的方向与盈亏、
 *  持仓行的卖出按钮、成交详情的方向、确认框的方向标签(下方源码断言)。账本变动(流水页签、成交详情的账本行)不在此列:中性色 */
const DIRECTION_TEXT = ["--terminal-up", "--terminal-down"];
/** 正文(含 10–13 px 的终端小字)的 AA 门槛 */
const AA_TEXT = 4.5;

describe("contrast helpers", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#fff")).toBeCloseTo(4.54, 2);
  });

  it("resolves each look to its own opaque terminal panel", () => {
    expect(LOOKS.map(({ look }) => look)).toEqual(["light", "dark"]);
    expect(LOOKS.map(({ chain }) => resolveToken(chain, PANEL))).toEqual(["#ffffff", "#11141c"]);
    expect(LOOKS.map(({ chain }) => resolveToken(chain, OVERLAY))).toEqual(["#ffffff", "#0d101b"]);
  });

  it("composites rgba() and color-mix(…, transparent) washes over the panel", () => {
    const light = LOOKS[0].chain;
    // rgba(10, 138, 82, 0.1) 叠在 #fff 上;color-mix(in srgb, #00a15f 12%, transparent) 叠在 #fff 上
    expect(composite(light, PANEL, [SELECTED])).toBe("#e7f3ee");
    expect(composite(light, PANEL, ["--up-soft"])).toBe("#e0f4ec");
    expect(composite(light, PANEL, [])).toBe("#ffffff");
  });
});

/** 盘口行里不分方向的字:数量 --foreground,累计与笔数 --terminal-book-muted(OrderBookRow;下面另有源码断言) */
const BOOK_TEXT = ["--foreground", "--terminal-book-muted"];

/** 一种真实的底:从 base 起按顺序叠 layers 的半透明染色,text 是真正压在上面的文字 token */
type Wash = { where: string; base: string; layers: string[]; text: string[] };

/**
 * 盘口一行(OrderBookRow,terminal.css 的 .t-book-row 自成层叠上下文):行自己的悬停底 → 深度条(同方向,从行尾长出,
 * 长的时候盖到整行)→ 闪烁底(数量变化时整行一闪,同方向,keyframes 起点是整层 --up-soft / --down-soft)→ 文字。
 * 买卖两侧 × 悬停有无 × 深度条有无 × 闪烁有无,十六种叠法全查。压着的字:数量、累计与笔数、同方向的价格
 *(买盘 --terminal-book-up 压在涨色深度条上,卖盘 --terminal-book-down 压在跌色深度条上,两者随涨跌轴一起翻转)。
 * 最差的是「悬停 + 深度条 + 闪烁起点」:P1-26 之前的盘口价格在这里浅色 4.21 / 4.06:1、dark 跌色 3.94:1,累计与笔数 dark 4.46:1
 *(P1-25e 把闪烁当一次性动画排除在外),所以 --terminal-book-green / -red 与 dark 的 --terminal-book-muted 按这一叠重新取值。
 */
const BOOK_ROWS: Wash[] = (["up", "down"] as const).flatMap((side) =>
  [false, true].flatMap((hover) =>
    [false, true].flatMap((depth) =>
      [false, true].map((flash) => ({
        where: `book ${side === "up" ? "bid" : "ask"} row${hover ? ", hovered" : ""}${depth ? ", depth bar" : ""}${flash ? ", flash" : ""}`,
        base: PANEL,
        layers: [...(hover ? [HOVER] : []), ...(depth ? [`--${side}-soft`] : []), ...(flash ? [`--${side}-soft`] : [])],
        text: [...BOOK_TEXT, `--terminal-book-${side}`],
      })),
    ),
  ),
);

/**
 * 终端里文字真正压着的半透明染色底(终审复核;P1-26 补全涨跌文字与闪烁底):
 *   - 盘口行:见 BOOK_ROWS;
 *   - 列表行悬停(标的、成交带、委托 / 历史 / 成交 / 持仓):三级灰与涨跌文字都有;
 *   - --terminal-selected:选中的分段 / 页签 / 周期 / 指标按钮与当前标的行 —— 字是 --foreground,当前标的行还有 24h 涨跌;
 *   - 价格闪烁(FlashCell):头部最新价按 24h 涨跌着涨跌色、盘口中缝最新价是 --foreground,价格涨闪涨色底、跌闪跌色底,
 *     与 24h 涨跌的方向无关,所以两种字色 × 两种闪烁底全查;
 *   - 方向色描边的小按钮(持仓行的「卖出」):悬停时自己铺同方向染色,底下还有行的悬停底;两侧对称地查;
 *   - 对话框:确认框的方向标签压在同方向染色上(成交详情的分录增减直接在对话框底上,见上一条「三种面」)。
 * 深度条之外的 --up-soft / --down-soft 与盘口深度条同是站点原料色的 12%(浅色)/ 14%(深色),随涨跌轴翻转。
 */
const WASHES: Wash[] = [
  ...BOOK_ROWS,
  { where: "list row, hovered", base: PANEL, layers: [HOVER], text: [...TEXT, ...DIRECTION_TEXT] },
  { where: "selected row / segment", base: PANEL, layers: [SELECTED], text: ["--foreground", ...DIRECTION_TEXT] },
  ...["--up-soft", "--down-soft"].map((flash) => ({ where: `price flash (${flash})`, base: PANEL, layers: [flash], text: ["--foreground", ...DIRECTION_TEXT] })),
  ...(["up", "down"] as const).map((side) => ({
    where: `${side === "up" ? "buy" : "sell"}-tinted button, hovered in a hovered row`,
    base: PANEL,
    layers: [HOVER, `--${side}-soft`],
    text: [`--terminal-${side}`],
  })),
  ...(["up", "down"] as const).map((side) => ({ where: `confirm dialog ${side === "up" ? "buy" : "sell"} chip`, base: OVERLAY, layers: [`--${side}-soft`], text: [`--terminal-${side}`] })),
];

describe("terminal text contrast (WCAG AA)", () => {
  it(`keeps ${[...TEXT, ...DIRECTION_TEXT].join(", ")} at ≥ ${AA_TEXT}:1 on every terminal surface in light and dark, on both up/down axes`, () => {
    const failures: string[] = [];
    for (const { look, chain: lookChain } of LOOKS) {
      for (const { axis, extra } of AXES) {
        const chain = [...lookChain, ...extra];
        for (const text of [...TEXT, ...DIRECTION_TEXT]) {
          for (const surface of SURFACES) {
            const ratio = contrastRatio(resolveToken(chain, text), resolveToken(chain, surface));
            if (ratio < AA_TEXT) failures.push(`${look} ${axis}: ${text} on ${surface} = ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it(`keeps the text on the terminal's translucent washes (selection, hover, depth bars, price flashes, tinted buttons) at ≥ ${AA_TEXT}:1 on both up/down axes, with no exemptions`, () => {
    const failures: string[] = [];
    for (const { look, chain: lookChain } of LOOKS) {
      for (const { axis, extra } of AXES) {
        const chain = [...lookChain, ...extra];
        for (const { where, base, layers, text } of WASHES) {
          const background = composite(chain, base, layers);
          for (const token of text) {
            const ratio = contrastRatio(resolveToken(chain, token), background);
            if (ratio < AA_TEXT) failures.push(`${look} ${axis}: ${token} on ${where} (${[base, ...layers].join(" + ")}) = ${ratio.toFixed(2)}:1`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("flips the terminal's direction aliases with the up/down axis, and only [data-terminal] and the red-up rule declare them", () => {
    for (const { look, chain } of LOOKS) {
      // 绿涨红跌:涨 / 买 = 绿、跌 / 卖 = 红;红涨绿跌:反过来 —— 与深度条、闪烁底的 --up-soft / --down-soft 同向
      const flipped = [...chain, ...RED_UP];
      for (const [alias, raw] of [["book-", "book-"], ["", ""]]) {
        expect(resolveToken(chain, `--terminal-${alias}up`), look).toBe(resolveToken(chain, `--terminal-${raw}green`));
        expect(resolveToken(chain, `--terminal-${alias}down`), look).toBe(resolveToken(chain, `--terminal-${raw}red`));
        expect(resolveToken(flipped, `--terminal-${alias}up`), look).toBe(resolveToken(chain, `--terminal-${raw}red`));
        expect(resolveToken(flipped, `--terminal-${alias}down`), look).toBe(resolveToken(chain, `--terminal-${raw}green`));
      }
    }
    // 外观块 html[data-theme="dark"] [data-terminal] 与翻转规则同为 (0,2,1):它若也写别名,红涨绿跌翻不翻就只看两条规则的先后,
    // 所以别名只许无前缀的 [data-terminal]((0,1,0),翻转规则压得过)与翻转规则自己声明
    for (const aliases of [["--terminal-book-up", "--terminal-book-down"], ["--terminal-up", "--terminal-down"]]) {
      const declaring = [...BLOCKS].filter(([, body]) => aliases.some((a) => valueOf(body, a) !== undefined)).map(([selector]) => selector);
      expect(declaring, aliases.join(" / ")).toEqual(["[data-terminal]", 'html[data-updown="red-up"] [data-terminal]']);
    }
  });

  it("uses the order book's deeper set for all direction text in light (user decision §9.1 #43), and keeps the site palette in dark wherever it already passes", () => {
    const [light, dark] = LOOKS.map(({ chain }) => chain);
    // 浅色:终端的涨跌文字与盘口价格列同一套,且确实比站点方向色(主站、按钮底、K 线仍在用)深
    const panel = resolveToken(light, PANEL);
    for (const side of ["green", "red"]) {
      expect(resolveToken(light, `--terminal-${side}`), side).toBe(resolveToken(light, `--terminal-book-${side}`));
      expect(contrastRatio(resolveToken(light, `--terminal-${side}`), panel), side).toBeGreaterThan(contrastRatio(resolveToken(light, `--palette-${side}`), panel));
    }
    // dark:站点的 --palette-green / -red 在终端别处的底上都过 4.5:1,不动;盘口价格只有跌色要为「悬停 + 深度条 + 闪烁」提亮一级
    expect(resolveToken(dark, "--terminal-green")).toBe(resolveToken(dark, "--palette-green"));
    expect(resolveToken(dark, "--terminal-red")).toBe(resolveToken(dark, "--palette-red"));
    expect(resolveToken(dark, "--terminal-book-green")).toBe(resolveToken(dark, "--palette-green"));
  });

  it("the order book row draws its price with --terminal-book-up / -down and its cumulative and order-count columns with --terminal-book-muted (what the wash check above measures), and --terminal-book-muted stays quieter than --foreground", () => {
    const row = readFileSync(fileURLToPath(new URL("./OrderBookRow.tsx", import.meta.url)), "utf8");
    const cells = [...row.matchAll(/<span className="tnum[^"]*">\{(cumText|orders)\}<\/span>/g)];
    expect(cells.map((m) => m[1])).toEqual(["cumText", "orders"]);
    for (const [cell] of cells) {
      expect(cell).toContain("text-(--terminal-book-muted)");
      expect(cell).not.toMatch(/text-muted/);
    }
    const price = row.match(/<span className=\{`tnum[^`]*`\}>\{priceText\}<\/span>/);
    expect(price?.[0]).toContain('bid ? "text-(--terminal-book-up)" : "text-(--terminal-book-down)"');
    expect(price?.[0]).not.toMatch(/\btext-(up|down)\b/);
    // 深度条与闪烁底都是同方向的站点染色(WASHES 的 BOOK_ROWS 按这个叠)
    expect(row).toContain('bid ? "bg-up-soft" : "bg-down-soft"');
    expect(row).toContain('bid ? "flash-up" : "flash-down"');
    for (const { look, chain } of LOOKS) {
      const panel = resolveToken(chain, PANEL);
      expect(contrastRatio(resolveToken(chain, "--foreground"), panel), look).toBeGreaterThan(contrastRatio(resolveToken(chain, "--terminal-book-muted"), panel));
    }
  });

  // 源码门禁(P1-26):终端里不再有站点方向色的文字类。text-up / text-down / text-(--up) 在浅色白底只有 3.35 / 4.46:1,
  // 终端的涨跌文字一律走上面量过的四个 token;三个着色函数(changeTone / sideTone / pnlTone)是大部分调用点的出口。
  it("leaves no site direction-colour text class in the terminal: every direction-coloured word uses one of the four measured tokens", () => {
    const hits = TERMINAL_SOURCES.flatMap(({ name, src }) =>
      src.split("\n").flatMap((line, i) => (/(?<![\w-])text-(?:up|down)(?![\w-])|text-\(--(?:up|down)\)|text-\[var\(--(?:up|down)\)\]/.test(line) ? [`${name}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
    const direction = new Set(TERMINAL_SOURCES.flatMap(({ src }) => [...src.matchAll(/text-\((--terminal-[\w-]+-(?:up|down)|--terminal-(?:up|down))\)/g)].map((m) => m[1])));
    expect([...direction].sort()).toEqual(["--terminal-book-down", "--terminal-book-up", "--terminal-down", "--terminal-up"]);
    expect([changeTone(1.25), changeTone(-0.5), changeTone(0), changeTone(null)]).toEqual(["text-(--terminal-up)", "text-(--terminal-down)", "text-muted", "text-muted"]);
    expect([sideTone("BUY"), sideTone("SELL")]).toEqual(["text-(--terminal-up)", "text-(--terminal-down)"]);
    expect([pnlTone(100), pnlTone(-100), pnlTone(0), pnlTone(null)]).toEqual(["text-(--terminal-up)", "text-(--terminal-down)", "text-muted", "text-muted"]);
  });

  // 实心买卖按钮(下单面板的方向切换与提交、手机底部的买入 / 卖出条、确认框的确认键):终端方向色底 + text-background 的字。
  // 用户决定(计划 §9.1 第 43 条)终端内的涨跌色达到 AA、主站不动 —— 按钮也在终端里,改用 --terminal-up / -down 作底(随涨跌轴翻转),
  // 字底对比在两种外观 × 两个涨跌轴上都 ≥ 4.5:1;站点的 bg-up / bg-down 不再出现在这三个文件里(K 线等图形仍用站点色,不在本条)。
  it("puts the solid buy / sell buttons on the terminal direction fills and keeps their labels at AA in every look and axis", () => {
    for (const name of ["OrderPanel.tsx", "MobileTabs.tsx", "OrderConfirmDialog.tsx"]) {
      const src = TERMINAL_SOURCES.find((s) => s.name === name)?.src ?? "";
      expect(src, name).toContain("bg-(--terminal-up)");
      expect(src, name).toContain("bg-(--terminal-down)");
      expect(src, name).not.toMatch(/(?<![\w-])bg-(?:up|down)(?![\w-])/);
      expect(src, name).toContain("text-background");
    }
    const failures: string[] = [];
    for (const { look, chain: lookChain } of LOOKS) {
      for (const { axis, extra } of AXES) {
        const chain = [...lookChain, ...extra];
        for (const fill of ["--terminal-up", "--terminal-down"]) {
          const ratio = contrastRatio(resolveToken(chain, "--background"), resolveToken(chain, fill));
          if (ratio < AA_TEXT) failures.push(`${look} ${axis}: --background on ${fill} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // 灰阶层级(终审复核):dark 里 --muted-2 仍比 --muted 明显低一阶;浅色里两级已经几乎并成一级 ——
  // --muted #6e6e73 在白底上 5.07:1,--muted-2 #717177 4.85:1,之比约 1.05,列头、单位、标的名读起来和 --muted 一样。
  // 要在浅色保住一阶,得把全站共用的浅色 --muted 压深(约 #5c5c61:白底 6.65:1,与 --muted-2 之比 1.37),那是全站视觉决定,交 lead(见 P1-25d 报告);
  // 在那之前浅色这里只守「不倒挂」,不再用测试名声称层级还在。
  const MIN_STEP: Record<string, number> = { light: 1, dark: 1.2 };
  it("keeps --muted-2 a visible step (≥ 1.2×) quieter than --muted in dark, and never louder than --muted in light, where the two levels have merged", () => {
    const steps: Record<string, number> = {};
    for (const { look, chain } of LOOKS) {
      const panel = resolveToken(chain, PANEL);
      const muted = contrastRatio(resolveToken(chain, "--muted"), panel);
      const muted2 = contrastRatio(resolveToken(chain, "--muted-2"), panel);
      steps[look] = muted / muted2;
      expect(steps[look], `${look}: --muted ${muted.toFixed(2)}:1 vs --muted-2 ${muted2.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN_STEP[look]);
    }
    // 浅色真的并成了一级:哪天 lead 压深了 --muted,这条会失败,提醒把浅色的 MIN_STEP 提到 1.2 并删掉这条
    expect(steps.light).toBeLessThan(1.2);
  });
});
