-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AlertSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AlertSettings" ("alertEmails", "alertFrequency", "alertOnLowStock", "alertOnOutOfStock", "createdAt", "dailyAlertAmPm", "dailyAlertHour", "dailyAlertTimezone", "id", "lowStockEnabled", "lowStockThreshold", "shop", "updatedAt") SELECT "alertEmails", "alertFrequency", "alertOnLowStock", "alertOnOutOfStock", "createdAt", "dailyAlertAmPm", "dailyAlertHour", "dailyAlertTimezone", "id", "lowStockEnabled", "lowStockThreshold", "shop", "updatedAt" FROM "AlertSettings";
DROP TABLE "AlertSettings";
ALTER TABLE "new_AlertSettings" RENAME TO "AlertSettings";
CREATE UNIQUE INDEX "AlertSettings_shop_key" ON "AlertSettings"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
