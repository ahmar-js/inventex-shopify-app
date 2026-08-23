-- CreateTable
CREATE TABLE "CollectionRule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "collectionTitle" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "CollectionRule_shop_idx" ON "CollectionRule"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRule_shop_collectionId_key" ON "CollectionRule"("shop", "collectionId");
