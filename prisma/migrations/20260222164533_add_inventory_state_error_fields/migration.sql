-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InventoryState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previousState" TEXT,
    "modifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored" BOOLEAN NOT NULL DEFAULT false,
    "restoredAt" DATETIME,
    "error" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT
);
INSERT INTO "new_InventoryState" ("action", "id", "modifiedAt", "previousState", "productId", "restored", "restoredAt", "shop") SELECT "action", "id", "modifiedAt", "previousState", "productId", "restored", "restoredAt", "shop" FROM "InventoryState";
DROP TABLE "InventoryState";
ALTER TABLE "new_InventoryState" RENAME TO "InventoryState";
CREATE INDEX "InventoryState_shop_restored_idx" ON "InventoryState"("shop", "restored");
CREATE UNIQUE INDEX "InventoryState_shop_productId_key" ON "InventoryState"("shop", "productId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
