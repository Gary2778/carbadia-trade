import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog, type DialogProps } from "./Dialog";
import { EmptyState } from "./EmptyState";
import { ErrorState } from "./ErrorState";
import { Skeleton } from "./Skeleton";
import { DEFAULT_OVERSCAN, DEFAULT_ROW_HEIGHT, VirtualList } from "./VirtualList";

// §9.1 第 7 条:不引 jsdom,组件只做 renderToStaticMarkup 的服务端标记测试;交互靠内置浏览器手工验收。
// 没有 LangProvider 时 useT 落到默认英文,断言按核心文案的 ui 命名空间写。这里故意不包 TerminalMessagesProvider:
// ui/ 基础件在 /trade 之外也用(P2-01),一旦哪个又去读 useT("terminal"),这些用例会直接抛错。

const count = (html: string, needle: string) => html.split(needle).length - 1;
// children 按 createElement 的位置参数传(react/no-children-prop),类型上从 props 里去掉
const dialog = (props: Omit<DialogProps, "children">, ...children: ReactNode[]) =>
  createElement(Dialog as ComponentType<Omit<DialogProps, "children">>, props, ...children);

describe("Skeleton", () => {
  it("renders the requested number of fixed-height rows and announces loading", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { rows: 4 }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading…");
    expect(count(html, "h-row")).toBe(4);
  });

  it("defaults to three rows and renders one filling block for height=panel", () => {
    expect(count(renderToStaticMarkup(createElement(Skeleton)), "h-row")).toBe(3);
    const panel = renderToStaticMarkup(createElement(Skeleton, { height: "panel", className: "extra" }));
    expect(count(panel, "h-row")).toBe(0);
    expect(count(panel, "t-shimmer")).toBe(1);
    expect(panel).not.toContain("animate-pulse");
    expect(panel).toContain("extra");
  });
});

describe("EmptyState", () => {
  it("renders title, hint and the action slot", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: "No open orders", hint: "Place one from the order panel", action: createElement("a", { href: "/trade" }, "Go") }),
    );
    expect(html).toContain("No open orders");
    expect(html).toContain("Place one from the order panel");
    expect(html).toContain('<a href="/trade">Go</a>');
  });

  it("falls back to ui.empty when no title is given", () => {
    const html = renderToStaticMarkup(createElement(EmptyState));
    expect(html).toContain("Nothing here yet");
    expect(html).not.toContain("<button");
  });
});

describe("ErrorState", () => {
  it("is an alert in danger colour with a retry button when onRetry is given", () => {
    const html = renderToStaticMarkup(createElement(ErrorState, { message: "Feed unavailable", onRetry: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("text-danger");
    expect(html).toContain("Feed unavailable");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Retry<\/button>/);
  });

  it("has no button without onRetry", () => {
    const html = renderToStaticMarkup(createElement(ErrorState, { message: "x" }));
    expect(html).not.toContain("<button");
  });
});

describe("VirtualList", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ symbol: `SYM-${i}` }));
  const renderRow = (item: { symbol: string }, index: number): ReactNode => createElement("span", { "data-row": index }, item.symbol);
  const getKey = (item: { symbol: string }) => item.symbol;

  it("keeps the TableViewport region semantics and renders the empty slot for an empty list", () => {
    const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items: [], label: "Instrument list, scrollable", renderRow, getKey }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Instrument list, scrollable"');
    expect(html).toMatch(/aria-describedby="([^"]+)"[\s\S]*id="\1"/);
    expect(html).toContain("Scroll to see more rows");
    expect(html).toContain("Nothing here yet");
    const custom = renderToStaticMarkup(
      createElement(VirtualList<{ symbol: string }>, { items: [], label: "x", renderRow, getKey, empty: createElement("p", null, "No fills") }),
    );
    expect(custom).toContain("No fills");
    expect(custom).not.toContain("Nothing here yet");
  });

  it("renders the first rows on the server (initialRect) but not the whole list", () => {
    const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey }));
    for (let i = 0; i < DEFAULT_OVERSCAN; i++) expect(html, `row ${i}`).toContain(`data-row="${i}"`);
    const rendered = count(html, "data-index=");
    expect(rendered).toBeGreaterThanOrEqual(DEFAULT_OVERSCAN);
    expect(rendered).toBeLessThan(items.length);
    expect(html).not.toContain("SYM-99");
    // 行绝对定位,按 CSS 行高(--spacing-row)平移,容器总高 = 行数 × --spacing-row;
    // 断言里不写裸 px 字面量,ui/** 是 tokens-only 目录,扫描器可能连测试文件一起读
    expect(html).toContain("transform:translateY(calc(var(--spacing-row) * 1))");
    expect(html).toContain(`height:calc(var(--spacing-row) * ${items.length})`);
    expect(count(html, "h-row")).toBe(rendered);
  });

  // P1-25d 终审修复:粗指针设备在 ≥ 80rem(左栏在网格里)时,CSS 首帧就把 --spacing-row 换成 2.75rem(行 44 px),
  // 而虚拟器的服务端快照按 22 px 估算、按像素 start 平移 —— SSR / 水合首帧每行压住下一行的一半。
  // 行高是 h-row 定死的(所有行等高),所以位置与总高一律用 CSS 变量表达,首帧就跟着 CSS 走;像素估值只决定渲染哪几行。
  it("positions rows and sizes the track in --spacing-row units, whatever pixel estimate the virtualizer got", () => {
    const touchEstimate = 44; // 服务端快照拿不到粗指针:估值与 CSS 真实行高不一致时,位置也不能跟着估值走
    for (const rowHeight of [DEFAULT_ROW_HEIGHT, touchEstimate]) {
      const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey, rowHeight }));
      const starts = [...html.matchAll(/transform:translateY\(([^;"]+)\)/g)].map((m) => m[1]);
      expect(starts.length).toBeGreaterThan(1);
      starts.forEach((start, i) => expect(start).toBe(`calc(var(--spacing-row) * ${i})`));
      expect(html).toContain(`height:calc(var(--spacing-row) * ${items.length})`);
      expect(html).not.toMatch(/translateY\(\d/);
    }
  });

  it("honours rowHeight and overscan (the pixel estimate only picks the rendered range)", () => {
    const rowHeight = 20;
    const overscan = 2;
    const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey, rowHeight, overscan }));
    expect(html).toContain(`height:calc(var(--spacing-row) * ${items.length})`);
    expect(html).toContain("transform:translateY(calc(var(--spacing-row) * 1))");
    expect(count(html, "data-index=")).toBeLessThanOrEqual(2 * overscan + 1);
  });

  it("still renders at least one row on the server with overscan 0", () => {
    const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey, overscan: 0 }));
    expect(html).toContain('data-row="0"');
    expect(count(html, "data-index=")).toBeGreaterThanOrEqual(1);
    expect(count(html, "data-index=")).toBeLessThan(items.length);
  });

  it("header (P2-12): a sticky row inside the scroll container above the rows, header and track at the minimum width; without it the markup is unchanged", () => {
    const header = createElement("div", { "data-head": "" }, "Head");
    const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey, header, minWidth: "40rem" }));
    const region = html.slice(html.indexOf('role="region"'));
    expect(region).toContain('<div class="sticky top-0 z-(--z-sticky)" style="min-width:40rem"><div data-head="">Head</div></div><div class="relative w-full" style="height:calc(var(--spacing-row) * 100);min-width:40rem">');
    expect(html).toContain('data-row="0"');
    // 空列表:表头照样在,空状态在它下面
    const empty = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items: [], label: "x", renderRow, getKey, header }));
    expect(empty.indexOf("data-head")).toBeGreaterThan(-1);
    expect(empty.indexOf("data-head")).toBeLessThan(empty.indexOf("Nothing here yet"));
    const plain = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey }));
    expect(plain).not.toContain("sticky");
    expect(plain).not.toContain("min-width");
    expect(plain).toContain('<div class="relative w-full" style="height:calc(var(--spacing-row) * 100)">');
  });

  // P2-12 收尾:贴顶表头的 z-index 不能漏到页面的层叠上下文里 —— 否则页面滚动时,它和同为 --z-sticky、DOM 在前的终端头部比,
  // 画在头部上面、还截走头部的点击。有表头时 region 自己是层叠上下文(isolate);没有表头时 class 与原来逐字节一致
  it("header: the scroll region isolates its own stacking context, so the sticky header never paints over sticky page chrome; without a header the class is unchanged", () => {
    const regionClass = (html: string) => (/role="region"[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "").split(" ");
    const header = createElement("div", { "data-head": "" }, "Head");
    for (const list of [items, []]) {
      const html = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items: list, label: "x", renderRow, getKey, header, className: "min-h-0 flex-1" }));
      expect(regionClass(html)).toEqual(expect.arrayContaining(["relative", "overflow-auto", "isolate", "min-h-0", "flex-1"]));
      // 表头仍在 region 里面(隔离的正是它)
      expect(html.indexOf("data-head")).toBeGreaterThan(html.indexOf('role="region"'));
    }
    const plain = renderToStaticMarkup(createElement(VirtualList<{ symbol: string }>, { items, label: "x", renderRow, getKey, className: "min-h-0 flex-1" }));
    expect(regionClass(plain).join(" ")).toBe("relative overflow-auto tabular-nums focus-visible:outline-none focus-visible:shadow-focus min-h-0 flex-1");
  });
});

describe("Dialog", () => {
  it("emits nothing while closed", () => {
    const html = renderToStaticMarkup(dialog({ open: false, onClose: () => {}, title: "Confirm order" }, "body"));
    expect(html).toBe("");
  });

  it("renders a native dialog labelled by its title with a close button when open", () => {
    const html = renderToStaticMarkup(dialog({ open: true, onClose: () => {}, title: "Confirm order", describedBy: "desc-1" }, createElement("p", { id: "desc-1" }, "Body")));
    expect(html).toMatch(/^<dialog /);
    expect(html).toMatch(/aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"[^>]*>Confirm order<\/h2>/);
    expect(html).toContain('aria-describedby="desc-1"');
    expect(html).toContain('<p id="desc-1">Body</p>');
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).toContain("bg-surface-overlay");
  });
});
