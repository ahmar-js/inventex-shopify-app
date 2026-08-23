-- CreateTable
CREATE TABLE "DeadLetterJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT NOT NULL,
    "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperationalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyApiMetric" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "totalDurationMs" BIGINT NOT NULL DEFAULT 0,
    "maxDurationMs" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyApiMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterJob_shop_jobId_key" ON "DeadLetterJob"("shop", "jobId");

-- CreateIndex
CREATE INDEX "DeadLetterJob_shop_failedAt_idx" ON "DeadLetterJob"("shop", "failedAt");

-- CreateIndex
CREATE INDEX "OperationalEvent_shop_createdAt_idx" ON "OperationalEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "OperationalEvent_level_createdAt_idx" ON "OperationalEvent"("level", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyApiMetric_shop_operation_outcome_bucketStart_key" ON "ShopifyApiMetric"("shop", "operation", "outcome", "bucketStart");

-- CreateIndex
CREATE INDEX "ShopifyApiMetric_shop_bucketStart_idx" ON "ShopifyApiMetric"("shop", "bucketStart");
