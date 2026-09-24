-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "cashBalance" BIGINT NOT NULL DEFAULT 0,
    "lockedCash" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "standard" TEXT NOT NULL,
    "projectType" TEXT NOT NULL,
    "vintage" INTEGER NOT NULL,
    "country" TEXT NOT NULL,
    "registry" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "lastPrice" INTEGER,
    "anchorPrice" INTEGER,
    "isScenario" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Holding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "locked" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Holding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Holding_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "price" INTEGER,
    "quantity" INTEGER NOT NULL,
    "filledQuantity" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "avgFillPrice" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "buyOrderId" TEXT NOT NULL,
    "sellOrderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trade_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_buyOrderId_fkey" FOREIGN KEY ("buyOrderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_sellOrderId_fkey" FOREIGN KEY ("sellOrderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Trade_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OtcListing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "pricePerUnit" INTEGER NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OtcListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OtcListing_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OtcDeal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OtcDeal_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "OtcListing" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OtcDeal_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT,
    "visitorId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "message" TEXT NOT NULL,
    "contact" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "assetId" TEXT,
    "delta" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ShadowSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetSymbol" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "shadowClose" INTEGER,
    "shadowVolume" INTEGER NOT NULL DEFAULT 0,
    "realClose" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "rowsUpserted" INTEGER NOT NULL DEFAULT 0,
    "dataAsOf" TEXT,
    "error" TEXT
);

-- CreateTable
CREATE TABLE "Retirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SIMULATED',
    "quantity" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "registry" TEXT NOT NULL,
    "standard" TEXT NOT NULL,
    "vintage" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "beneficiary" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "publicMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_symbol_key" ON "Asset"("symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Holding_userId_assetId_key" ON "Holding"("userId", "assetId");

-- CreateIndex
CREATE INDEX "Order_assetId_side_status_idx" ON "Order"("assetId", "side", "status");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Trade_assetId_createdAt_idx" ON "Trade"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_buyerId_createdAt_idx" ON "Trade"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_sellerId_createdAt_idx" ON "Trade"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_buyOrderId_idx" ON "Trade"("buyOrderId");

-- CreateIndex
CREATE INDEX "Trade_sellOrderId_idx" ON "Trade"("sellOrderId");

-- CreateIndex
CREATE INDEX "OtcListing_assetId_status_idx" ON "OtcListing"("assetId", "status");

-- CreateIndex
CREATE INDEX "Event_name_createdAt_idx" ON "Event"("name", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_userId_account_createdAt_idx" ON "LedgerEntry"("userId", "account", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_refType_refId_idx" ON "LedgerEntry"("refType", "refId");

-- CreateIndex
CREATE INDEX "LedgerEntry_createdAt_idx" ON "LedgerEntry"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShadowSnapshot_assetSymbol_day_key" ON "ShadowSnapshot"("assetSymbol", "day");

-- CreateIndex
CREATE INDEX "SyncRun_source_startedAt_idx" ON "SyncRun"("source", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Retirement_reference_key" ON "Retirement"("reference");

-- CreateIndex
CREATE INDEX "Retirement_userId_createdAt_idx" ON "Retirement"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Retirement_userId_idempotencyKey_key" ON "Retirement"("userId", "idempotencyKey");
