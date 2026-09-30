// src/shared 纯度门禁:非测试文件不得 import react、next/*、@/generated、@/lib、../lib、prisma(计划 §3.5)。
// 静态扫描,不执行被测文件;测试文件(*.test.ts)可以导入 zod 与 ../../server/ws-schema.mjs,所以排除在外。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SHARED_DIR = fileURLToPath(new URL(".", import.meta.url));

/** 递归列出 src/shared/** 下的 .ts / .tsx 源文件(排除 *.test.ts / *.test.tsx),路径相对 src/shared */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
    out.push(relative(SHARED_DIR, full));
  }
  return out.sort();
}

/** 抽出文件里全部模块说明符:import … from "x"、export … from "x"、import "x"、import("x")、require("x") */
function moduleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/g, // import x from "m" / export * from "m"
    /\bimport\s*["']([^"']+)["']/g, // import "m"(副作用导入)
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // import("m")
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // require("m")
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

const FORBIDDEN: { label: string; test: (spec: string) => boolean }[] = [
  { label: "react", test: (s) => /^react(?:-dom)?(?:\/|$)/.test(s) },
  { label: "next/*", test: (s) => /^next(?:\/|$)/.test(s) },
  { label: "@/generated", test: (s) => /^@\/generated(?:\/|$)/.test(s) },
  { label: "@/lib", test: (s) => /^@\/lib(?:\/|$)/.test(s) },
  { label: "../lib", test: (s) => s.startsWith(".") && /\/lib(?:\/|$)/.test(s) },
  { label: "prisma", test: (s) => /prisma/i.test(s) },
];

describe("src/shared 纯度", () => {
  const files = listSourceFiles(SHARED_DIR);

  it("扫描到了契约文件本身(防止空扫描通过)", () => {
    for (const f of ["index.ts", "types.ts", "ws-protocol.ts", "bus.ts", "api-shapes.ts", "constants.ts"]) {
      expect(files).toContain(f);
    }
  });

  it.each(files)("%s 不导入 react / next / @/generated / @/lib / ../lib / prisma", (file) => {
    const specs = moduleSpecifiers(readFileSync(join(SHARED_DIR, file), "utf8"));
    const offenders = specs.flatMap((spec) => FORBIDDEN.filter((rule) => rule.test(spec)).map((rule) => `${spec} (${rule.label})`));
    expect(offenders).toEqual([]);
  });

  it("说明符抽取覆盖四种导入写法(自检)", () => {
    const sample = [
      // 样本里的说明符用单引号:既覆盖单引号写法,也让验收命令 grep 'from "(react|next|…)' src/shared 保持为空
      "import { a } from 'react';",
      "import type { B } from 'next/server';",
      'export * from "./types";',
      "import '@/lib/side-effect';",
      "const c = await import('../lib/x');",
      "const d = require('@prisma/client');",
    ].join("\n");
    expect(moduleSpecifiers(sample)).toEqual(["react", "next/server", "./types", "@/lib/side-effect", "../lib/x", "@prisma/client"]);
    expect(FORBIDDEN.filter((r) => r.test("react")).map((r) => r.label)).toEqual(["react"]);
    expect(FORBIDDEN.filter((r) => r.test("../lib/x")).map((r) => r.label)).toEqual(["../lib"]);
    expect(FORBIDDEN.filter((r) => r.test("./types"))).toEqual([]);
    expect(FORBIDDEN.filter((r) => r.test("../../server/ws-schema.mjs"))).toEqual([]);
  });
});
