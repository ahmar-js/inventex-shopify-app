import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Billing API plans match Nada tiers and include a seven-day trial", async () => {
  const [billing, shopify] = await Promise.all([
    read("app/services/billing.ts"),
    read("app/shopify.server.ts"),
  ]);
  for (const price of ["9.99", "14.99", "19.99", "39.99"]) {
    assert.match(billing, new RegExp(`amount: ${price.replace(".", "\\.")}`));
  }
  assert.match(billing, /BILLING_TRIAL_DAYS = 7/);
  assert.match(shopify, /BillingInterval\.Every30Days/);
  assert.match(shopify, /trialDays: BILLING_TRIAL_DAYS/);
});

test("billing uses Active plus Draft count and persists shop-scoped access", async () => {
  const [server, schema] = await Promise.all([
    read("app/services/billing.server.ts"),
    read("prisma/schema.prisma"),
  ]);
  assert.match(
    server,
    /productsCount\(query: "status:active,draft", limit: null\)/,
  );
  assert.match(server, /currentAppInstallation/);
  assert.match(server, /accessAllowed: false/);
  assert.match(schema, /model BillingState/);
  assert.match(schema, /shop\s+String\s+@unique/);
  assert.match(schema, /productCount\s+Int/);
  assert.match(schema, /accessAllowed\s+Boolean/);
});

test("all automation paths fail closed behind the billing gate", async () => {
  const [worker, alerts, hideActions, sortActions] = await Promise.all([
    read("app/services/jobs.server.ts"),
    read("app/services/alerts.server.ts"),
    read("app/services/hide-actions.server.ts"),
    read("app/services/collection-sort-actions.server.ts"),
  ]);
  for (const job of [
    "EVALUATE_PRODUCT",
    "HIDE_PRODUCT",
    "HIDE_VARIANT",
    "SORT_COLLECTION",
  ]) {
    assert.match(worker, new RegExp(`JOB_TYPES\\.${job}`));
  }
  assert.match(worker, /isAutomationAllowed/);
  assert.match(alerts, /accessAllowed/);
  assert.match(hideActions, /getBillingAccess/);
  assert.match(sortActions, /getBillingAccess/);
});

test("subscription and product-count changes are reconciled asynchronously", async () => {
  const [toml, subscriptionRoute, productRoute, worker] = await Promise.all([
    read("shopify.app.toml"),
    read("app/routes/webhooks.app-subscriptions.update.tsx"),
    read("app/routes/webhooks.products.create.tsx"),
    read("app/services/jobs.server.ts"),
  ]);
  assert.match(toml, /topics = \[ "app_subscriptions\/update" \]/);
  assert.match(toml, /topics = \[ "products\/create" \]/);
  assert.match(subscriptionRoute, /authenticateAndEnqueueWebhook/);
  assert.match(productRoute, /authenticateAndEnqueueWebhook/);
  assert.match(worker, /refreshBillingAccess|[Gg]etBillingAccessForShop/);
  assert.match(worker, /invalidateBillingState/);
});

test("dashboard and onboarding expose real independent feature state", async () => {
  const [dashboard, schema] = await Promise.all([
    read("app/routes/app._index.tsx"),
    read("prisma/schema.prisma"),
  ]);
  assert.match(dashboard, /title="Sorting"/);
  assert.match(dashboard, /title="Hiding"/);
  assert.match(dashboard, /title="Alerts"/);
  assert.match(dashboard, /collectionAutoSorting\.count/);
  assert.match(dashboard, /inventoryState\.count/);
  assert.match(dashboard, /alertQueue\.count/);
  assert.match(dashboard, /choice" value="SORT"/);
  assert.match(dashboard, /choice" value="HIDE"/);
  assert.match(schema, /onboardingCompleted/);
  assert.doesNotMatch(
    schema,
    /strategy\s+String|restoreBehavior|Master switch for the automation/,
  );
});

test("Hide-page exclusions also own the inventex-ignore product tag", async () => {
  const actions = await read("app/services/hide-actions.server.ts");
  assert.match(actions, /INVENTEX_IGNORE_TAG/);
  assert.match(actions, /tagsAdd/);
  assert.match(actions, /tagsRemove/);
});
