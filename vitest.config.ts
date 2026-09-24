import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 与 tsconfig 的 "@/*" → "./src/*" 保持一致,让测试能导入用了别名的源文件
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { include: ["src/**/*.test.ts"], passWithNoTests: true },
});
