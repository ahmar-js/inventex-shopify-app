import db from "../db.server";
import { authenticate } from "../shopify.server";
import { fetchAllCollectionIds } from "./collection-sort.server";
import { enqueueCollectionSortCommand } from "./webhooks.server";
import { getBillingAccess } from "./billing.server";
import { billingAccessMessage } from "./billing";
import { instrumentAdminApi } from "./observability.server";

export async function handleCollectionSortAction(request: Request) {
  const { admin: rawAdmin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const admin = instrumentAdminApi(rawAdmin, shop);
  const formData = await request.formData();
  const action = formData.get("_action");

  if (action === "setAutoSorting") {
    const collectionId = String(formData.get("collectionId") ?? "");
    const enabled = formData.get("enabled") === "true";
    const requestedBaseSortOrder = String(
      formData.get("baseSortOrder") ?? "MANUAL",
    );
    if (!collectionId)
      return failure("setAutoSorting", "Missing collection ID.");
    if (enabled) {
      const access = await getBillingAccess({ admin, session, force: true });
      if (!access.accessAllowed) {
        return failure(
          "setAutoSorting",
          billingAccessMessage(access) ?? "Automation requires a plan.",
          collectionId,
        );
      }
    }

    try {
      await db.collectionAutoSorting.upsert({
        where: { shop_collectionId: { shop, collectionId } },
        update: {
          enabled,
          disabledReason: null,
          ...(enabled && isBaseSortOrder(requestedBaseSortOrder)
            ? { baseSortOrder: requestedBaseSortOrder }
            : {}),
        },
        create: {
          shop,
          collectionId,
          enabled,
          baseSortOrder: isBaseSortOrder(requestedBaseSortOrder)
            ? requestedBaseSortOrder
            : "MANUAL",
        },
      });
      await enqueueCollectionSortCommand({
        shop,
        collectionId,
        command: enabled ? "enable" : "disable",
        baseSortOrder:
          enabled && isBaseSortOrder(requestedBaseSortOrder)
            ? requestedBaseSortOrder
            : undefined,
      });
      return {
        _action: "setAutoSorting" as const,
        success: true,
        collectionId,
        enabled,
      };
    } catch {
      return failure(
        "setAutoSorting",
        "Failed to queue auto sorting change.",
        collectionId,
      );
    }
  }

  if (action === "enableAllAutoSorting") {
    const access = await getBillingAccess({ admin, session, force: true });
    if (!access.accessAllowed) {
      return failure(
        "enableAllAutoSorting",
        billingAccessMessage(access) ?? "Automation requires a plan.",
      );
    }
    try {
      const collections = await fetchAllCollectionIds(admin);
      for (let offset = 0; offset < collections.length; offset += 100) {
        const batch = collections.slice(offset, offset + 100);
        await db.$transaction(
          batch.map(({ id: collectionId }) =>
            db.collectionAutoSorting.upsert({
              where: { shop_collectionId: { shop, collectionId } },
              update: { enabled: true, disabledReason: null },
              create: { shop, collectionId, enabled: true },
            }),
          ),
        );
        await Promise.all(
          batch.map(({ id: collectionId }) =>
            enqueueCollectionSortCommand({
              shop,
              collectionId,
              command: "enable",
            }),
          ),
        );
      }
      return {
        _action: "enableAllAutoSorting" as const,
        success: true,
        count: collections.length,
      };
    } catch {
      return failure(
        "enableAllAutoSorting",
        "Failed to queue sorting for all collections.",
      );
    }
  }

  const collectionId = String(formData.get("collectionId") ?? "");
  const sortOrder = String(formData.get("sortOrder") ?? "");
  if (!collectionId || !isBaseSortOrder(sortOrder)) {
    return failure(
      "changeSortOrder",
      "Missing or invalid sorting type.",
      collectionId,
    );
  }

  const access = await getBillingAccess({ admin, session, force: true });
  if (!access.accessAllowed) {
    return failure(
      "changeSortOrder",
      billingAccessMessage(access) ?? "Automation requires a plan.",
      collectionId,
    );
  }

  try {
    await db.collectionAutoSorting.upsert({
      where: { shop_collectionId: { shop, collectionId } },
      update: {
        enabled: true,
        baseSortOrder: sortOrder,
        disabledReason: null,
      },
      create: { shop, collectionId, enabled: true, baseSortOrder: sortOrder },
    });
    await enqueueCollectionSortCommand({
      shop,
      collectionId,
      command: "updateBaseOrder",
      baseSortOrder: sortOrder,
    });
    return {
      _action: "changeSortOrder" as const,
      success: true,
      collectionId,
      sortOrder,
    };
  } catch {
    return failure(
      "changeSortOrder",
      "Failed to queue the base-order change.",
      collectionId,
    );
  }
}

function failure(
  action: "setAutoSorting" | "enableAllAutoSorting" | "changeSortOrder",
  error: string,
  collectionId = "",
) {
  return { _action: action, success: false as const, error, collectionId };
}

function isBaseSortOrder(value: string) {
  return [
    "ALPHA_ASC",
    "ALPHA_DESC",
    "BEST_SELLING",
    "CREATED",
    "CREATED_DESC",
    "MANUAL",
    "PRICE_ASC",
    "PRICE_DESC",
  ].includes(value);
}
