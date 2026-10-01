import { readFileSync } from "node:fs";
import { createElement, useContext, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TradeLayout from "@/app/trade/layout";
import { MESSAGES } from "@/i18n";
import { TerminalMessagesContext, useT } from "@/i18n/LangProvider";
import terminalEn from "@/i18n/messages/terminal/en";
import terminalZhCN from "@/i18n/messages/terminal/zh-CN";
import { TerminalMessagesProvider } from "@/i18n/TerminalMessages";
import { renderToStaticMarkup as renderInTerminal } from "@/i18n/test-support";

// 终端文案的运行时接线(docs/trade-upgrade-plan.md §6.2.2 C9;P2-01):terminal 命名空间不在根 LangProvider 里,
// 由 /trade 的共用布局经 TerminalMessagesProvider 登记;useT("terminal") 的写法不变,在 /trade 之外调用直接抛错。
// node 环境、不引 jsdom(§9.1 第 7 条):没有 LangProvider 时语言落到默认英文;中文那一份按上下文里的对象核对。

/** 把 useT("terminal") 取到的一条文案渲染出来 */
function TerminalProbe(): ReactNode {
  const t = useT("terminal");
  return createElement("i", null, t.book.title);
}
/** 核心命名空间的探针:不需要 Provider */
function CoreProbe(): ReactNode {
  const nav = useT("nav");
  const ui = useT("ui");
  return createElement("i", null, `${nav.demoBadge}|${ui.dialogClose}`);
}
/** 上下文里两种语言各取一条 */
function ContextProbe(): ReactNode {
  const all = useContext(TerminalMessagesContext);
  return createElement("i", null, all === null ? "none" : `${all.en === terminalEn}|${all["zh-CN"] === terminalZhCN}|${all["zh-CN"].book.title}`);
}

describe("useT(\"terminal\") outside /trade", () => {
  it("throws a clear error instead of returning undefined", () => {
    expect(() => renderToStaticMarkup(createElement(TerminalProbe))).toThrow(/useT\("terminal"\) was called outside <TerminalMessagesProvider>/);
    expect(() => renderToStaticMarkup(createElement(TerminalProbe))).toThrow(/src\/app\/trade\/layout\.tsx/);
  });

  it("leaves the core namespaces working without any provider", () => {
    expect(renderToStaticMarkup(createElement(CoreProbe))).toBe(`<i>${MESSAGES.en.nav.demoBadge}|${MESSAGES.en.ui.dialogClose}</i>`);
    expect(renderToStaticMarkup(createElement(ContextProbe))).toBe("<i>none</i>");
  });
});

describe("TerminalMessagesProvider", () => {
  it("serves the terminal namespace to useT(\"terminal\") in the server render, adding no markup of its own", () => {
    const html = renderToStaticMarkup(createElement(TerminalMessagesProvider, null, createElement(TerminalProbe)));
    expect(html).toBe(`<i>${terminalEn.book.title}</i>`);
    expect(terminalEn.book.title).toBe("Order book");
  });

  it("carries both languages, loaded together (no per-language lazy load)", () => {
    const html = renderToStaticMarkup(createElement(TerminalMessagesProvider, null, createElement(ContextProbe)));
    expect(html).toBe(`<i>true|true|${terminalZhCN.book.title}</i>`);
    expect(terminalZhCN.book.title).toBe("盘口");
  });

  it("is what the test helper wraps around terminal components", () => {
    expect(renderInTerminal(createElement(TerminalProbe))).toBe(`<i>${terminalEn.book.title}</i>`);
  });
});

describe("src/app/trade/layout.tsx (shared layout of every /trade page)", () => {
  it("registers the terminal copy for its children and renders no structure of its own", () => {
    const html = renderToStaticMarkup(createElement(TradeLayout, null, createElement(TerminalProbe)));
    expect(html).toBe(`<i>${terminalEn.book.title}</i>`);
    expect(renderToStaticMarkup(createElement(TradeLayout, null, createElement("p", null, "page")))).toBe("<p>page</p>");
  });

  it("imports terminal.css once for all of /trade; the symbol layout keeps only the metadata", () => {
    const shared = readFileSync(new URL("../app/trade/layout.tsx", import.meta.url), "utf8");
    const symbol = readFileSync(new URL("../app/trade/[symbol]/layout.tsx", import.meta.url), "utf8");
    expect(shared).toMatch(/^import "@\/app\/terminal\.css";$/m);
    expect(shared).not.toMatch(/^"use client"/m);
    expect(symbol).not.toMatch(/^import .*terminal\.css/m);
    expect(symbol).toContain("export async function generateMetadata");
  });
});
