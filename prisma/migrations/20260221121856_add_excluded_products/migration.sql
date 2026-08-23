-- CreateTable
CREATE TABLE "ExcludedProduct" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ExcludedProduct_shop_idx" ON "ExcludedProduct"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ExcludedProduct_shop_productId_key" ON "ExcludedProduct"("shop", "productId");
