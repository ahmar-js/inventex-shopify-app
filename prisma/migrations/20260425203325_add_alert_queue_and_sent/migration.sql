-- CreateTable
CREATE TABLE "AlertSent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL DEFAULT '',
    "alertType" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AlertQueue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "variantId" TEXT NOT NULL DEFAULT '',
    "variantTitle" TEXT NOT NULL DEFAULT '',
    "alertType" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed" BOOLEAN NOT NULL DEFAULT false
);

-- CreateIndex
CREATE INDEX "AlertSent_shop_productId_alertType_sentAt_idx" ON "AlertSent"("shop", "productId", "alertType", "sentAt");

-- CreateIndex
CREATE INDEX "AlertQueue_shop_processed_queuedAt_idx" ON "AlertQueue"("shop", "processed", "queuedAt");
