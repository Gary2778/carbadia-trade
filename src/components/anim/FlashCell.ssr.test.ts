import { createElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlashCell } from "./FlashCell";

// 价格变化后的那一次渲染没法在 renderToStaticMarkup 里走到(首帧没有「上一次」)。这里把 useState 换成可控的桩:
// states 非空时依次吐出预设的 [prev, flash],setter 什么都不做;为空时透传真 useState(上面的 SSR 用例照常)。
// 然后直接调用 FlashCell 拿到它返回的元素树,断言 key 挂在谁身上。
const hooks = vi.hoisted(() => ({ states: [] as unknown[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => (hooks.states.length ? [hooks.states.shift(), () => {}] : actual.useState(init)),
  };
});

// §9.1 第 7 条:不引 jsdom,只做 renderToStaticMarkup。渲染期 setState 的「记住上一次 value」模式
// 如果比较用 !==,value 为 NaN 时 NaN !== NaN 恒真,每次渲染都再 setState,React 抛 "Too many re-renders";
// 这里锁住 Object.is 的写法:坏值只是不闪,不能把整棵树打进错误边界。

// children 按 createElement 的位置参数传(react/no-children-prop),类型上从 props 里去掉(同 ui.ssr.test.ts)
type Value = number | null | undefined;
const Cell = FlashCell as ComponentType<{ value: Value; className?: string }>;
const render = (value: Value) => renderToStaticMarkup(createElement(Cell, { value, className: "tnum" }, "$70.37"));

describe("FlashCell", () => {
  it("renders the children in a chip without a flash class on the first render", () => {
    const html = render(7037);
    expect(html).toContain("$70.37");
    expect(html).toContain("rounded-chip");
    expect(html).toContain("tnum");
    expect(html).not.toMatch(/flash-(up|down)/);
  });

  it("accepts null and undefined values", () => {
    expect(render(null)).toContain("$70.37");
    expect(render(undefined)).toContain("$70.37");
  });

  it("does not loop on NaN (NaN !== NaN would re-run the render-phase setState forever)", () => {
    expect(() => render(NaN)).not.toThrow();
    expect(render(NaN)).toContain("$70.37");
    expect(render(NaN)).not.toMatch(/flash-(up|down)/);
  });
});

describe("FlashCell keeps its children mounted across price changes (NumberTicker keeps tweening on /market)", () => {
  afterEach(() => {
    hooks.states = [];
  });
  type Props = { value: number; children: ReactNode; className?: string };
  const call = (props: Props, prev: number, flash: { key: number; dir: "up" | "down" | null }) => {
    hooks.states = [prev, flash];
    return (FlashCell as unknown as (p: Props) => ReactElement<{ className: string; children: ReactNode[] }>)(props);
  };

  it("the changing key sits on a background layer; the children stay in the same slot of an unkeyed wrapper", () => {
    const child = createElement("span", { "data-probe": "" }, "$70.38");
    const first = call({ value: 7038, children: child, className: "px-1" }, 7037, { key: 3, dir: "up" });
    const second = call({ value: 7039, children: child, className: "px-1" }, 7038, { key: 4, dir: "up" });
    for (const [el, key] of [
      [first, "3"],
      [second, "4"],
    ] as const) {
      expect(el.key).toBeNull(); // 外层不重挂载
      expect(el.props.className).toContain("px-1");
      const [layer, content] = el.props.children as [ReactElement<{ className: string; "aria-hidden": string; children?: ReactNode }>, ReactNode];
      expect(content).toBe(child); // 子树原样、同一位置:React 不会卸载它
      expect(layer.key).toBe(key); // 只有底色层随变化重挂载,CSS 动画重新开始
      expect(layer.props.className).toContain("flash-up");
      expect(layer.props["aria-hidden"]).toBe("true");
      expect(layer.props.children).toBeUndefined();
    }
  });

  it("no flash: the layer slot is empty but kept, so the children never change position", () => {
    const child = createElement("span", null, "—");
    const el = call({ value: 7037, children: child }, 7037, { key: 0, dir: null });
    const [layer, content] = el.props.children as [ReactNode, ReactNode];
    expect(layer).toBeNull();
    expect(content).toBe(child);
  });
});
