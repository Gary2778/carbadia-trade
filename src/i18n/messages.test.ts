import { describe, expect, it } from "vitest";
import en, { type Messages } from "./messages/en";
import zhCN from "./messages/zh-CN";

// 文案注册表的结构契约(docs/trade-upgrade-plan.md §4.8 / §4.10):
// en 与 zh-CN 键集逐叶相等、叶子非空、函数型词条两边参数一致、terminal.order.errors = DraftError 枚举。
// `Messages = typeof en` 已在编译期挡住 zh-CN 缺键 / 多键;这里补运行时无法由类型覆盖的部分
// (`as Record<string, string>` 的 data.assetNames、空字符串、函数 arity)。

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

describe("messages: terminal namespace contract (§4.8 / §4.10)", () => {
  it("has the fourteen terminal groups, the ui namespace, the two nav keys and the six extra asset names", () => {
    expect(Object.keys(en.terminal)).toEqual([
      "demo", "connection", "header", "meta", "instruments", "book", "tape",
      "chart", "order", "tabs", "shortcuts", "a11y", "toast", "mobile",
    ]);
    expect(Object.keys(en.ui)).toEqual([
      "loading", "empty", "error", "retry", "close", "confirm", "cancel", "notProvided", "loadMore",
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
