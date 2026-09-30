import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ThemeProvider 的接线(node 环境,不引 jsdom;组件本身的 effect 不跑,按源码把关)。存储读写与派生见 appearance-storage.test.ts。
describe("ThemeProvider wiring (source)", () => {
  const src = readFileSync(fileURLToPath(new URL("./ThemeProvider.tsx", import.meta.url)), "utf8");

  it("paints the path-derived appearance in a layout effect, so a soft navigation into or out of /trade never shows a frame in the other theme", () => {
    expect(src).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*?readAppearance\(pathname\)[\s\S]*?paint\(stored\.theme\);\s*paintUpDown\(stored\.upDown\);[\s\S]*?\}, \[pathname\]\);/);
    expect(src).not.toMatch(/useEffect\(\(\) => \{[\s\S]*?\}, \[pathname\]\);/);
  });

  it("never touches localStorage itself: reads and writes go through appearance-storage (the in-memory fallback)", () => {
    expect(src).not.toMatch(/localStorage\./);
    expect(src).toMatch(/from "\.\/appearance-storage"/);
  });

  it("exports only the component, the hook and types (non-component exports would make every edit a full-reload Fast Refresh boundary)", () => {
    const exported = [...src.matchAll(/^export (?:function|const|let|class) (\w+)/gm)].map((m) => m[1]);
    expect(exported.sort()).toEqual(["ThemeProvider", "useTheme"]);
  });
});
