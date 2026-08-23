-- CreateTable
CREATE TABLE "CollectionAutoSorting" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "CollectionAutoSorting_shop_idx" ON "CollectionAutoSorting"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionAutoSorting_shop_collectionId_key" ON "CollectionAutoSorting"("shop", "collectionId");
