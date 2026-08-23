import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  INVENTEX_IGNORE_TAG,
  normalizeRedirectMode,
  normalizeRedirectPath,
} from "./hide";
import { getBillingAccess } from "./billing.server";
import { billingAccessMessage } from "./billing";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import {
  cancelAllPendingProductHides,
  enqueueHideCatalogScan,
  enqueueHideProduct,
  enqueueProductEvaluation,
  enqueueRepublishHiddenProducts,
} from "./webhooks.server";

export async function handleHideAction(request: Request) {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const action = String(formData.get("_action") ?? "saveHideSettings");

  if (action === "addExcludedProducts") {
    let products: Array<{ id: string; title: string }>;
    try {
      products = parseProducts(String(formData.get("products") ?? "[]"));
      await updateIgnoreTags(
        admin,
        products.map(({ id }) => id),
        true,
      );
    } catch (error) {
      return failure(
        action,
        error instanceof Error ? error.message : "Failed to ignore products.",
      );
    }
    await db.$transaction(
      products.map((product) =>
        db.excludedProduct.upsert({
          where: {
            shop_productId: { shop, productId: product.id },
          },
          update: { productTitle: product.title },
          create: {
            shop,
            productId: product.id,
            productTitle: product.title,
          },
        }),
      ),
    );
    const sourceJobId = `ignore:${Date.now()}`;
    await Promise.all(
      products.map((product) =>
        enqueueProductEvaluation({
          shop,
          productId: product.id,
          sourceJobId,
          reason: "ignoreChanged",
        }),
      ),
    );
    return { success: true, action, count: products.length };
  }

  if (action === "removeExcludedProduct") {
    const productId = String(formData.get("productId") ?? "");
    if (!productId) return failure(action, "Missing product ID.");
    try {
      await updateIgnoreTags(admin, [productId], false);
    } catch (error) {
      return failure(
        action,
        error instanceof Error
          ? error.message
          : "Failed to remove the ignore tag.",
      );
    }
    await db.excludedProduct.deleteMany({ where: { shop, productId } });
    await enqueueProductEvaluation({
      shop,
      productId,
      sourceJobId: `ignore:${Date.now()}`,
      reason: "ignoreChanged",
    });
    return { success: true, action };
  }

  if (action === "scanNow") {
    const billing = await getBillingAccess({ admin, session, force: true });
    if (!billing.accessAllowed) {
      return failure(
        action,
        billingAccessMessage(billing) ?? "Automation requires a plan.",
      );
    }
    const current = await db.shopSettings.findUnique({ where: { shop } });
    if (!current?.hideEnabled) {
      return failure(action, "Enable hiding before scanning the catalog.");
    }
    if (await hideSettingsAreLocked(shop, current.hideJobId)) {
      return failure(action, "A catalog hide job is already running.");
    }
    const result = await enqueueHideCatalogScan(shop);
    await setHideJobLock(shop, result.job.id);
    return { success: true, action, jobId: result.job.id };
  }

  const current = await db.shopSettings.findUnique({ where: { shop } });
  if (await hideSettingsAreLocked(shop, current?.hideJobId ?? null)) {
    return failure(
      action,
      "Hide settings are locked while the catalog job runs.",
    );
  }

  const hideEnabled = formData.get("hideEnabled") === "true";
  if (hideEnabled) {
    const billing = await getBillingAccess({ admin, session, force: true });
    if (!billing.accessAllowed) {
      return failure(
        action,
        billingAccessMessage(billing) ?? "Automation requires a plan.",
      );
    }
  }
  const parsedDelay = Number(formData.get("hideDelayDays") ?? 0);
  if (!Number.isInteger(parsedDelay) || parsedDelay < 0 || parsedDelay > 365) {
    return failure(action, "Delay must be a whole number from 0 to 365.");
  }
  const redirectMode = normalizeRedirectMode(
    String(formData.get("redirectMode") ?? current?.redirectMode ?? "none"),
  );
  let redirectPath = String(
    formData.get("redirectPath") ?? current?.redirectPath ?? "/",
  );
  try {
    if (redirectMode === "custom") {
      redirectPath = normalizeRedirectPath(redirectPath);
    }
  } catch (error) {
    return failure(
      action,
      error instanceof Error ? error.message : String(error),
    );
  }

  await db.shopSettings.upsert({
    where: { shop },
    create: {
      shop,
      hideEnabled,
      hideDelayDays: parsedDelay,
      redirectMode,
      redirectPath,
    },
    update: {
      hideEnabled,
      hideDelayDays: parsedDelay,
      redirectMode,
      redirectPath,
    },
  });

  const wasEnabled = current?.hideEnabled ?? false;
  if (hideEnabled && !wasEnabled) {
    const result = await enqueueHideCatalogScan(shop);
    await setHideJobLock(shop, result.job.id);
    return { success: true, action, jobId: result.job.id, operation: "scan" };
  }
  if (!hideEnabled && wasEnabled) {
    await cancelAllPendingProductHides(shop);
    const result = await enqueueRepublishHiddenProducts(shop);
    await setHideJobLock(shop, result.job.id);
    return {
      success: true,
      action,
      jobId: result.job.id,
      operation: "republish",
    };
  }
  if (hideEnabled && current && current.hideDelayDays !== parsedDelay) {
    await rescheduleSoldOutProducts(shop, parsedDelay);
  }

  return { success: true, action, operation: "saved" };
}

async function rescheduleSoldOutProducts(shop: string, delayDays: number) {
  const products = await db.productAvailabilityState.findMany({
    where: {
      shop,
      status: "soldOut",
      ignored: false,
      soldOutAt: { not: null },
    },
    select: { productId: true, soldOutAt: true },
  });
  await Promise.all(
    products.map(({ productId, soldOutAt }) =>
      enqueueHideProduct({
        shop,
        productId,
        soldOutAt: soldOutAt!,
        delayDays,
        sourceJobId: "hide-settings",
      }),
    ),
  );
}

async function hideSettingsAreLocked(shop: string, jobId: string | null) {
  if (!jobId) return false;
  const job = await db.job.findFirst({
    where: { id: jobId, shop },
    select: { status: true },
  });
  return job?.status === "PENDING" || job?.status === "PROCESSING";
}

async function setHideJobLock(shop: string, jobId: string) {
  await db.shopSettings.update({ where: { shop }, data: { hideJobId: jobId } });
}

function parseProducts(value: string) {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Invalid product selection.");
  return parsed
    .filter(
      (product): product is { id: string; title: string } =>
        typeof product === "object" &&
        product !== null &&
        "id" in product &&
        "title" in product &&
        typeof product.id === "string" &&
        typeof product.title === "string",
    )
    .slice(0, 250);
}

function failure(action: string, error: string) {
  return { success: false as const, action, error };
}

async function updateIgnoreTags(
  admin: AdminApiContext,
  productIds: string[],
  add: boolean,
) {
  for (let offset = 0; offset < productIds.length; offset += 10) {
    await Promise.all(
      productIds.slice(offset, offset + 10).map(async (productId) => {
        const response = await admin.graphql(
          add
            ? `#graphql
                mutation InventexAddIgnoreTag($id: ID!, $tags: [String!]!) {
                  tagsAdd(id: $id, tags: $tags) {
                    userErrors { field message }
                  }
                }
              `
            : `#graphql
                mutation InventexRemoveIgnoreTag($id: ID!, $tags: [String!]!) {
                  tagsRemove(id: $id, tags: $tags) {
                    userErrors { field message }
                  }
                }
              `,
          { variables: { id: productId, tags: [INVENTEX_IGNORE_TAG] } },
        );
        const json = (await response.json()) as {
          data?: {
            tagsAdd?: { userErrors: Array<{ message: string }> };
            tagsRemove?: { userErrors: Array<{ message: string }> };
          };
          errors?: Array<{ message: string }>;
        };
        const userErrors = add
          ? json.data?.tagsAdd?.userErrors
          : json.data?.tagsRemove?.userErrors;
        if (!userErrors && !json.errors?.length) {
          throw new Error("Shopify did not confirm the product tag update.");
        }
        const messages = [
          ...(json.errors ?? []).map(({ message }) => message),
          ...(userErrors ?? []).map(({ message }) => message),
        ];
        if (messages.length > 0) throw new Error(messages.join("; "));
      }),
    );
  }
}
