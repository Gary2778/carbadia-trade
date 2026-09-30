import { describe, expect, it } from "vitest";
import en from "@/i18n/messages/en";
import zhCN from "@/i18n/messages/zh-CN";
import {
  HOTKEYS,
  hotkeyKeyLabel,
  intervalSlot,
  isPriceField,
  isTypingTarget,
  matchHotkey,
  nudgePrice,
  shortcutRows,
  type HotkeyAction,
  type HotkeyEvent,
  type HotkeyTarget,
} from "./hotkeys";

// 键盘快捷键(计划 §3.6 键盘表):matchHotkey 是纯函数,node 环境直接喂事件形状的对象,不引 jsdom。

const BODY: HotkeyTarget = { tagName: "BODY", isContentEditable: false, dataset: {} };
const BUTTON: HotkeyTarget = { tagName: "BUTTON", isContentEditable: false, dataset: {} };
const TEXT_INPUT: HotkeyTarget = { tagName: "INPUT", type: "text", isContentEditable: false, dataset: {} };
const SEARCH_INPUT: HotkeyTarget = { tagName: "INPUT", type: "search", isContentEditable: false, dataset: {} };
// OrderPanel 的价格框带 data-price-field="" → dataset.priceField === ""
const PRICE_INPUT: HotkeyTarget = { tagName: "INPUT", type: "text", isContentEditable: false, dataset: { priceField: "" } };

function ev(key: string, opts: Partial<Omit<HotkeyEvent, "key">> = {}): HotkeyEvent {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: BODY, ...opts };
}
const match = (key: string, opts?: Partial<Omit<HotkeyEvent, "key">>) => matchHotkey(ev(key, opts), HOTKEYS);

describe("matchHotkey — one case per shortcut (§3.6)", () => {
  it("/ focuses the instrument search", () => {
    expect(match("/")).toBe("focusSearch");
  });

  it("Ctrl+K and Cmd+K are the same shortcut, and work while typing", () => {
    expect(match("k", { ctrlKey: true })).toBe("focusSearch");
    expect(match("k", { metaKey: true })).toBe("focusSearch");
    expect(match("k", { ctrlKey: true, target: TEXT_INPUT })).toBe("focusSearch");
    expect(match("k", { metaKey: true, target: PRICE_INPUT })).toBe("focusSearch");
    // Caps Lock 下 key 是大写
    expect(match("K", { metaKey: true })).toBe("focusSearch");
    // 多一个 Shift / Alt 就不是它(Firefox 的 Ctrl+Shift+K 是开发者工具)
    expect(match("K", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(match("k", { ctrlKey: true, altKey: true })).toBeNull();
    // 不带修饰键的 k 什么都不是
    expect(match("k")).toBeNull();
  });

  it("b / s pick the side", () => {
    expect(match("b")).toBe("sideBuy");
    expect(match("s")).toBe("sideSell");
  });

  it("l / m pick the order type", () => {
    expect(match("l")).toBe("typeLimit");
    expect(match("m")).toBe("typeMarket");
  });

  it("↑ / ↓ in the price field step the price by one tick; with Shift by ten", () => {
    expect(match("ArrowUp", { target: PRICE_INPUT })).toBe("priceUp");
    expect(match("ArrowDown", { target: PRICE_INPUT })).toBe("priceDown");
    expect(match("ArrowUp", { target: PRICE_INPUT, shiftKey: true })).toBe("priceUp10");
    expect(match("ArrowDown", { target: PRICE_INPUT, shiftKey: true })).toBe("priceDown10");
  });

  it("Enter in the price field is the review shortcut", () => {
    expect(match("Enter", { target: PRICE_INPUT })).toBe("review");
  });

  it("Esc works everywhere, including inside inputs", () => {
    expect(match("Escape")).toBe("cancelDialog");
    expect(match("Escape", { target: SEARCH_INPUT })).toBe("cancelDialog");
    expect(match("Escape", { target: PRICE_INPUT })).toBe("cancelDialog");
  });

  it("1–7 map to interval1…interval7 in order", () => {
    const expected: HotkeyAction[] = ["interval1", "interval2", "interval3", "interval4", "interval5", "interval6", "interval7"];
    expect(["1", "2", "3", "4", "5", "6", "7"].map((k) => match(k))).toEqual(expected);
    expect(match("8")).toBeNull();
    expect(match("0")).toBeNull();
  });

  it("? opens the help", () => {
    // US 布局下 ? 是 Shift+/,shiftKey 为真
    expect(match("?", { shiftKey: true })).toBe("help");
    expect(match("?")).toBe("help");
  });
});

describe("matchHotkey — scopes and modifiers", () => {
  it("b does not fire inside an input, textarea, select or contenteditable", () => {
    expect(match("b", { target: TEXT_INPUT })).toBeNull();
    expect(match("b", { target: SEARCH_INPUT })).toBeNull();
    expect(match("b", { target: PRICE_INPUT })).toBeNull();
    expect(match("b", { target: { tagName: "TEXTAREA", isContentEditable: false, dataset: {} } })).toBeNull();
    expect(match("b", { target: { tagName: "SELECT", isContentEditable: false, dataset: {} } })).toBeNull();
    expect(match("b", { target: { tagName: "DIV", isContentEditable: true, dataset: {} } })).toBeNull();
  });

  it("? and / do not fire inside an input (they are typed characters there)", () => {
    expect(match("?", { shiftKey: true, target: TEXT_INPUT })).toBeNull();
    expect(match("?", { shiftKey: true, target: PRICE_INPUT })).toBeNull();
    expect(match("/", { target: SEARCH_INPUT })).toBeNull();
    expect(match("1", { target: PRICE_INPUT })).toBeNull();
  });

  it("only priceField shortcuts pass inside the price field", () => {
    // 价格框里:↑↓、Enter、Esc、Ctrl/Cmd+K 放行;单字母与数字不放行
    for (const key of ["b", "s", "l", "m", "/", "3"]) expect(match(key, { target: PRICE_INPUT }), key).toBeNull();
    // 其它输入框里 ↑↓ / Enter 不是快捷键(交给浏览器:光标移动、表单隐式提交)
    expect(match("ArrowUp", { target: TEXT_INPUT })).toBeNull();
    expect(match("Enter", { target: TEXT_INPUT })).toBeNull();
    // 不在输入框里的 ↑↓ / Enter(页面滚动、按钮激活)也不是
    expect(match("ArrowUp")).toBeNull();
    expect(match("Enter", { target: BUTTON })).toBeNull();
  });

  it("non-text inputs (range slider, checkbox) are not typing targets", () => {
    const range: HotkeyTarget = { tagName: "INPUT", type: "range", isContentEditable: false, dataset: {} };
    const checkbox: HotkeyTarget = { tagName: "INPUT", type: "checkbox", isContentEditable: false, dataset: {} };
    expect(match("b", { target: range })).toBe("sideBuy");
    expect(match("m", { target: checkbox })).toBe("typeMarket");
    // 但滑杆上的 ↑↓ 是滑杆自己的,不是价格步进
    expect(match("ArrowUp", { target: range })).toBeNull();
  });

  it("letters with Shift, Ctrl, Cmd or Alt are not the plain shortcut", () => {
    expect(match("B", { shiftKey: true })).toBeNull();
    expect(match("b", { ctrlKey: true })).toBeNull();
    expect(match("b", { metaKey: true })).toBeNull();
    expect(match("b", { altKey: true })).toBeNull();
    expect(match("/", { ctrlKey: true })).toBeNull();
    // Caps Lock(无 Shift 的大写)照常
    expect(match("B")).toBe("sideBuy");
  });

  it("named keys need the exact modifier set", () => {
    expect(match("Enter", { target: PRICE_INPUT, shiftKey: true })).toBeNull();
    expect(match("ArrowUp", { target: PRICE_INPUT, ctrlKey: true })).toBeNull();
    expect(match("ArrowUp", { target: PRICE_INPUT, altKey: true })).toBeNull();
    expect(match("Escape", { shiftKey: true })).toBeNull();
  });

  it("digits and punctuation that need Shift on some layouts still match", () => {
    // AZERTY 的数字行、德语布局的 / 都要 Shift
    expect(match("3", { shiftKey: true })).toBe("interval3");
    expect(match("/", { shiftKey: true })).toBe("focusSearch");
  });

  it("returns null while an IME is composing, for a null target, and for unknown keys", () => {
    expect(match("b", { isComposing: true })).toBeNull();
    expect(match("b", { target: null })).toBe("sideBuy");
    expect(match("x")).toBeNull();
    expect(match("Tab")).toBeNull();
  });

  it("honours the table it is given (first match wins)", () => {
    expect(matchHotkey(ev("b"), [])).toBeNull();
    expect(matchHotkey(ev("b"), [{ key: "b", action: "help", label: "help" }, ...HOTKEYS])).toBe("help");
  });
});

describe("target helpers", () => {
  it("isTypingTarget / isPriceField", () => {
    expect(isTypingTarget(BODY)).toBe(false);
    expect(isTypingTarget(BUTTON)).toBe(false);
    expect(isTypingTarget(TEXT_INPUT)).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", isContentEditable: false, dataset: {} })).toBe(true); // 无 type = text
    expect(isTypingTarget({ tagName: "input", type: "NUMBER", isContentEditable: false, dataset: {} })).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
    expect(isPriceField(PRICE_INPUT)).toBe(true);
    expect(isPriceField(TEXT_INPUT)).toBe(false);
    expect(isPriceField(null)).toBe(false);
  });
});

describe("HOTKEYS table", () => {
  it("covers every action of §3.6 exactly once per key combination", () => {
    const combos = HOTKEYS.map((h) => `${h.mod ?? ""}+${h.key}`);
    expect(new Set(combos).size).toBe(combos.length);
    const actions = new Set(HOTKEYS.map((h) => h.action));
    for (const a of ["focusSearch", "sideBuy", "sideSell", "typeLimit", "typeMarket", "priceUp", "priceDown", "priceUp10", "priceDown10", "review", "cancelDialog", "help"] as const) {
      expect(actions.has(a), a).toBe(true);
    }
    for (let i = 1; i <= 7; i++) expect(actions.has(`interval${i}` as HotkeyAction)).toBe(true);
  });

  it("every label is a terminal.shortcuts.* key with text in both languages", () => {
    for (const h of HOTKEYS) {
      expect(typeof en.terminal.shortcuts[h.label], h.label).toBe("string");
      expect(zhCN.terminal.shortcuts[h.label].length, h.label).toBeGreaterThan(0);
    }
  });
});

describe("shortcutRows / hotkeyKeyLabel (help table)", () => {
  it("groups HOTKEYS by label in table order; every hotkey lands in exactly one row", () => {
    const rows = shortcutRows(HOTKEYS);
    expect(rows.map((r) => r.label)).toEqual(["search", "palette", "buy", "sell", "limit", "market", "nudge", "nudge10", "submit", "escape", "interval", "help"]);
    const listed = rows.flatMap((r) => r.hotkeys);
    expect(listed).toHaveLength(HOTKEYS.length);
    expect(new Set(listed)).toEqual(new Set(HOTKEYS));
    expect(rows.find((r) => r.label === "interval")!.hotkeys.map(hotkeyKeyLabel)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    // ±1 tick 与 ±10 tick 各占一行(帮助表不再把 Shift+↑↓ 写成「± 一个 tick」)
    expect(rows.find((r) => r.label === "nudge")!.hotkeys.map(hotkeyKeyLabel)).toEqual(["↑", "↓"]);
    expect(rows.find((r) => r.label === "nudge10")!.hotkeys.map(hotkeyKeyLabel)).toEqual(["Shift+↑", "Shift+↓"]);
  });

  it("renders key caps", () => {
    const label = (action: HotkeyAction) => hotkeyKeyLabel(HOTKEYS.find((h) => h.action === action && (action !== "focusSearch" || h.mod))!);
    expect(label("focusSearch")).toBe("Ctrl/Cmd+K");
    expect(label("priceUp")).toBe("↑");
    expect(label("priceDown10")).toBe("Shift+↓");
    expect(label("review")).toBe("Enter");
    expect(label("cancelDialog")).toBe("Esc");
    expect(label("help")).toBe("?");
    expect(label("sideBuy")).toBe("B");
    expect(hotkeyKeyLabel({ key: "/", action: "focusSearch", label: "search" })).toBe("/");
  });
});

describe("intervalSlot", () => {
  it("maps interval1…interval7 to 0…6 and everything else to null", () => {
    expect(intervalSlot("interval1")).toBe(0);
    expect(intervalSlot("interval7")).toBe(6);
    expect(intervalSlot("help")).toBeNull();
  });
});

describe("nudgePrice", () => {
  const cents2 = { tickSize: 1, pricePrecision: 2 };
  const dime = { tickSize: 10, pricePrecision: 2 };

  it("steps an on-tick price by whole ticks", () => {
    expect(nudgePrice("70.00", 1, cents2, null)).toBe("70.01");
    expect(nudgePrice("70.00", -1, cents2, null)).toBe("69.99");
    expect(nudgePrice("70.00", 10, cents2, null)).toBe("70.10");
    expect(nudgePrice("70.10", 1, dime, null)).toBe("70.20");
    expect(nudgePrice("70.10", -10, dime, null)).toBe("69.10");
    expect(nudgePrice("1,234.50", 1, cents2, null)).toBe("1234.51");
  });

  it("snaps an off-tick price to the next tick in the direction of travel", () => {
    expect(nudgePrice("70.05", 1, dime, null)).toBe("70.10");
    expect(nudgePrice("70.05", -1, dime, null)).toBe("70.00");
  });

  it("never goes below one tick or above the price cap", () => {
    expect(nudgePrice("0.01", -1, cents2, null)).toBe("0.01");
    expect(nudgePrice("0.10", -5, dime, null)).toBe("0.10");
    expect(nudgePrice("1000000.00", 1, cents2, null)).toBe("1000000.00");
  });

  it("an empty or unreadable field starts from the fallback price (snapped to tick), without stepping", () => {
    expect(nudgePrice("", 1, cents2, 6800)).toBe("68.00");
    expect(nudgePrice("  ", -1, dime, 6805)).toBe("68.10");
    expect(nudgePrice("abc", 1, cents2, 6800)).toBe("68.00");
    expect(nudgePrice("0", 1, cents2, 6800)).toBe("68.00");
  });

  it("returns null when there is nothing to step from", () => {
    expect(nudgePrice("", 1, cents2, null)).toBeNull();
    expect(nudgePrice("", 1, cents2, 0)).toBeNull();
    expect(nudgePrice("", 1, cents2, Number.NaN)).toBeNull();
  });

  it("treats a bad tickSize as 1", () => {
    expect(nudgePrice("70.00", 1, { tickSize: 0, pricePrecision: 2 }, null)).toBe("70.01");
  });
});
