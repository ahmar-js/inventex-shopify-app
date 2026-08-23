import type {
  AdminApiContext,
  Session,
} from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import {
  BILLING_PLANS,
  resolveBillingEntitlement,
  type SubscriptionDetails,
} from "./billing";
import { logger } from "./logger.server";
import {
  captureOperationalError,
  instrumentAdminApi,
} from "./observability.server";

const BILLING_CACHE_MS = 5 * 60 * 1_000;

interface BillingContextQuery {
  data?: {
    productsCount?: { count: number } | null;
    currentAppInstallation?: {
      activeSubscriptions: SubscriptionDetails[];
    } | null;
    shop?: {
      plan: {
        partnerDevelopment: boolean;
        shopifyPlus: boolean;
        publicDisplayName: string;
      };
    } | null;
  };
}

export interface BillingAccess {
  productCount: number;
  requiredPlan: string;
  subscribedPlan: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string;
  subscriptionTest: boolean;
  trialEndsAt: string | null;
  developmentStore: boolean;
  shopPlan: string | null;
  accessAllowed: boolean;
  accessReason: string;
  checkedAt: string | null;
}

export async function getBillingAccess(input: {
  admin: AdminApiContext;
  session: Session;
  force?: boolean;
}): Promise<BillingAccess> {
  const cached = await db.billingState.findUnique({
    where: { shop: input.session.shop },
  });
  if (
    !input.force &&
    cached?.checkedAt &&
    Date.now() - cached.checkedAt.getTime() < BILLING_CACHE_MS
  ) {
    return serializeBillingState(cached);
  }

  return refreshBillingAccess(input.admin, input.session);
}

export async function refreshBillingAccess(
  admin: AdminApiContext,
  session: Session,
): Promise<BillingAccess> {
  try {
    const measuredAdmin = instrumentAdminApi(admin, session.shop);
    const contextResponse = await measuredAdmin.graphql(`#graphql
        query InventexBillingContext {
          productsCount(query: "status:active,draft", limit: null) {
            count
          }
          shop {
            plan {
              partnerDevelopment
              shopifyPlus
              publicDisplayName
            }
          }
          currentAppInstallation {
            activeSubscriptions {
              id
              name
              status
              test
              trialDays
              createdAt
            }
          }
        }
      `);
    const context = (await contextResponse.json()) as BillingContextQuery;
    const shopPlan = context.data?.shop?.plan;
    const productCount = context.data?.productsCount?.count;
    const installation = context.data?.currentAppInstallation;
    if (!shopPlan || typeof productCount !== "number" || !installation) {
      throw new Error("Shopify billing context query returned incomplete data");
    }

    const subscriptions: SubscriptionDetails[] =
      installation.activeSubscriptions.map((subscription) => ({
        id: subscription.id,
        name: subscription.name,
        status: subscription.status,
        test: subscription.test,
        trialDays: subscription.trialDays,
        createdAt: subscription.createdAt,
      }));
    const entitlement = resolveBillingEntitlement({
      productCount,
      shopPlan,
      subscriptions,
    });
    const subscription = entitlement.subscription;
    const checkedAt = new Date();
    const trialEndsAt = subscription?.trialDays
      ? new Date(
          new Date(subscription.createdAt).getTime() +
            subscription.trialDays * 24 * 60 * 60 * 1_000,
        )
      : null;
    const data = {
      productCount: entitlement.productCount,
      requiredPlan: entitlement.requiredPlan.name,
      subscribedPlan: entitlement.subscribedPlan?.name ?? null,
      subscriptionId: subscription?.id ?? null,
      subscriptionStatus: subscription?.status ?? "NONE",
      subscriptionTest: subscription?.test ?? false,
      trialEndsAt,
      developmentStore: entitlement.developmentStore,
      shopPlan: shopPlan.publicDisplayName,
      accessAllowed: entitlement.accessAllowed,
      accessReason: entitlement.accessReason,
      checkedAt,
    };
    const state = await db.billingState.upsert({
      where: { shop: session.shop },
      update: data,
      create: { shop: session.shop, ...data },
    });
    logger.info("Billing entitlement refreshed", {
      shop: session.shop,
      productCount,
      billingPlan: state.subscribedPlan ?? state.requiredPlan,
      accessAllowed: state.accessAllowed,
      reason: state.accessReason,
    });
    return serializeBillingState(state);
  } catch (error) {
    logger.error("Billing entitlement refresh failed closed", {
      shop: session.shop,
      error,
    });
    await captureOperationalError({
      shop: session.shop,
      source: "billing",
      message: "Billing entitlement refresh failed closed",
      error,
    });
    const existing = await db.billingState.findUnique({
      where: { shop: session.shop },
    });
    const state = await db.billingState.upsert({
      where: { shop: session.shop },
      update: {
        accessAllowed: false,
        accessReason: "CHECK_FAILED",
        checkedAt: new Date(),
      },
      create: {
        shop: session.shop,
        productCount: existing?.productCount ?? 0,
        requiredPlan: existing?.requiredPlan ?? BILLING_PLANS[0].name,
        accessAllowed: false,
        accessReason: "CHECK_FAILED",
        checkedAt: new Date(),
      },
    });
    return serializeBillingState(state);
  }
}

export async function getBillingAccessForShop(shop: string, force = false) {
  const { admin, session } = await unauthenticated.admin(shop);
  return getBillingAccess({ admin, session, force });
}

export async function isAutomationAllowed(shop: string) {
  try {
    return (await getBillingAccessForShop(shop)).accessAllowed;
  } catch (error) {
    logger.error("Automation blocked because billing could not be checked", {
      shop,
      error,
    });
    return false;
  }
}

export async function invalidateBillingState(shop: string) {
  await db.billingState.updateMany({
    where: { shop },
    data: { checkedAt: null },
  });
}

function serializeBillingState(state: {
  productCount: number;
  requiredPlan: string;
  subscribedPlan: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string;
  subscriptionTest: boolean;
  trialEndsAt: Date | null;
  developmentStore: boolean;
  shopPlan: string | null;
  accessAllowed: boolean;
  accessReason: string;
  checkedAt: Date | null;
}): BillingAccess {
  return {
    ...state,
    trialEndsAt: state.trialEndsAt?.toISOString() ?? null,
    checkedAt: state.checkedAt?.toISOString() ?? null,
  };
}
