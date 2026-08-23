import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BILLING_PLAN_NAMES,
  billingPlanCoversProducts,
  requiredPlanForProductCount,
  resolveBillingEntitlement,
} from "../app/services/billing.ts";

const paidShop = {
  partnerDevelopment: false,
  shopifyPlus: false,
  publicDisplayName: "Basic",
};

const subscription = (name, overrides = {}) => ({
  id: "gid://shopify/AppSubscription/1",
  name,
  status: "ACTIVE",
  test: false,
  trialDays: 7,
  createdAt: "2026-08-23T00:00:00.000Z",
  ...overrides,
});

test("Nada-equivalent tiers use active and draft product boundaries", () => {
  assert.equal(
    requiredPlanForProductCount(100).name,
    BILLING_PLAN_NAMES.STARTER,
  );
  assert.equal(
    requiredPlanForProductCount(101).name,
    BILLING_PLAN_NAMES.GROWTH,
  );
  assert.equal(
    requiredPlanForProductCount(1_000).name,
    BILLING_PLAN_NAMES.GROWTH,
  );
  assert.equal(requiredPlanForProductCount(1_001).name, BILLING_PLAN_NAMES.PRO);
  assert.equal(
    requiredPlanForProductCount(10_000).name,
    BILLING_PLAN_NAMES.PRO,
  );
  assert.equal(
    requiredPlanForProductCount(10_001).name,
    BILLING_PLAN_NAMES.ENTERPRISE,
  );
});

test("partner development and Shopify trial stores receive free access", () => {
  for (const shopPlan of [
    { ...paidShop, partnerDevelopment: true, publicDisplayName: "Development" },
    { ...paidShop, publicDisplayName: "Trial" },
    { ...paidShop, shopifyPlus: true, publicDisplayName: "Plus Trial" },
  ]) {
    const access = resolveBillingEntitlement({
      productCount: 25_000,
      shopPlan,
      subscriptions: [],
    });
    assert.equal(access.accessAllowed, true);
    assert.equal(access.accessReason, "FREE_DEVELOPMENT_STORE");
  }
});

test("a paid store without a subscription is blocked", () => {
  const access = resolveBillingEntitlement({
    productCount: 10,
    shopPlan: paidShop,
    subscriptions: [],
  });
  assert.equal(access.accessAllowed, false);
  assert.equal(access.accessReason, "PAYMENT_REQUIRED");
});

test("test subscriptions never unlock normal stores", () => {
  const access = resolveBillingEntitlement({
    productCount: 10,
    shopPlan: paidShop,
    subscriptions: [subscription(BILLING_PLAN_NAMES.STARTER, { test: true })],
  });
  assert.equal(access.accessAllowed, false);
});

test("an active subscription must cover the current product count", () => {
  const overCap = resolveBillingEntitlement({
    productCount: 101,
    shopPlan: paidShop,
    subscriptions: [subscription(BILLING_PLAN_NAMES.STARTER)],
  });
  assert.equal(overCap.accessAllowed, false);
  assert.equal(overCap.accessReason, "PLAN_LIMIT_EXCEEDED");

  const covered = resolveBillingEntitlement({
    productCount: 101,
    shopPlan: paidShop,
    subscriptions: [subscription(BILLING_PLAN_NAMES.GROWTH)],
  });
  assert.equal(covered.accessAllowed, true);
  assert.equal(covered.accessReason, "ACTIVE_SUBSCRIPTION");
  assert.equal(
    billingPlanCoversProducts(BILLING_PLAN_NAMES.GROWTH, 1_000),
    true,
  );
});
