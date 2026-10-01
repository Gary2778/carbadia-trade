import { readFileSync } from "node:fs";
import { createElement, useContext, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AccountLayout from "@/app/trade/account/layout";
import { AccountMessagesProvider } from "@/i18n/AccountMessages";
import { AccountMessagesContext, useT } from "@/i18n/LangProvider";
import accountEn from "@/i18n/messages/account/en";
import accountZhCN from "@/i18n/messages/account/zh-CN";
import { renderAccountMarkup, renderToStaticMarkup as renderInTerminal } from "@/i18n/test-support";

// 资产页文案的运行时接线(P2-10,照终端文案 terminal-messages.ssr.test.ts 的办法):account 命名空间既不在根 LangProvider 里,
// 也不在 /trade 的共用布局里,由 /trade/account 的布局经 AccountMessagesProvider 登记;在资产页之外调用 useT("account") 直接抛错。

function AccountProbe(): ReactNode {
  const a = useT("account");
  return createElement("i", null, a.title);
}
function ContextProbe(): ReactNode {
  const all = useContext(AccountMessagesContext);
  return createElement("i", null, all === null ? "none" : `${all.en === accountEn}|${all["zh-CN"] === accountZhCN}|${all["zh-CN"].title}`);
}

describe('useT("account") outside the portfolio page', () => {
  it("throws a clear error, with no provider and under the terminal's provider alike (the terminal page does not carry this copy)", () => {
    expect(() => renderToStaticMarkup(createElement(AccountProbe))).toThrow(/useT\("account"\) was called outside <AccountMessagesProvider>/);
    expect(() => renderInTerminal(createElement(AccountProbe))).toThrow(/src\/app\/trade\/account\/layout\.tsx/);
    expect(renderToStaticMarkup(createElement(ContextProbe))).toBe("<i>none</i>");
  });
});

describe("AccountMessagesProvider", () => {
  it("serves both languages to useT(\"account\") in the server render, adding no markup of its own", () => {
    expect(renderToStaticMarkup(createElement(AccountMessagesProvider, null, createElement(AccountProbe)))).toBe(`<i>${accountEn.title}</i>`);
    expect(renderToStaticMarkup(createElement(AccountMessagesProvider, null, createElement(ContextProbe)))).toBe(`<i>true|true|${accountZhCN.title}</i>`);
    expect(renderAccountMarkup(createElement(AccountProbe))).toBe(`<i>${accountEn.title}</i>`);
  });

  it("is registered by src/app/trade/account/layout.tsx, which renders nothing of its own", () => {
    expect(renderToStaticMarkup(createElement(AccountLayout, null, createElement(AccountProbe)))).toBe(`<i>${accountEn.title}</i>`);
    expect(renderToStaticMarkup(createElement(AccountLayout, null, createElement("p", null, "page")))).toBe("<p>page</p>");
    const layout = readFileSync(new URL("../app/trade/account/layout.tsx", import.meta.url), "utf8");
    expect(layout).not.toMatch(/^"use client"/m);
    expect(layout).not.toMatch(/^import .*terminal\.css/m); // terminal.css 由上一级 /trade 的布局给
  });
});
