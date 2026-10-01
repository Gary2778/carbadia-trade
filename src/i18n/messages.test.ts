import { describe, expect, it } from "vitest";
import accountEn from "./messages/account/en";
import accountZhCN from "./messages/account/zh-CN";
import coreEn from "./messages/core/en";
import coreZhCN from "./messages/core/zh-CN";
import en, { type Messages } from "./messages/en";
import terminalEn from "./messages/terminal/en";
import terminalZhCN from "./messages/terminal/zh-CN";
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
  it("has the fourteen Phase 1 terminal groups followed by the three Phase 2 groups, the ui namespace, the nav keys and the six extra asset names", () => {
    // 顺序固定:Phase 1 的 14 组在前,Phase 2 的组 ledger(P2-07)/ retire(P2-09)/ exportCsv(P2-06)在后;
    // 原来预留给 P2-10 的空组 account 已删掉(资产页文案自成 account 命名空间,见上一个 describe)
    const groups = [
      "demo", "connection", "header", "meta", "instruments", "book", "tape",
      "chart", "order", "tabs", "shortcuts", "a11y", "toast", "mobile",
      "ledger", "retire", "exportCsv",
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

  it("keys terminal.order.errors by exactly the DraftError literals", () => {
    expect([...Object.keys(en.terminal.order.errors)].sort()).toEqual([...DRAFT_ERRORS].sort());
    expect([...Object.keys(zhCN.terminal.order.errors)].sort()).toEqual([...DRAFT_ERRORS].sort());
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
