import type { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { classifyProductAvailability } from "./availability";
import {
  buildSequentialMoves,
  chunkCollectionMoves,
  mergeCollectionMembership,
  sortCollectionProducts,
  type CollectionProductAvailability,
} from "./collection-sort";
import { logger } from "./logger.server";
import {
  enqueueCollectionSort,
  enqueueProductEvaluation,
} from "./webhooks.server";

const BULK_THRESHOLD = 2_000;
const SHOPIFY_JOB_POLL_MS = 500;
const SHOPIFY_JOB_MAX_POLLS = 60;

type BaseSortOrder =
  | "ALPHA_ASC"
  | "ALPHA_DESC"
  | "BEST_SELLING"
  | "CREATED"
  | "CREATED_DESC"
  | "MANUAL"
  | "MOST_RELEVANT"
  | "PRICE_ASC"
  | "PRICE_DESC";

interface CollectionSnapshot {
  id: string;
  title: string;
  sortOrder: BaseSortOrder;
  productCount: number;
  productIds: string[];
}

interface GraphqlErrorPayload {
  errors?: Array<{ message?: string; extensions?: { code?: string } }>;
}

export class CollectionSortDeferredError extends Error {
  constructor(
    message: string,
    readonly runAfter = new Date(Date.now() + 60_000),
  ) {
    super(message);
    this.name = "CollectionSortDeferredError";
  }
}

export function collectionGid(value: string | number): string {
  const id = String(value);
  return id.startsWith("gid://") ? id : `gid://shopify/Collection/${id}`;
}

export async function enableCollectionAutoSortingNow(
  admin: AdminApiContext,
  shop: string,
  collectionId: string,
  requestedBaseSortOrder?: string,
) {
  const desired = await db.collectionAutoSorting.findUnique({
    where: { shop_collectionId: { shop, collectionId } },
  });
  if (!desired?.enabled) return;

  const original = await fetchCollectionSnapshot(
    admin,
    collectionId,
    "COLLECTION_DEFAULT",
  );
  const baseSortOrder = normalizeBaseSortOrder(
    requestedBaseSortOrder ?? original.sortOrder,
  );
  const baseProductIds =
    baseSortOrder === original.sortOrder
      ? original.productIds
      : (
          await fetchCollectionSnapshot(
            admin,
            collectionId,
            sortQueryFor(baseSortOrder).sortKey,
            sortQueryFor(baseSortOrder).reverse,
          )
        ).productIds;

  await db.collectionAutoSorting.update({
    where: { shop_collectionId: { shop, collectionId } },
    data: {
      originalSortOrder: original.sortOrder,
      baseSortOrder,
      originalProductIds: toJson(original.productIds),
      baseProductIds: toJson(baseProductIds),
      oosOriginalIndices: toJson({}),
      productCount: original.productCount,
      disabledReason: null,
      lastError: null,
      bulkOperationId: null,
    },
  });

  if (original.sortOrder !== "MANUAL") {
    await updateShopifyCollectionSortOrder(admin, collectionId, "MANUAL");
  }
  await enqueueCollectionSort({
    shop,
    collectionId,
    productCount: original.productCount,
    reason: "enabled",
    immediate: true,
  });
  logger.info("Collection auto-sort enabled", {
    shop,
    collectionId,
    productCount: original.productCount,
  });
}

export async function disableCollectionAutoSortingNow(
  admin: AdminApiContext,
  shop: string,
  collectionId: string,
) {
  const state = await db.collectionAutoSorting.findUnique({
    where: { shop_collectionId: { shop, collectionId } },
  });
  if (!state || state.enabled) return;

  const originalOrder = jsonStringArray(state.originalProductIds);
  if (state.originalSortOrder === "MANUAL" && originalOrder.length > 0) {
    const current = await fetchCollectionSnapshot(
      admin,
      collectionId,
      "MANUAL",
    );
    await reorderCollection(
      admin,
      collectionId,
      current.productIds,
      originalOrder.filter((id) => current.productIds.includes(id)),
    );
  }
  await updateShopifyCollectionSortOrder(
    admin,
    collectionId,
    normalizeBaseSortOrder(state.originalSortOrder),
  );
  await db.collectionAutoSorting.update({
    where: { shop_collectionId: { shop, collectionId } },
    data: { bulkOperationId: null, lastError: null },
  });
  logger.info("Collection auto-sort disabled and Shopify order restored", {
    shop,
    collectionId,
  });
}

export async function updateCollectionBaseOrderNow(
  admin: AdminApiContext,
  shop: string,
  collectionId: string,
  requestedBaseSortOrder: string,
) {
  const state = await db.collectionAutoSorting.findUnique({
    where: { shop_collectionId: { shop, collectionId } },
  });
  if (!state?.enabled) return;
  if (jsonStringArray(state.originalProductIds).length === 0) {
    await enableCollectionAutoSortingNow(
      admin,
      shop,
      collectionId,
      requestedBaseSortOrder,
    );
    return;
  }

  const baseSortOrder = normalizeBaseSortOrder(requestedBaseSortOrder);
  const query = sortQueryFor(baseSortOrder);
  const snapshot = await fetchCollectionSnapshot(
    admin,
    collectionId,
    query.sortKey,
    query.reverse,
  );
  if (snapshot.sortOrder !== "MANUAL") {
    await updateShopifyCollectionSortOrder(admin, collectionId, "MANUAL");
  }
  const baseProductIds =
    baseSortOrder === "MANUAL"
      ? mergeCollectionMembership(
          jsonStringArray(state.originalProductIds),
          snapshot.productIds,
        )
      : snapshot.productIds;
  await db.collectionAutoSorting.update({
    where: { shop_collectionId: { shop, collectionId } },
    data: {
      baseSortOrder,
      baseProductIds: toJson(baseProductIds),
      oosOriginalIndices: toJson({}),
      productCount: snapshot.productCount,
      disabledReason: null,
    },
  });
  await enqueueCollectionSort({
    shop,
    collectionId,
    productCount: snapshot.productCount,
    reason: "baseOrderChanged",
    immediate: true,
  });
}

export async function sortCollectionNow(
  admin: AdminApiContext,
  shop: string,
  collectionId: string,
  sourceJobId: string,
) {
  const state = await db.collectionAutoSorting.findUnique({
    where: { shop_collectionId: { shop, collectionId } },
  });
  if (!state?.enabled) return;

  const current = await fetchCollectionSnapshot(admin, collectionId, "MANUAL");
  if (current.sortOrder !== "MANUAL") {
    await disableForExternalSortChange(shop, collectionId, current.sortOrder);
    return;
  }

  if (current.productCount >= BULK_THRESHOLD) {
    await ensureBulkAvailability(admin, shop, state.bulkOperationId, current);
  }

  const availabilityRows = await db.productAvailabilityState.findMany({
    where: { shop, productId: { in: current.productIds } },
    select: { productId: true, status: true, ignored: true },
  });
  const known = new Set(availabilityRows.map(({ productId }) => productId));
  const missing = current.productIds.filter(
    (productId) => !known.has(productId),
  );
  if (missing.length > 0) {
    for (let offset = 0; offset < missing.length; offset += 100) {
      await Promise.all(
        missing.slice(offset, offset + 100).map((productId) =>
          enqueueProductEvaluation({
            shop,
            productId,
            sourceJobId,
            reason: "collectionBootstrap",
          }),
        ),
      );
    }
    throw new CollectionSortDeferredError(
      `Waiting for ${missing.length} product availability evaluations`,
    );
  }

  const availability = Object.fromEntries(
    availabilityRows.map(({ productId, status, ignored }) => [
      productId,
      { status, ignored } as CollectionProductAvailability,
    ]),
  );
  const result = sortCollectionProducts({
    currentOrder: current.productIds,
    baseOrder: jsonStringArray(state.baseProductIds),
    availability,
    previousOosOriginalIndices: jsonNumberRecord(state.oosOriginalIndices),
  });

  await reorderCollection(
    admin,
    collectionId,
    current.productIds,
    result.targetOrder,
  );
  await db.collectionAutoSorting.update({
    where: { shop_collectionId: { shop, collectionId } },
    data: {
      baseProductIds: toJson(result.baseOrder),
      oosOriginalIndices: toJson(result.oosOriginalIndices),
      productCount: current.productCount,
      lastSortedAt: new Date(),
      lastError: null,
      bulkOperationId: null,
    },
  });
  logger.info("Collection sorted by availability", {
    shop,
    collectionId,
    productCount: current.productCount,
  });
}

export async function handleCollectionUpdateJob(
  admin: AdminApiContext,
  shop: string,
  collectionId: string,
) {
  const state = await db.collectionAutoSorting.findUnique({
    where: { shop_collectionId: { shop, collectionId } },
  });
  if (!state?.enabled) return;

  const collection = await fetchCollectionIdentity(admin, collectionId);
  if (!collection) {
    await db.collectionAutoSorting.deleteMany({
      where: { shop, collectionId },
    });
    return;
  }
  if (collection.sortOrder !== "MANUAL") {
    await disableForExternalSortChange(
      shop,
      collectionId,
      collection.sortOrder,
    );
    return;
  }
  await enqueueCollectionSort({
    shop,
    collectionId,
    productCount: collection.productCount,
    reason: "collectionUpdated",
  });
}

export async function enqueueSortsForProduct(
  admin: AdminApiContext,
  shop: string,
  productId: string,
) {
  const collectionIds = await fetchProductCollectionIds(admin, productId);
  if (collectionIds.length === 0) return;
  const states = await db.collectionAutoSorting.findMany({
    where: { shop, enabled: true, collectionId: { in: collectionIds } },
    select: { collectionId: true, productCount: true },
  });
  await Promise.all(
    states.map((state) =>
      enqueueCollectionSort({
        shop,
        collectionId: state.collectionId,
        productCount: state.productCount,
        reason: "productAvailabilityChanged",
      }),
    ),
  );
}

export async function fetchAllCollectionIds(admin: AdminApiContext) {
  const ids: Array<{ id: string; sortOrder: string }> = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query allCollectionIds($cursor: String) {
          collections(first: 250, after: $cursor) {
            nodes { id sortOrder }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { variables: { cursor } },
    );
    const json = await readGraphqlResponse<{
      data?: {
        collections?: {
          nodes: Array<{ id: string; sortOrder: string }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    }>(response);
    const connection = json.data?.collections;
    if (!connection) throw new Error("Shopify collections query failed");
    ids.push(...connection.nodes);
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }
  return ids;
}

async function fetchCollectionSnapshot(
  admin: AdminApiContext,
  collectionId: string,
  sortKey: string,
  reverse = false,
): Promise<CollectionSnapshot> {
  const productIds: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let identity: Omit<CollectionSnapshot, "productIds"> | null = null;

  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query collectionSortSnapshot(
          $id: ID!
          $cursor: String
          $sortKey: ProductCollectionSortKeys!
          $reverse: Boolean!
        ) {
          collection(id: $id) {
            id
            title
            sortOrder
            productsCount { count }
            products(
              first: 250
              after: $cursor
              sortKey: $sortKey
              reverse: $reverse
            ) {
              nodes { id }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      {
        variables: {
          id: collectionId,
          cursor,
          sortKey: sortKey as never,
          reverse,
        },
      },
    );
    const json = await readGraphqlResponse<{
      data?: {
        collection?: {
          id: string;
          title: string;
          sortOrder: BaseSortOrder;
          productsCount?: { count: number } | null;
          products: {
            nodes: Array<{ id: string }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    }>(response);
    const collection = json.data?.collection;
    if (!collection)
      throw new Error(`Shopify collection not found: ${collectionId}`);
    identity ??= {
      id: collection.id,
      title: collection.title,
      sortOrder: collection.sortOrder,
      productCount: collection.productsCount?.count ?? 0,
    };
    productIds.push(...collection.products.nodes.map(({ id }) => id));
    hasNextPage = collection.products.pageInfo.hasNextPage;
    cursor = collection.products.pageInfo.endCursor;
  }

  if (!identity)
    throw new Error(`Shopify collection not found: ${collectionId}`);
  return {
    ...identity,
    productCount: Math.max(identity.productCount, productIds.length),
    productIds,
  };
}

async function fetchCollectionIdentity(
  admin: AdminApiContext,
  collectionId: string,
) {
  const response = await admin.graphql(
    `#graphql
      query collectionSortIdentity($id: ID!) {
        collection(id: $id) {
          id
          sortOrder
          productsCount { count }
        }
      }
    `,
    { variables: { id: collectionId } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      collection?: {
        id: string;
        sortOrder: BaseSortOrder;
        productsCount?: { count: number } | null;
      } | null;
    };
  }>(response);
  const collection = json.data?.collection;
  return collection
    ? {
        id: collection.id,
        sortOrder: collection.sortOrder,
        productCount: collection.productsCount?.count ?? 0,
      }
    : null;
}

async function fetchProductCollectionIds(
  admin: AdminApiContext,
  productId: string,
) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query productCollections($id: ID!, $cursor: String) {
          product(id: $id) {
            collections(first: 250, after: $cursor) {
              nodes { id }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      { variables: { id: productId, cursor } },
    );
    const json = await readGraphqlResponse<{
      data?: {
        product?: {
          collections: {
            nodes: Array<{ id: string }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    }>(response);
    const connection = json.data?.product?.collections;
    if (!connection) return ids;
    ids.push(...connection.nodes.map(({ id }) => id));
    hasNextPage = connection.pageInfo.hasNextPage;
    cursor = connection.pageInfo.endCursor;
  }
  return ids;
}

async function updateShopifyCollectionSortOrder(
  admin: AdminApiContext,
  collectionId: string,
  sortOrder: BaseSortOrder,
) {
  const response = await admin.graphql(
    `#graphql
      mutation updateInventexCollectionSort($collection: CollectionUpdateInput!) {
        collectionUpdate(collection: $collection) {
          collection { id sortOrder }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        collection: { id: collectionId, sortOrder: sortOrder as never },
      },
    },
  );
  const json = await readGraphqlResponse<{
    data?: {
      collectionUpdate?: {
        userErrors: Array<{ message: string }>;
      };
    };
  }>(response);
  throwUserErrors(json.data?.collectionUpdate?.userErrors);
}

async function reorderCollection(
  admin: AdminApiContext,
  collectionId: string,
  currentOrder: string[],
  targetOrder: string[],
) {
  const moves = buildSequentialMoves(currentOrder, targetOrder);
  for (const chunk of chunkCollectionMoves(moves)) {
    const response = await admin.graphql(
      `#graphql
        mutation reorderInventexCollection($id: ID!, $moves: [MoveInput!]!) {
          collectionReorderProducts(id: $id, moves: $moves) {
            job { id }
            userErrors { field message }
          }
        }
      `,
      { variables: { id: collectionId, moves: chunk } },
    );
    const json = await readGraphqlResponse<{
      data?: {
        collectionReorderProducts?: {
          job?: { id: string } | null;
          userErrors: Array<{ message: string }>;
        };
      };
    }>(response);
    const payload = json.data?.collectionReorderProducts;
    throwUserErrors(payload?.userErrors);
    if (payload?.job?.id) await waitForShopifyJob(admin, payload.job.id);
  }
}

async function waitForShopifyJob(admin: AdminApiContext, jobId: string) {
  for (let attempt = 0; attempt < SHOPIFY_JOB_MAX_POLLS; attempt++) {
    const response = await admin.graphql(
      `#graphql
        query inventexShopifyJob($id: ID!) {
          job(id: $id) { id done }
        }
      `,
      { variables: { id: jobId } },
    );
    const json = await readGraphqlResponse<{
      data?: { job?: { done: boolean } | null };
    }>(response);
    if (json.data?.job?.done) return;
    await new Promise((resolve) => setTimeout(resolve, SHOPIFY_JOB_POLL_MS));
  }
  throw new Error(`Shopify reorder job timed out: ${jobId}`);
}

async function disableForExternalSortChange(
  shop: string,
  collectionId: string,
  sortOrder: string,
) {
  const reason = `Shopify sort order changed to ${sortOrder}`;
  await db.collectionAutoSorting.updateMany({
    where: { shop, collectionId, enabled: true },
    data: { enabled: false, disabledReason: reason },
  });
  logger.warn("Collection auto-sort disabled after Shopify sort change", {
    shop,
    collectionId,
    sortOrder,
  });
}

async function ensureBulkAvailability(
  admin: AdminApiContext,
  shop: string,
  existingOperationId: string | null,
  collection: CollectionSnapshot,
) {
  if (!existingOperationId) {
    const operationId = await startAvailabilityBulkQuery(admin, collection.id);
    await db.collectionAutoSorting.update({
      where: { shop_collectionId: { shop, collectionId: collection.id } },
      data: { bulkOperationId: operationId },
    });
    throw new CollectionSortDeferredError("Waiting for Shopify bulk query");
  }

  const bulk = await fetchBulkOperation(admin, existingOperationId);
  if (bulk.status === "CREATED" || bulk.status === "RUNNING") {
    throw new CollectionSortDeferredError(
      "Shopify bulk query is still running",
    );
  }
  if (bulk.status !== "COMPLETED" || !bulk.url) {
    await db.collectionAutoSorting.update({
      where: { shop_collectionId: { shop, collectionId: collection.id } },
      data: { bulkOperationId: null, lastError: bulk.errorCode ?? bulk.status },
    });
    throw new Error(
      `Shopify bulk query failed: ${bulk.errorCode ?? bulk.status}`,
    );
  }

  const response = await fetch(bulk.url);
  if (!response.ok) {
    throw new Error(
      `Could not download Shopify bulk result (${response.status})`,
    );
  }
  await persistBulkAvailability(
    shop,
    collection.productIds,
    await response.text(),
  );
  await db.collectionAutoSorting.update({
    where: { shop_collectionId: { shop, collectionId: collection.id } },
    data: { bulkOperationId: null },
  });
}

async function startAvailabilityBulkQuery(
  admin: AdminApiContext,
  collectionId: string,
) {
  const numericId = collectionId.split("/").at(-1);
  if (!numericId) throw new Error(`Invalid collection GID: ${collectionId}`);
  const query = `{
    products(query: "collection_id:${numericId}") {
      edges {
        node {
          __typename
          id
          title
          tags
          variants {
            edges {
              node {
                __typename
                id
                title
                inventoryPolicy
                inventoryItem {
                  id
                  tracked
                  inventoryLevels {
                    edges {
                      node {
                        __typename
                        id
                        location { id name fulfillsOnlineOrders }
                        quantities(names: ["available"]) { name quantity }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;
  const response = await admin.graphql(
    `#graphql
      mutation inventexAvailabilityBulk($query: String!) {
        bulkOperationRunQuery(query: $query) {
          bulkOperation { id status }
          userErrors { field message }
        }
      }
    `,
    { variables: { query } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      bulkOperationRunQuery?: {
        bulkOperation?: { id: string } | null;
        userErrors: Array<{ message: string }>;
      };
    };
  }>(response);
  const payload = json.data?.bulkOperationRunQuery;
  throwUserErrors(payload?.userErrors);
  if (!payload?.bulkOperation?.id) {
    throw new Error("Shopify did not create an availability bulk query");
  }
  return payload.bulkOperation.id;
}

async function fetchBulkOperation(admin: AdminApiContext, id: string) {
  const response = await admin.graphql(
    `#graphql
      query inventexBulkOperation($id: ID!) {
        bulkOperation(id: $id) { id status url errorCode }
      }
    `,
    { variables: { id } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      bulkOperation?: {
        status: string;
        url?: string | null;
        errorCode?: string | null;
      } | null;
    };
  }>(response);
  if (!json.data?.bulkOperation)
    throw new Error(`Bulk operation not found: ${id}`);
  return json.data.bulkOperation;
}

interface BulkProduct {
  id: string;
  title: string;
  tags: string[];
  variants: Array<{
    variantId: string;
    title: string;
    inventoryPolicy: "CONTINUE" | "DENY";
    tracked: boolean;
    inventoryItemId: string;
    locations: Array<{
      locationId: string;
      locationName: string;
      fulfillsOnlineOrders: boolean;
      available: number;
    }>;
  }>;
}

async function persistBulkAvailability(
  shop: string,
  expectedProductIds: string[],
  jsonl: string,
) {
  const products = new Map<string, BulkProduct>();
  const variants = new Map<string, BulkProduct["variants"][number]>();
  const inventoryItems = new Map<string, BulkProduct["variants"][number]>();

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const node = JSON.parse(line) as Record<string, unknown>;
    const typename = node.__typename;
    if (typename === "Product") {
      products.set(String(node.id), {
        id: String(node.id),
        title: String(node.title ?? ""),
        tags: Array.isArray(node.tags) ? node.tags.map(String) : [],
        variants: [],
      });
    } else if (typename === "ProductVariant") {
      const product = products.get(String(node.__parentId));
      const item = node.inventoryItem as
        | { id?: string; tracked?: boolean }
        | undefined;
      if (!product || !item?.id) continue;
      const variant: BulkProduct["variants"][number] = {
        variantId: String(node.id),
        title: String(node.title ?? ""),
        inventoryPolicy:
          node.inventoryPolicy === "CONTINUE" ? "CONTINUE" : "DENY",
        tracked: item.tracked !== false,
        inventoryItemId: item.id,
        locations: [],
      };
      product.variants.push(variant);
      variants.set(variant.variantId, variant);
      inventoryItems.set(item.id, variant);
    } else if (typename === "InventoryLevel") {
      const variant =
        inventoryItems.get(String(node.__parentId)) ??
        variants.get(String(node.__parentId));
      const location = node.location as
        | {
            id?: string;
            name?: string;
            fulfillsOnlineOrders?: boolean;
          }
        | undefined;
      const quantities = Array.isArray(node.quantities)
        ? (node.quantities as Array<{ name?: string; quantity?: number }>)
        : [];
      if (!variant || !location?.id) continue;
      variant.locations.push({
        locationId: location.id,
        locationName: location.name ?? "",
        fulfillsOnlineOrders: location.fulfillsOnlineOrders === true,
        available:
          quantities.find(({ name }) => name === "available")?.quantity ?? 0,
      });
    }
  }

  const expected = new Set(expectedProductIds);
  const relevant = [...products.values()].filter(({ id }) => expected.has(id));
  if (relevant.length !== expected.size) {
    throw new Error(
      `Bulk availability returned ${relevant.length} of ${expected.size} collection products`,
    );
  }

  const [settings, exclusions, previousStates] = await Promise.all([
    db.shopSettings.findUnique({
      where: { shop },
      select: { sortContinueSellingAsOos: true },
    }),
    db.excludedProduct.findMany({
      where: { shop, productId: { in: expectedProductIds } },
      select: { productId: true },
    }),
    db.productAvailabilityState.findMany({
      where: { shop, productId: { in: expectedProductIds } },
      select: { productId: true, soldOutAt: true },
    }),
  ]);
  const excluded = new Set(exclusions.map(({ productId }) => productId));
  const previous = new Map(
    previousStates.map(({ productId, soldOutAt }) => [productId, soldOutAt]),
  );

  for (let offset = 0; offset < relevant.length; offset += 100) {
    const batch = relevant.slice(offset, offset + 100);
    await db.$transaction(
      batch.map((product) => {
        const availability = classifyProductAvailability({
          variants: product.variants.map((variant) => ({
            variantId: variant.variantId,
            title: variant.title,
            inventoryPolicy: variant.inventoryPolicy,
            tracked: variant.tracked,
            locations: variant.locations,
          })),
          tags: product.tags,
          excluded: excluded.has(product.id),
          sortContinueSellingAsOos: settings?.sortContinueSellingAsOos ?? false,
          previousSoldOutAt: previous.get(product.id),
        });
        const data = {
          status: availability.status,
          ignored: availability.ignored,
          soldOutAt: availability.soldOutAt,
          variants: toJson(availability.variants),
          evaluatedAt: availability.evaluatedAt,
        };
        return db.productAvailabilityState.upsert({
          where: { shop_productId: { shop, productId: product.id } },
          update: data,
          create: { shop, productId: product.id, ...data },
        });
      }),
    );
  }
}

function sortQueryFor(sortOrder: BaseSortOrder) {
  const mapping: Record<BaseSortOrder, { sortKey: string; reverse: boolean }> =
    {
      ALPHA_ASC: { sortKey: "TITLE", reverse: false },
      ALPHA_DESC: { sortKey: "TITLE", reverse: true },
      BEST_SELLING: { sortKey: "BEST_SELLING", reverse: false },
      CREATED: { sortKey: "CREATED", reverse: false },
      CREATED_DESC: { sortKey: "CREATED", reverse: true },
      MANUAL: { sortKey: "MANUAL", reverse: false },
      MOST_RELEVANT: { sortKey: "COLLECTION_DEFAULT", reverse: false },
      PRICE_ASC: { sortKey: "PRICE", reverse: false },
      PRICE_DESC: { sortKey: "PRICE", reverse: true },
    };
  return mapping[sortOrder];
}

function normalizeBaseSortOrder(value: string): BaseSortOrder {
  const allowed = new Set<BaseSortOrder>([
    "ALPHA_ASC",
    "ALPHA_DESC",
    "BEST_SELLING",
    "CREATED",
    "CREATED_DESC",
    "MANUAL",
    "MOST_RELEVANT",
    "PRICE_ASC",
    "PRICE_DESC",
  ]);
  return allowed.has(value as BaseSortOrder)
    ? (value as BaseSortOrder)
    : "MANUAL";
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

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonNumberRecord(value: Prisma.JsonValue): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
