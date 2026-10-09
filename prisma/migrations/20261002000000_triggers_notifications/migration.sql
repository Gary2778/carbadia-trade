-- 条件单与通知(计划 §6.3.2 C1): 只 CREATE TABLE / CREATE INDEX, 不动已有表的列, 旧镜像可直接回滚(多出的表它不读)。
-- 目录名手写固定; SQL 由 prisma migrate diff --from-migrations 生成后, 九条 CREATE 都手工加了 IF NOT EXISTS, 已不是原样输出:
-- Prisma 不把迁移包在事务里, 中途停下(卷写满、建 Order 索引时容器被杀、写锁)时前几条已生效, 而 docker-entrypoint.sh 的 P3009 自愈
-- 会删掉未完成记录并重放整份 —— 没有 IF NOT EXISTS 重放就卡在「table "Trigger" already exists」, 每次启动都失败。
-- sqlite_master 不记 IF NOT EXISTS, 所以 migrate diff 仍应无差异; 已按旧文本应用过的库不受影响(已完成的迁移不重跑)。
-- 迁移测试(src/lib/server/migrations.test.ts)钉住每条 CREATE 都带 IF NOT EXISTS。

-- CreateTable
CREATE TABLE IF NOT EXISTS "Trigger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "triggerPrice" INTEGER NOT NULL,
    "side" TEXT,
    "orderType" TEXT,
    "limitPrice" INTEGER,
    "quantity" INTEGER,
    "ocoGroupId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "orderId" TEXT,
    "firedPrice" INTEGER,
    "clientKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "firedAt" DATETIME,
    CONSTRAINT "Trigger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trigger_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trigger_status_assetId_idx" ON "Trigger"("status", "assetId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Trigger_userId_status_createdAt_idx" ON "Trigger"("userId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Trigger_userId_clientKey_key" ON "Trigger"("userId", "clientKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OtcListing_sellerId_idx" ON "OtcListing"("sellerId");

