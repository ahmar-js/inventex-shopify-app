-- CreateTable
CREATE TABLE "AlertSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "lowStockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertFrequency" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AlertSettings_shop_key" ON "AlertSettings"("shop");
