#!/usr/bin/env node
// @ts-check
// 给一个本地用户造大账本(计划 §6.2 P2-11「负载」:一个 ≥ 5 万行账本的用户;不加依赖,用 Node 自带的 node:sqlite)。
// 只对本地库的**副本**跑(它会改库);服务要停着(SQLite 单写者,改完再起服务)。拒绝 /data/ 下的路径(生产卷)、名为 trade.db
// 或 dev.db 的文件,以及 DATABASE_URL(环境变量或 ./.env)指向的库(见 refusedTarget):
//
//   sqlite3 prisma/dev.db ".backup 'prisma/load.db'"          # 副本(prisma/*.db 已在 .gitignore)
//   node scripts/perf/big-ledger.mjs prisma/load.db --user <userId> [--rows 50000] [--days 30] [--recent 0.2]
//
// 做法:在该用户已有持仓里挑数量最大的非情景标的 A(价格 p = A.lastPrice),按真实撮合写账本的形状追加合成流水,
// 每一组对每个账户的净额都是 0,所以余额、持仓、冻结与 Σdelta 对账都不用改(postflight 照样全 0):
//   · 市价买卖来回 1 吨(6 行,与 matching.ts 的 taker 结算同形):买 CASH −p / HOLDING +1(TRADE_SETTLE,TRADE);
//     1 ms 后卖 HOLDING_LOCKED +1(ORDER_LOCK,ORDER)、CASH +p / HOLDING −1 / HOLDING_LOCKED −1(TRADE_SETTLE,TRADE);
//   · 限价买单挂上又撤(4 行):CASH −10p / CASH_LOCKED +10p(ORDER_LOCK),之后 CASH +10p / CASH_LOCKED −10p(ORDER_UNLOCK)。
// 两种各占一半行数(来回 6 行、挂撤 4 行,组数按行数折算)。时间在最近 --days 天内随机,其中 --recent 的比例落在最近 24 小时
// (24 小时变化要对窗口里的流水求和);createdAt 一律写整数毫秒(与 Prisma 写入一致;文本会让窗口判断失效,见 postflight 的
// ledgerCreatedAtTypes)。该用户的赠金行(GRANT / SEED / MIGRATION_BASELINE)挪到最早的合成流水之前(模拟老账户:
// 否则窗口外的合成买入会先于赠金,倒推出的现金可能为负)。合成流水引用的订单 / 成交 id 不在 Order / Trade 表里,只用于度量。
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { refusedTarget } from "./db-copy-guard.mjs";

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[big-ledger] ${msg}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { db: "", user: "", rows: 50_000, days: 30, recent: 0.2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--user") o.user = value();
    else if (a === "--rows") o.rows = Number(value());
    else if (a === "--days") o.days = Number(value());
    else if (a === "--recent") o.recent = Number(value());
    else if (!a.startsWith("-") && !o.db) o.db = a;
    else die(`unknown argument ${a}`);
  }
  if (!o.db || !o.user) die("usage: node scripts/perf/big-ledger.mjs <db copy> --user <userId> [--rows 50000] [--days 30] [--recent 0.2]");
  if (!Number.isInteger(o.rows) || o.rows < 10) die(`--rows must be an integer >= 10, got ${o.rows}`);
  if (!(o.days >= 2)) die(`--days must be >= 2, got ${o.days}`);
  if (!(o.recent >= 0 && o.recent <= 1)) die(`--recent must be between 0 and 1, got ${o.recent}`);
  const abs = path.resolve(o.db);
  const refused = refusedTarget(abs);
  if (refused) die(`refusing to write ${abs}: ${refused}. Make a copy first (sqlite3 prisma/dev.db ".backup 'prisma/load.db'") and pass the copy`);
  return { ...o, db: abs };
}

const o = parseArgs(process.argv.slice(2));
const db = new DatabaseSync(o.db);
db.exec("PRAGMA busy_timeout = 5000");

const user = /** @type {{ id: string; isBot: number } | undefined} */ (db.prepare(`SELECT id, isBot FROM "User" WHERE id = ?`).get(o.user));
if (!user) die(`no user ${o.user}`);
if (user.isBot) die(`${o.user} is a bot`);
const holding = /** @type {{ assetId: string; symbol: string; quantity: number; lastPrice: number } | undefined} */ (
  db
    .prepare(
      `SELECT h.assetId, a.symbol, h.quantity, a.lastPrice FROM "Holding" h JOIN "Asset" a ON a.id = h.assetId
       WHERE h.userId = ? AND h.quantity > 0 AND a.isScenario = 0 AND a.lastPrice IS NOT NULL ORDER BY h.quantity DESC LIMIT 1`,
    )
    .get(o.user)
);
if (!holding) die(`${o.user} holds no non-scenario instrument with a last price (buy some first)`);
const price = holding.lastPrice;
const before = /** @type {{ n: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM "LedgerEntry" WHERE userId = ?`).get(o.user)).n;

const now = Date.now();
const DAY = 86_400_000;
/** 合成流水的时间:recent 的比例在最近 24 小时,其余在更早的 days − 1 天里;离现在至少 1 分钟 */
const when = () => (Math.random() < o.recent ? now - 60_000 - Math.random() * (DAY - 60_000) : now - DAY - Math.random() * (o.days - 1) * DAY);
const id = () => `perf${randomBytes(10).toString("hex")}`;

const insert = db.prepare(
  `INSERT INTO "LedgerEntry" (id, userId, account, assetId, delta, reason, refType, refId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
/** @param {string} account @param {string | null} assetId @param {number} delta @param {string} reason @param {string} refType @param {string} refId @param {number} at */
const line = (account, assetId, delta, reason, refType, refId, at) => insert.run(id(), o.user, account, assetId, delta, reason, refType, refId, Math.round(at));

// 行数一半给来回(6 行一组)、一半给挂撤(4 行一组),向上取整,保证总数不少于 --rows
const roundTrips = Math.ceil(o.rows / 2 / 6);
const cycles = Math.ceil((o.rows - roundTrips * 6) / 4);
let earliest = now;
const started = performance.now();
db.exec("BEGIN IMMEDIATE");
try {
  for (let i = 0; i < roundTrips; i++) {
    const t = when();
    earliest = Math.min(earliest, t);
    const buy = id();
    const sellOrder = id();
    const sell = id();
    line("CASH", null, -price, "TRADE_SETTLE", "TRADE", buy, t);
    line("HOLDING", holding.assetId, 1, "TRADE_SETTLE", "TRADE", buy, t);
    line("HOLDING_LOCKED", holding.assetId, 1, "ORDER_LOCK", "ORDER", sellOrder, t + 1);
    line("CASH", null, price, "TRADE_SETTLE", "TRADE", sell, t + 1);
    line("HOLDING", holding.assetId, -1, "TRADE_SETTLE", "TRADE", sell, t + 1);
    line("HOLDING_LOCKED", holding.assetId, -1, "TRADE_SETTLE", "TRADE", sell, t + 1);
  }
  for (let i = 0; i < cycles; i++) {
    const t = when();
    earliest = Math.min(earliest, t);
    const order = id();
    const lock = price * 10;
    const cancelAt = Math.min(now - 1, t + 1 + Math.random() * 600_000);
    line("CASH", null, -lock, "ORDER_LOCK", "ORDER", order, t);
    line("CASH_LOCKED", null, lock, "ORDER_LOCK", "ORDER", order, t);
    line("CASH", null, lock, "ORDER_UNLOCK", "ORDER", order, cancelAt);
    line("CASH_LOCKED", null, -lock, "ORDER_UNLOCK", "ORDER", order, cancelAt);
  }
  // 老账户:赠金行挪到最早的合成流水之前
  const moved = db
    .prepare(`UPDATE "LedgerEntry" SET createdAt = ? WHERE userId = ? AND reason IN ('GRANT', 'SEED', 'MIGRATION_BASELINE')`)
    .run(Math.floor(earliest) - 60_000, o.user).changes;
  db.exec("COMMIT");
  const after = /** @type {{ n: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM "LedgerEntry" WHERE userId = ?`).get(o.user)).n;
  const recent = /** @type {{ n: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM "LedgerEntry" WHERE userId = ? AND createdAt > ?`).get(o.user, now - DAY)).n;
  console.log(
    JSON.stringify({
      db: path.basename(o.db),
      user: `…${o.user.slice(-6)}`,
      asset: holding.symbol,
      priceCents: price,
      roundTrips,
      cycles,
      ledgerRowsBefore: before,
      ledgerRowsAfter: after,
      rowsInLast24h: recent,
      grantRowsMoved: Number(moved),
      ms: Math.round(performance.now() - started),
    }),
  );
} catch (e) {
  db.exec("ROLLBACK");
  die(e instanceof Error ? e.message : String(e));
}
