import { describe, expect, it } from "vitest";
import { effectiveTheme, pressKidsButton, pressThemeButton, readThemeState, type ThemeState } from "./themeState";

const LIGHT: ThemeState = { base: "light", kids: false };
const DARK: ThemeState = { base: "dark", kids: false };
const KIDS_FROM_LIGHT: ThemeState = { base: "light", kids: true };
const KIDS_FROM_DARK: ThemeState = { base: "dark", kids: true };

describe("theme state", () => {
  it("reads the two storage keys, falling back to light with kids mode off", () => {
    expect(readThemeState(null, null)).toEqual(LIGHT);
    expect(readThemeState("dark", null)).toEqual(DARK);
    expect(readThemeState("light", "1")).toEqual(KIDS_FROM_LIGHT);
    expect(readThemeState("dark", "1")).toEqual(KIDS_FROM_DARK);
    // 非法值:主题回落浅色;儿童护眼只认 "1"
    expect(readThemeState("kids", "true")).toEqual(LIGHT);
    expect(readThemeState("", "0")).toEqual(LIGHT);
  });

  it("treats kids eye-care mode as part of the dark family", () => {
    expect(effectiveTheme(LIGHT)).toBe("light");
    expect(effectiveTheme(DARK)).toBe("dark");
    expect(effectiveTheme(KIDS_FROM_LIGHT)).toBe("dark");
    expect(effectiveTheme(KIDS_FROM_DARK)).toBe("dark");
  });

  it("flips light and dark with the sun/moon button", () => {
    expect(pressThemeButton(LIGHT)).toEqual(DARK);
    expect(pressThemeButton(DARK)).toEqual(LIGHT);
  });

  it("leaves kids mode with the sun/moon button, landing on the theme its icon shows", () => {
    expect(pressThemeButton(KIDS_FROM_LIGHT)).toEqual(LIGHT);
    expect(pressThemeButton(KIDS_FROM_DARK)).toEqual(DARK);
  });

  it("turns kids mode on and off without forgetting the theme underneath", () => {
    expect(pressKidsButton(LIGHT)).toEqual(KIDS_FROM_LIGHT);
    expect(pressKidsButton(DARK)).toEqual(KIDS_FROM_DARK);
    expect(pressKidsButton(pressKidsButton(LIGHT))).toEqual(LIGHT);
    expect(pressKidsButton(pressKidsButton(DARK))).toEqual(DARK);
  });

  it("never mutates the state it was given", () => {
    const state: ThemeState = { base: "dark", kids: false };
    pressThemeButton(state);
    pressKidsButton(state);
    expect(state).toEqual({ base: "dark", kids: false });
  });
});
