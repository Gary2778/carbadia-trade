import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import coreEn from "@/i18n/messages/core/en";
import { CreditOverview } from "./CreditOverview";

// /market/[symbol] 的项目概览在 /trade 之外:它的「模拟 · 未核证」取自核心包的 ui.simulatedUnverified(P2-01 从
// terminal.meta 挪来,文案不变)。这里故意不包 TerminalMessagesProvider —— 这个组件要是又去读 useT("terminal"),渲染会直接抛错。
// node 环境、不引 jsdom(计划 §9.1 第 7 条);没有 LangProvider 时语言落到默认英文。

const ASSET = {
  symbol: "VCS-FOR-2021",
  name: "云南森林经营碳汇项目",
  standard: "VCS",
  projectType: "林业碳汇",
  vintage: 2021,
  country: "中国",
  registry: "Verra",
  lastPrice: 7000,
  isScenario: false,
  methodology: null,
};
const render = (verificationStatus: string | null) =>
  renderToStaticMarkup(createElement(CreditOverview, { asset: { ...ASSET, verificationStatus }, availableSupply: 1000, holding: null }));

describe("CreditOverview (outside /trade, core copy only)", () => {
  it("shows ui.simulatedUnverified for a SIMULATED_UNVERIFIED instrument without any terminal copy loaded", () => {
    expect(coreEn.ui.simulatedUnverified).toBe("Simulated · unverified");
    expect(render("SIMULATED_UNVERIFIED")).toContain(`>${coreEn.ui.simulatedUnverified}<`);
  });

  it("never shows it when the status is unknown: the field reads as not provided", () => {
    expect(render(null)).not.toContain(coreEn.ui.simulatedUnverified);
  });
});
