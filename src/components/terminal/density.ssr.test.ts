import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "@/i18n/test-support"; // = react-dom/server + /trade 布局登记文案的那层 Provider
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import { DEFAULT_ROW_HEIGHT, DENSE_ROW_HEIGHT } from "@/components/ui/VirtualList";
import { DensityToggle } from "./DensityToggle";

// 紧凑行高(P3-10,计划 §6.3.2 C8):useDensity 打桩成可切换的值(服务端快照恒为 comfortable 由 prefs.test.ts 守),
// 渲染开关的两种状态;其余是源码 / CSS 的钉子 —— 行高 token 的切换在 terminal.css,估值在 VirtualList,触屏与高行的覆写写在子节点上。
const prefsState = vi.hoisted(() => ({ density: "comfortable" as "comfortable" | "compact" }));
vi.mock("@/lib/market/prefs", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/market/prefs")>()), useDensity: () => prefsState.density }));

beforeEach(() => {
  prefsState.density = "comfortable";
});

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const TERMINAL_CSS = read("../../app/terminal.css");
const GLOBALS_CSS = read("../../app/globals.css");
/** 去掉注释:只看真正写下的规则 */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("DensityToggle", () => {
  const render = () => renderToStaticMarkup(createElement(DensityToggle));

  it("是一个带可访问名称与按下状态的按钮:未选紧凑时 aria-pressed=false;只有图标,名称在 aria-label 与 title 里", () => {
    const html = render();
    expect(html).toMatch(/^<button type="button" aria-pressed="false" aria-label="Compact rows" title="Compact rows" data-density-toggle="comfortable" class="/);
    expect(html).toContain(`aria-label="${en.terminal.header.density}"`);
    expect(html).not.toContain("bg-(--terminal-selected)");
    // 图标是装饰:读屏只念名称;没有可见文字(头部右侧放不下,见组件注释)
    expect(html).toMatch(/<svg aria-hidden="true"[^>]*><path d="M2\.5 3\.5h11M2\.5 8h11M2\.5 12\.5h11"><\/path><\/svg><\/button>$/);
    expect(html).not.toContain("<span");
  });

  it("紧凑时 aria-pressed=true,底色用选中色(与指标开关同一对 token),图标换成五道紧的线", () => {
    prefsState.density = "compact";
    const html = render();
    expect(html).toMatch(/aria-pressed="true" aria-label="Compact rows" title="Compact rows" data-density-toggle="compact"/);
    expect(html).toContain("bg-(--terminal-selected) text-foreground");
    expect(html).toContain('d="M2.5 2.5h11M2.5 5.25h11M2.5 8h11M2.5 10.75h11M2.5 13.5h11"');
  });

  it("触控目标与另外两个头部开关一致:< 64rem 是 min-h-touch,≥ 64rem 收回;只有图标,宽度也是 44 px(min-w-touch,≥ 64rem 收回)", () => {
    expect(render()).toMatch(/class="[^"]*\bmin-h-touch\b[^"]*\blg:min-h-0\b/);
    expect(render()).toMatch(/class="[^"]*\bmin-w-touch\b[^"]*\blg:min-w-0\b/);
  });

  it("两种语言各有一条文案(terminal.header.density),不写内联三元", () => {
    expect(en.terminal.header.density).toBe("Compact rows");
    expect(zhCN.terminal.header.density).toBe("紧凑行高");
    expect(code(read("./DensityToggle.tsx"))).not.toMatch(/isChinese|zh-CN|lang ===/);
  });

  it("在终端头部与时区选择、涨跌颜色开关同一组(行尾),资产页页头没有它(密度只属于终端)", () => {
    expect(read("./TerminalHeader.tsx")).toMatch(/<TimeZoneSelect \/>\s*<DensityToggle \/>\s*<UpDownToggle \/>/);
    expect(read("../account/AccountPage.tsx")).not.toMatch(/DensityToggle/);
  });
});

describe("行高 token 的切换", () => {
  it("terminal.css:[data-terminal][data-density=compact] 把 --spacing-row 指到 --spacing-row-dense", () => {
    expect(code(TERMINAL_CSS)).toMatch(/\[data-terminal\]\[data-density="compact"\]\s*\{\s*--spacing-row:\s*var\(--spacing-row-dense\);\s*\}/);
  });

  it("globals.css 里 --spacing-row 是 1.375rem、--spacing-row-dense 是 1.25rem;JS 估值 22 / 20 与它们一致(根字号 16)", () => {
    const rem = (name: string) => Number(new RegExp(`^\\s*${name}:\\s*([\\d.]+)rem;`, "m").exec(GLOBALS_CSS)?.[1]);
    expect(rem("--spacing-row") * 16).toBe(DEFAULT_ROW_HEIGHT);
    expect(rem("--spacing-row-dense") * 16).toBe(DENSE_ROW_HEIGHT);
    expect([DEFAULT_ROW_HEIGHT, DENSE_ROW_HEIGHT]).toEqual([22, 20]);
  });

  it("TerminalShell 根节点的 data-density 来自 useDensity()(服务端与水合首帧 comfortable 由 trade-page.ssr.test.ts 与 prefs.test.ts 守)", () => {
    const shell = code(read("./TerminalShell.tsx"));
    expect(shell).toMatch(/const density = useDensity\(\);/);
    expect(shell).toMatch(/data-glass="off" data-density=\{density\} data-layout=\{layout\}/);
  });

  it("没传 rowHeight 的虚拟列表按密度取估值(盘口 tape、各页签、标的列表);只有触屏的 44 与条件单历史的 44 是显式的", () => {
    const list = code(read("../ui/VirtualList.tsx"));
    expect(list).toMatch(/const density = useDensity\(\);/);
    expect(list).toMatch(/rowHeightProp \?\? \(density === "compact" \? DENSE_ROW_HEIGHT : DEFAULT_ROW_HEIGHT\)/);
    expect(code(read("./InstrumentPanel.tsx"))).toMatch(/rowHeight=\{touchRows \? TOUCH_ROW_HEIGHT : undefined\}/);
    expect(code(read("./TabTable.tsx"))).toMatch(/rowHeight=\{tallRows \? TALL_ROW_HEIGHT : undefined\}/);
  });

  it("触屏的 44 px 行与条件单历史的高行写在子节点上,仍压过终端根的密度;两处都不读密度", () => {
    expect(code(read("./InstrumentPanel.tsx"))).toMatch(/pointer-coarse:\[--spacing-row:var\(--spacing-row-touch\)\] max-lg:\[--spacing-row:var\(--spacing-row-touch\)\]/);
    expect(code(read("./TabTable.tsx"))).toMatch(/tallRows \? "min-h-0 flex-1 \[--spacing-row:var\(--spacing-row-touch\)\]"/);
    expect(code(TERMINAL_CSS)).not.toMatch(/data-density[^{]*\{[^}]*row-touch/);
  });

  it("所有行高都经 h-row / min-h-row(行不写死数字),所以切换不用逐个组件改", () => {
    for (const file of ["./TapeRow.tsx", "./OrderBookRow.tsx", "./SpreadBar.tsx", "./TabTable.tsx", "./PositionsTab.tsx", "./InstrumentRow.tsx", "../ui/VirtualList.tsx"]) {
      expect(read(file), file).toMatch(/\b(?:min-)?h-row\b/);
    }
  });
});

describe("持仓行的「止盈止损」按钮在紧凑行高里放得下", () => {
  it("行距是行高的一半(两行正好一行高:22 px 行 11 px、20 px 行 10 px);按钮上不再写固定的 leading-none", () => {
    expect(code(TERMINAL_CSS)).toMatch(/\[data-terminal\] \[data-tpsl\]\s*\{\s*line-height:\s*calc\(var\(--spacing-row\) \/ 2\);\s*\}/);
    const tab = read("./PositionsTab.tsx");
    const button = /data-tpsl=""[\s\S]*?className="([^"]*)"/.exec(tab)?.[1] ?? "";
    expect(button).toContain("whitespace-normal");
    expect(button).toContain("text-balance");
    expect(button).not.toMatch(/\bleading-/);
  });
});
