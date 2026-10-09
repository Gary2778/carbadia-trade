import { describe, expect, it } from "vitest";
import accountEn from "./messages/account/en";
import accountZhCN from "./messages/account/zh-CN";
import coreEn from "./messages/core/en";
import coreZhCN from "./messages/core/zh-CN";
import en, { type Messages } from "./messages/en";
import terminalEn from "./messages/terminal/en";
import terminalZhCN from "./messages/terminal/zh-CN";
import noticesEn from "./messages/notices/en";
import noticesZhCN from "./messages/notices/zh-CN";
import zhCN from "./messages/zh-CN";
import { MESSAGES } from "./index";

// 文案注册表的结构契约(docs/trade-upgrade-plan.md §4.8 / §4.10):
// en 与 zh-CN 键集逐叶相等、叶子非空、函数型词条两边参数一致、terminal.order.errors = DraftError 枚举。
// `Messages = typeof en` 已在编译期挡住 zh-CN 缺键 / 多键;这里补运行时无法由类型覆盖的部分
// (`as Record<string, string>` 的 data.assetNames、空字符串、函数 arity)。
// P2-01 起文案分两处存放(计划 §6.2.2 C9):核心命名空间在 messages/core/*(根 LangProvider 引入,每页都带),
// terminal 在 messages/terminal/*(只随 /trade 加载);P2-10 起资产页的 account 在 messages/account/*(只随 /trade/account 加载);
// messages/en.ts、zh-CN.ts 是三者合并后的完整对象,本文件的断言都对它做。

type Leaf = string | ((...args: never[]) => string);

// 递归收集 "a.b.c" → 叶子;对象继续下钻,其余一律当叶子(空串 / 数字 / null 都会在后面的断言里暴露)
function collectLeaves(node: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectLeaves(v, prefix ? `${prefix}.${k}` : k, out);
    }
    return out;
  }
  out.set(prefix, node);
  return out;
}

const isLeaf = (v: unknown): v is Leaf =>
  (typeof v === "string" && v.trim().length > 0) || typeof v === "function";

const EN = collectLeaves(en, "", new Map());
const ZH = collectLeaves(zhCN, "", new Map());

// §4.8 固定的 DraftError 联合(src/shared/order-math.ts 的 validateDraft 返回值);
// 故意不 import 类型:P1-01 / P1-05 的文件在波次 ① 可能还不存在,本测试只做运行时断言。
const DRAFT_ERRORS = [
  "invalidPrice",
  "invalidQty",
  "belowMinQty",
  "offTick",
  "offStep",
  "insufficientCash",
  "insufficientQty",
  "noLiquidity",
  "overMaxNotional",
  "overMaxPrice",
] as const;

// 条件单(P3-07):terminal.triggers.errors 的键 = TriggerDraftError(src/shared/types.ts),terminal.triggers.submitErrors 的键 =
// TriggerSubmitError(src/lib/market/trigger-submit.ts)。同上,只做运行时断言;新加一个错误码而漏了文案,这里与组件的类型检查都会失败
const TRIGGER_DRAFT_ERRORS = [
  "invalidTrigger",
  "wouldTriggerNow",
  "directionNeeded",
  "invalidPrice",
  "overMaxPrice",
  "offTick",
  "invalidQty",
  "belowMinQty",
  "offStep",
  "overMaxNotional",
  "ocoNeedsOne",
  "takeProfitTooLow",
  "stopLossTooHigh",
  "overPosition",
] as const;
const TRIGGER_SUBMIT_ERRORS = ["wouldTriggerNow", "tooManyTriggers", "insufficientQty", "triggersDisabled", "invalid", "notCancellable", "rateLimited", "unauthorized", "network", "uncertain"] as const;
// 条件单的状态与原因(src/shared/types.ts 的 TriggerStatus / TriggerReason)
const TRIGGER_STATUSES = ["PENDING", "TRIGGERING", "TRIGGERED", "REJECTED", "CANCELLED"] as const;
const TRIGGER_REASONS = ["USER", "OCO", "INSUFFICIENT_CASH", "INSUFFICIENT_QTY", "NO_FILL", "INVALID"] as const;

describe("messages: en and zh-CN", () => {
  it("have exactly the same set of leaf keys", () => {
    const onlyInEn = [...EN.keys()].filter((k) => !ZH.has(k));
    const onlyInZh = [...ZH.keys()].filter((k) => !EN.has(k));
    expect(onlyInEn, "keys present in en but missing from zh-CN").toEqual([]);
    expect(onlyInZh, "keys present in zh-CN but missing from en").toEqual([]);
  });

  it("only hold non-empty strings or functions at the leaves", () => {
    const bad: string[] = [];
    for (const [lang, leaves] of [
      ["en", EN],
      ["zh-CN", ZH],
    ] as const) {
      for (const [path, value] of leaves) if (!isLeaf(value)) bad.push(`${lang}: ${path} = ${JSON.stringify(value)}`);
    }
    expect(bad).toEqual([]);
  });

  it("keep function-typed entries as functions with the same arity in both languages", () => {
    const mismatched: string[] = [];
    for (const [path, value] of EN) {
      if (typeof value !== "function") continue;
      const zh = ZH.get(path);
      if (typeof zh !== "function") mismatched.push(`${path}: zh-CN is ${typeof zh}, en is a function`);
      else if (zh.length !== value.length) mismatched.push(`${path}: arity en=${value.length} zh-CN=${zh.length}`);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("messages: core / terminal / account split (§6.2.2 C9, P2-10)", () => {
  it("merges the core namespaces, the terminal namespace and the account namespace into the full object, by reference", () => {
    for (const [merged, core, terminal, account] of [[en, coreEn, terminalEn, accountEn], [zhCN, coreZhCN, terminalZhCN, accountZhCN]] as const) {
      expect(Object.keys(merged).sort()).toEqual([...Object.keys(core), "terminal", "account"].sort());
      expect(merged.terminal).toBe(terminal);
      expect(merged.account).toBe(account);
      for (const ns of Object.keys(core) as (keyof typeof core)[]) expect(merged[ns], ns).toBe(core[ns]);
    }
  });

  it("keeps the terminal namespace out of the core registry that the root LangProvider imports", () => {
    expect(Object.keys(coreEn)).not.toContain("terminal");
    expect(Object.keys(coreZhCN)).not.toContain("terminal");
    expect(MESSAGES.en).toBe(coreEn);
    expect(MESSAGES["zh-CN"]).toBe(coreZhCN);
    expect("terminal" in MESSAGES.en || "terminal" in MESSAGES["zh-CN"]).toBe(false);
    // 合并对象确实带着终端文案(上一条不是因为 terminal 整个没了才通过)
    expect(Object.keys(en.terminal).length).toBeGreaterThanOrEqual(17);
    expect(collectLeaves(en.terminal, "", new Map()).size).toBeGreaterThan(200);
  });

  it("keeps the account namespace (portfolio page, P2-10) out of the core registry and out of the terminal namespace", () => {
    for (const registry of [coreEn, coreZhCN, MESSAGES.en, MESSAGES["zh-CN"]]) expect(Object.keys(registry)).not.toContain("account");
    // 原来在 terminal 里预留的空组 account 已删掉:资产页文案自成一个命名空间,不随终端首屏加载
    expect(Object.keys(en.terminal)).not.toContain("account");
    expect(Object.keys(zhCN.terminal)).not.toContain("account");
    // 旧 /portfolio 页(PortfolioViews)的核心命名空间 portfolio 随页面删掉了(P2-12):它每页都进 floor,却已无人读
    for (const registry of [coreEn, coreZhCN]) expect(Object.keys(registry)).not.toContain("portfolio");
    // 合并对象确实带着资产页文案(上面几条不是因为 account 整个没了才通过)
    expect(collectLeaves(en.account, "", new Map()).size).toBeGreaterThan(40);
    // 只写「不支持充提」的说明,没有任何充值 / 提现 / 划转的入口文案
    expect(en.account.demoNote).toMatch(/cannot be deposited, withdrawn or transferred out/);
    expect(zhCN.account.demoNote).toBe("演示资金没有价值，不能充值、提现或转出。");
  });

  it("serves the four strings used outside the terminal from core namespaces, word for word, and no longer from terminal", () => {
    // Nav 的 Demo 徽标、ui/Dialog、ui/VirtualList、/market 的 CreditOverview(P2-01 从 terminal.* 挪来,文案一个字不改)
    const moved: Array<[key: string, enText: string, zhText: string, oldPath: string]> = [
      ["nav.demoTooltip", "Prices are formed by a market-making bot. No real credits, no real money, no registry records.", "行情由做市机器人形成。没有真实碳信用、真实资金或登记机构记录。", "terminal.demo.tooltip"],
      ["ui.dialogClose", "Close dialog", "关闭对话框", "terminal.a11y.dialogClose"],
      ["ui.listHint", "Scroll to see more rows", "滚动查看更多行", "terminal.a11y.listHint"],
      ["ui.simulatedUnverified", "Simulated · unverified", "模拟 · 未核证", "terminal.meta.simulatedUnverified"],
    ];
    const coreLeavesEn = collectLeaves(coreEn, "", new Map());
    const coreLeavesZh = collectLeaves(coreZhCN, "", new Map());
    for (const [key, enText, zhText, oldPath] of moved) {
      expect(coreLeavesEn.get(key), `en ${key}`).toBe(enText);
      expect(coreLeavesZh.get(key), `zh-CN ${key}`).toBe(zhText);
      expect(EN.has(oldPath), `en ${oldPath}`).toBe(false);
      expect(ZH.has(oldPath), `zh-CN ${oldPath}`).toBe(false);
    }
  });
});

describe("messages: terminal namespace contract (§4.8 / §4.10)", () => {
  it("has the fourteen Phase 1 terminal groups followed by the three Phase 2 groups and the Phase 3 groups, the ui namespace, the nav keys and the six extra asset names", () => {
    // 顺序固定:Phase 1 的 14 组在前,Phase 2 的组 ledger(P2-07)/ retire(P2-09)/ exportCsv(P2-06)在后,再后是 Phase 3 的组 markets(P3-05)/ triggers(P3-07)/ tz(P3-09);
    // 原来预留给 P2-10 的空组 account 已删掉(资产页文案自成 account 命名空间,见上一个 describe)
    const groups = [
      "demo", "connection", "header", "meta", "instruments", "book", "tape",
      "chart", "order", "tabs", "shortcuts", "a11y", "toast", "mobile",
      "ledger", "retire", "exportCsv",
      "markets", "triggers", "tz",
    ];
    expect(Object.keys(en.terminal)).toEqual(groups);
    expect(Object.keys(zhCN.terminal)).toEqual(groups);
    expect(Object.keys(en.ui)).toEqual([
      "loading", "empty", "error", "retry", "close", "confirm", "cancel", "notProvided", "loadMore",
      "dialogClose", "listHint", "simulatedUnverified",
    ]);
    expect(en.nav.demoBadge).toBe("Demo");
    expect(zhCN.nav.demoBadge).toBe("模拟盘");
    expect(en.nav.terminal).toBe("Terminal");
    expect(zhCN.nav.terminal).toBe("终端");
    // P3-05:「总览」在「行情」与「终端」之间(Nav 的 LINKS 顺序),指向 /trade/markets
    expect(en.nav.overview).toBe("Overview");
    expect(zhCN.nav.overview).toBe("总览");
    expect(Object.keys(en.nav).indexOf("overview")).toBe(Object.keys(en.nav).indexOf("markets") + 1);
    for (const symbol of ["VCS-FOR-2022", "VCS-FOR-2023", "GS-WIND-2023", "CCER-SOL-2022", "GS-MANG-2023", "VCS-COOK-2021"]) {
      expect(en.data.assetNames[symbol], `en assetNames.${symbol}`).toBeTruthy();
      expect(zhCN.data.assetNames[symbol], `zh-CN assetNames.${symbol}`).toBeTruthy();
    }
    // 同项目其它 vintage 与已有条目同名:年份由 VintageSelector 呈现,名字里不带年份
    expect(en.data.assetNames["VCS-FOR-2022"]).toBe(en.data.assetNames["VCS-FOR-2021"]);
    expect(zhCN.data.assetNames["GS-MANG-2023"]).toBe(zhCN.data.assetNames["GS-MANG-2022"]);
  });

  it("fills the reserved exportCsv group (P2-06) with the same three keys in both languages", () => {
    expect(Object.keys(en.terminal.exportCsv)).toEqual(["label", "hint", "hintFiltered"]);
    expect(Object.keys(zhCN.terminal.exportCsv)).toEqual(["label", "hint", "hintFiltered"]);
    expect(en.terminal.exportCsv.label).toBe("Export CSV");
    expect(zhCN.terminal.exportCsv.label).toBe("导出 CSV");
    // 提示里说清楚两件事:导出的是全部行(不只是已加载的),而且是模拟数据
    for (const m of [en, zhCN]) {
      for (const hint of [m.terminal.exportCsv.hint, m.terminal.exportCsv.hintFiltered]) {
        expect(hint).toMatch(/CSV/);
        expect(hint).toMatch(/Simulated data|模拟数据/);
      }
    }
  });

  // P3-05:总览页的说明写明「模拟」与「24 小时前 = 100」,每张指数卡的标记也写「模拟」(诚实规则:这是模拟盘,不是真实市场指数);
  // 不用「实时 / live」(launch-checklist 第 48 行:不暗示真实活跃度)
  it("labels every index on the market overview page as simulated, explains '24 hours ago = 100', and avoids the word Live", () => {
    expect(en.terminal.markets.intro).toMatch(/simulated indices: 24 hours ago = 100/);
    expect(zhCN.terminal.markets.intro).toBe("各组项目在过去 24 小时的涨跌。以下都是模拟指数：24 小时前 = 100。");
    expect(en.terminal.markets.simulatedIndex).toBe("Simulated index");
    expect(zhCN.terminal.markets.simulatedIndex).toBe("模拟指数");
    for (const m of [en, zhCN]) {
      const s = m.terminal.markets;
      const label = { symbol: "VCS-FOR-2021", name: "Forest", price: "10.00", change: "+1.00%", scenario: false };
      const strings = [
        ...Object.values(s).filter((v): v is string => typeof v === "string"),
        s.members(1), s.members(2), s.breadth(1, 1), s.partial(2, 3),
        s.rowLabel({ ...label, volume: null }), s.rowLabel({ ...label, volume: "5 t", scenario: true }),
      ];
      for (const text of strings) {
        expect(text).not.toMatch(/\blive\b/i);
        expect(text).not.toContain("实时");
        expect(text).not.toMatch(/deposit|withdraw|transfer|充值|提现|划转/i);
      }
    }
  });

  it("keys terminal.order.errors by exactly the DraftError literals", () => {
    expect([...Object.keys(en.terminal.order.errors)].sort()).toEqual([...DRAFT_ERRORS].sort());
    expect([...Object.keys(zhCN.terminal.order.errors)].sort()).toEqual([...DRAFT_ERRORS].sort());
  });

  it("keys the conditional-order errors by exactly the TriggerDraftError and TriggerSubmitError literals, and statuses / reasons by TriggerStatus / TriggerReason (P3-07)", () => {
    for (const m of [en, zhCN]) {
      expect([...Object.keys(m.terminal.triggers.errors)].sort()).toEqual([...TRIGGER_DRAFT_ERRORS].sort());
      expect([...Object.keys(m.terminal.triggers.submitErrors)].sort()).toEqual([...TRIGGER_SUBMIT_ERRORS].sort());
      expect([...Object.keys(m.terminal.triggers.status)].sort()).toEqual([...TRIGGER_STATUSES].sort());
      // NO_FILL 的状态与原因按方向另放在 triggers.noFill(被拒的行不说「下单失败」,与通知一致),不在 reason 里
      expect([...Object.keys(m.terminal.triggers.reason)].sort()).toEqual(TRIGGER_REASONS.filter((r) => r !== "NO_FILL").sort());
      expect(Object.keys(m.terminal.triggers.noFill)).toEqual(["status", "buy", "sell"]);
      expect(Object.keys(m.terminal.triggers.types)).toEqual(["conditional", "takeProfit", "stopLoss", "alert"]);
    }
  });

  // P3-07:条件单的文案只说引擎真做的事 —— 看的是「最新成交价」;已触发只说「委托已提交」,从不说「成交」;模拟盘不写充提与「实时」
  it("words conditional orders by the last trade price, never calls a triggered order filled, and avoids deposit / live wording", () => {
    // 终审定稿:说成「有成交价达到或高于 / 低于」(引擎看的是逐笔成交,等于也触发)
    expect(en.terminal.triggers.whenAbove("70.00")).toBe("When a trade happens at 70.00 or higher");
    expect(en.terminal.triggers.whenBelow("60.00")).toBe("When a trade happens at 60.00 or lower");
    expect(zhCN.terminal.triggers.whenAbove("70.00")).toBe("有成交价达到或高于 70.00 时触发");
    expect(zhCN.terminal.triggers.whenBelow("60.00")).toBe("有成交价达到或低于 60.00 时触发");
    expect(en.terminal.triggers.status.TRIGGERED).toBe("Triggered · order submitted");
    expect(zhCN.terminal.triggers.status.TRIGGERED).toBe("已触发 · 委托已提交");
    for (const m of [en, zhCN]) {
      const s = m.terminal.triggers;
      expect(Object.values(s.status).join(" ")).not.toMatch(/fill|成交/i);
      // 三段说明(条件单、止盈止损、价格提醒)都写明 OTC 成交不触发
      for (const body of [m.terminal.order.conditionalBody, s.tpslBody, s.alertBody]) expect(body).toMatch(/OTC deals do not trigger (it|them)\.|OTC 成交不会触发它(们)?。/);
      const strings = [m.terminal.order.conditionalBody, s.tpslBody, s.alertBody, ...Object.values(s.submitErrors), ...Object.values(s.reason), ...Object.values(s.noFill), ...Object.values(s.errors).filter((v): v is string => typeof v === "string")];
      for (const text of strings) {
        expect(text).not.toMatch(/\blive\b/i);
        expect(text).not.toContain("实时");
        expect(text).not.toMatch(/deposit|withdraw|transfer|充值|提现|划转/i);
      }
    }
    // 复审定稿的几句(lead 给的原文):市价买单能买多少买多少、止盈止损先触发的撤掉另一张、没能提交或一吨没成交这一组就结束
    expect(en.terminal.order.conditionalBody).toBe(
      "Waits until the last trade price reaches the trigger price, then places a normal order for you. Nothing is reserved while it waits. If cash or holdings fall short when it triggers, the order is rejected and you are notified; a market buy buys only what your cash covers. OTC deals do not trigger it.",
    );
    expect(zhCN.terminal.order.conditionalBody).toBe(
      "等最新成交价达到触发价，再替你下一笔普通委托。等待期间不冻结资金或持仓。触发时如果资金或持仓不够，委托会被拒绝并通知你；市价买单则是能买多少买多少。OTC 成交不会触发它。",
    );
    expect(en.terminal.triggers.tpslBody).toMatch(/the first one to trigger cancels the other; if that order cannot be placed or nothing fills, the pair is finished/);
    expect(zhCN.terminal.triggers.tpslBody).toMatch(/先触发的一张会让另一张自动撤销；这张委托如果没能提交或一吨都没成交，这一组就结束了/);
    // 同一个名字:「触发后」一项在票据、确认框与页签表头里都用 triggers.after
    expect([en.terminal.triggers.after, zhCN.terminal.triggers.after]).toEqual(["After trigger", "触发后"]);
    expect([en.terminal.triggers.status.REJECTED, zhCN.terminal.triggers.status.REJECTED]).toEqual(["Order failed", "下单失败"]);
    expect([en.terminal.triggers.reason.INVALID, zhCN.terminal.triggers.reason.INVALID]).toEqual(["The order could not be placed", "委托没能提交"]);
    expect([en.terminal.triggers.alertTriggering, zhCN.terminal.triggers.alertTriggering]).toEqual(["Triggering", "正在触发"]);
    expect([en.terminal.triggers.pickLabel, zhCN.terminal.triggers.pickLabel]).toEqual(["No trades yet. Trigger when the price:", "还没有成交价。请选择触发条件："]);
    // 持仓行的按钮英文不用缩写;这个功能里英文一律连字符拼写(Take-profit / stop-loss)
    expect(en.terminal.triggers.tpsl).toBe("Take-profit / stop-loss");
    expect([en.terminal.triggers.types.takeProfit, en.terminal.triggers.types.stopLoss, en.terminal.triggers.tpslBoth]).toEqual(["Take-profit", "Stop-loss", "Take-profit and stop-loss"]);
    expect(en.terminal.triggers.tpslBody).toMatch(/take-profit price, a stop-loss price/);
    expect(en.terminal.triggers.tpslBody).not.toMatch(/take profit|stop loss/i);
    // P3 终审定稿:撤销按钮按行的名字、两个可访问名、空历史、上限与拒绝的说法、提醒说明、输入框标签
    const tp = { type: en.terminal.triggers.types.takeProfit, symbol: "VCS-FOR-2021" };
    expect(en.terminal.triggers.cancelLabel({ ...tp, armed: false })).toBe("Cancel take-profit VCS-FOR-2021");
    expect(en.terminal.triggers.cancelLabel({ ...tp, armed: true })).toBe("Confirm cancel take-profit VCS-FOR-2021");
    expect(zhCN.terminal.triggers.cancelLabel({ type: zhCN.terminal.triggers.types.takeProfit, symbol: "VCS-FOR-2021", armed: false })).toBe("撤单：VCS-FOR-2021 的止盈");
    expect(zhCN.terminal.triggers.cancelLabel({ type: zhCN.terminal.triggers.types.takeProfit, symbol: "VCS-FOR-2021", armed: true })).toBe("确认撤单：VCS-FOR-2021 的止盈");
    expect(en.terminal.tabs.cancelOrderLabel({ buy: true, symbol: "VCS-FOR-2021", armed: false })).toBe("Cancel buy order VCS-FOR-2021");
    expect(zhCN.terminal.tabs.cancelOrderLabel({ buy: true, symbol: "VCS-FOR-2021", armed: false })).toBe("撤单：VCS-FOR-2021 的买单");
    expect(zhCN.terminal.tabs.cancelOrderLabel({ buy: false, symbol: "VCS-FOR-2021", armed: true })).toBe("确认撤单：VCS-FOR-2021 的卖单");
    // WCAG 2.5.3(名称含可见文字):两个页签的撤单按钮看得见的是 tabs.cancel / tabs.cancelConfirm,可访问名以它开头(两种语言、两种状态)
    for (const m of [en, zhCN]) {
      for (const armed of [false, true]) {
        const visible = armed ? m.terminal.tabs.cancelConfirm : m.terminal.tabs.cancel;
        expect(m.terminal.tabs.cancelOrderLabel({ buy: true, symbol: "VCS-FOR-2021", armed }).startsWith(visible), `${visible} / orders`).toBe(true);
        for (const type of Object.values(m.terminal.triggers.types)) {
          expect(m.terminal.triggers.cancelLabel({ type, symbol: "VCS-FOR-2021", armed }).startsWith(visible), `${visible} / ${type}`).toBe(true);
        }
      }
    }
    expect([en.terminal.tabs.triggerScopeLabel, zhCN.terminal.tabs.triggerScopeLabel]).toEqual(["Show waiting or finished conditional orders and alerts", "显示进行中或已结束的条件单与提醒"]);
    expect([en.terminal.a11y.triggersRegion, zhCN.terminal.a11y.triggersRegion]).toEqual(["Conditional orders and alerts table, scrollable", "条件单与提醒表格，可滚动"]);
    expect(zhCN.terminal.tabs.emptyTriggerHistory).toBe("还没有已结束的条件单或提醒");
    expect([en.terminal.triggers.submitErrors.tooManyTriggers, zhCN.terminal.triggers.submitErrors.tooManyTriggers]).toEqual([
      "The limit is 50 waiting conditional orders and alerts. Cancel some first.",
      "最多同时有 50 个等待中的条件单和提醒，请先撤销一些。",
    ]);
    expect([en.terminal.triggers.submitErrors.triggersDisabled, zhCN.terminal.triggers.submitErrors.triggersDisabled]).toEqual([
      "Conditional orders and alerts are switched off for now. Try again later.",
      "条件单和提醒暂时停用，请稍后再试。",
    ]);
    expect(en.terminal.triggers.submitErrors.invalid).toBe("The request was refused. Check it and try again.");
    expect(en.terminal.triggers.alertBody).toMatch(/^You get a notice here when the last trade price reaches this price\./);
    expect(zhCN.terminal.triggers.alertBody).toMatch(/^最新成交价达到这个价格时，在这里给你发一条通知。/);
    expect([zhCN.terminal.triggers.takeProfitPrice, zhCN.terminal.triggers.stopLossPrice, zhCN.terminal.triggers.alertPrice]).toEqual(["止盈价", "止损价", "提醒价"]);
  });

  it("keeps the connection badge free of the word Live in both languages (launch-checklist)", () => {
    for (const m of [en, zhCN]) {
      for (const v of Object.values(m.terminal.connection)) {
        if (typeof v === "string") {
          expect(v).not.toMatch(/\blive\b/i);
          expect(v).not.toContain("实时");
        }
      }
    }
  });

  it("interpolates the arguments of every function-typed terminal entry in both languages", () => {
    const cases: Array<[label: string, call: (m: Messages) => string, expected: string[]]> = [
      ["connection.rtt", (m) => m.terminal.connection.rtt(42), ["42"]],
      ["instruments.count", (m) => m.terminal.instruments.count(14), ["14"]],
      ["chart.readout", (m) => m.terminal.chart.readout({ o: "1.00", h: "2.00", l: "0.50", c: "1.50", v: "7" }), ["1.00", "2.00", "0.50", "1.50", "7"]],
      ["order.confirmTitle", (m) => m.terminal.order.confirmTitle({ side: m.terminal.order.buy, symbol: "VCS-FOR-2021" }), ["VCS-FOR-2021"]],
      ["order.errors.belowMinQty", (m) => m.terminal.order.errors.belowMinQty(5), ["5"]],
      ["order.errors.offTick", (m) => m.terminal.order.errors.offTick("0.01"), ["0.01"]],
      ["order.errors.offStep", (m) => m.terminal.order.errors.offStep(10), ["10"]],
      ["a11y.connection", (m) => m.terminal.a11y.connection(m.terminal.connection.offline), ["Offline", "离线"]],
      ["toast.orderPlaced", (m) => m.terminal.toast.orderPlaced({ side: m.terminal.order.sell, qty: 3, symbol: "CCER-SOL-2023" }), ["3", "CCER-SOL-2023"]],
      ["toast.fill", (m) => m.terminal.toast.fill({ qty: 3, price: "12.34" }), ["3", "12.34"]],
      ["toast.rateLimited", (m) => m.terminal.toast.rateLimited(30), ["30"]],
      ["account.summary.change24hSince", (m) => m.account.summary.change24hSince("09/30 14:10"), ["09/30 14:10"]],
      ["account.allocation.unpriced", (m) => m.account.allocation.unpriced(3), ["3"]],
      ["markets.members", (m) => m.terminal.markets.members(5), ["5"]],
      ["markets.breadth", (m) => m.terminal.markets.breadth(3, 2), ["3", "2"]],
      ["markets.partial", (m) => m.terminal.markets.partial(3, 4), ["3", "4"]],
      // 榜单行的可访问名:代码、项目名、最新价、24h 涨跌,成交量榜另有成交量,情景标的带标记
      ["markets.rowLabel", (m) => m.terminal.markets.rowLabel({ symbol: "VCS-FOR-2021", name: "Forest A", price: "10.00", change: "+3.50%", volume: "1,200 t", scenario: false }), ["VCS-FOR-2021", "Forest A", "10.00", "+3.50%", "1,200 t"]],
      // P3-07:条件单 / 止盈止损 / 价格提醒
      ["triggers.whenAbove", (m) => m.terminal.triggers.whenAbove("70.00"), ["70.00"]],
      ["triggers.whenBelow", (m) => m.terminal.triggers.whenBelow("60.00"), ["60.00"]],
      ["triggers.actionMarket", (m) => m.terminal.triggers.actionMarket({ buy: false, qty: "10" }), ["10"]],
      ["triggers.actionLimit", (m) => m.terminal.triggers.actionLimit({ buy: true, qty: "10", price: "69.50" }), ["10", "69.50"]],
      ["triggers.placed", (m) => m.terminal.triggers.placed({ type: m.terminal.triggers.types.alert, symbol: "VCS-FOR-2021" }), ["VCS-FOR-2021"]],
      ["triggers.cancelled", (m) => m.terminal.triggers.cancelled(m.terminal.triggers.types.takeProfit), []],
      ["triggers.placed (both)", (m) => m.terminal.triggers.placed({ type: m.terminal.triggers.tpslBoth, symbol: "GS-WIND-2023" }), ["GS-WIND-2023"]],
      ["triggers.errors.offTick", (m) => m.terminal.triggers.errors.offTick("0.01"), ["0.01"]],
      ["triggers.errors.belowMinQty", (m) => m.terminal.triggers.errors.belowMinQty(5), ["5"]],
      ["triggers.errors.offStep", (m) => m.terminal.triggers.errors.offStep(10), ["10"]],
      // P3 终审:按行的撤销按钮名、条件单确认框的标题
      ["triggers.cancelLabel", (m) => m.terminal.triggers.cancelLabel({ type: m.terminal.triggers.types.takeProfit, symbol: "VCS-FOR-2021", armed: false }), ["VCS-FOR-2021"]],
      ["tabs.cancelOrderLabel", (m) => m.terminal.tabs.cancelOrderLabel({ buy: true, symbol: "VCS-FOR-2021", armed: true }), ["VCS-FOR-2021"]],
      ["order.confirmConditionalTitle", (m) => m.terminal.order.confirmConditionalTitle({ buy: true, symbol: "VCS-FOR-2021" }), ["VCS-FOR-2021"]],
    ];
    for (const [label, call, expected] of cases) {
      for (const [lang, m] of [["en", en], ["zh-CN", zhCN]] as const) {
        const out = call(m);
        expect(out.trim().length, `${lang} ${label}`).toBeGreaterThan(0);
        // a11y.connection 的期望是两种语言各一个,其它是两边都要出现的参数
        const wanted = label === "a11y.connection" ? [lang === "en" ? expected[0] : expected[1]] : expected;
        for (const piece of wanted) expect(out, `${lang} ${label}`).toContain(piece);
      }
    }
  });
});

// ---- 站内通知(P3-08):铃铛的几句在 core.notices,句子与面板文案在 messages/notices/(随懒加载的面板走) ----
// 计划 C9 的 P3-08 修订:通知的句子不进每页的 floor 包 —— 铃铛(每页都有)只要可访问名、弹出层标题与加载失败的提示;
// 终端里已有的说法(terminal.triggers)一个字不改地沿用。floor 里没有这些句子由 scripts/perf/chunk-report.mjs 把关(noticeCopy 标记)。
describe("messages: notices (P3-08)", () => {
  const NOTICE_EN = collectLeaves(noticesEn, "", new Map());
  const NOTICE_ZH = collectLeaves(noticesZhCN, "", new Map());

  it("core.notices holds only what the bell needs in every page: its name with the count, the popover title, the load-failure text and its reload action", () => {
    for (const registry of [coreEn, coreZhCN]) {
      expect(Object.keys(registry)).toContain("notices");
      expect(Object.keys(registry.notices)).toEqual(["title", "bell", "error", "reload"]);
    }
    expect(en.notices).toBe(coreEn.notices);
    expect(zhCN.notices).toBe(coreZhCN.notices);
    for (const m of [en, zhCN]) {
      expect(Object.keys(m.terminal)).not.toContain("notices");
      expect(Object.keys(m.account)).not.toContain("notices");
    }
    expect([en.notices.title, zhCN.notices.title]).toEqual(["Notifications", "通知"]);
    expect([en.notices.error, zhCN.notices.error]).toEqual(["Could not load notifications", "通知加载失败"]);
    expect([en.notices.reload, zhCN.notices.reload]).toEqual(["Reload page", "刷新页面"]);
  });

  it("keeps the sentences out of core and out of the merged object: only the lazy panel and the toast load them", () => {
    for (const registry of [coreEn, coreZhCN, MESSAGES.en, MESSAGES["zh-CN"]]) {
      const text = JSON.stringify(Object.keys(registry.notices));
      for (const key of ["fill", "act", "trigger", "alert", "reason", "empty", "emptyHint", "unread", "noFillReason", "fallback"]) expect(text, key).not.toContain(`"${key}"`);
    }
  });

  it("has the same leaf keys in en and zh-CN, only non-empty strings or functions, and functions with the same arity", () => {
    expect([...NOTICE_EN.keys()].filter((k) => !NOTICE_ZH.has(k))).toEqual([]);
    expect([...NOTICE_ZH.keys()].filter((k) => !NOTICE_EN.has(k))).toEqual([]);
    const bad: string[] = [];
    for (const [lang, leaves] of [["en", NOTICE_EN], ["zh-CN", NOTICE_ZH]] as const) {
      for (const [path, value] of leaves) if (!isLeaf(value)) bad.push(`${lang}: ${path} = ${JSON.stringify(value)}`);
    }
    expect(bad).toEqual([]);
    for (const [path, value] of NOTICE_EN) {
      if (typeof value !== "function") continue;
      const zh = NOTICE_ZH.get(path);
      expect(typeof zh, path).toBe("function");
      expect((zh as (...a: never[]) => string).length, `arity of ${path}`).toBe(value.length);
    }
    expect(NOTICE_EN.size).toBe(NOTICE_ZH.size);
  });

  it("keys the sentences by the notice outcomes and reasons: trigger by outcome (+ NO_FILL), reason by TriggerReason minus USER and NO_FILL, the NO_FILL reasons by side", () => {
    for (const m of [noticesEn, noticesZhCN]) {
      expect(Object.keys(m)).toEqual(["empty", "emptyHint", "unread", "fill", "act", "trigger", "alert", "reason", "noFillReason", "fallback"]);
      expect(Object.keys(m.trigger)).toEqual(["TRIGGERED", "REJECTED", "CANCELLED", "NO_FILL"]);
      // 本人撤单(USER)不产生通知,没有文案;NO_FILL 的原因按方向另说(noFillReason)
      expect([...Object.keys(m.reason)].sort()).toEqual(TRIGGER_REASONS.filter((r) => r !== "USER" && r !== "NO_FILL").sort());
      expect(Object.keys(m.noFillReason)).toEqual(["buy", "sell"]);
    }
  });

  it("reuses the terminal's wording word for word: the failure reasons, 'Triggered · order submitted', 'Order failed', 'Cancelled'", () => {
    for (const [m, terminal] of [[noticesEn, en.terminal], [noticesZhCN, zhCN.terminal]] as const) {
      for (const reason of Object.keys(m.reason) as (keyof typeof m.reason)[]) expect(m.reason[reason], reason).toBe(terminal.triggers.reason[reason]);
      const args = { act: "ACT", price: "PRICE" };
      expect(m.trigger.TRIGGERED(args).startsWith(terminal.triggers.status.TRIGGERED)).toBe(true);
      expect(m.trigger.REJECTED(args).startsWith(terminal.triggers.status.REJECTED)).toBe(true);
      expect(m.trigger.CANCELLED(args).startsWith(terminal.triggers.status.CANCELLED)).toBe(true);
    }
  });

  // 通知说「Triggered, but nothing filled」并链到条件单页签的那一行:那一行不能写「Order failed」。两边的原因两句同字,状态 / 标题含义一致
  it("says the same thing for NO_FILL in the notice and in the Conditional tab: triggered, nothing filled (not 'Order failed'), with the same side-aware reasons word for word", () => {
    const args = { act: "ACT", price: "PRICE" };
    for (const [m, terminal] of [[noticesEn, en.terminal], [noticesZhCN, zhCN.terminal]] as const) {
      expect(m.noFillReason.buy).toBe(terminal.triggers.noFill.buy);
      expect(m.noFillReason.sell).toBe(terminal.triggers.noFill.sell);
      // 其余被拒的原因仍是「下单失败」,NO_FILL 不在 reason 里
      expect(Object.keys(terminal.triggers.reason)).not.toContain("NO_FILL");
      expect(terminal.triggers.status.REJECTED).toBe(m === noticesEn ? "Order failed" : "下单失败");
      for (const text of [m.trigger.NO_FILL(args), terminal.triggers.noFill.status]) expect(text).not.toMatch(/fail|失败/i);
    }
    // 含义一致:都说「已触发」+「没有成交」
    for (const text of [noticesEn.trigger.NO_FILL({ act: "ACT", price: "PRICE" }), en.terminal.triggers.noFill.status]) {
      expect(text).toMatch(/^Triggered/);
      expect(text).toContain("nothing filled");
    }
    for (const text of [noticesZhCN.trigger.NO_FILL({ act: "ACT", price: "PRICE" }), zhCN.terminal.triggers.noFill.status]) {
      expect(text).toMatch(/^已触发/);
      expect(text).toContain("没有成交");
    }
    // 同一句、同样的标点:页签的状态就是通知句子冒号前的那一段
    expect([en.terminal.triggers.noFill.status, zhCN.terminal.triggers.noFill.status]).toEqual(["Triggered, but nothing filled", "已触发，但没有成交"]);
    expect(noticesEn.trigger.NO_FILL(args).startsWith(`${en.terminal.triggers.noFill.status}: `)).toBe(true);
    expect(noticesZhCN.trigger.NO_FILL(args).startsWith(`${zhCN.terminal.triggers.noFill.status}：`)).toBe(true);
  });

  it("words the NO_FILL case for what happened (the order went in, nothing filled), side by side, not as 'Order failed' and not blaming cash for a sell", () => {
    const args = { act: "buy 20 tonnes of X", price: "$30.00" };
    expect(noticesEn.trigger.NO_FILL(args)).toBe("Triggered, but nothing filled: buy 20 tonnes of X (trigger price $30.00)");
    expect(noticesZhCN.trigger.NO_FILL({ act: "买入 20 吨 X", price: "$30.00" })).toBe("已触发，但没有成交：买入 20 吨 X（触发价 $30.00）");
    expect([noticesEn.noFillReason.buy, noticesEn.noFillReason.sell]).toEqual(["Not enough cash, or no one was selling", "No one was buying"]);
    expect([noticesZhCN.noFillReason.buy, noticesZhCN.noFillReason.sell]).toEqual(["资金不足，或者没有人在卖", "没有人在买"]);
    for (const m of [noticesEn, noticesZhCN]) expect(m.trigger.NO_FILL(args)).not.toMatch(/failed|失败/);
    expect(noticesEn.noFillReason.sell).not.toMatch(/cash|资金/);
    expect(noticesZhCN.noFillReason.sell).not.toMatch(/资金/);
  });

  it("states what happened in one sentence each, with the same facts in both languages, and never says a triggered order was filled", () => {
    const fill = { buy: true, qty: "1,250", symbol: "VCS-FOR-2021", price: "$68.50" };
    // 英文句子的单位写全(tonnes;1 吨写 tonne),不写 t
    expect(noticesEn.fill(fill)).toBe("Bought 1,250 tonnes of VCS-FOR-2021 at $68.50");
    expect(noticesEn.fill({ ...fill, buy: false })).toBe("Sold 1,250 tonnes of VCS-FOR-2021 at $68.50");
    expect(noticesEn.fill({ ...fill, qty: "1" })).toBe("Bought 1 tonne of VCS-FOR-2021 at $68.50");
    expect(noticesZhCN.fill(fill)).toBe("已买入 1,250 吨 VCS-FOR-2021，成交价 $68.50");
    expect(noticesZhCN.fill({ ...fill, buy: false })).toBe("已卖出 1,250 吨 VCS-FOR-2021，成交价 $68.50");
    const act = { buy: false, qty: "5", symbol: "GS-WIND-2022" };
    expect(noticesEn.act(act)).toBe("sell 5 tonnes of GS-WIND-2022");
    expect(noticesEn.act({ ...act, qty: "1" })).toBe("sell 1 tonne of GS-WIND-2022");
    expect(noticesZhCN.act(act)).toBe("卖出 5 吨 GS-WIND-2022");
    for (const m of [noticesEn, noticesZhCN]) {
      for (const [label, text] of [
        ["fill", m.fill(fill)],
        ["act", m.act(act)],
        ["TRIGGERED", m.trigger.TRIGGERED({ act: "ACT", price: "$1.00" })],
        ["REJECTED", m.trigger.REJECTED({ act: "ACT", price: "$1.00" })],
        ["CANCELLED", m.trigger.CANCELLED({ act: "ACT", price: "$1.00" })],
        ["NO_FILL", m.trigger.NO_FILL({ act: "ACT", price: "$1.00" })],
        ["alert up", m.alert({ symbol: "SYM", up: true, price: "$2.00", alertPrice: "$1.00" })],
        ["alert down", m.alert({ symbol: "SYM", up: false, price: "$2.00", alertPrice: "$1.00" })],
      ] as const) {
        expect(text.trim().length, label).toBeGreaterThan(0);
        // 参数都进了句子
        for (const piece of label === "fill" ? ["1,250", "VCS-FOR-2021", "$68.50"] : label.startsWith("alert") ? ["SYM", "$2.00", "$1.00"] : label === "act" ? ["5", "GS-WIND-2022"] : ["ACT", "$1.00"]) expect(text, label).toContain(piece);
      }
      // 触发只说「委托已提交」,不说成交
      expect(m.trigger.TRIGGERED({ act: "ACT", price: "$1.00" })).not.toMatch(/fill|成交/i);
    }
    expect(noticesEn.alert({ symbol: "SYM", up: true, price: "$2.00", alertPrice: "$1.00" })).toContain("rose");
    expect(noticesEn.alert({ symbol: "SYM", up: false, price: "$2.00", alertPrice: "$1.00" })).toContain("fell");
    expect(noticesZhCN.alert({ symbol: "SYM", up: true, price: "$2.00", alertPrice: "$1.00" })).toContain("涨到");
    expect(noticesZhCN.alert({ symbol: "SYM", up: false, price: "$2.00", alertPrice: "$1.00" })).toContain("跌到");
  });

  it("names the bell with the unread count, and uses full-width punctuation in Chinese sentences", () => {
    expect([en.notices.bell(0), en.notices.bell(1), en.notices.bell(12)]).toEqual(["Notifications", "Notifications, 1 unread", "Notifications, 12 unread"]);
    expect([zhCN.notices.bell(0), zhCN.notices.bell(1), zhCN.notices.bell(12)]).toEqual(["通知", "通知，1 条未读", "通知，12 条未读"]);
    const zhSentences = [
      noticesZhCN.fill({ buy: true, qty: "1", symbol: "S", price: "$1.00" }),
      noticesZhCN.trigger.REJECTED({ act: "x", price: "$1.00" }),
      noticesZhCN.trigger.NO_FILL({ act: "x", price: "$1.00" }),
      noticesZhCN.alert({ symbol: "S", up: true, price: "$2.00", alertPrice: "$1.00" }),
      noticesZhCN.emptyHint,
      noticesZhCN.noFillReason.buy,
      zhCN.notices.bell(2),
    ];
    for (const text of zhSentences) expect(text).not.toMatch(/[,:;()](?!\d)/);
  });

  it("keeps the notices free of live / deposit / withdraw / transfer wording (a simulation)", () => {
    for (const m of [noticesEn, noticesZhCN]) {
      const strings = [
        m.empty,
        m.emptyHint,
        m.unread,
        m.fill({ buy: true, qty: "1", symbol: "S", price: "$1.00" }),
        m.trigger.TRIGGERED({ act: "x", price: "$1.00" }),
        m.trigger.NO_FILL({ act: "x", price: "$1.00" }),
        m.alert({ symbol: "S", up: true, price: "$2.00", alertPrice: "$1.00" }),
        ...Object.values(m.reason),
        ...Object.values(m.noFillReason),
      ];
      for (const text of strings) {
        expect(text).not.toMatch(/\blive\b/i);
        expect(text).not.toContain("实时");
        expect(text).not.toMatch(/deposit|withdraw|transfer|充值|提现|划转/i);
      }
    }
  });
});
