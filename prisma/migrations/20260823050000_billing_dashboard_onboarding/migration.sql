-- Remove the legacy XOR automation strategy. Sorting, hiding, and alerts are
-- independent features in Inventex.
ALTER TABLE "ShopSettings"
  DROP COLUMN "enabled",
  DROP COLUMN "restoreBehavior",
  DROP COLUMN "strategy",
  ADD COLUMN "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "onboardingChoice" TEXT;

CREATE TABLE "BillingState" (
  "id" SERIAL NOT NULL,
  "shop" TEXT NOT NULL,
  "productCount" INTEGER NOT NULL DEFAULT 0,
  "requiredPlan" TEXT NOT NULL,
  "subscribedPlan" TEXT,
  "subscriptionId" TEXT,
  "subscriptionStatus" TEXT NOT NULL DEFAULT 'NONE',
  "subscriptionTest" BOOLEAN NOT NULL DEFAULT false,
  "trialEndsAt" TIMESTAMP(3),
  "developmentStore" BOOLEAN NOT NULL DEFAULT false,
  "shopPlan" TEXT,
  "accessAllowed" BOOLEAN NOT NULL DEFAULT false,
  "accessReason" TEXT NOT NULL DEFAULT 'PAYMENT_REQUIRED',
  "checkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BillingState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillingState_shop_key" ON "BillingState"("shop");
CREATE INDEX "BillingState_accessAllowed_checkedAt_idx"
  ON "BillingState"("accessAllowed", "checkedAt");
