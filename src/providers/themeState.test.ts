import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  THEME_KEY,
  UPDOWN_KEY,
  defaultThemeFor,
  pressThemeButton,
  pressUpDownButton,
  readTheme,
  readUpDown,
} from "./themeState";

describe("theme state (two looks: light and dark)", () => {
  it("reads carbadia-theme, falling back to light when nothing is stored or the value is illegal", () => {
    expect(THEME_KEY).toBe("carbadia-theme");
    expect(readTheme(null)).toBe("light");
    expect(readTheme("light")).toBe("light");
    expect(readTheme("dark")).toBe("dark");
    // 非法值:回落浅色
    expect(readTheme("")).toBe("light");
    expect(readTheme("DARK")).toBe("light");
    expect(readTheme("sepia")).toBe("light");
    expect(readTheme("1")).toBe("light");
  });

  it("flips light and dark with the sun/moon button", () => {
    expect(pressThemeButton("light")).toBe("dark");
    expect(pressThemeButton("dark")).toBe("light");
    expect(pressThemeButton(pressThemeButton("light"))).toBe("light");
  });

  it("exports only the two-look rules: theme, up/down axis and the terminal's first-visit default", () => {
    const src = readFileSync(fileURLToPath(new URL("./themeState.ts", import.meta.url)), "utf8");
    const exported = [...src.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["THEME_KEY", "UPDOWN_KEY", "defaultThemeFor", "pressThemeButton", "pressUpDownButton", "readTheme", "readUpDown"]);
    expect([...src.matchAll(/^export type (\w+)/gm)].map((m) => m[1]).sort()).toEqual(["Theme", "UpDown"]);
  });
});

// ── 涨跌轴与终端首访 dark ────────────────────────────────────────

describe("up/down colour axis", () => {
  it("reads carbadia-updown and defaults to green-up when nothing is stored", () => {
    expect(UPDOWN_KEY).toBe("carbadia-updown");
    expect(readUpDown(null)).toBe("green-up");
    expect(readUpDown("green-up")).toBe("green-up");
    expect(readUpDown("red-up")).toBe("red-up");
  });

  it("falls back to green-up for illegal values", () => {
    expect(readUpDown("")).toBe("green-up");
    expect(readUpDown("red")).toBe("green-up");
    expect(readUpDown("RED-UP")).toBe("green-up");
    expect(readUpDown("1")).toBe("green-up");
  });

  it("flips between green-up and red-up with the toggle", () => {
    expect(pressUpDownButton("green-up")).toBe("red-up");
    expect(pressUpDownButton("red-up")).toBe("green-up");
    expect(pressUpDownButton(pressUpDownButton("green-up"))).toBe("green-up");
  });
});

describe("defaultThemeFor", () => {
  it("first visit to the terminal (nothing stored + /trade prefix) is dark", () => {
    expect(defaultThemeFor("/trade", null)).toBe("dark");
    expect(defaultThemeFor("/trade/VCS-FOR-2021", null)).toBe("dark");
    // 资产页在 /trade 之下(P2-10):与终端同一套设计语言,首访同样深色
    expect(defaultThemeFor("/trade/account", null)).toBe("dark");
  });

  it("first visit anywhere else stays light", () => {
    expect(defaultThemeFor("/", null)).toBe("light");
    expect(defaultThemeFor("/market/VCS-FOR-2021", null)).toBe("light");
    expect(defaultThemeFor("/orders", null)).toBe("light");
    expect(defaultThemeFor("/otc", null)).toBe("light");
  });

  it("a stored choice wins on the terminal and elsewhere, illegal values read as light", () => {
    // 存过就按存的:终端不再强制 dark
    expect(defaultThemeFor("/trade", "light")).toBe("light");
    expect(defaultThemeFor("/trade/VCS-FOR-2021", "dark")).toBe("dark");
    expect(defaultThemeFor("/", "dark")).toBe("dark");
    expect(defaultThemeFor("/", "light")).toBe("light");
    // 非法存储值与 readTheme 同一规则:回落浅色,不因为在终端而变深
    expect(defaultThemeFor("/trade", "sepia")).toBe("light");
    expect(defaultThemeFor("/", "")).toBe("light");
  });
});
