// 做市机器人: 每 ~2.5s(BOT_TICK_MS)对每个标的随机游走报价、维护两侧 5 档、概率吃单
import { randomBytes } from "node:crypto";
import type { Asset, Order, User } from "@/generated/prisma";
import { prisma } from "../server/db";
import { cancelOrder, placeOrder } from "./matching";
import { buildQuoteLevels, nextFair, shouldTake, takeQty } from "./bot-math";

// 节奏可配(计划 §3.4、§1.4):生产默认 2500,本地压盘口设 500–800;非法值(NaN / 非正)回退默认,免得 setTimeout(NaN) 变成空转
const TICK_MS = (() => {
  const n = Number(process.env.BOT_TICK_MS ?? 2500);
  return Number.isFinite(n) && n > 0 ? n : 2500;
})();
const STATS_INTERVAL_MS = 60_000; // 每 60 s 一行 {"src":"bot","ev":"stats",...}(与 hub 的 ws stats 同形,便于日志检索)
const MAX_DRIFT = 0.02; // 挂单偏离 fair 超过 ±2% 即撤
const CASH_FLOOR = 100_000_000; // $1M(分)
const CASH_RESET = 5_000_000_000; // $50M(分; BigInt 列容纳)
const QTY_FLOOR = 10_000;
const QTY_TOPUP = 1_000_000;
// 机器人历史数据保留天数(机器人 24/7 刷单, 不清理 SQLite 会无限膨胀): 机器人之间的成交、机器人的终态订单与账本流水。
// 默认 7 天(2026-07 生产实测约 35MB/天), 可用 RETENTION_DAYS 环境变量调整(与 entrypoint 的开机清理共用)。
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 7);
const CLEANUP_INTERVAL_MS = 6 * 3_600_000; // 清理间隔

declare global {
  // dev HMR 下防止重复启动
  var __carbadiaBot: boolean | undefined;
}

export function startMarketBot() {
  if (globalThis.__carbadiaBot) return;
  globalThis.__carbadiaBot = true;
  console.log("[bot] 做市机器人启动");
  void loop();
}

async function loop() {
  let lastCleanupAt = 0; // 0 保证启动后首轮就清理一次
  let lastStatsAt = Date.now();
  let assets = 0;
  const tickMs: number[] = []; // 本统计窗口内每个 tick 的耗时
  for (;;) {
    const startedAt = Date.now();
    try {
      assets = await tick();
    } catch (e) {
      console.error("[bot] tick 失败", e);
    }
    tickMs.push(Date.now() - startedAt);
    if (Date.now() - lastStatsAt >= STATS_INTERVAL_MS) {
      logStats(tickMs, assets);
      tickMs.length = 0;
      lastStatsAt = Date.now();
    }
    if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      await cleanupHistory();
    }
    await new Promise((r) => setTimeout(r, TICK_MS + Math.random() * 800));
  }
}

/** 一行 JSON:tickMs = 窗口内 tick 平均耗时(计划 §3.4 的字段),另附 ticks / p99Ms 便于看尾延迟;ws-flood 验收「bot tick 增幅 <20%」看它 */
function logStats(tickMs: readonly number[], assets: number) {
  if (tickMs.length === 0) return;
  const sorted = [...tickMs].sort((a, b) => a - b);
  const avg = Math.round(sorted.reduce((sum, ms) => sum + ms, 0) / sorted.length);
  const p99 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)];
  console.log(JSON.stringify({ src: "bot", ev: "stats", tickMs: avg, assets, ticks: sorted.length, p99Ms: p99 }));
}

// 数据保留: 删掉超过保留期的机器人成交、订单与账本流水, 以及 90 天前的埋点事件。
// 真人参与的成交、订单与流水永久保留: 只删"买卖双方都是机器人"的成交、"属主是机器人"的孤儿终态订单和机器人自己的流水。
// 必须分小批执行: Railway 网络卷上一条几十万行的 DELETE 会持锁几十分钟,
// 期间用户下单全部超时;分批 + 批间让出事件循环, 在线清理不影响交易。
const CLEANUP_BATCH = 5_000;
const CLEANUP_MAX_BATCHES = 200; // 单轮上限 100 万行, 防止无限循环
export async function cleanupHistory() {
  try {
    const cutoffMs = Date.now() - RETENTION_DAYS * 86_400_000;
    let trades = 0;
    let orders = 0;
    let ledgers = 0;
    for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
      const n = await prisma.$executeRaw`
        DELETE FROM "Trade" WHERE rowid IN (
          SELECT t.rowid FROM "Trade" t
          JOIN "User" b ON b.id = t.buyerId
          JOIN "User" s ON s.id = t.sellerId
          WHERE t.createdAt < ${cutoffMs} AND b.isBot = 1 AND s.isBot = 1
          LIMIT ${CLEANUP_BATCH}
        )`;
      trades += n;
      if (n < CLEANUP_BATCH) break;
      await new Promise((r) => setTimeout(r, 300)); // 让出写锁, 用户下单可插队
    }
    for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
      // 只删不再被任何成交引用的订单, 避免外键约束失败。真人订单永久保留。
      const n = await prisma.$executeRaw`
        DELETE FROM "Order" WHERE rowid IN (
          SELECT o.rowid FROM "Order" o
          JOIN "User" u ON u.id = o.userId
          WHERE u.isBot = 1 AND o.status IN ('FILLED','CANCELLED') AND o.createdAt < ${cutoffMs}
            AND NOT EXISTS (SELECT 1 FROM "Trade" t WHERE t.buyOrderId = o.id)
            AND NOT EXISTS (SELECT 1 FROM "Trade" t WHERE t.sellOrderId = o.id)
          LIMIT ${CLEANUP_BATCH}
        )`;
      orders += n;
      if (n < CLEANUP_BATCH) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    // 审计流水: 真人流水永久保留; bot 流水随保留期清理(与成交/订单同策略)
    for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
      const n = await prisma.$executeRaw`
        DELETE FROM "LedgerEntry" WHERE rowid IN (
          SELECT l.rowid FROM "LedgerEntry" l
          JOIN "User" u ON u.id = l.userId
          WHERE u.isBot = 1 AND l.createdAt < ${cutoffMs}
          LIMIT ${CLEANUP_BATCH}
        )`;
      ledgers += n;
      if (n < CLEANUP_BATCH) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    // 埋点事件只留 90 天(体量小,单条 DELETE 即可)
    await prisma.$executeRaw`DELETE FROM "Event" WHERE createdAt < ${Date.now() - 90 * 86_400_000}`;
    console.log(`[bot] 历史清理完成: 成交 ${trades} 条, 订单 ${orders} 条, 流水 ${ledgers} 条`);
  } catch (e) {
    console.error("[bot] 历史清理失败", e);
  }
}

/**
 * 锁定值前缀,与 auth.ts 的 LOCKED_PASSWORD_PREFIX 同一个("!"):verifyPassword 对 `!` 开头的哈希恒为 false。
 * 不从 auth.ts 导入——它带 next/headers,而机器人跑在 instrumentation 那个 bundle 里。
 */
const LOCKED_PASSWORD_PREFIX = "!";

/**
 * 把仍可用的机器人密码哈希改成 `!<64 位随机十六进制>`(P1-25b):prisma/seed.ts 给 mm1/mm2/mm3@carbadia.bot 的是公开的演示密码,
 * 登录路由与 getCurrentUser 已经拒绝 isBot 用户,这里再让哈希本身失效(纵深防御)。已锁的跳过,所以只有首轮(启动后)真的写库。
 * 这会改写生产库里机器人用户的 passwordHash;机器人从不登录,旧镜像也只在登录时读这一列,回滚不需要恢复它。
 */
async function lockBotCredentials(bots: readonly Pick<User, "id" | "passwordHash">[]): Promise<number> {
  let locked = 0;
  for (const b of bots) {
    if (b.passwordHash.startsWith(LOCKED_PASSWORD_PREFIX)) continue;
    // where 带 isBot:true —— 万一这期间该账户被改成真人,不去碰它的密码
    const { count } = await prisma.user.updateMany({
      where: { id: b.id, isBot: true },
      data: { passwordHash: LOCKED_PASSWORD_PREFIX + randomBytes(32).toString("hex") },
    });
    locked += count;
  }
  if (locked > 0) console.log(`[bot] 已锁定 ${locked} 个机器人账户的密码(不可登录)`);
  return locked;
}

/** 一轮:对每个标的报价;返回标的数(stats 行的 assets 字段) */
async function tick(): Promise<number> {
  const bots = await prisma.user.findMany({ where: { isBot: true } });
  if (bots.length === 0) return 0;
  await lockBotCredentials(bots).catch((e) => console.error("[bot] 锁定机器人密码失败", e instanceof Error ? e.message : e));
  const assets = await prisma.asset.findMany();
  for (const asset of assets) {
    try {
      await quoteAsset(asset, bots);
    } catch (e) {
      console.error(`[bot] ${asset.symbol} 报价失败`, e);
    }
  }
  return assets.length;
}

type OpenQuote = Pick<Order, "userId" | "side" | "price">;

/** o 与 newer 里同一账户、方向相反的某张挂单价格交叉(买价 ≥ 卖价) */
function crossesNewerOwn(o: OpenQuote, newer: readonly OpenQuote[]): boolean {
  const price = o.price;
  if (price == null) return false;
  return newer.some(
    (n) => n.userId === o.userId && n.side !== o.side && n.price != null && (o.side === "BUY" ? price >= n.price : price <= n.price),
  );
}

async function quoteAsset(asset: Asset, bots: User[]) {
  const anchor = asset.anchorPrice ?? asset.lastPrice;
  if (anchor == null) return;
  const last = asset.lastPrice ?? anchor;
  const rng = Math.random;
  const fair = nextFair(last, anchor, rng);
  const botIds = bots.map((b) => b.id);
  const pick = () => bots[Math.floor(Math.random() * bots.length)];

  // 1) 自动补给(演示盘不破产; 凭空铸造须留 mint 审计流水, 与余额写入同事务)。
  //    放在报价之前: 新标的首 tick 还没有持仓, 先报价会让每张卖单都被 "Insufficient available holdings" 拒掉(P1-06 交接)。
  for (const b of bots) {
    const fresh = await prisma.user.findUnique({ where: { id: b.id }, select: { cashBalance: true } });
    if (fresh && Number(fresh.cashBalance) < CASH_FLOOR) {
      const delta = CASH_RESET - Number(fresh.cashBalance);
      await prisma.$transaction([
        prisma.user.update({ where: { id: b.id }, data: { cashBalance: BigInt(CASH_RESET) } }),
        prisma.ledgerEntry.create({ data: { userId: b.id, account: "CASH", delta: BigInt(delta), reason: "BOT_MINT_CASH" } }),
      ]);
    }
    const h = await prisma.holding.findUnique({ where: { userId_assetId: { userId: b.id, assetId: asset.id } } });
    if (!h || h.quantity - h.locked < QTY_FLOOR) {
      await prisma.$transaction([
        prisma.holding.upsert({
          where: { userId_assetId: { userId: b.id, assetId: asset.id } },
          create: { userId: b.id, assetId: asset.id, quantity: QTY_TOPUP, locked: 0 },
          update: { quantity: { increment: QTY_TOPUP } },
        }),
        prisma.ledgerEntry.create({ data: { userId: b.id, account: "HOLDING", assetId: asset.id, delta: BigInt(QTY_TOPUP), reason: "BOT_MINT_QTY" } }),
      ]);
    }
  }

  // 2) 撤掉偏离过远的机器人挂单,以及与同一机器人较新挂单价格交叉的旧挂单。
  //    后者只来自自成交防护(计划 §9.1 第 41 条)上线之前:旧撮合跳过本人对手单,新单以交叉价挂出(P1-18 实测买一 71.40 > 卖一 70.83)。
  //    上线后撮合自己会撤掉被穿过的本人挂单,不再产生这种状态;这里按同一规则(新单胜出、撤旧单)一次性清掉存量,
  //    否则它要等到被吃单碰到才消失。本机器人不记订单 id,每轮重读挂单,不依赖「自己的挂单不会被自己的新单撤掉」。
  const open = await prisma.order.findMany({
    where: { assetId: asset.id, userId: { in: botIds }, status: { in: ["OPEN", "PARTIAL"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], // 新 → 旧:旧单与已保留的新单比
  });
  const keep: typeof open = [];
  for (const o of open) {
    if (o.price != null && (Math.abs(o.price - fair) / fair > MAX_DRIFT || crossesNewerOwn(o, keep))) {
      await cancelOrder(o.userId, o.id).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
    } else {
      keep.push(o);
    }
  }

  // 3) 两侧补足约 5 档
  const bidCount = keep.filter((o) => o.side === "BUY").length;
  const askCount = keep.filter((o) => o.side === "SELL").length;
  const { bids, asks } = buildQuoteLevels(fair, rng);
  for (const lvl of bids.slice(0, Math.max(0, 5 - bidCount))) {
    await placeOrder({ userId: pick().id, assetId: asset.id, side: "BUY", type: "LIMIT", price: lvl.price, quantity: lvl.quantity }).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
  }
  for (const lvl of asks.slice(0, Math.max(0, 5 - askCount))) {
    await placeOrder({ userId: pick().id, assetId: asset.id, side: "SELL", type: "LIMIT", price: lvl.price, quantity: lvl.quantity }).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
  }

  // 4) 概率吃单(穿越价差的限价单, 打印成交)
  if (shouldTake(rng)) {
    const side = Math.random() < 0.5 ? "BUY" : "SELL";
    const price = Math.round(side === "BUY" ? fair * 1.015 : fair * 0.985);
    await placeOrder({ userId: pick().id, assetId: asset.id, side, type: "LIMIT", price, quantity: takeQty(rng) }).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
  }

}

// ---- 测试钩子 ----
export const _internal = {
  /** 对库里每个标的跑一轮报价(与 loop 里的一次 tick 相同,不睡眠、不清理) */
  tick,
};
