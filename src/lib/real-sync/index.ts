// 影子价格常驻同步循环(instrumentation 挂载, SYNC_DISABLED=1 可关)。
// 模式复制自 bot 的 lastCleanupAt: 不用 24h 长定时器(容器随时重启, 活不过部署),
// 而是短周期醒来查"最近一次 OK SyncRun 是否已超 24h"(判据落库, 重启后仍有效)。
// 主站 carbadia.io 的同名循环还跑 OffsetsDB 与 CCER 两个源;那两个源属于 Atlas,不在本站。
import { prisma } from "../server/db";
import { syncShadow } from "./shadow";

const CHECK_INTERVAL_MS = 30 * 60_000; // 30 分钟醒一次
const SYNC_EVERY_MS = 24 * 3_600_000; // 日更一次
// 超过该阈值仍 RUNNING 的 SyncRun 判定为进程死亡遗留的孤儿行
const ORPHAN_AFTER_MS = 3_600_000;

declare global {
  // dev HMR 下防止重复启动
  var __carbadiaRealSync: boolean | undefined;
}

export function startRealSync() {
  if (globalThis.__carbadiaRealSync) return;
  globalThis.__carbadiaRealSync = true;
  console.log("[sync] 影子价格同步循环启动");
  void loop();
}

const SOURCES = [
  { source: "shadowprice", run: syncShadow }, // 影子价格快照 + 内部真实收盘对照(shadow.ts)
] as const;

async function loop() {
  for (;;) {
    await reapOrphanRuns().catch((e) => console.error("[sync] 孤儿 SyncRun 清理失败", e));
    for (const { source, run } of SOURCES) {
      try {
        if (await isDue(source)) await run();
      } catch (e) {
        console.error(`[sync] ${source} 本轮同步失败, 下轮再试`, e);
      }
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

async function reapOrphanRuns() {
  const { count } = await prisma.syncRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(Date.now() - ORPHAN_AFTER_MS) } },
    data: { status: "FAILED", finishedAt: new Date(), error: "orphaned" },
  });
  if (count > 0) console.warn(`[sync] 清理 ${count} 条进程死亡遗留的 RUNNING SyncRun → FAILED(orphaned)`);
}

async function isDue(source: string): Promise<boolean> {
  const lastOk = await prisma.syncRun.findFirst({
    where: { source, status: "OK" },
    orderBy: { startedAt: "desc" },
  });
  return !lastOk || Date.now() - lastOk.startedAt.getTime() >= SYNC_EVERY_MS;
}
