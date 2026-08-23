-- PostgreSQL production baseline. The previous migration history targeted SQLite
-- and cannot be applied to PostgreSQL.

CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopSettings" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'HIDE',
    "restoreBehavior" TEXT NOT NULL DEFAULT 'ALWAYS',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryState" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousState" TEXT,
    "modifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored" BOOLEAN NOT NULL DEFAULT false,
    "restoredAt" TIMESTAMP(3),
    "error" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    CONSTRAINT "InventoryState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollectionRule" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "collectionTitle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CollectionRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExcludedProduct" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExcludedProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlertSettings" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "lowStockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertFrequency" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "alertEmails" TEXT NOT NULL DEFAULT '',
    "dailyAlertHour" INTEGER NOT NULL DEFAULT 9,
    "dailyAlertAmPm" TEXT NOT NULL DEFAULT 'AM',
    "dailyAlertTimezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "alertOnLowStock" BOOLEAN NOT NULL DEFAULT true,
    "lowStockThreshold" INTEGER NOT NULL DEFAULT 5,
    "alertOnOutOfStock" BOOLEAN NOT NULL DEFAULT true,
    "stockCheckLevel" TEXT NOT NULL DEFAULT 'PRODUCT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AlertSettings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlertSent" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "alertType" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertSent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AlertQueue" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "variantId" TEXT NOT NULL DEFAULT '',
    "variantTitle" TEXT NOT NULL DEFAULT '',
    "alertType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "AlertQueue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CollectionAutoSorting" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CollectionAutoSorting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "uniqueKey" TEXT NOT NULL,
    "lastError" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
CREATE INDEX "Session_shop_idx" ON "Session"("shop");
CREATE INDEX "InventoryState_shop_restored_idx" ON "InventoryState"("shop", "restored");
CREATE UNIQUE INDEX "InventoryState_shop_productId_key" ON "InventoryState"("shop", "productId");
CREATE INDEX "CollectionRule_shop_idx" ON "CollectionRule"("shop");
CREATE UNIQUE INDEX "CollectionRule_shop_collectionId_key" ON "CollectionRule"("shop", "collectionId");
CREATE INDEX "ExcludedProduct_shop_idx" ON "ExcludedProduct"("shop");
CREATE UNIQUE INDEX "ExcludedProduct_shop_productId_key" ON "ExcludedProduct"("shop", "productId");
CREATE UNIQUE INDEX "AlertSettings_shop_key" ON "AlertSettings"("shop");
CREATE INDEX "AlertSent_shop_productId_alertType_sentAt_idx" ON "AlertSent"("shop", "productId", "alertType", "sentAt");
CREATE INDEX "AlertQueue_shop_processed_queuedAt_idx" ON "AlertQueue"("shop", "processed", "queuedAt");
CREATE INDEX "CollectionAutoSorting_shop_idx" ON "CollectionAutoSorting"("shop");
CREATE UNIQUE INDEX "CollectionAutoSorting_shop_collectionId_key" ON "CollectionAutoSorting"("shop", "collectionId");
CREATE INDEX "Job_status_runAfter_idx" ON "Job"("status", "runAfter");
CREATE INDEX "Job_shop_status_idx" ON "Job"("shop", "status");
CREATE UNIQUE INDEX "Job_shop_uniqueKey_key" ON "Job"("shop", "uniqueKey");
