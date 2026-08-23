import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Shopify config has the Phase 0 subscriptions, scopes, and API version", async () => {
  const config = await read("shopify.app.toml");
  for (const expected of [
    'api_version = "2026-07"',
    'topics = [ "inventory_levels/update" ]',
    'topics = [ "products/update" ]',
    'topics = [ "products/delete" ]',
    'topics = [ "collections/create" ]',
    'topics = [ "collections/update" ]',
    'topics = [ "collections/delete" ]',
    'compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]',
    "read_locations",
    "write_online_store_navigation",
  ]) {
    assert.match(config, new RegExp(escapeRegExp(expected)));
  }
});

test("webhook request routes only enqueue and never call Shopify inline", async () => {
  const routes = [
    "app/routes/webhooks.inventory-update.tsx",
    "app/routes/webhooks.products.update.tsx",
    "app/routes/webhooks.products.delete.tsx",
    "app/routes/webhooks.collections.create.tsx",
    "app/routes/webhooks.collections.update.tsx",
    "app/routes/webhooks.collections.delete.tsx",
  ];

  for (const route of routes) {
    const source = await read(route);
    assert.match(source, /authenticateAndEnqueueWebhook/);
    assert.doesNotMatch(
      source,
      /collectionReorderProducts|admin\.graphql|handleInventoryUpdate/,
    );
  }

  const queue = await read("app/services/webhooks.server.ts");
  assert.match(queue, /authenticate\.webhook\(request\)/);
  assert.match(queue, /db\.job\.create/);
  assert.match(queue, /webhook:\$\{input\.webhookId\}/);
});

test("worker claims PostgreSQL jobs safely and implements throttle backoff", async () => {
  const worker = await read("app/services/jobs.server.ts");
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /candidate\.status === 429/);
  assert.match(worker, /candidate\.code === "THROTTLED"/);
  assert.match(worker, /status: JobStatus\.PENDING/);
  assert.match(worker, /runAfter: new Date/);
});

test("fresh OAuth installs create default settings on API 2026-07", async () => {
  const source = await read("app/shopify.server.ts");
  const graphqlConfig = await read(".graphqlrc.ts");
  assert.match(source, /apiVersion: ApiVersion\.July26/);
  assert.match(graphqlConfig, /apiVersion: ApiVersion\.July26/);
  assert.match(source, /afterAuth/);
  assert.match(source, /shopSettings\.upsert/);
  assert.match(source, /create: \{ shop: session\.shop \}/);
});

test("cron endpoints always fail closed and Docker deploys migrations", async () => {
  const cronAuth = await read("app/services/cron-auth.server.ts");
  const dockerfile = await read("Dockerfile");
  const packageJson = JSON.parse(await read("package.json"));

  assert.doesNotMatch(cronAuth, /allowing cron request outside production/);
  assert.match(cronAuth, /Cron is not configured/);
  assert.match(dockerfile, /FROM node:20-alpine AS build/);
  assert.match(dockerfile, /RUN npm ci\n/);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(packageJson.scripts.setup, /prisma migrate deploy/);
});

test("shop redaction covers every shop-owned model", async () => {
  const cleanup = await read("app/services/shop-data.server.ts");
  for (const model of [
    "alertQueue",
    "alertSent",
    "alertSettings",
    "billingState",
    "collectionAutoSorting",
    "collectionRule",
    "excludedProduct",
    "inventoryState",
    "productAvailabilityState",
    "variantInventoryState",
    "shopSettings",
    "job",
    "session",
  ]) {
    assert.match(cleanup, new RegExp(`db\\.${model}\\.deleteMany`));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
