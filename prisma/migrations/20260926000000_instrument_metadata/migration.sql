-- 终端元数据(计划 §3.4): 只 ADD COLUMN / CREATE INDEX, 不重建表, 旧镜像可直接回滚。
-- 目录名手写固定(§9.1 第 40 条), 用 prisma migrate diff --from-migrations 核对与 schema.prisma 无差异。
ALTER TABLE "Asset" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Asset" ADD COLUMN "methodology" TEXT;
ALTER TABLE "Asset" ADD COLUMN "verificationStatus" TEXT;
ALTER TABLE "Asset" ADD COLUMN "tickSize" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Asset" ADD COLUMN "pricePrecision" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "Asset" ADD COLUMN "qtyStep" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Asset" ADD COLUMN "minQty" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Asset" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");
ALTER TABLE "Order" ADD COLUMN "clientOrderId" TEXT;
ALTER TABLE "Order" ADD COLUMN "updatedAt" DATETIME;
CREATE UNIQUE INDEX "Order_userId_clientOrderId_key" ON "Order"("userId", "clientOrderId");
