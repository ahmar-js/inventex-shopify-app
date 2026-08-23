import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import {
  classifyProductAvailability,
  type AvailabilityLocationInput,
  type AvailabilityStatus,
  type AvailabilityVariantInput,
  type InventoryPolicy,
  type VariantAvailability,
} from "./availability";

const VARIANT_PAGE_SIZE = 100;
const INVENTORY_LEVEL_PAGE_SIZE = 250;

interface InventoryLevelNode {
  location: {
    id: string;
    name: string;
    fulfillsOnlineOrders: boolean;
  };
  quantities: Array<{ name: string; quantity: number }>;
}

interface InventoryLevelConnection {
  nodes: InventoryLevelNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface VariantNode {
  id: string;
  title: string;
  inventoryPolicy: InventoryPolicy;
  inventoryItem: {
    id: string;
    tracked: boolean;
    inventoryLevels: InventoryLevelConnection;
  };
}

interface ProductAvailabilityData {
  id: string;
  title: string;
  tags: string[];
  variants: AvailabilityVariantInput[];
}

interface GraphqlErrorPayload {
  errors?: Array<{
    message?: string;
    extensions?: { code?: string };
  }>;
}

export interface ProductAvailabilityResult {
  productId: string;
  productTitle: string;
  status: AvailabilityStatus;
  variants: VariantAvailability[];
  ignored: boolean;
  ignoreReason: "tag" | "excludedProduct" | null;
  soldOutAt: Date | null;
  evaluatedAt: Date;
}

export class ProductNotFoundError extends Error {
  constructor(productId: string) {
    super(`Shopify product not found: ${productId}`);
    this.name = "ProductNotFoundError";
  }
}

export async function evaluateProductAvailability(
  admin: AdminApiContext,
  shop: string,
  productId: string,
  evaluatedAt = new Date(),
): Promise<ProductAvailabilityResult> {
  const [product, settings, exclusion, previous] = await Promise.all([
    fetchProductAvailabilityData(admin, productId),
    db.shopSettings.findUnique({
      where: { shop },
      select: { sortContinueSellingAsOos: true },
    }),
    db.excludedProduct.findUnique({
      where: { shop_productId: { shop, productId } },
      select: { id: true },
    }),
    db.productAvailabilityState.findUnique({
      where: { shop_productId: { shop, productId } },
      select: { soldOutAt: true },
    }),
  ]);

  const result = classifyProductAvailability({
    variants: product.variants,
    tags: product.tags,
    excluded: exclusion !== null,
    sortContinueSellingAsOos: settings?.sortContinueSellingAsOos ?? false,
    previousSoldOutAt: previous?.soldOutAt,
    evaluatedAt,
  });

  return {
    productId: product.id,
    productTitle: product.title,
    ...result,
  };
}

export async function resolveProductGidFromInventoryItem(
  admin: AdminApiContext,
  inventoryItemId: number | string,
): Promise<string | null> {
  const id = String(inventoryItemId).startsWith("gid://")
    ? String(inventoryItemId)
    : `gid://shopify/InventoryItem/${inventoryItemId}`;
  const response = await admin.graphql(
    `#graphql
      query resolveProductFromInventoryItem($id: ID!) {
        inventoryItem(id: $id) {
          variants(first: 1) {
            nodes {
              product { id }
            }
          }
        }
      }
    `,
    { variables: { id } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      inventoryItem?: {
        variants?: { nodes?: Array<{ product?: { id?: string } }> };
      } | null;
    };
  }>(response);
  return json.data?.inventoryItem?.variants?.nodes?.[0]?.product?.id ?? null;
}

async function fetchProductAvailabilityData(
  admin: AdminApiContext,
  productId: string,
): Promise<ProductAvailabilityData> {
  let cursor: string | null = null;
  let hasNextPage = true;
  let productTitle = "";
  let tags: string[] = [];
  const variants: AvailabilityVariantInput[] = [];

  while (hasNextPage) {
    const response: Response = await admin.graphql(
      `#graphql
        query productAvailability($productId: ID!, $cursor: String) {
          product(id: $productId) {
            id
            title
            tags
            variants(first: ${VARIANT_PAGE_SIZE}, after: $cursor) {
              nodes {
                id
                title
                inventoryPolicy
                inventoryItem {
                  id
                  tracked
                  inventoryLevels(first: ${INVENTORY_LEVEL_PAGE_SIZE}) {
                    nodes {
                      location {
                        id
                        name
                        fulfillsOnlineOrders
                      }
                      quantities(names: ["available"]) {
                        name
                        quantity
                      }
                    }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      { variables: { productId, cursor } },
    );
    const json = await readGraphqlResponse<{
      data?: {
        product?: {
          id: string;
          title: string;
          tags: string[];
          variants: {
            nodes: VariantNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      };
    }>(response);
    const product = json.data?.product;
    if (!product) throw new ProductNotFoundError(productId);

    productTitle = product.title;
    tags = product.tags;
    for (const variant of product.variants.nodes) {
      const levels = [...variant.inventoryItem.inventoryLevels.nodes];
      let levelPageInfo = variant.inventoryItem.inventoryLevels.pageInfo;
      while (levelPageInfo.hasNextPage && levelPageInfo.endCursor) {
        const next = await fetchInventoryLevelPage(
          admin,
          variant.inventoryItem.id,
          levelPageInfo.endCursor,
        );
        levels.push(...next.nodes);
        levelPageInfo = next.pageInfo;
      }

      variants.push({
        variantId: variant.id,
        title: variant.title,
        inventoryPolicy: variant.inventoryPolicy,
        tracked: variant.inventoryItem.tracked,
        locations: levels.map(toAvailabilityLocation),
      });
    }

    hasNextPage = product.variants.pageInfo.hasNextPage;
    cursor = product.variants.pageInfo.endCursor;
  }

  return { id: productId, title: productTitle, tags, variants };
}

async function fetchInventoryLevelPage(
  admin: AdminApiContext,
  inventoryItemId: string,
  cursor: string,
): Promise<InventoryLevelConnection> {
  const response = await admin.graphql(
    `#graphql
      query inventoryLevelPage($inventoryItemId: ID!, $cursor: String!) {
        inventoryItem(id: $inventoryItemId) {
          inventoryLevels(first: ${INVENTORY_LEVEL_PAGE_SIZE}, after: $cursor) {
            nodes {
              location { id name fulfillsOnlineOrders }
              quantities(names: ["available"]) { name quantity }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `,
    { variables: { inventoryItemId, cursor } },
  );
  const json = await readGraphqlResponse<{
    data?: {
      inventoryItem?: { inventoryLevels?: InventoryLevelConnection } | null;
    };
  }>(response);
  const connection = json.data?.inventoryItem?.inventoryLevels;
  if (!connection) {
    throw new Error(`Inventory item not found: ${inventoryItemId}`);
  }
  return connection;
}

function toAvailabilityLocation(
  level: InventoryLevelNode,
): AvailabilityLocationInput {
  const available = level.quantities.find(
    (quantity) => quantity.name === "available",
  )?.quantity;
  return {
    locationId: level.location.id,
    locationName: level.location.name,
    fulfillsOnlineOrders: level.location.fulfillsOnlineOrders,
    available: available ?? 0,
  };
}

async function readGraphqlResponse<T extends object>(
  response: Response,
): Promise<T> {
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
