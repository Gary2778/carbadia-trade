import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TZ_KEY, TZ_PREFS, readTz, type TimeZonePref } from "./timeZoneState";

describe("time-zone preference state (carbadia-tz)", () => {
  it("uses the carbadia-tz key and offers local, Beijing and UTC in that order", () => {
    expect(TZ_KEY).toBe("carbadia-tz");
    expect(TZ_PREFS).toEqual(["local", "Asia/Shanghai", "UTC"]);
  });

  it("reads the three legal values as they are", () => {
    for (const pref of TZ_PREFS) expect(readTz(pref)).toBe(pref);
  });

  it("falls back to local when nothing is stored or the value is unknown (no other IANA zones, no case folding)", () => {
    expect(readTz(null)).toBe("local");
    expect(readTz("")).toBe("local");
    expect(readTz("Local")).toBe("local");
    expect(readTz("utc")).toBe("local");
    expect(readTz("UTC+8")).toBe("local");
    expect(readTz("Asia/Tokyo")).toBe("local");
    expect(readTz("asia/shanghai")).toBe("local");
    expect(readTz("1")).toBe("local");
  });

  it("derives the type from the as-const list, so the type and the list cannot drift apart", () => {
    const src = readFileSync(fileURLToPath(new URL("./timeZoneState.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/export const TZ_PREFS = \["local", "Asia\/Shanghai", "UTC"\] as const;/);
    expect(src).toMatch(/export type TimeZonePref = \(typeof TZ_PREFS\)\[number\];/);
    // 类型层面:清单里的每个元素都是 TimeZonePref(tsc 检查),readTz 的结果也是
    const all: readonly TimeZonePref[] = TZ_PREFS;
    expect(all.map(readTz)).toEqual([...TZ_PREFS]);
  });

  it("is a plain module: no \"use client\", no React, no storage access of its own", () => {
    const src = readFileSync(fileURLToPath(new URL("./timeZoneState.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/^\s*["']use client["']/m);
    expect(src).not.toMatch(/from ["']react["']/);
    expect(src).not.toMatch(/localStorage/);
  });
});
