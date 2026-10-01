import { describe, expect, it } from "vitest";
import { LEGACY_REDIRECTS, safeReturnTo } from "./redirects";

// cbda.trade 没有 /exchange 前缀;带旧前缀落进来的链接整棵子树平移到根。
// 旧资产页 /portfolio 与 /dashboard 由 /trade/account 取代(计划 §6.2.2 C8,P2-10)。
describe("旧地址重定向表", () => {
  // /portfolio 与 /dashboard 是临时跳转(307):永久跳转会被浏览器长期缓存,回滚到没有 /trade/account 的 Phase 1 后收不回来(P2-13)
  it("/exchange/:path* → /:path*(308);/portfolio 与 /dashboard → /trade/account(307,回滚安全)", () => {
    expect(LEGACY_REDIRECTS).toEqual([
      { source: "/exchange/:path*", destination: "/:path*", permanent: true },
      { source: "/portfolio", destination: "/trade/account", permanent: false },
      { source: "/dashboard", destination: "/trade/account", permanent: false },
    ]);
  });
});

describe("safeReturnTo", () => {
  /** 登录页的 router.push 就是这样解析回跳目标的(Next 的 app router:new URL(href, location.href)) */
  const resolved = (target: string) => new URL(target, "https://cbda.trade/login?returnTo=x");

  it("站内相对路径原样返回", () => {
    expect(safeReturnTo("/otc")).toBe("/otc");
    expect(safeReturnTo("/trade/account")).toBe("/trade/account");
    expect(safeReturnTo("/trade/VCS-FOR-2021?side=BUY")).toBe("/trade/VCS-FOR-2021?side=BUY");
    expect(safeReturnTo("/trade/VCS-FOR-2021?side=SELL#book")).toBe("/trade/VCS-FOR-2021?side=SELL#book");
  });

  it("空值、绝对地址、协议相对地址都回落到资产页 /trade/account", () => {
    expect(safeReturnTo(null)).toBe("/trade/account");
    expect(safeReturnTo(undefined)).toBe("/trade/account");
    expect(safeReturnTo("")).toBe("/trade/account");
    expect(safeReturnTo("https://evil.example")).toBe("/trade/account");
    expect(safeReturnTo("//evil.example")).toBe("/trade/account");
    expect(safeReturnTo("/\\evil.example")).toBe("/trade/account");
    expect(safeReturnTo("javascript:alert(document.cookie)")).toBe("/trade/account");
    expect(safeReturnTo("trade/account")).toBe("/trade/account");
  });

  // 终审 SEC-1:?returnTo=/%09/evil.example 经 useSearchParams 解码成 `/\t/evil.example`,旧正则只看第二个字符(制表符)就放行,
  // 浏览器解析时删掉制表符 / 换行,结果是 https://evil.example/
  it("控制字符、空白、反斜杠一律拒绝(浏览器解析时会删掉或改写它们)", () => {
    for (const raw of ["/\t/evil.example", "/\n/evil.example", "/\r\\evil.example", "/\r/evil.example", " /\t/evil.example", "/\u0000/evil.example", "/\u007F/evil.example", "/ /evil.example", "/　/evil.example", "/ok\\..\\..\\evil"]) {
      expect(safeReturnTo(raw), JSON.stringify(raw)).toBe("/trade/account");
    }
    // 旧实现确实会把这些原样交出去,而它们解析之后是站外
    expect(resolved("/\t/evil.example").origin).toBe("https://evil.example");
    expect(resolved("/\n/evil.example").origin).toBe("https://evil.example");
  });

  it("解析之后变成 // 开头的路径(点段折叠)也拒绝:交给 router.push 会成为协议相对地址", () => {
    expect(new URL("/.//evil.example", "https://cbda.trade").pathname).toBe("//evil.example");
    for (const raw of ["/.//evil.example", "/..//evil.example", "/a/..//evil.example", "/%2e//evil.example"]) {
      expect(safeReturnTo(raw), raw).toBe("/trade/account");
    }
  });

  it("返回值在登录页上解析之后总是本站(逐个载荷核对)", () => {
    const payloads = [
      "/\t/evil.example", "/\n/evil.example", "/\r\\evil.example", "//evil.example", "/\\evil.example", "https://evil.example",
      "javascript:alert(1)", "/.//evil.example", "/..//evil.example", "/%09/evil.example", "/%2F/evil.example", "/trade/VCS-FOR-2021?side=BUY",
      "\\\\evil.example", "/ /evil.example", "http:/evil.example", "/x#//evil.example",
    ];
    for (const raw of payloads) {
      const target = safeReturnTo(raw);
      expect(target.startsWith("/") && !target.startsWith("//"), raw).toBe(true);
      expect(resolved(target).origin, raw).toBe("https://cbda.trade");
    }
  });
});
