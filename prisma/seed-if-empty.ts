// 仅当数据库为空时写入种子数据。
// 注意 seed.ts 是破坏性的（先 deleteMany 再重建），所以绝不能在每次部署时无条件运行，
// 否则会清空线上用户产生的数据。这里以「用户数为 0」判定空库。
import { spawnSync } from "node:child_process";
import { PrismaClient } from "../src/generated/prisma";

async function run() {
  const prisma = new PrismaClient();
  let count: number;
  try {
    count = await prisma.user.count();
  } finally {
    await prisma.$disconnect();
  }

  if (count > 0) {
    console.log(`[seed] 已有 ${count} 个用户，跳过种子数据。`);
    return;
  }

  console.log("[seed] 数据库为空，写入演示种子数据…");
  const r = spawnSync("npx", ["tsx", "prisma/seed.ts"], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[seed] 种子脚本失败");
    process.exit(r.status ?? 1);
  }
}

run().catch((e) => {
  console.error("[seed] 初始化失败", e);
  process.exit(1);
});
