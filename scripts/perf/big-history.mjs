#!/usr/bin/env node
// @ts-check
// 给一个本地用户造大量订单与成交(P2-13:CSV 导出改前改后的耗时对照,终审 P2-SRV-3;不加依赖,用 Node 自带的 node:sqlite)。
// 与 big-ledger.mjs 同一套规矩:只对本地库的**副本**跑(它会改库),服务要停着;拒绝 /data/ 下的路径、名为 trade.db 或 dev.db
// 的文件,以及 DATABASE_URL(环境变量或 ./.env)指向的库(db-copy-guard.mjs):
//
//   sqlite3 prisma/dev.db ".backup 'prisma/load.db'"
//   node scripts/perf/big-history.mjs prisma/load.db --user <userId> [--fills 50000] [--days 30]
//
// 做法:每一笔合成成交 = 该用户一张 1 吨的 FILLED 限价单(买卖交替,本人是 taker)+ 一个机器人的一张 FILLED 对手单(早 1 ms,maker)
// + 一行 Trade,价格 = 标的的 lastPrice。所以该用户多出 --fills 张订单与 --fills 笔成交。只写 Order / Trade 两张表,不写账本、
// 不改余额与持仓:余额、持仓与各项对账不受影响(postflight 照样全 0),总览与 24 小时变化只读账本,也不受影响。
// 时间在 [now − days, now − 25 h] 里随机(不进 24 小时窗口,不动行情的 24 小时统计);createdAt 写整数毫秒(与 Prisma 一致)。
// 合成成交的一方是真人,机器人清理(只删买卖双方都是机器人的成交、不再被成交引用的机器人订单)不会删它们。
import { randomBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { refusedTarget } from "./db-copy-guard.mjs";

/** @param {string} msg @returns {never} */
function die(msg) {
  console.error(`[big-history] ${msg}`);
  process.exit(2);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const o = { db: "", user: "", fills: 50_000, days: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => argv[++i] ?? die(`${a} needs a value`);
    if (a === "--user") o.user = value();
    else if (a === "--fills") o.fills = Number(value());
    else if (a === "--days") o.days = Number(value());
    else if (!a.startsWith("-") && !o.db) o.db = a;
    else die(`unknown argument ${a}`);
  }
  if (!o.db || !o.user) die("usage: node scripts/perf/big-history.mjs <db copy> --user <userId> [--fills 50000] [--days 30]");
  if (!Number.isInteger(o.fills) || o.fills < 1) die(`--fills must be a positive integer, got ${o.fills}`);
  if (!(o.days >= 2)) die(`--days must be >= 2, got ${o.days}`);
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
const bot = /** @type {{ id: string } | undefined} */ (db.prepare(`SELECT id FROM "User" WHERE isBot = 1 ORDER BY id LIMIT 1`).get());
if (!bot) die("no bot user to trade against (start the server once with the bot on)");
const asset = /** @type {{ id: string; symbol: string; lastPrice: number } | undefined} */ (
  db
    .prepare(
      `SELECT a.id, a.symbol, a.lastPrice FROM "Asset" a LEFT JOIN "Holding" h ON h.assetId = a.id AND h.userId = ?
       WHERE a.isScenario = 0 AND a.lastPrice IS NOT NULL ORDER BY COALESCE(h.quantity, 0) DESC, a.symbol LIMIT 1`,
    )
    .get(o.user)
);
if (!asset) die("no non-scenario instrument with a last price");
/** @param {string} sql */
const count = (sql) => /** @type {{ n: number }} */ (db.prepare(sql).get(o.user, o.user)).n;
const ordersBefore = count(`SELECT COUNT(*) AS n FROM "Order" WHERE userId = ? OR userId = ?`);
const fillsBefore = count(`SELECT COUNT(*) AS n FROM "Trade" WHERE buyerId = ? OR sellerId = ?`);

const now = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** [now − days, now − 25 h] 里的随机整数毫秒 */
const when = () => Math.round(now - 25 * HOUR - Math.random() * (o.days * DAY - 25 * HOUR));
const id = () => `perf${randomBytes(10).toString("hex")}`;

const insertOrder = db.prepare(
  `INSERT INTO "Order" (id, userId, assetId, side, type, price, quantity, filledQuantity, status, avgFillPrice, createdAt, updatedAt)
   VALUES (?, ?, ?, ?, 'LIMIT', ?, 1, 1, 'FILLED', ?, ?, ?)`,
);
const insertTrade = db.prepare(
  `INSERT INTO "Trade" (id, assetId, buyOrderId, sellOrderId, buyerId, sellerId, price, quantity, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
);
const price = asset.lastPrice;
const started = performance.now();
db.exec("BEGIN IMMEDIATE");
try {
  for (let i = 0; i < o.fills; i++) {
    const t = when();
    const userBuys = i % 2 === 0;
    const mine = id();
    const theirs = id();
    // 机器人的对手单早 1 ms(maker),本人的单是 taker
    insertOrder.run(theirs, bot.id, asset.id, userBuys ? "SELL" : "BUY", price, price, t - 1, t);
    insertOrder.run(mine, o.user, asset.id, userBuys ? "BUY" : "SELL", price, price, t, t);
    insertTrade.run(id(), asset.id, userBuys ? mine : theirs, userBuys ? theirs : mine, userBuys ? o.user : bot.id, userBuys ? bot.id : o.user, price, t);
  }
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  die(e instanceof Error ? e.message : String(e));
}
console.log(
  JSON.stringify({
    db: path.basename(o.db),
    user: `…${o.user.slice(-6)}`,
    asset: asset.symbol,
    priceCents: price,
    ordersBefore,
    ordersAfter: count(`SELECT COUNT(*) AS n FROM "Order" WHERE userId = ? OR userId = ?`),
    fillsBefore,
    fillsAfter: count(`SELECT COUNT(*) AS n FROM "Trade" WHERE buyerId = ? OR sellerId = ?`),
    ms: Math.round(performance.now() - started),
  }),
);
