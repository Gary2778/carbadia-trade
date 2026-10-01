// @ts-check
// 会改库的本地度量脚本(big-ledger.mjs、big-history.mjs)共用的守卫:只接受库的「副本」(P2-11 定的规则,P2-13 从 big-ledger 挪出来共用)。
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/**
 * 库文件路径 → 拒绝的理由(null = 可以写)。这些脚本会不可逆地改库(追加几万行合成流水 / 订单 / 成交,big-ledger 还改赠金行的 createdAt),
 * 所以只接受「副本」:拒绝生产卷(/data/)、生产库名 trade.db、本地共用的开发库 dev.db(每次度量都用它),
 * 以及 DATABASE_URL 指向的库(环境变量与 ./.env 里的都算;file: 相对路径按 Prisma 的规则相对 prisma/ 目录解析,
 * 同名的库文件一律拒绝,不只比完整路径)。
 * @param {string} abs
 * @returns {string | null}
 */
export function refusedTarget(abs) {
  const base = path.basename(abs);
  if (abs.startsWith("/data/")) return "it is under /data/ (the production volume)";
  if (base === "trade.db") return "trade.db is the production database name";
  if (base === "dev.db") return "dev.db is the shared local database every perf run uses";
  /** @type {string[]} */
  const urls = [];
  if (process.env.DATABASE_URL) urls.push(process.env.DATABASE_URL);
  try {
    const env = fs.readFileSync(path.resolve(".env"), "utf8");
    const m = env.match(/^\s*DATABASE_URL\s*=\s*["']?([^"'\n]+)["']?\s*$/m);
    if (m) urls.push(m[1]);
  } catch {
    // 没有 .env(度量时常挪成 .env.off):只看环境变量
  }
  for (const url of urls) {
    if (!url.startsWith("file:")) continue;
    const file = url.slice("file:".length).split("?")[0];
    const target = path.isAbsolute(file) ? file : path.resolve("prisma", file);
    if (target === abs || path.basename(target) === base) return `it is the DATABASE_URL target (${url})`;
  }
  return null;
}
