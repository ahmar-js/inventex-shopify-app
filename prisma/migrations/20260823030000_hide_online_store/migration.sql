ALTER TABLE "ShopSettings"
ADD COLUMN "hideEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "hideDelayDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "redirectMode" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN "redirectPath" TEXT NOT NULL DEFAULT '/',
ADD COLUMN "onlineStorePublicationId" TEXT,
ADD COLUMN "hideJobId" TEXT;

ALTER TABLE "InventoryState"
ADD COLUMN "productTitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN "productHandle" TEXT,
ADD COLUMN "redirectId" TEXT;
