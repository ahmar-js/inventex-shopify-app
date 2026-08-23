-- CreateTable
CREATE TABLE "ShopSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'HIDE',
    "restoreBehavior" TEXT NOT NULL DEFAULT 'ALWAYS',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InventoryState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousState" TEXT,
    "modifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored" BOOLEAN NOT NULL DEFAULT false,
    "restoredAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");

-- CreateIndex
CREATE INDEX "InventoryState_shop_restored_idx" ON "InventoryState"("shop", "restored");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryState_shop_productId_key" ON "InventoryState"("shop", "productId");
