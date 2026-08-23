/**
 * Inventory automation service layer.
 *
 * This module contains the core business logic for handling inventory changes.
 * Routes (webhook handlers) call into this service — keeping controllers thin.
 */

import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { maybeFireAlerts } from "./alerts.server";

// ─── Types ──────────────────────────────────────────────────

export type Strategy = "HIDE" | "PUSH_DOWN";
export type RestoreBehavior = "ALWAYS" | "CONDITIONAL" | "NONE";

export interface InventoryUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
  updated_at: string;
}

// ─── Main handler ───────────────────────────────────────────

/**
 * Called by the inventory_levels/update webhook route.
 *
 * Determines whether a product should be hidden/pushed-down or restored
 * based on the merchant's settings and the new inventory level.
 */
export async function handleInventoryUpdate(
  admin: AdminApiContext,
  shop: string,
  payload: InventoryUpdatePayload,
) {
  const settings = await db.shopSettings.findUnique({ where: { shop } });

  if (!settings || !settings.enabled) {
    console.log(`[inventory] Automation disabled for ${shop}, skipping.`);
    return;
  }

  const { inventory_item_id, available } = payload;

  const productId = await resolveProductId(admin, inventory_item_id);
  if (!productId) {
    console.log(
      `[inventory] Could not resolve product for inventory item ${inventory_item_id}`,
    );
    return;
  }

  if (available <= 0) {
    // Check if product is in collection scope before acting
    const inScope = await isProductInScope(admin, shop, productId);
    if (!inScope) {
      console.log(
        `[inventory] Product ${productId} not in any tracked collection, skipping.`,
      );
      // Still check alerts even when outside automation scope
      await maybeFireAlerts(admin, shop, productId).catch((err) =>
        console.error("[inventory] maybeFireAlerts error:", err),
      );
      return;
    }
    // Check if product is explicitly excluded
    const excluded = await isProductExcluded(shop, productId);
    if (excluded) {
      console.log(
        `[inventory] Product ${productId} is excluded from automation, skipping.`,
      );
      // Still check alerts for excluded products
      await maybeFireAlerts(admin, shop, productId).catch((err) =>
        console.error("[inventory] maybeFireAlerts error:", err),
      );
      return;
    }
    await handleOutOfStock(admin, shop, productId, settings.strategy as Strategy);
    // Fire stock alerts after handling automation
    await maybeFireAlerts(admin, shop, productId).catch((err) =>
      console.error("[inventory] maybeFireAlerts error:", err),
    );
  } else {
    await handleBackInStock(
      admin,
      shop,
      productId,
      settings.restoreBehavior as RestoreBehavior,
    );
    // Low-stock alerts apply even when product is not fully out of stock
    await maybeFireAlerts(admin, shop, productId).catch((err) =>
      console.error("[inventory] maybeFireAlerts error:", err),
    );
  }
}

// ─── Resolve product from inventory item ────────────────────

/**
 * Check if a product is explicitly excluded from automation.
 */
async function isProductExcluded(
  shop: string,
  productId: string,
  preloadedExclusions?: Set<string>,
): Promise<boolean> {
  if (preloadedExclusions) {
    return preloadedExclusions.has(productId);
  }
  const found = await db.excludedProduct.findUnique({
    where: { shop_productId: { shop, productId } },
  });
  return !!found;
}

/**
 * Check if a product belongs to at least one of the merchant's
 * tracked collections. If no collection rules exist, ALL products
 * are considered in scope.
 */
async function isProductInScope(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  preloadedRules?: Array<{ collectionId: string }>,
): Promise<boolean> {
  const rules =
    preloadedRules ??
    (await db.collectionRule.findMany({
      where: { shop },
      select: { collectionId: true },
    }));

  // No rules = all products in scope (store-wide mode)
  if (rules.length === 0) return true;

  // Query the product's collections
  const response = await admin.graphql(
    `#graphql
    query checkProductCollections($productId: ID!) {
      product(id: $productId) {
        collections(first: 100) {
          edges {
            node {
              id
            }
          }
        }
      }
    }`,
    { variables: { productId } },
  );

  const json = await response.json();
  const productCollectionIds = new Set(
    (json.data?.product?.collections?.edges ?? []).map(
      (e: any) => e.node.id,
    ),
  );

  const ruleIds = rules.map((r: { collectionId: string }) => r.collectionId);
  return ruleIds.some((id: string) => productCollectionIds.has(id));
}

// ─── Resolve product — inventory item → variant → product ───

/**
 * Given an inventory_item_id, query Shopify to find the product GID.
 * Path: inventoryItem → variant → product
 */
async function resolveProductId(
  admin: AdminApiContext,
  inventoryItemId: number,
): Promise<string | null> {
  try {
    const response = await admin.graphql(
      `#graphql
      query resolveProduct($inventoryItemId: ID!) {
        inventoryItem(id: $inventoryItemId) {
          variant {
            product {
              id
            }
          }
        }
      }`,
      {
        variables: {
          inventoryItemId: `gid://shopify/InventoryItem/${inventoryItemId}`,
        },
      },
    );

    const json = await response.json();
    const productId = json.data?.inventoryItem?.variant?.product?.id ?? null;

    if (productId) {
      console.log(
        `[inventory] Resolved inventory item ${inventoryItemId} → ${productId}`,
      );
    }

    return productId;
  } catch (error) {
    console.error(
      `[inventory] Failed to resolve product for inventory item ${inventoryItemId}:`,
      error,
    );
    return null;
  }
}

// ─── Out-of-stock handling ──────────────────────────────────

/**
 * Handle a product going out of stock.
 * HIDE → unpublish from Online Store.
 * PUSH_DOWN → move to bottom of all its collections.
 */
async function handleOutOfStock(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  strategy: Strategy,
) {
  // Check if we already tracked this product as modified
  const existing = await db.inventoryState.findUnique({
    where: { shop_productId: { shop, productId } },
  });

  if (existing && !existing.restored) {
    console.log(
      `[inventory] Product ${productId} already handled, skipping.`,
    );
    return;
  }

  console.log(
    `[inventory] Product ${productId} is out of stock. Strategy: ${strategy}`,
  );

  let previousState: string | null = null;
  let errorMessage: string | null = null;

  try {
    if (strategy === "HIDE") {
      previousState = await hideProduct(admin, productId);
    } else {
      previousState = await pushProductToBottom(admin, productId);
    }
  } catch (err: any) {
    errorMessage = err?.message ?? String(err);
    console.error(`[inventory] Error applying ${strategy} to ${productId}:`, err);
  }

  // Record what we did (or failed to do) so we can audit/restore later
  await db.inventoryState.upsert({
    where: { shop_productId: { shop, productId } },
    create: {
      shop,
      productId,
      action: strategy === "HIDE" ? "HIDDEN" : "PUSHED_DOWN",
      previousState,
      error: errorMessage !== null,
      errorMessage,
    },
    update: {
      action: strategy === "HIDE" ? "HIDDEN" : "PUSHED_DOWN",
      previousState,
      restored: false,
      restoredAt: null,
      modifiedAt: new Date(),
      error: errorMessage !== null,
      errorMessage,
    },
  });
}

/**
 * Unpublish a product from the Online Store sales channel.
 * Returns JSON string of the publication IDs it was published to (for restore).
 */
async function hideProduct(
  admin: AdminApiContext,
  productId: string,
): Promise<string | null> {
  try {
    // Step 1: Find which publications this product is currently on
    const pubResponse = await admin.graphql(
      `#graphql
      query getProductPublications($productId: ID!) {
        product(id: $productId) {
          resourcePublicationsV2(first: 20) {
            edges {
              node {
                publication {
                  id
                  name
                }
                isPublished
              }
            }
          }
        }
      }`,
      { variables: { productId } },
    );

    const pubJson = await pubResponse.json();
    const publications =
      pubJson.data?.product?.resourcePublicationsV2?.edges ?? [];

    // Save the current publication state so we can restore later
    const publishedIds = publications
      .filter((e: any) => e.node.isPublished)
      .map((e: any) => ({
        id: e.node.publication.id,
        name: e.node.publication.name,
      }));

    if (publishedIds.length === 0) {
      console.log(`[inventory] Product ${productId} is already unpublished.`);
      return JSON.stringify(publishedIds);
    }

    // Step 2: Unpublish from all channels
    const unpubResponse = await admin.graphql(
      `#graphql
      mutation unpublishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          id: productId,
          input: publishedIds.map((p: any) => ({
            publicationId: p.id,
          })),
        },
      },
    );

    const unpubJson = await unpubResponse.json();
    const errors = unpubJson.data?.publishableUnpublish?.userErrors ?? [];

    if (errors.length > 0) {
      console.error(`[inventory] Errors unpublishing ${productId}:`, errors);
    } else {
      console.log(
        `[inventory] Unpublished product ${productId} from ${publishedIds.length} channel(s).`,
      );
    }

    return JSON.stringify(publishedIds);
  } catch (error) {
    console.error(`[inventory] Failed to hide product ${productId}:`, error);
    return null;
  }
}

/**
 * Move a product to the bottom of all its collections.
 * Returns JSON string of collection IDs + original sort orders (for restore).
 *
 * For non-MANUAL collections, we first switch them to MANUAL sort order
 * (preserving the current visual order), then move the product to the end.
 */
async function pushProductToBottom(
  admin: AdminApiContext,
  productId: string,
): Promise<string | null> {
  try {
    // Step 1: Find all collections this product belongs to
    const collectionsResponse = await admin.graphql(
      `#graphql
      query getProductCollections($productId: ID!) {
        product(id: $productId) {
          collections(first: 50) {
            edges {
              node {
                id
                title
                sortOrder
              }
            }
          }
        }
      }`,
      { variables: { productId } },
    );

    const collectionsJson = await collectionsResponse.json();
    const collections =
      collectionsJson.data?.product?.collections?.edges ?? [];

    if (collections.length === 0) {
      console.log(`[inventory] Product ${productId} is not in any collections.`);
      return JSON.stringify([]);
    }

    const collectionData: Array<{ id: string; title: string; sortOrder: string }> = [];

    for (const edge of collections) {
      const collection = edge.node;
      collectionData.push({
        id: collection.id,
        title: collection.title,
        sortOrder: collection.sortOrder,
      });

      // Step 2: If the collection is NOT manual, switch it to MANUAL first.
      // This preserves the current visual ordering but allows us to reorder.
      if (collection.sortOrder !== "MANUAL") {
        console.log(
          `[inventory] Collection "${collection.title}" uses ${collection.sortOrder} sort. Switching to MANUAL.`,
        );

        const updateResponse = await admin.graphql(
          `#graphql
          mutation setCollectionManualSort($input: CollectionInput!) {
            collectionUpdate(input: $input) {
              userErrors {
                field
                message
              }
            }
          }`,
          {
            variables: {
              input: {
                id: collection.id,
                sortOrder: "MANUAL",
              },
            },
          },
        );

        const updateJson = await updateResponse.json();
        const updateErrors =
          updateJson.data?.collectionUpdate?.userErrors ?? [];

        if (updateErrors.length > 0) {
          console.error(
            `[inventory] Failed to set MANUAL sort on "${collection.title}":`,
            updateErrors,
          );
          continue;
        }
      }

      // Step 3: Get all products in the collection in current order
      const productsResponse = await admin.graphql(
        `#graphql
        query getCollectionProducts($collectionId: ID!) {
          collection(id: $collectionId) {
            products(first: 250, sortKey: COLLECTION_DEFAULT) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }`,
        { variables: { collectionId: collection.id } },
      );

      const productsJson = await productsResponse.json();
      const productEdges =
        productsJson.data?.collection?.products?.edges ?? [];
      const allProductIds = productEdges.map((e: any) => e.node.id);

      const currentIndex = allProductIds.indexOf(productId);

      if (currentIndex === -1) {
        console.log(
          `[inventory] Product not found in "${collection.title}" product list, skipping.`,
        );
        continue;
      }

      if (currentIndex === allProductIds.length - 1) {
        console.log(
          `[inventory] Product already at bottom of "${collection.title}", skipping.`,
        );
        continue;
      }

      // Step 4: Move product to the last position (0-indexed)
      const lastPosition = (allProductIds.length - 1).toString();
      const reorderResponse = await admin.graphql(
        `#graphql
        mutation reorderCollectionProducts($id: ID!, $moves: [MoveInput!]!) {
          collectionReorderProducts(id: $id, moves: $moves) {
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            id: collection.id,
            moves: [{ id: productId, newPosition: lastPosition }],
          },
        },
      );

      const reorderJson = await reorderResponse.json();
      const reorderErrors =
        reorderJson.data?.collectionReorderProducts?.userErrors ?? [];

      if (reorderErrors.length > 0) {
        console.error(
          `[inventory] Errors reordering in "${collection.title}":`,
          reorderErrors,
        );
      } else {
        console.log(
          `[inventory] Pushed ${productId} to bottom of "${collection.title}".`,
        );
      }
    }

    return JSON.stringify(collectionData);
  } catch (error) {
    console.error(
      `[inventory] Failed to push product ${productId} to bottom:`,
      error,
    );
    return null;
  }
}

// ─── Back-in-stock handling ─────────────────────────────────

/**
 * Handle a product coming back in stock.
 * Applies the merchant's chosen restore behavior.
 */
async function handleBackInStock(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  restoreBehavior: RestoreBehavior,
) {
  if (restoreBehavior === "NONE") {
    console.log(
      `[inventory] Restore behavior is NONE for ${shop}, skipping restore.`,
    );
    return;
  }

  const existing = await db.inventoryState.findUnique({
    where: { shop_productId: { shop, productId } },
  });

  if (!existing || existing.restored) {
    if (restoreBehavior === "CONDITIONAL") {
      console.log(
        `[inventory] Product ${productId} was not modified by app, skipping (CONDITIONAL).`,
      );
      return;
    }
    if (!existing) {
      console.log(
        `[inventory] No tracked state for ${productId}, nothing to restore.`,
      );
      return;
    }
  }

  console.log(
    `[inventory] Restoring product ${productId} (behavior: ${restoreBehavior}, action was: ${existing.action})`,
  );

  let errorMessage: string | null = null;

  try {
    if (existing.action === "HIDDEN") {
      await restoreProduct(admin, productId, existing.previousState);
    } else if (existing.action === "PUSHED_DOWN") {
      await restoreCollectionSortOrder(admin, existing.previousState);
    }
  } catch (err: any) {
    errorMessage = err?.message ?? String(err);
    console.error(`[inventory] Error restoring ${productId}:`, err);
  }

  await db.inventoryState.update({
    where: { shop_productId: { shop, productId } },
    data: {
      restored: errorMessage === null,
      restoredAt: errorMessage === null ? new Date() : null,
      error: errorMessage !== null,
      errorMessage,
    },
  });
}

/**
 * Republish a product to the channels it was previously published on.
 */
async function restoreProduct(
  admin: AdminApiContext,
  productId: string,
  previousState: string | null,
) {
  if (!previousState) {
    console.log(
      `[inventory] No previous publication state for ${productId}, cannot restore.`,
    );
    return;
  }

  try {
    const publishedChannels: Array<{ id: string; name: string }> =
      JSON.parse(previousState);

    if (publishedChannels.length === 0) {
      console.log(
        `[inventory] Product ${productId} had no publications to restore.`,
      );
      return;
    }

    const pubResponse = await admin.graphql(
      `#graphql
      mutation republishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors {
            field
            message
          }
        }
      }`,
      {
        variables: {
          id: productId,
          input: publishedChannels.map((p) => ({
            publicationId: p.id,
          })),
        },
      },
    );

    const pubJson = await pubResponse.json();
    const errors = pubJson.data?.publishablePublish?.userErrors ?? [];

    if (errors.length > 0) {
      console.error(`[inventory] Errors republishing ${productId}:`, errors);
    } else {
      console.log(
        `[inventory] Republished product ${productId} to ${publishedChannels.length} channel(s).`,
      );
    }
  } catch (error) {
    console.error(
      `[inventory] Failed to restore product ${productId}:`,
      error,
    );
  }
}

/**
 * Restore the original sort order for collections that were switched to
 * MANUAL when a product was pushed to the bottom.
 */
async function restoreCollectionSortOrder(
  admin: AdminApiContext,
  previousState: string | null,
) {
  if (!previousState) {
    console.log(
      `[inventory] No previous collection state, cannot restore sort order.`,
    );
    return;
  }

  try {
    const collections: Array<{ id: string; title: string; sortOrder: string }> =
      JSON.parse(previousState);

    if (collections.length === 0) {
      console.log(`[inventory] No collections to restore sort order for.`);
      return;
    }

    for (const col of collections) {
      // Only restore if the original sort order wasn't already MANUAL
      if (col.sortOrder === "MANUAL") {
        console.log(
          `[inventory] Collection "${col.title}" was already MANUAL, skipping sort restore.`,
        );
        continue;
      }

      const response = await admin.graphql(
        `#graphql
        mutation restoreCollectionSort($input: CollectionInput!) {
          collectionUpdate(input: $input) {
            collection {
              id
              sortOrder
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              id: col.id,
              sortOrder: col.sortOrder,
            },
          },
        },
      );

      const json = await response.json();
      const errors = json.data?.collectionUpdate?.userErrors ?? [];

      if (errors.length > 0) {
        console.error(
          `[inventory] Errors restoring sort order for "${col.title}":`,
          errors,
        );
      } else {
        console.log(
          `[inventory] Restored collection "${col.title}" sort order to ${col.sortOrder}.`,
        );
      }
    }
  } catch (error) {
    console.error(`[inventory] Failed to restore collection sort order:`, error);
  }
}

// ─── Bulk scan ──────────────────────────────────────────────

/**
 * Scan all products in the store and apply the current strategy
 * to any that are already out of stock. This handles products that
 * were out of stock before the app was installed/enabled.
 *
 * Returns { processed, affected } counts.
 */
export async function scanExistingProducts(
  admin: AdminApiContext,
  shop: string,
): Promise<{ processed: number; affected: number }> {
  const settings = await db.shopSettings.findUnique({ where: { shop } });

  if (!settings || !settings.enabled) {
    console.log(`[scan] Automation disabled for ${shop}, skipping scan.`);
    return { processed: 0, affected: 0 };
  }

  const strategy = settings.strategy as Strategy;
  let processed = 0;
  let affected = 0;
  let cursor: string | null = null;
  let hasNextPage = true;

  // Preload collection rules once for the entire scan
  const rules = await db.collectionRule.findMany({
    where: { shop },
    select: { collectionId: true },
  });

  // Preload excluded product IDs once for the entire scan
  const exclusions = await db.excludedProduct.findMany({
    where: { shop },
    select: { productId: true },
  });
  const excludedSet = new Set(exclusions.map((e: any) => e.productId));

  console.log(`[scan] Starting bulk scan for ${shop} (strategy: ${strategy})`);

  while (hasNextPage) {
    const response: any = await admin.graphql(
      `#graphql
      query getProducts($cursor: String) {
        products(first: 50, after: $cursor) {
          edges {
            node {
              id
              title
              totalInventory
              status
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }`,
      { variables: { cursor } },
    );

    const json: any = await response.json();
    const edges: any[] = json.data?.products?.edges ?? [];
    hasNextPage = json.data?.products?.pageInfo?.hasNextPage ?? false;

    if (edges.length > 0) {
      cursor = edges[edges.length - 1].cursor;
    }

    for (const edge of edges) {
      const product = edge.node;
      processed++;

      // Skip draft/archived products
      if (product.status !== "ACTIVE") {
        continue;
      }

      // Check if already tracked and not restored
      const existing = await db.inventoryState.findUnique({
        where: { shop_productId: { shop, productId: product.id } },
      });

      if (existing && !existing.restored) {
        // Already handled
        continue;
      }

      if (product.totalInventory <= 0) {
        // Check product exclusion list
        if (excludedSet.has(product.id)) continue;

        // Check collection scope (pass preloaded rules to avoid extra DB hits)
        if (rules.length > 0) {
          const inScope = await isProductInScope(
            admin,
            shop,
            product.id,
            rules,
          );
          if (!inScope) continue;
        }

        console.log(
          `[scan] Product "${product.title}" (${product.id}) is out of stock. Applying ${strategy}.`,
        );

        try {
          await handleOutOfStock(admin, shop, product.id, strategy);
          affected++;
        } catch (error) {
          console.error(
            `[scan] Error processing "${product.title}":`,
            error,
          );
        }
      }
    }
  }

  console.log(
    `[scan] Completed for ${shop}. Processed: ${processed}, Affected: ${affected}`,
  );

  return { processed, affected };
}
