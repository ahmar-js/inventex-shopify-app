import { Prisma } from "@prisma/client";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "./logger.server";

export const JOB_TYPES = {
  INVENTORY_UPDATE: "INVENTORY_UPDATE",
  PRODUCT_UPDATE: "PRODUCT_UPDATE",
  PRODUCT_DELETE: "PRODUCT_DELETE",
  EVALUATE_PRODUCT: "EVALUATE_PRODUCT",
  COLLECTION_CREATE: "COLLECTION_CREATE",
  COLLECTION_UPDATE: "COLLECTION_UPDATE",
  COLLECTION_DELETE: "COLLECTION_DELETE",
  APP_UNINSTALLED: "APP_UNINSTALLED",
  CUSTOMERS_DATA_REQUEST: "CUSTOMERS_DATA_REQUEST",
  CUSTOMERS_REDACT: "CUSTOMERS_REDACT",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

interface EnqueueJobInput {
  shop: string;
  type: JobType;
  payload: unknown;
  uniqueKey: string;
  runAfter?: Date;
}

interface EnqueueWebhookInput {
  shop: string;
  topic: string;
  webhookId: string;
  jobType: JobType;
  payload: Record<string, unknown>;
}

export async function enqueueWebhook(input: EnqueueWebhookInput) {
  const uniqueKey = `webhook:${input.webhookId}`;
  return enqueueJob({
    shop: input.shop,
    type: input.jobType,
    uniqueKey,
    payload: {
      webhookId: input.webhookId,
      topic: input.topic,
      data: input.payload,
    },
  });
}

export async function enqueueProductEvaluation(input: {
  shop: string;
  productId: string;
  sourceJobId: string;
  reason: "inventory" | "productUpdate";
}) {
  return enqueueJob({
    shop: input.shop,
    type: JOB_TYPES.EVALUATE_PRODUCT,
    uniqueKey: `evaluate-product:${input.productId}:${input.sourceJobId}`,
    payload: {
      data: {
        productId: input.productId,
        reason: input.reason,
        sourceJobId: input.sourceJobId,
      },
    },
  });
}

export async function enqueueJob(input: EnqueueJobInput) {
  const payload = JSON.parse(
    JSON.stringify(input.payload),
  ) as Prisma.InputJsonValue;

  try {
    const job = await db.job.create({
      data: {
        shop: input.shop,
        type: input.type,
        payload,
        uniqueKey: input.uniqueKey,
        runAfter: input.runAfter,
      },
    });
    return { job, duplicate: false };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const job = await db.job.findUniqueOrThrow({
        where: {
          shop_uniqueKey: {
            shop: input.shop,
            uniqueKey: input.uniqueKey,
          },
        },
      });
      return { job, duplicate: true };
    }
    throw error;
  }
}

export async function authenticateAndEnqueueWebhook(
  request: Request,
  jobType: JobType,
) {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);
  const result = await enqueueWebhook({
    shop,
    topic: String(topic),
    webhookId,
    jobType,
    payload,
  });

  logger.info(
    result.duplicate ? "Duplicate webhook acknowledged" : "Webhook enqueued",
    {
      shop,
      topic: String(topic),
      webhookId,
      jobId: result.job.id,
      jobType,
      ...resourceContext(jobType, payload),
    },
  );

  return { ...result, shop, topic: String(topic), webhookId, payload };
}

function resourceContext(jobType: JobType, payload: Record<string, unknown>) {
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
