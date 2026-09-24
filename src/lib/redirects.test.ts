import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS, safeReturnTo } from "./redirects";

// cbda.trade 没有 /exchange 前缀;带旧前缀落进来的链接整棵子树平移到根
describe("旧前缀重定向表", () => {
  it("/exchange/:path* → /:path*(308)", () => {
    expect(LEGACY_REDIRECTS).toEqual([{ source: "/exchange/:path*", destination: "/:path*", permanent: true }]);
  });
});

describe("safeReturnTo", () => {
  it("站内相对路径原样返回", () => {
    expect(safeReturnTo("/otc")).toBe("/otc");
  });
  it("空值、绝对地址、协议相对地址都回落到 /portfolio", () => {
    expect(safeReturnTo(null)).toBe("/portfolio");
    expect(safeReturnTo("https://evil.example")).toBe("/portfolio");
    expect(safeReturnTo("//evil.example")).toBe("/portfolio");
  });
});
