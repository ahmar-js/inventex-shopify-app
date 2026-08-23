import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import type { ProductAvailabilityResult } from "./availability.server";
import { INVENTEX_IGNORE_TAG, hasTag } from "./hide";
import { resolveOnlineStorePublicationId } from "./hide.server";
import { logger } from "./logger.server";
import {
  cancelPendingVariantHide,
  enqueueHideVariant,
  enqueueProductEvaluation,
  enqueueUnhideVariant,
} from "./webhooks.server";
import { variantHideCatalogEligible, variantHideDecision } from "./variant-hide";

interface GraphqlErrorPayload {
  errors?: Array<{ message?: string }>;
}

interface VariantPublicationContext {
  id: string;
  title: string;
  publishedOnPublication: boolean;
  product: { id: string; title: string; tags: string[] };
}

export async function syncVariantHideForAvailability(
  shop: string,
  availability: ProductAvailabilityResult,
  sourceJobId: string,
) {
  const [settings, states] = await Promise.all([
    db.shopSettings.findUnique({
      where: { shop },
      select: { variantHideEnabled: true, variantHideEligible: true },
    }),
    db.variantInventoryState.findMany({
      where: { shop, productId: availability.productId, restored: false },
      select: { variantId: true, error: true },
    }),
  ]);
  const active = new Map(states.map((state) => [state.variantId, state]));

  for (const variant of availability.variants) {
    const state = active.get(variant.variantId);
    const decision = variantHideDecision({
      enabled: settings?.variantHideEnabled === true,
      eligible: settings?.variantHideEligible === true,
      ignored: availability.ignored,
      status: variant.status,
      activelyHidden: Boolean(state),
      hideErrored: state?.error,
    });

    if (decision === "hide") {
      await enqueueHideVariant({
        shop,
        productId: availability.productId,
        variantId: variant.variantId,
        sourceJobId,
      });
    } else {
      await cancelPendingVariantHide(shop, variant.variantId);
      if (decision === "unhide") {
        await enqueueUnhideVariant({
          shop,
          productId: availability.productId,
          variantId: variant.variantId,
          sourceJobId,
          reason: availability.ignored
            ? "ignored"
            : settings?.variantHideEnabled !== true
              ? "disabled"
              : settings?.variantHideEligible !== true
                ? "ineligible"
                : "available",
        });
      }
    }
    active.delete(variant.variantId);
  }

  for (const state of active.values()) {
    await cancelPendingVariantHide(shop, state.variantId);
    await enqueueUnhideVariant({
      shop,
      productId: availability.productId,
      variantId: state.variantId,
      sourceJobId,
      reason: "deleted",
    });
  }
}

export async function hideVariantFromOnlineStore(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  variantId: string,
) {
  const [settings, existing, excluded] = await Promise.all([
    db.shopSettings.findUnique({
      where: { shop },
      select: { variantHideEnabled: true, variantHideEligible: true },
    }),
    db.variantInventoryState.findUnique({
      where: { shop_variantId: { shop, variantId } },
    }),
    db.excludedProduct.findUnique({
      where: { shop_productId: { shop, productId } },
      select: { id: true },
    }),
  ]);
  if (!settings?.variantHideEnabled || !settings.variantHideEligible || excluded) {
    return { changed: false };
  }

  const publicationId = await resolveOnlineStorePublicationId(admin, shop);
  const variant = await fetchVariantContext(admin, variantId, publicationId);
  if (
    !variant ||
    variant.product.id !== productId ||
    hasTag(variant.product.tags, INVENTEX_IGNORE_TAG)
  ) {
    return { changed: false };
  }

  const activelyHidden = existing && !existing.restored;
  if (!variant.publishedOnPublication && !activelyHidden) {
    logger.info("Variant already absent from Online Store; hide skipped", {
      shop,
      productId,
      variantId,
    });
    return { changed: false };
  }
  if (activelyHidden && !existing.error && !variant.publishedOnPublication) {
    return { changed: false };
  }

  await db.variantInventoryState.upsert({
    where: { shop_variantId: { shop, variantId } },
    create: {
      shop,
      productId,
      variantId,
      productTitle: variant.product.title,
      variantTitle: variant.title,
    },
    update: {
      productId,
      productTitle: variant.product.title,
      variantTitle: variant.title,
      hiddenAt: new Date(),
      restored: false,
      restoredAt: null,
      error: false,
      errorMessage: null,
    },
  });

  try {
    if (variant.publishedOnPublication) {
      await changeVariantPublication(admin, "unpublish", variantId, publicationId);
    }
    logger.info("Variant hidden from Online Store", { shop, productId, variantId });
    return { changed: true };
  } catch (error) {
    await recordVariantError(shop, variantId, error);
    throw error;
  }
}

export async function unhideVariantToOnlineStore(
  admin: AdminApiContext,
  shop: string,
  variantId: string,
) {
  const state = await db.variantInventoryState.findUnique({
    where: { shop_variantId: { shop, variantId } },
  });
  if (!state || state.restored) return { changed: false };

  try {
    const publicationId = await resolveOnlineStorePublicationId(admin, shop);
    const variant = await fetchVariantContext(admin, variantId, publicationId);
    if (!variant) {
      await markVariantRestored(shop, variantId);
      return { changed: false };
    }
    if (!variant.publishedOnPublication) {
      await changeVariantPublication(admin, "publish", variantId, publicationId);
    }
    await markVariantRestored(shop, variantId);
    logger.info("Variant restored to Online Store", {
      shop,
      productId: state.productId,
      variantId,
    });
    return { changed: true };
  } catch (error) {
    await recordVariantError(shop, variantId, error);
    throw error;
  }
}

export async function countPublishedOnlineStoreProducts(admin: AdminApiContext) {
  const response = await admin.graphql(
    `#graphql
      query inventexPublishedProductCount($limit: Int) {
        productsCount(query: "published_status:published", limit: $limit) {
          count
        }
      }
    `,
    { variables: { limit: 501 } },
  );
  const json = await readGraphqlResponse<{
    data?: { productsCount?: { count: number } };
  }>(response);
  const count = json.data?.productsCount?.count;
  if (typeof count !== "number") throw new Error("Shopify product count failed");
  return count;
}

export async function dispatchVariantHideScan(
  admin: AdminApiContext,
  shop: string,
  sourceJobId: string,
) {
  const publishedProductCount = await countPublishedOnlineStoreProducts(admin);
  const eligible = variantHideCatalogEligible(publishedProductCount);
  await db.shopSettings.updateMany({
    where: { shop, variantHideEnabled: true },
    data: {
      variantHideEligible: eligible,
      variantHideCatalogCount: publishedProductCount,
    },
  });
  if (!eligible) {
    logger.warn("Variant hide paused by published-product beta limit", {
      shop,
      jobId: sourceJobId,
      productCount: publishedProductCount,
    });
    return { publishedProductCount, dispatched: 0, eligible: false };
  }

  let cursor: string | null = null;
  let hasNextPage = true;
  let dispatched = 0;
  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query inventexPublishedProductsForVariantHide($cursor: String) {
          products(first: 250, after: $cursor, query: "published_status:published") {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor } },
    );
    const json = await readGraphqlResponse<{
      data?: {
        products?: {
          nodes: Array<{ id: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(response);
    const products = json.data?.products;
    if (!products) throw new Error("Shopify published product scan failed");
    for (const { id: productId } of products.nodes) {
      await enqueueProductEvaluation({
        shop,
        productId,
        sourceJobId,
        reason: "variantHideScan",
      });
    }
    dispatched += products.nodes.length;
    hasNextPage = products.pageInfo.hasNextPage;
    cursor = products.pageInfo.endCursor;
  }
  return { publishedProductCount, dispatched, eligible: true };
}

export async function republishAllHiddenVariants(
  admin: AdminApiContext,
  shop: string,
) {
  let lastId = 0;
  let restored = 0;
  let hasMore = true;
  const errors: string[] = [];
  while (hasMore) {
    const rows = await db.variantInventoryState.findMany({
      where: { shop, restored: false, id: { gt: lastId } },
      orderBy: { id: "asc" },
      take: 50,
      select: { id: true, variantId: true },
    });
    if (!rows.length) break;
    for (const { variantId } of rows) {
      try {
        const result = await unhideVariantToOnlineStore(admin, shop, variantId);
        if (result.changed) restored++;
      } catch (error) {
        errors.push(`${variantId}: ${errorMessage(error)}`);
      }
    }
    lastId = rows.at(-1)?.id ?? lastId;
    hasMore = rows.length === 50;
  }
  if (errors.length) {
    throw new Error(`Failed to restore ${errors.length} variants: ${errors.join("; ")}`);
  }
  return restored;
}

export async function clearVariantHideJobLock(shop: string, jobId: string) {
  await db.shopSettings.updateMany({
    where: { shop, variantHideJobId: jobId },
    data: { variantHideJobId: null },
  });
}

async function fetchVariantContext(
  admin: AdminApiContext,
  variantId: string,
  publicationId: string,
): Promise<VariantPublicationContext | null> {
  const response = await admin.graphql(
    `#graphql
      query inventexVariantPublicationContext($id: ID!, $publicationId: ID!) {
        productVariant(id: $id) {
          id
          title
          publishedOnPublication(publicationId: $publicationId)
          product { id title tags }
        }
      }
    `,
    { variables: { id: variantId, publicationId } },
  );
  const json = await readGraphqlResponse<{
    data?: { productVariant?: VariantPublicationContext | null };
  }>(response);
  return json.data?.productVariant ?? null;
}

async function changeVariantPublication(
  admin: AdminApiContext,
  action: "publish" | "unpublish",
  variantId: string,
  publicationId: string,
) {
  const mutation = action === "publish"
    ? `#graphql
        mutation inventexPublishVariant($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }
      `
    : `#graphql
        mutation inventexUnpublishVariant($id: ID!, $input: [PublicationInput!]!) {
          publishableUnpublish(id: $id, input: $input) {
            userErrors { field message }
          }
        }
      `;
  const response = await admin.graphql(mutation, {
    variables: { id: variantId, input: [{ publicationId }] },
  });
  const json = await readGraphqlResponse<{
    data?: Record<string, { userErrors: Array<{ message: string }> }>;
  }>(response);
  const payload = json.data?.[
    action === "publish" ? "publishablePublish" : "publishableUnpublish"
  ];
  if (!payload) throw new Error("Shopify publication mutation returned no payload");
  if (payload.userErrors.length) {
    throw new Error(payload.userErrors.map(({ message }) => message).join("; "));
  }
}

async function markVariantRestored(shop: string, variantId: string) {
  await db.variantInventoryState.update({
    where: { shop_variantId: { shop, variantId } },
    data: {
      restored: true,
      restoredAt: new Date(),
      error: false,
      errorMessage: null,
    },
  });
}

async function recordVariantError(shop: string, variantId: string, error: unknown) {
  await db.variantInventoryState.updateMany({
    where: { shop, variantId },
    data: { error: true, errorMessage: errorMessage(error).slice(0, 4_000) },
  });
}

async function readGraphqlResponse<T extends object>(response: Response) {
  const json = (await response.json()) as T & GraphqlErrorPayload;
  if (json.errors?.length) {
    const error = new Error(
      json.errors.map(({ message }) => message ?? "Shopify GraphQL error").join("; "),
    );
    Object.assign(error, { body: json });
    throw error;
  }
  return json;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
