import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { BILLING_PLAN_NAMES, BILLING_TRIAL_DAYS } from "./services/billing";

if (process.env.NODE_ENV === "production") {
  for (const name of [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SHOPIFY_APP_URL",
    "DATABASE_URL",
    "CRON_SECRET",
    "RESEND_API_KEY",
    "ALERT_FROM_EMAIL",
    "SUPPORT_EMAIL",
  ]) {
    if (!process.env[name]?.trim()) {
      throw new Error(`${name} is required in production`);
    }
  }
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    [BILLING_PLAN_NAMES.STARTER]: {
      trialDays: BILLING_TRIAL_DAYS,
      lineItems: [
        {
          amount: 9.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [BILLING_PLAN_NAMES.GROWTH]: {
      trialDays: BILLING_TRIAL_DAYS,
      lineItems: [
        {
          amount: 14.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [BILLING_PLAN_NAMES.PRO]: {
      trialDays: BILLING_TRIAL_DAYS,
      lineItems: [
        {
          amount: 19.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [BILLING_PLAN_NAMES.ENTERPRISE]: {
      trialDays: BILLING_TRIAL_DAYS,
      lineItems: [
        {
          amount: 39.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      await prisma.shopSettings.upsert({
        where: { shop: session.shop },
        update: {},
        create: { shop: session.shop },
      });
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
