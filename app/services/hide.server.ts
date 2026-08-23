import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import type { ProductAvailabilityResult } from "./availability.server";
import {
  hasTag,
  hideAutomationDecision,
  INVENTEX_HIDDEN_TAG,
  INVENTEX_IGNORE_TAG,
  redirectTarget,
  type RedirectMode,
} from "./hide";
import { logger } from "./logger.server";
import {
  cancelPendingProductHide,
  enqueueHideProduct,
  enqueueProductEvaluation,
  enqueueUnhideProduct,
} from "./webhooks.server";

interface GraphqlErrorPayload {
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

interface ProductHideContext {
  id: string;
  title: string;
  handle: string;
  tags: string[];
  publishedOnPublication: boolean;
}

export async function syncHideAutomationForAvailability(
  shop: string,
  availability: ProductAvailabilityResult,
  sourceJobId: string,
) {
  const [settings, state] = await Promise.all([
    db.shopSettings.findUnique({
      where: { shop },
      select: { hideEnabled: true, hideDelayDays: true },
    }),
    db.inventoryState.findUnique({
      where: { shop_productId: { shop, productId: availability.productId } },
      select: { restored: true, action: true, error: true },
    }),
  ]);

  const decision = hideAutomationDecision({
    hideEnabled: settings?.hideEnabled === true,
    status: availability.status,
    ignored: availability.ignored,
    activelyHidden: state?.action === "HIDDEN" && !state.restored,
    hideErrored: state?.error,
  });

  if (decision !== "hide") {
    await cancelPendingProductHide(shop, availability.productId);
    if (decision === "unhide") {
      await enqueueUnhideProduct({
        shop,
        productId: availability.productId,
        sourceJobId,
        reason: availability.ignored ? "ignored" : "available",
      });
    }
    return;
  }

  const soldOutAt = availability.soldOutAt ?? availability.evaluatedAt;
  await enqueueHideProduct({
    shop,
    productId: availability.productId,
    soldOutAt,
    delayDays: settings?.hideDelayDays ?? 0,
    sourceJobId,
  });
}

export async function resolveOnlineStorePublicationId(
  admin: AdminApiContext,
  shop: string,
) {
  const cached = await db.shopSettings.findUnique({
    where: { shop },
    select: { onlineStorePublicationId: true },
  });
  if (cached?.onlineStorePublicationId) return cached.onlineStorePublicationId;

  let cursor: string | null = null;
  let hasNextPage = true;
  const publications: Array<{
    id: string;
    name: string;
    supportsFuturePublishing: boolean;
    catalog?: { title: string } | null;
  }> = [];

  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query inventexOnlineStorePublications($cursor: String) {
          publications(first: 100, after: $cursor, catalogType: APP) {
            nodes { id name supportsFuturePublishing catalog { title } }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor } },
    );
    const json = await readGraphqlResponse<{
      data?: {
        publications?: {
          nodes: Array<{
            id: string;
            name: string;
            supportsFuturePublishing: boolean;
            catalog?: { title: string } | null;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(response);
    const connection = json.data?.publications;
    if (!connection) throw new Error("Shopify publications query failed");
    publications.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }

  const onlineStore =
    publications.find(
      ({ name }) => name.trim().toLocaleLowerCase() === "online store",
    ) ??
    publications.find(
      ({ catalog }) =>
        catalog?.title.trim().toLocaleLowerCase() === "online store",
    ) ??
    publications.find(
      ({ supportsFuturePublishing }) => supportsFuturePublishing,
    );
  if (!onlineStore) {
    throw new Error("Online Store publication was not found for this shop");
  }

  await db.shopSettings.upsert({
    where: { shop },
    update: { onlineStorePublicationId: onlineStore.id },
    create: { shop, onlineStorePublicationId: onlineStore.id },
  });
  return onlineStore.id;
}

export async function hideProductFromOnlineStore(
  admin: AdminApiContext,
  shop: string,
  productId: string,
) {
  const [settings, existing, excluded] = await Promise.all([
    db.shopSettings.findUnique({
      where: { shop },
      select: {
        hideEnabled: true,
        redirectMode: true,
        redirectPath: true,
      },
    }),
    db.inventoryState.findUnique({
      where: { shop_productId: { shop, productId } },
    }),
    db.excludedProduct.findUnique({
      where: { shop_productId: { shop, productId } },
      select: { id: true },
    }),
  ]);
  if (!settings?.hideEnabled || excluded) return { changed: false };

  const publicationId = await resolveOnlineStorePublicationId(admin, shop);
  const product = await fetchProductHideContext(
    admin,
    productId,
    publicationId,
  );
  if (!product || hasTag(product.tags, INVENTEX_IGNORE_TAG)) {
    return { changed: false };
  }

  const activeState = existing?.action === "HIDDEN" && !existing.restored;
  const hasAppTag = hasTag(product.tags, INVENTEX_HIDDEN_TAG);
  if (activeState && !existing.error && !hasAppTag) {
    logger.info(
      "Merchant removed Inventex hidden tag; hide ownership released",
      {
        shop,
        productId,
      },
    );
    return { changed: false };
  }
  if (!product.publishedOnPublication && !activeState) {
    logger.info("Product already absent from Online Store; hide skipped", {
      shop,
      productId,
    });
    return { changed: false };
  }

  await db.inventoryState.upsert({
    where: { shop_productId: { shop, productId } },
    create: {
      shop,
      productId,
      productTitle: product.title,
      productHandle: product.handle,
      action: "HIDDEN",
      restored: false,
    },
    update: {
      productTitle: product.title,
      productHandle: product.handle,
      action: "HIDDEN",
      restored: false,
      restoredAt: null,
      modifiedAt: new Date(),
      error: false,
      errorMessage: null,
    },
  });

  try {
    if (product.publishedOnPublication) {
      await changeOnlineStorePublication(
        admin,
        "unpublish",
        productId,
        publicationId,
      );
    }
    if (!hasAppTag) await addHiddenTag(admin, productId);

    let redirectId = existing?.redirectId ?? null;
    const target = redirectTarget(
      settings.redirectMode as RedirectMode,
      settings.redirectPath,
    );
    if (target && !redirectId) {
      redirectId = await createProductRedirect(
        admin,
        `/products/${product.handle}`,
        target,
      );
    }

    await db.inventoryState.update({
      where: { shop_productId: { shop, productId } },
      data: { redirectId, error: false, errorMessage: null },
    });
    logger.info("Product hidden from Online Store", { shop, productId });
    return { changed: true, redirectId };
  } catch (error) {
    await recordInventoryError(shop, productId, error);
    throw error;
  }
}

export async function unhideProductToOnlineStore(
  admin: AdminApiContext,
  shop: string,
  productId: string,
) {
  const state = await db.inventoryState.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  if (!state || state.action !== "HIDDEN" || state.restored) {
    return { changed: false };
  }

  try {
    const publicationId = await resolveOnlineStorePublicationId(admin, shop);
    const product = await fetchProductHideContext(
      admin,
      productId,
      publicationId,
    );
    if (!product || !hasTag(product.tags, INVENTEX_HIDDEN_TAG)) {
      await markInventoryRestored(shop, productId);
      logger.info("Product left unpublished because Inventex tag was removed", {
        shop,
        productId,
      });
      return { changed: false, merchantOverride: true };
    }

    if (!product.publishedOnPublication) {
      await changeOnlineStorePublication(
        admin,
        "publish",
        productId,
        publicationId,
      );
    }
    if (state.redirectId) {
      await deleteProductRedirect(admin, state.redirectId);
      await db.inventoryState.update({
        where: { shop_productId: { shop, productId } },
        data: { redirectId: null },
      });
    }
    await removeHiddenTag(admin, productId);
    await markInventoryRestored(shop, productId);
    logger.info("Product restored to Online Store", { shop, productId });
    return { changed: true };
  } catch (error) {
    await recordInventoryError(shop, productId, error);
    throw error;
  }
}

export async function enqueueCatalogProductEvaluations(
  admin: AdminApiContext,
  shop: string,
  sourceJobId: string,
) {
  let cursor: string | null = null;
  let hasNextPage = true;
  let count = 0;
  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query inventexHideCatalogProducts($cursor: String) {
          products(first: 250, after: $cursor) {
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
    const connection = json.data?.products;
    if (!connection) throw new Error("Shopify product catalog query failed");
    for (let offset = 0; offset < connection.nodes.length; offset += 100) {
      const batch = connection.nodes.slice(offset, offset + 100);
      await Promise.all(
        batch.map(({ id: productId }) =>
          enqueueProductEvaluation({
            shop,
            productId,
            sourceJobId,
            reason: "hideScan",
          }),
        ),
      );
    }
    count += connection.nodes.length;
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }
  return count;
}

export async function republishAllInventexHidden(
  admin: AdminApiContext,
  shop: string,
) {
  let afterId = 0;
  let restored = 0;
  let hasMore = true;
  const errors: string[] = [];

  while (hasMore) {
    const rows = await db.inventoryState.findMany({
      where: {
        shop,
        action: "HIDDEN",
        restored: false,
        id: { gt: afterId },
      },
      orderBy: { id: "asc" },
      take: 50,
      select: { id: true, productId: true },
    });
    if (rows.length === 0) {
      hasMore = false;
      continue;
    }
    for (const row of rows) {
      try {
        const result = await unhideProductToOnlineStore(
          admin,
          shop,
          row.productId,
        );
        if (result.changed) restored++;
      } catch (error) {
        errors.push(`${row.productId}: ${errorMessage(error)}`);
      }
    }
    afterId = rows.at(-1)?.id ?? afterId;
  }

  if (errors.length > 0) {
    throw new Error(
      `Failed to restore ${errors.length} products: ${errors.join("; ")}`,
    );
  }
  return restored;
}

export async function clearHideJobLock(shop: string, jobId: string) {
  await db.shopSettings.updateMany({
    where: { shop, hideJobId: jobId },
    data: { hideJobId: null },
  });
}

async function fetchProductHideContext(
  admin: AdminApiContext,
  productId: string,
  publicationId: string,
): Promise<ProductHideContext | null> {
  const response = await admin.graphql(
    `#graphql
      query inventexProductHideContext($id: ID!, $publicationId: ID!) {
        product(id: $id) {
          id
          title
          handle
          tags
          publishedOnPublication(publicationId: $publicationId)
        }
      }
    `,
    { variables: { id: productId, publicationId } },
  );
  const json = await readGraphqlResponse<{
    data?: { product?: ProductHideContext | null };
  }>(response);
  return json.data?.product ?? null;
}

async function changeOnlineStorePublication(
  admin: AdminApiContext,
  action: "publish" | "unpublish",
  productId: string,
  publicationId: string,
) {
  const mutation =
    action === "publish"
      ? `#graphql
          mutation inventexPublishOnlineStore($id: ID!, $input: [PublicationInput!]!) {
            publishablePublish(id: $id, input: $input) {
              userErrors { field message }
            }
          }
        `
      : `#graphql
          mutation inventexUnpublishOnlineStore($id: ID!, $input: [PublicationInput!]!) {
            publishableUnpublish(id: $id, input: $input) {
              userErrors { field message }
            }
          }
        `;
  const response = await admin.graphql(mutation, {
    variables: { id: productId, input: [{ publicationId }] },
  });
  const json = await readGraphqlResponse<{
    data?: Record<string, { userErrors: Array<{ message: string }> }>;
  }>(response);
  const payload =
    json.data?.[
      action === "publish" ? "publishablePublish" : "publishableUnpublish"
    ];
  throwUserErrors(payload?.userErrors);
}

async function addHiddenTag(admin: AdminApiContext, productId: string) {
  const response = await admin.graphql(
    `#graphql
      mutation inventexAddHiddenTag($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
      }
    `,
    { variables: { id: productId, tags: [INVENTEX_HIDDEN_TAG] } },
  );
  const json = await readGraphqlResponse<{
    data?: { tagsAdd?: { userErrors: Array<{ message: string }> } };
  }>(response);
  throwUserErrors(json.data?.tagsAdd?.userErrors);
}

async function removeHiddenTag(admin: AdminApiContext, productId: string) {
  const response = await admin.graphql(
    `#graphql
      mutation inventexRemoveHiddenTag($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
      }
    `,
    { variables: { id: productId, tags: [INVENTEX_HIDDEN_TAG] } },
  );
  const json = await readGraphqlResponse<{
    data?: { tagsRemove?: { userErrors: Array<{ message: string }> } };
  }>(response);
  throwUserErrors(json.data?.tagsRemove?.userErrors);
}

async function createProductRedirect(
  admin: AdminApiContext,
  path: string,
  target: string,
) {
  const response = await admin.graphql(
    `#graphql
      mutation inventexCreateProductRedirect($urlRedirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $urlRedirect) {
          urlRedirect { id }
          userErrors { field message }
        }
      }
    `,
    { variables: { urlRedirect: { path, target } } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      urlRedirectCreate?: {
        urlRedirect?: { id: string } | null;
        userErrors: Array<{ message: string }>;
      };
    };
  }>(response);
  const payload = json.data?.urlRedirectCreate;
  throwUserErrors(payload?.userErrors);
  if (!payload?.urlRedirect?.id)
    throw new Error("Shopify did not create redirect");
  return payload.urlRedirect.id;
}

async function deleteProductRedirect(
  admin: AdminApiContext,
  redirectId: string,
) {
  const response = await admin.graphql(
    `#graphql
      mutation inventexDeleteProductRedirect($id: ID!) {
        urlRedirectDelete(id: $id) {
          deletedUrlRedirectId
          userErrors { field message }
        }
      }
    `,
    { variables: { id: redirectId } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      urlRedirectDelete?: { userErrors: Array<{ message: string }> };
    };
  }>(response);
  throwUserErrors(json.data?.urlRedirectDelete?.userErrors);
}

async function markInventoryRestored(shop: string, productId: string) {
  await db.inventoryState.update({
    where: { shop_productId: { shop, productId } },
    data: {
      restored: true,
      restoredAt: new Date(),
      error: false,
      errorMessage: null,
    },
  });
}

async function recordInventoryError(
  shop: string,
  productId: string,
  error: unknown,
) {
  await db.inventoryState.updateMany({
    where: { shop, productId },
    data: { error: true, errorMessage: errorMessage(error).slice(0, 4_000) },
  });
}

function throwUserErrors(errors?: Array<{ message: string }>) {
  if (errors?.length) {
    throw new Error(errors.map(({ message }) => message).join("; "));
  }
}

async function readGraphqlResponse<T extends object>(response: Response) {
  const json = (await response.json()) as T & GraphqlErrorPayload;
  if (json.errors?.length) {
    const error = new Error(
      json.errors
        .map(({ message }) => message ?? "Shopify GraphQL error")
        .join("; "),
    );
    Object.assign(error, { body: json });
    throw error;
  }
  return json;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
