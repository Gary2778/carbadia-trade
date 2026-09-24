// 做市机器人: 每 ~2.5s 对每个标的随机游走报价、维护两侧 5 档、概率吃单
import type { Asset, User } from "@/generated/prisma";
import { prisma } from "../server/db";
import { cancelOrder, placeOrder } from "./matching";
import { buildQuoteLevels, nextFair, shouldTake, takeQty } from "./bot-math";

const TICK_MS = 2500;
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
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("[bot] tick 失败", e);
    }
    if (Date.now() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lastCleanupAt = Date.now();
      await cleanupHistory();
    }
    await new Promise((r) => setTimeout(r, TICK_MS + Math.random() * 800));
  }
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

async function tick() {
  const bots = await prisma.user.findMany({ where: { isBot: true } });
  if (bots.length === 0) return;
  const assets = await prisma.asset.findMany();
  for (const asset of assets) {
    try {
      await quoteAsset(asset, bots);
    } catch (e) {
      console.error(`[bot] ${asset.symbol} 报价失败`, e);
    }
  }
}

async function quoteAsset(asset: Asset, bots: User[]) {
  const anchor = asset.anchorPrice ?? asset.lastPrice;
  if (anchor == null) return;
  const last = asset.lastPrice ?? anchor;
  const rng = Math.random;
  const fair = nextFair(last, anchor, rng);
  const botIds = bots.map((b) => b.id);
  const pick = () => bots[Math.floor(Math.random() * bots.length)];

  // 1) 撤掉偏离过远的机器人挂单
  const open = await prisma.order.findMany({
    where: { assetId: asset.id, userId: { in: botIds }, status: { in: ["OPEN", "PARTIAL"] } },
  });
  const keep: typeof open = [];
  for (const o of open) {
    if (o.price != null && Math.abs(o.price - fair) / fair > MAX_DRIFT) {
      await cancelOrder(o.userId, o.id).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
    } else {
      keep.push(o);
    }
  }

  // 2) 两侧补足约 5 档
  const bidCount = keep.filter((o) => o.side === "BUY").length;
  const askCount = keep.filter((o) => o.side === "SELL").length;
  const { bids, asks } = buildQuoteLevels(fair, rng);
  for (const lvl of bids.slice(0, Math.max(0, 5 - bidCount))) {
    await placeOrder({ userId: pick().id, assetId: asset.id, side: "BUY", type: "LIMIT", price: lvl.price, quantity: lvl.quantity }).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
  }
  for (const lvl of asks.slice(0, Math.max(0, 5 - askCount))) {
    await placeOrder({ userId: pick().id, assetId: asset.id, side: "SELL", type: "LIMIT", price: lvl.price, quantity: lvl.quantity }).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
  }

  // 3) 概率吃单(穿越价差的限价单, 打印成交)
  if (shouldTake(rng)) {
    const side = Math.random() < 0.5 ? "BUY" : "SELL";
    const price = Math.round(side === "BUY" ? fair * 1.015 : fair * 0.985);
    await placeOrder({ userId: pick().id, assetId: asset.id, side, type: "LIMIT", price, quantity: takeQty(rng) }).catch((e) => console.error(`[bot] ${asset.symbol} 操作失败`, e instanceof Error ? e.message : e));
  }

  // 4) 自动补给(演示盘不破产; 凭空铸造须留 mint 审计流水, 与余额写入同事务)
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
}
