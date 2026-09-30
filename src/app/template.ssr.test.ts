import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Template from "./template";

// 站点 template 的首屏不淡入(P1-25f 复测后 lead 修):服务端 HTML 里内容必须是不透明的,LCP 才按内容画出的时刻算。
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

describe("template · 首屏不淡入", () => {
  it("服务端渲染不带 opacity:0 的初始样式,内容照常输出", () => {
    const html = renderToStaticMarkup(createElement(Template, null, createElement("p", null, "hello")));
    expect(html).toContain("<p>hello</p>");
    expect(html).not.toMatch(/opacity:\s*0[;"]/);
  });
});
