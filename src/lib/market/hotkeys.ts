// 终端键盘快捷键(计划 §3.6 键盘表、§4.7「快捷键仅在 pointer: fine 设备启用」、§4.10 terminal.shortcuts.*)。
// 本模块是纯数据 + 纯函数(node 环境可测,不碰 DOM / window):
//   - HOTKEYS:快捷键表。key 与 KeyboardEvent.key 比较;mod 为唯一允许的修饰键("ctrl" = Ctrl 或 Cmd,两者等价);
//     when 为作用域:"global"(输入框里也生效)、"notTyping"(默认;焦点在可输入元素里不生效)、"priceField"(只在下单价格框里);
//     label 是帮助表那一行的文案键(terminal.shortcuts.<label>),几条快捷键可以共用一行(↑↓ 同属 nudge、Shift+↑↓ 同属 nudge10,1–7 同属 interval);
//   - matchHotkey(e, hotkeys):事件 → HotkeyAction | null;输入框内只放行 global 与 priceField 类;
//   - shortcutRows / hotkeyKeyLabel:KeyboardShortcutsHelp 的表格由它们从 HOTKEYS 生成,与 HOTKEYS 一一对应;
//   - nudgePrice:价格框 ↑↓ 按 tickSize 步进的文本计算。
// 分发(DOM 与 store 的副作用)在 TerminalShell。
import type { Messages } from "@/i18n";
import { MAX_PRICE_CENTS } from "@/shared/order-math";
import { parseCents, priceInputText } from "./order-draft";

export type HotkeyAction =
  | "focusSearch"
  | "sideBuy"
  | "sideSell"
  | "typeLimit"
  | "typeMarket"
  | "priceUp"
  | "priceDown"
  | "priceUp10"
  | "priceDown10"
  | "review"
  | "cancelDialog"
  | "interval1"
  | "interval2"
  | "interval3"
  | "interval4"
  | "interval5"
  | "interval6"
  | "interval7"
  | "help";

export type HotkeyScope = "global" | "notTyping" | "priceField";
export type HotkeyMod = "ctrl" | "shift" | "alt";

/** 帮助表一行的文案键:terminal.shortcuts 里除标题与脚注以外的键 */
export type ShortcutLabel = Exclude<keyof Messages["terminal"]["shortcuts"], "title" | "pointerOnly">;

export type Hotkey = {
  /** 与 KeyboardEvent.key 比较;单个字母写小写 */
  key: string;
  mod?: HotkeyMod;
  /** 缺省 "notTyping" */
  when?: HotkeyScope;
  action: HotkeyAction;
  label: ShortcutLabel;
};

/** 顺序即帮助表的行序(按 label 首次出现);同一组合键只出现一次 */
export const HOTKEYS: readonly Hotkey[] = [
  { key: "/", action: "focusSearch", label: "search" },
  { key: "k", mod: "ctrl", when: "global", action: "focusSearch", label: "palette" },
  { key: "b", action: "sideBuy", label: "buy" },
  { key: "s", action: "sideSell", label: "sell" },
  { key: "l", action: "typeLimit", label: "limit" },
  { key: "m", action: "typeMarket", label: "market" },
  { key: "ArrowUp", when: "priceField", action: "priceUp", label: "nudge" },
  { key: "ArrowDown", when: "priceField", action: "priceDown", label: "nudge" },
  { key: "ArrowUp", mod: "shift", when: "priceField", action: "priceUp10", label: "nudge10" },
  { key: "ArrowDown", mod: "shift", when: "priceField", action: "priceDown10", label: "nudge10" },
  { key: "Enter", when: "priceField", action: "review", label: "submit" },
  { key: "Escape", when: "global", action: "cancelDialog", label: "escape" },
  { key: "1", action: "interval1", label: "interval" },
  { key: "2", action: "interval2", label: "interval" },
  { key: "3", action: "interval3", label: "interval" },
  { key: "4", action: "interval4", label: "interval" },
  { key: "5", action: "interval5", label: "interval" },
  { key: "6", action: "interval6", label: "interval" },
  { key: "7", action: "interval7", label: "interval" },
  { key: "?", action: "help", label: "help" },
];

/** 事件目标里用得到的部分(HTMLElement 结构上满足;测试直接喂对象) */
export type HotkeyTarget = {
  tagName?: string;
  /** <input> 的 type;缺省按 text */
  type?: string;
  isContentEditable?: boolean;
  dataset?: Record<string, string | undefined>;
};

/** KeyboardEvent 里用得到的部分 */
export type HotkeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  target: HotkeyTarget | null;
};

/** 不接收文字输入的 <input>:单字母快捷键在它们上面照常生效 */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/** 焦点在可输入元素里(文本类 input、textarea、select、contenteditable):这时单键快捷键让给输入 */
export function isTypingTarget(target: HotkeyTarget | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
}

/** 下单面板的价格框(OrderPanel 的 input 带 data-price-field) */
export function isPriceField(target: HotkeyTarget | null): boolean {
  return target?.dataset?.priceField !== undefined;
}

/** 单个字符的非字母键(? / 数字):有的键盘布局要按 Shift 才打得出来,所以 Shift 不参与比较 */
const isShiftableChar = (key: string): boolean => key.length === 1 && key.toLowerCase() === key.toUpperCase();

function modifiersMatch(h: Hotkey, e: HotkeyEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey; // Ctrl 与 Cmd 等价
  switch (h.mod) {
    case "ctrl":
      return ctrl && !e.altKey && !e.shiftKey;
    case "shift":
      return e.shiftKey && !ctrl && !e.altKey;
    case "alt":
      return e.altKey && !ctrl && !e.shiftKey;
    default:
      return !ctrl && !e.altKey && (!e.shiftKey || isShiftableChar(h.key));
  }
}

function scopeMatches(scope: HotkeyScope, target: HotkeyTarget | null): boolean {
  if (scope === "global") return true;
  if (scope === "priceField") return isPriceField(target);
  return !isTypingTarget(target);
}

/**
 * 事件 → 动作(表里第一条匹配的),没有匹配为 null。
 * 字母不区分大小写,但按着 Shift 的字母不算(Shift+B 不是买入;Caps Lock 下的无 Shift 大写照常);
 * 输入法组字中一律 null。输入框内只放行 global(Esc、Ctrl/Cmd+K)与 priceField(价格框里的 ↑↓ Enter)。
 */
export function matchHotkey(e: HotkeyEvent, hotkeys: readonly Hotkey[] = HOTKEYS): HotkeyAction | null {
  if (e.isComposing) return null;
  const key = e.key.length === 1 && !e.shiftKey ? e.key.toLowerCase() : e.key;
  // Ctrl/Cmd 组合里的字母在 Caps Lock 下是大写
  const keyLower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  for (const h of hotkeys) {
    const k = h.mod === "ctrl" || h.mod === "alt" ? keyLower : key;
    if (k !== h.key) continue;
    if (!modifiersMatch(h, e)) continue;
    if (!scopeMatches(h.when ?? "notTyping", e.target)) continue;
    return h.action;
  }
  return null;
}

/** interval1…interval7 → 0…6(= 图表页签 CHART_TABS 的下标:分时 / 1m / 5m / 15m / 1h / 4h / 1d);其它动作 null */
export function intervalSlot(action: HotkeyAction): number | null {
  const m = /^interval([1-7])$/.exec(action);
  return m ? Number(m[1]) - 1 : null;
}

// ------------------------------------------------------------------ 帮助表

const KEY_CAPS: Record<string, string> = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Enter: "Enter" };
const MOD_CAPS: Record<HotkeyMod, string> = { ctrl: "Ctrl/Cmd", shift: "Shift", alt: "Alt" };

/** 帮助表里的键帽文字:Ctrl/Cmd+K、Shift+↑、Esc、B;按键名不翻译(文案键本身也写 Ctrl/Cmd、Enter、Esc) */
export function hotkeyKeyLabel(h: Hotkey): string {
  const cap = KEY_CAPS[h.key] ?? (h.key.length === 1 ? h.key.toUpperCase() : h.key);
  return h.mod ? `${MOD_CAPS[h.mod]}+${cap}` : cap;
}

export type ShortcutRow = { label: ShortcutLabel; hotkeys: Hotkey[] };

/** 按 label 分组(行序 = 表里首次出现的顺序):每条快捷键恰好落在一行,每一行都来自表 */
export function shortcutRows(hotkeys: readonly Hotkey[] = HOTKEYS): ShortcutRow[] {
  const rows = new Map<ShortcutLabel, Hotkey[]>();
  for (const h of hotkeys) {
    const row = rows.get(h.label);
    if (row) row.push(h);
    else rows.set(h.label, [h]);
  }
  return [...rows].map(([label, list]) => ({ label, hotkeys: list }));
}

// ------------------------------------------------------------------ 价格步进

/**
 * 价格框 ↑ / ↓(ticks = ±1,Shift 为 ±10)的新文本(整数分 → 按标的精度的输入框文本)。
 * 已在 tick 网格上:按整 tick 走;不在网格上:先落到行进方向上的下一个 tick(↑ 向上、↓ 向下)再走余下的步数;
 * 结果夹在 [1 tick, MAX_PRICE_CENTS 以内最大的 tick]。
 * 框是空的或读不出正价格时,不步进,先填入 fallback(通常是最新价)取整到 tick;没有 fallback 返回 null(不动)。
 */
export function nudgePrice(text: string, ticks: number, instrument: { tickSize: number; pricePrecision: number }, fallback: number | null): string | null {
  const tick = Number.isSafeInteger(instrument.tickSize) && instrument.tickSize > 0 ? instrument.tickSize : 1;
  const maxPrice = Math.floor(MAX_PRICE_CENTS / tick) * tick;
  const clamp = (cents: number) => Math.min(maxPrice, Math.max(tick, cents));
  const current = parseCents(text);
  if (current === null || !Number.isFinite(current) || current <= 0) {
    if (fallback === null || !Number.isFinite(fallback) || fallback <= 0) return null;
    return priceInputText(clamp(Math.round(fallback / tick) * tick), instrument.pricePrecision);
  }
  const base = ticks >= 0 ? Math.floor(current / tick) * tick : Math.ceil(current / tick) * tick;
  return priceInputText(clamp(base + ticks * tick), instrument.pricePrecision);
}
