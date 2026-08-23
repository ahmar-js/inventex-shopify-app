ALTER TABLE "ShopSettings"
ADD COLUMN "variantHideEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "variantHideEligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "variantHideCatalogCount" INTEGER,
ADD COLUMN "variantHideJobId" TEXT;

ALTER TABLE "AlertSettings"
ADD COLUMN "weeklyDigestDay" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "lastDigestSentAt" TIMESTAMP(3);

CREATE TABLE "VariantInventoryState" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL DEFAULT '',
    "variantTitle" TEXT NOT NULL DEFAULT '',
    "hiddenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "restored" BOOLEAN NOT NULL DEFAULT false,
    "restoredAt" TIMESTAMP(3),
    "error" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,

    CONSTRAINT "VariantInventoryState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VariantInventoryState_shop_variantId_key"
ON "VariantInventoryState"("shop", "variantId");

CREATE INDEX "VariantInventoryState_shop_productId_idx"
ON "VariantInventoryState"("shop", "productId");

CREATE INDEX "VariantInventoryState_shop_restored_idx"
ON "VariantInventoryState"("shop", "restored");
