import { JobStatus, Prisma, type Job } from "@prisma/client";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  evaluateProductAvailability,
  ProductNotFoundError,
  resolveProductGidFromInventoryItem,
} from "./availability.server";
import { maybeFireAlertsForAvailability } from "./alerts.server";
import { logger } from "./logger.server";
import { enqueueProductEvaluation, JOB_TYPES } from "./webhooks.server";

const MAX_BATCH_SIZE = 25;
const STALE_LOCK_MINUTES = 15;
const MAX_THROTTLE_ATTEMPTS = 8;
const MAX_GENERAL_ATTEMPTS = 3;

interface WebhookJobPayload {
  webhookId?: string;
  topic?: string;
  data?: Record<string, unknown>;
}

export async function runJobBatch(limit = 10) {
  const jobs = await claimJobs(Math.max(1, Math.min(limit, MAX_BATCH_SIZE)));
  let processed = 0;
  let failed = 0;

  for (const job of jobs) {
    try {
      await processJob(job);
      await db.job.updateMany({
        where: { id: job.id, status: JobStatus.PROCESSING },
        data: {
          status: JobStatus.COMPLETED,
          lockedAt: null,
          lastError: null,
        },
      });
      processed++;
      logger.info("Job completed", jobContext(job));
    } catch (error) {
      failed++;
      await rescheduleOrFail(job, error);
    }
  }

  return { claimed: jobs.length, processed, failed };
}

async function claimJobs(limit: number): Promise<Job[]> {
  return db.$transaction(async (transaction) => {
    const candidates = await transaction.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT "id"
        FROM "Job"
        WHERE (
          "status" = 'PENDING'
          OR (
            "status" = 'PROCESSING'
            AND "lockedAt" < NOW() - (${STALE_LOCK_MINUTES} * INTERVAL '1 minute')
          )
        )
        AND "runAfter" <= NOW()
        ORDER BY "runAfter" ASC, "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `,
    );

    if (candidates.length === 0) return [];
    const ids = candidates.map(({ id }) => id);

    await transaction.job.updateMany({
      where: { id: { in: ids } },
      data: {
        status: JobStatus.PROCESSING,
        lockedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    return transaction.job.findMany({
      where: { id: { in: ids } },
      orderBy: [{ runAfter: "asc" }, { createdAt: "asc" }],
    });
  });
}

async function processJob(job: Job) {
  const payload = asWebhookPayload(job.payload);
  const data = payload.data ?? {};

  logger.info("Job started", {
    ...jobContext(job),
    webhookId: payload.webhookId,
    topic: payload.topic,
    ...resourceContext(job.type, data),
  });

  if (job.type === JOB_TYPES.INVENTORY_UPDATE) {
    const { admin } = await unauthenticated.admin(job.shop);
    const inventoryItemId = data.inventory_item_id;
    if (
      typeof inventoryItemId !== "number" &&
      typeof inventoryItemId !== "string"
    ) {
      throw new Error("Inventory webhook payload is missing inventory_item_id");
    }
    const productId = await resolveProductGidFromInventoryItem(
      admin,
      inventoryItemId,
    );
    if (!productId) {
      logger.warn("Inventory item no longer resolves to a product", {
        ...jobContext(job),
        inventoryItemId: String(inventoryItemId),
      });
      return;
    }
    const evaluation = await enqueueProductEvaluation({
      shop: job.shop,
      productId,
      sourceJobId: job.id,
      reason: "inventory",
    });
    logger.info("Product evaluation enqueued", {
      shop: job.shop,
      jobId: evaluation.job.id,
      jobType: JOB_TYPES.EVALUATE_PRODUCT,
      productId,
    });
    return;
  }

  if (job.type === JOB_TYPES.PRODUCT_UPDATE) {
    const productId = productGidFromPayload(data);
    if (!productId) throw new Error("Product webhook payload is missing id");
    await enqueueProductEvaluation({
      shop: job.shop,
      productId,
      sourceJobId: job.id,
      reason: "productUpdate",
    });
    return;
  }

  if (job.type === JOB_TYPES.PRODUCT_DELETE) {
    const productId = productGidFromPayload(data);
    if (productId) {
      await db.productAvailabilityState.deleteMany({
        where: { shop: job.shop, productId },
      });
    }
    return;
  }

  if (job.type === JOB_TYPES.EVALUATE_PRODUCT) {
    const productId =
      typeof data.productId === "string" ? data.productId : null;
    if (!productId) throw new Error("Evaluation job is missing productId");
    const { admin } = await unauthenticated.admin(job.shop);

    try {
      const availability = await evaluateProductAvailability(
        admin,
        job.shop,
        productId,
      );
      await db.productAvailabilityState.upsert({
        where: { shop_productId: { shop: job.shop, productId } },
        update: {
          status: availability.status,
          ignored: availability.ignored,
          soldOutAt: availability.soldOutAt,
          variants: toJson(availability.variants),
          evaluatedAt: availability.evaluatedAt,
        },
        create: {
          shop: job.shop,
          productId,
          status: availability.status,
          ignored: availability.ignored,
          soldOutAt: availability.soldOutAt,
          variants: toJson(availability.variants),
          evaluatedAt: availability.evaluatedAt,
        },
      });
      await maybeFireAlertsForAvailability(job.shop, availability);
      logger.info("Product availability evaluated", {
        ...jobContext(job),
        productId,
      });
    } catch (error) {
      if (error instanceof ProductNotFoundError) {
        await db.productAvailabilityState.deleteMany({
          where: { shop: job.shop, productId },
        });
        return;
      }
      throw error;
    }
    return;
  }

  // Product, collection, uninstall, and customer-compliance events are now
  // durable. Their domain handlers are added in the feature phases that own
  // those behaviors; Phase 0 deliberately performs no inline Shopify writes.
  logger.info("Webhook job accepted for downstream domain handling", {
    ...jobContext(job),
    webhookId: payload.webhookId,
    topic: payload.topic,
    ...resourceContext(job.type, data),
  });
}

async function rescheduleOrFail(job: Job, error: unknown) {
  const throttled = isShopifyThrottleError(error);
  const maxAttempts = throttled ? MAX_THROTTLE_ATTEMPTS : MAX_GENERAL_ATTEMPTS;
  const shouldRetry = job.attempts < maxAttempts;
  const delayMs = retryDelayMs(job.attempts, throttled);
  const lastError = errorMessage(error).slice(0, 4_000);

  await db.job.updateMany({
    where: { id: job.id, status: JobStatus.PROCESSING },
    data: shouldRetry
      ? {
          status: JobStatus.PENDING,
          runAfter: new Date(Date.now() + delayMs),
          lockedAt: null,
          lastError,
        }
      : {
          status: JobStatus.FAILED,
          lockedAt: null,
          lastError,
        },
  });

  logger[shouldRetry ? "warn" : "error"](
    shouldRetry ? "Job scheduled for retry" : "Job failed permanently",
    {
      ...jobContext(job),
      delayMs: shouldRetry ? delayMs : undefined,
      error,
    },
  );
}

function retryDelayMs(attempts: number, throttled: boolean) {
  const baseMs = throttled ? 30_000 : 10_000;
  const capped = Math.min(baseMs * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
  return capped + Math.floor(Math.random() * 2_000);
}

export function isShopifyThrottleError(error: unknown): boolean {
  const candidate = error as {
    status?: number;
    statusCode?: number;
    code?: string;
    message?: string;
    body?: unknown;
    response?: { status?: number; code?: number };
  };

  if (!candidate || typeof candidate !== "object") return false;
  if (
    candidate.status === 429 ||
    candidate.statusCode === 429 ||
    candidate.response?.status === 429 ||
    candidate.response?.code === 429 ||
    candidate.code === "THROTTLED"
  ) {
    return true;
  }

  if (/\b(429|THROTTLED)\b/i.test(candidate.message ?? "")) return true;
  return containsThrottleCode(candidate.body);
}

function containsThrottleCode(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsThrottleCode);

  const record = value as Record<string, unknown>;
  if (record.code === "THROTTLED") return true;
  return Object.values(record).some(containsThrottleCode);
}

function asWebhookPayload(payload: Prisma.JsonValue): WebhookJobPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as WebhookJobPayload;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function jobContext(job: Job) {
  return {
    shop: job.shop,
    jobId: job.id,
    jobType: job.type,
    attempts: job.attempts,
  };
}

function resourceContext(jobType: string, payload: Record<string, unknown>) {
  if (jobType.startsWith("COLLECTION_")) {
    const collectionId = payload.admin_graphql_api_id ?? payload.id;
    return collectionId ? { collectionId: String(collectionId) } : {};
  }
  if (jobType.startsWith("PRODUCT_")) {
    const productId = payload.admin_graphql_api_id ?? payload.id;
    return productId ? { productId: String(productId) } : {};
  }
  if (jobType === JOB_TYPES.EVALUATE_PRODUCT && payload.productId) {
    return { productId: String(payload.productId) };
  }
  if (payload.inventory_item_id) {
    return { inventoryItemId: String(payload.inventory_item_id) };
  }
  return {};
}

function productGidFromPayload(payload: Record<string, unknown>) {
  const id = payload.admin_graphql_api_id ?? payload.productId ?? payload.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const value = String(id);
  return value.startsWith("gid://") ? value : `gid://shopify/Product/${value}`;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
