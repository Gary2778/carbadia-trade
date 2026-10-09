import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 形状门禁(P3-01,用户 2026-10-01 选「甲 小圆角」):全站只用三档语义圆角 —— 容器 rounded-panel(8 px)、
// 按钮与输入框 rounded-control(6 px)、标签 rounded-chip(4 px),对话框沿用 rounded-dialog(12 px)。
// 胶囊形(rounded-full / rounded-pill)只留给正圆:圆点、步骤编号、圆形图标按钮 —— 同一行必须带等宽高(size-N 或 h-N w-N)。
// Tailwind 自带的 rounded-sm … rounded-3xl 与任意值 rounded-[…] 一律不用;exchange.css 的圆角只引 --radius-* 或 50%。

const SRC_DIR = fileURLToPath(new URL("../", import.meta.url));
const TEST_FILE = /\.test\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name) && !TEST_FILE.test(name)) out.push(path);
  }
  return out;
}

const STOCK_RADIUS = /\brounded(?:-[a-z]{1,2})?-(?:sm|md|lg|xl|2xl|3xl|\[)/;
const CAPSULE = /\brounded-(?:full|pill)\b/;
const SQUARE = /\bsize-[\w.()-]+|\bh-(\d+(?:\.\d+)?)\b.*\bw-\1\b|\bw-(\d+(?:\.\d+)?)\b.*\bh-\2\b/;

/** 一行里的形状违规;空数组 = 合规。注释行不算(LiquidGlassRefraction 里提到 rounded-full 的那句说明) */
export function shapeViolations(line: string): string[] {
  const code = line.replace(/\/\/.*$/, "");
  const found: string[] = [];
  if (STOCK_RADIUS.test(code)) found.push("stock Tailwind radius");
  if (CAPSULE.test(code) && !SQUARE.test(code)) found.push("capsule on a non-square element");
  return found;
}

describe("shape gate", () => {
  it("recognises the patterns it is meant to catch", () => {
    expect(shapeViolations('className="rounded-2xl border"')).toEqual(["stock Tailwind radius"]);
    expect(shapeViolations('className="rounded-t-xl"')).toEqual(["stock Tailwind radius"]);
    expect(shapeViolations('className="rounded-[10px]"')).toEqual(["stock Tailwind radius"]);
    expect(shapeViolations('className="px-4 py-2 rounded-full bg-accent"')).toEqual(["capsule on a non-square element"]);
    expect(shapeViolations('className="inline-flex rounded-pill border px-2"')).toEqual(["capsule on a non-square element"]);
    expect(shapeViolations('className="grid h-11 w-11 place-items-center rounded-full"')).toEqual([]);
    expect(shapeViolations('className="w-6 h-6 rounded-full"')).toEqual([]);
    expect(shapeViolations("className={`size-1.5 shrink-0 rounded-pill ${tone}`}")).toEqual([]);
    expect(shapeViolations('className="h-10 w-9 rounded-full"')).toEqual(["capsule on a non-square element"]);
    expect(shapeViolations('className="rounded-panel rounded-control rounded-chip rounded-dialog"')).toEqual([]);
    expect(shapeViolations("return value; // rounded-full 是 3.4e38px")).toEqual([]);
  });

  it("components and pages use only the semantic radii; capsules are circles", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_DIR)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          for (const rule of shapeViolations(line)) violations.push(`${relative(SRC_DIR, file)}:${index + 1} ${rule}`);
        });
    }
    expect(violations).toEqual([]);
  });

  it("exchange.css takes every radius from a token", () => {
    const css = readFileSync(join(SRC_DIR, "app/exchange.css"), "utf8");
    const radii = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1].trim());
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.filter((value) => !/^var\(--radius-(chip|control|panel|dialog)\)$/.test(value) && value !== "50%")).toEqual([]);
  });
});
