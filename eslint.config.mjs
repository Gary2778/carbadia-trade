import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma 生成的 client 不参与 lint(构建门禁会跑 lint,生成物必须排除)
    "src/generated/**",
    ".claude/**",
    ".worktrees/**",
    ".superpowers/**",
    // 生产只读运维脚本是 Node CommonJS(.cjs),require() 是正确写法
    "scripts/prod/*.cjs",
    // Cloudflare Worker 单文件,不走 Next/TS 规则集
    "infra/cloudflare-proxy/**",
  ]),
]);

export default eslintConfig;
