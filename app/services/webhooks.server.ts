import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { logger } from "./logger.server";
import { collectionSortDelayMs } from "./collection-sort";
import { hideRunAfter } from "./hide";

export const JOB_TYPES = {
  INVENTORY_UPDATE: "INVENTORY_UPDATE",
  PRODUCT_CREATE: "PRODUCT_CREATE",
  PRODUCT_UPDATE: "PRODUCT_UPDATE",
  PRODUCT_DELETE: "PRODUCT_DELETE",
  EVALUATE_PRODUCT: "EVALUATE_PRODUCT",
  COLLECTION_CREATE: "COLLECTION_CREATE",
  COLLECTION_UPDATE: "COLLECTION_UPDATE",
  COLLECTION_DELETE: "COLLECTION_DELETE",
  ENABLE_COLLECTION_SORT: "ENABLE_COLLECTION_SORT",
  DISABLE_COLLECTION_SORT: "DISABLE_COLLECTION_SORT",
  UPDATE_COLLECTION_BASE_ORDER: "UPDATE_COLLECTION_BASE_ORDER",
  SORT_COLLECTION: "SORT_COLLECTION",
  HIDE_PRODUCT: "HIDE_PRODUCT",
  UNHIDE_PRODUCT: "UNHIDE_PRODUCT",
  CATALOG_HIDE_SCAN: "CATALOG_HIDE_SCAN",
  REPUBLISH_HIDDEN_PRODUCTS: "REPUBLISH_HIDDEN_PRODUCTS",
  HIDE_VARIANT: "HIDE_VARIANT",
  UNHIDE_VARIANT: "UNHIDE_VARIANT",
  VARIANT_HIDE_SCAN: "VARIANT_HIDE_SCAN",
  REPUBLISH_HIDDEN_VARIANTS: "REPUBLISH_HIDDEN_VARIANTS",
  APP_UNINSTALLED: "APP_UNINSTALLED",
  APP_SUBSCRIPTIONS_UPDATE: "APP_SUBSCRIPTIONS_UPDATE",
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
  preserveEarlierRunAfter?: boolean;
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
  reason:
    | "inventory"
    | "productUpdate"
    | "collectionBootstrap"
    | "hideScan"
    | "variantHideScan"
    | "ignoreChanged";
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

export async function enqueueHideProduct(input: {
  shop: string;
  productId: string;
  soldOutAt: Date;
  delayDays: number;
  sourceJobId: string;
}) {
  return enqueueReplaceableJob({
    shop: input.shop,
    type: JOB_TYPES.HIDE_PRODUCT,
    uniqueKey: `hide:${input.shop}:${input.productId}`,
    runAfter: hideRunAfter(input.soldOutAt, input.delayDays),
    payload: {
      data: {
        productId: input.productId,
        soldOutAt: input.soldOutAt.toISOString(),
        delayDays: input.delayDays,
        sourceJobId: input.sourceJobId,
      },
    },
  });
}

export async function enqueueUnhideProduct(input: {
  shop: string;
  productId: string;
  sourceJobId: string;
  reason: "available" | "ignored" | "hideDisabled";
}) {
  return enqueueReplaceableJob({
    shop: input.shop,
    type: JOB_TYPES.UNHIDE_PRODUCT,
    uniqueKey: `unhide:${input.shop}:${input.productId}`,
    payload: {
      data: {
        productId: input.productId,
        sourceJobId: input.sourceJobId,
        reason: input.reason,
      },
    },
  });
}

export async function enqueueHideCatalogScan(shop: string) {
  return enqueueReplaceableJob({
    shop,
    type: JOB_TYPES.CATALOG_HIDE_SCAN,
    uniqueKey: `hide-scan:${shop}`,
    payload: { data: { reason: "hideEnabled" } },
  });
}

export async function enqueueRepublishHiddenProducts(shop: string) {
  return enqueueReplaceableJob({
    shop,
    type: JOB_TYPES.REPUBLISH_HIDDEN_PRODUCTS,
    uniqueKey: `republish-hidden:${shop}`,
    payload: { data: { reason: "hideDisabled" } },
  });
}

export async function cancelPendingProductHide(
  shop: string,
  productId: string,
) {
  return db.job.updateMany({
    where: {
      shop,
      type: JOB_TYPES.HIDE_PRODUCT,
      uniqueKey: `hide:${shop}:${productId}`,
      status: "PENDING",
    },
    data: { status: "COMPLETED", lockedAt: null, lastError: null },
  });
}

export async function cancelAllPendingProductHides(shop: string) {
  return db.job.updateMany({
    where: { shop, type: JOB_TYPES.HIDE_PRODUCT, status: "PENDING" },
    data: { status: "COMPLETED", lockedAt: null, lastError: null },
  });
}

export async function enqueueHideVariant(input: {
  shop: string;
  productId: string;
  variantId: string;
  sourceJobId: string;
}) {
  return enqueueReplaceableJob({
    shop: input.shop,
    type: JOB_TYPES.HIDE_VARIANT,
    uniqueKey: `hide-variant:${input.shop}:${input.variantId}`,
    payload: {
      data: {
        productId: input.productId,
        variantId: input.variantId,
        sourceJobId: input.sourceJobId,
      },
    },
  });
}

export async function enqueueUnhideVariant(input: {
  shop: string;
  productId: string;
  variantId: string;
  sourceJobId: string;
  reason: "available" | "ignored" | "disabled" | "ineligible" | "deleted";
}) {
  return enqueueReplaceableJob({
    shop: input.shop,
    type: JOB_TYPES.UNHIDE_VARIANT,
    uniqueKey: `unhide-variant:${input.shop}:${input.variantId}`,
    payload: {
      data: {
        productId: input.productId,
        variantId: input.variantId,
        sourceJobId: input.sourceJobId,
        reason: input.reason,
      },
    },
  });
}

export async function cancelPendingVariantHide(shop: string, variantId: string) {
  return db.job.updateMany({
    where: {
      shop,
      type: JOB_TYPES.HIDE_VARIANT,
      uniqueKey: `hide-variant:${shop}:${variantId}`,
      status: "PENDING",
    },
    data: { status: "COMPLETED", lockedAt: null, lastError: null },
  });
}

export async function cancelAllPendingVariantHides(shop: string) {
  return db.job.updateMany({
    where: { shop, type: JOB_TYPES.HIDE_VARIANT, status: "PENDING" },
    data: { status: "COMPLETED", lockedAt: null, lastError: null },
  });
}

export async function enqueueVariantHideScan(shop: string) {
  return enqueueReplaceableJob({
    shop,
    type: JOB_TYPES.VARIANT_HIDE_SCAN,
    uniqueKey: `variant-hide-scan:${shop}`,
    payload: { data: { reason: "variantHideEnabled" } },
  });
}

export async function enqueueRepublishHiddenVariants(shop: string) {
  return enqueueReplaceableJob({
    shop,
    type: JOB_TYPES.REPUBLISH_HIDDEN_VARIANTS,
    uniqueKey: `republish-hidden-variants:${shop}`,
    payload: { data: { reason: "variantHideDisabled" } },
  });
}

export async function enqueueCollectionSort(input: {
  shop: string;
  collectionId: string;
  productCount: number;
  reason: string;
  immediate?: boolean;
}) {
  return enqueueReplaceableJob({
    shop: input.shop,
    type: JOB_TYPES.SORT_COLLECTION,
    uniqueKey: `sort:${input.shop}:${input.collectionId}`,
    runAfter: input.immediate
      ? new Date()
      : new Date(Date.now() + collectionSortDelayMs(input.productCount)),
    payload: {
      data: {
        collectionId: input.collectionId,
        productCount: input.productCount,
        reason: input.reason,
      },
    },
    preserveEarlierRunAfter: true,
  });
}

export async function enqueueCollectionSortCommand(input: {
  shop: string;
  collectionId: string;
  command: "enable" | "disable" | "updateBaseOrder";
  baseSortOrder?: string;
}) {
  const type =
    input.command === "enable"
      ? JOB_TYPES.ENABLE_COLLECTION_SORT
      : input.command === "disable"
        ? JOB_TYPES.DISABLE_COLLECTION_SORT
        : JOB_TYPES.UPDATE_COLLECTION_BASE_ORDER;
  return enqueueReplaceableJob({
    shop: input.shop,
    type,
    uniqueKey: `${input.command}:${input.shop}:${input.collectionId}`,
    payload: {
      data: {
        collectionId: input.collectionId,
        baseSortOrder: input.baseSortOrder,
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
    if (isUniqueConstraintError(error)) {
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

async function enqueueReplaceableJob(input: EnqueueJobInput) {
  const payload = JSON.parse(
    JSON.stringify(input.payload),
  ) as Prisma.InputJsonValue;
  const existing = input.preserveEarlierRunAfter
    ? await db.job.findUnique({
        where: {
          shop_uniqueKey: { shop: input.shop, uniqueKey: input.uniqueKey },
        },
        select: { status: true, runAfter: true },
      })
    : null;
  const requestedRunAfter = input.runAfter ?? new Date();
  const runAfter =
    existing?.status === "PENDING" && existing.runAfter < requestedRunAfter
      ? existing.runAfter
      : requestedRunAfter;
  const job = await db.job.upsert({
    where: {
      shop_uniqueKey: { shop: input.shop, uniqueKey: input.uniqueKey },
    },
    update: {
      type: input.type,
      payload,
      status: "PENDING",
      runAfter,
      attempts: 0,
      lastError: null,
      lockedAt: null,
    },
    create: {
      shop: input.shop,
      type: input.type,
      payload,
      uniqueKey: input.uniqueKey,
      runAfter,
    },
  });
  return { job, duplicate: false };
}

function isUniqueConstraintError(error: unknown): error is { code: "P2002" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
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

  if (
    (jobType === JOB_TYPES.SORT_COLLECTION ||
      jobType === JOB_TYPES.ENABLE_COLLECTION_SORT ||
      jobType === JOB_TYPES.DISABLE_COLLECTION_SORT ||
      jobType === JOB_TYPES.UPDATE_COLLECTION_BASE_ORDER) &&
    payload.collectionId
  ) {
    return { collectionId: String(payload.collectionId) };
  }

  if (payload.inventory_item_id) {
    return { inventoryItemId: String(payload.inventory_item_id) };
  }
  return {};
}
