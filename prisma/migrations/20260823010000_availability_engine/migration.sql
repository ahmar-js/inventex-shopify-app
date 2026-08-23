ALTER TABLE "ShopSettings"
ADD COLUMN "sortContinueSellingAsOos" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ProductAvailabilityState" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "soldOutAt" TIMESTAMP(3),
    "variants" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductAvailabilityState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductAvailabilityState_shop_productId_key"
ON "ProductAvailabilityState"("shop", "productId");

CREATE INDEX "ProductAvailabilityState_shop_status_idx"
ON "ProductAvailabilityState"("shop", "status");
