-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AlertSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "lowStockEnabled" BOOLEAN NOT NULL DEFAULT false,
    "alertFrequency" TEXT NOT NULL DEFAULT 'IMMEDIATE',
    "alertEmails" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AlertSettings" ("alertFrequency", "createdAt", "id", "lowStockEnabled", "shop", "updatedAt") SELECT "alertFrequency", "createdAt", "id", "lowStockEnabled", "shop", "updatedAt" FROM "AlertSettings";
DROP TABLE "AlertSettings";
ALTER TABLE "new_AlertSettings" RENAME TO "AlertSettings";
CREATE UNIQUE INDEX "AlertSettings_shop_key" ON "AlertSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
