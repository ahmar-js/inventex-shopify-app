import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("runtime, app config, and codegen all use Shopify API 2026-07", async () => {
  const [toml, runtime, graphql] = await Promise.all([
    read("shopify.app.toml"),
    read("app/shopify.server.ts"),
    read(".graphqlrc.ts"),
  ]);
  assert.match(toml, /api_version = "2026-07"/);
  assert.match(runtime, /ApiVersion\.July26/);
  assert.match(graphql, /ApiVersion\.July26/);
});

test("alerts consume canonical availability and preserve four-hour cooldown", async () => {
  const alerts = await read("app/services/alerts.server.ts");
  const jobs = await read("app/services/jobs.server.ts");
  assert.match(alerts, /maybeFireAlertsForAvailability/);
  assert.doesNotMatch(alerts, /evaluateProductAvailability/);
  assert.match(alerts, /4 \* 60 \* 60 \* 1000/);
  assert.match(
    jobs,
    /maybeFireAlertsForAvailability\(job\.shop, availability\)/,
  );
});

test("daily and weekly digests use IANA timezones and persisted delivery time", async () => {
  const [schedule, alerts, schema] = await Promise.all([
    read("app/services/alerts-schedule.ts"),
    read("app/services/alerts.server.ts"),
    read("prisma/schema.prisma"),
  ]);
  assert.match(schedule, /Intl\.DateTimeFormat/);
  assert.match(schedule, /weeklyDigestDay/);
  assert.match(schedule, /lastSent\.getTime\(\) \+ WEEK_MS/);
  assert.match(alerts, /lastDigestSentAt: now/);
  assert.match(schema, /lastDigestSentAt\s+DateTime\?/);
  assert.doesNotMatch(schedule, /guessUtcOffset/);
});

test("variant jobs publish only variant IDs to the Online Store publication", async () => {
  const [variantHide, jobs, queue] = await Promise.all([
    read("app/services/variant-hide.server.ts"),
    read("app/services/jobs.server.ts"),
    read("app/services/webhooks.server.ts"),
  ]);
  assert.match(variantHide, /productVariant\(id: \$id\)/);
  assert.match(variantHide, /publishedOnPublication/);
  assert.match(variantHide, /publishableUnpublish/);
  assert.match(variantHide, /publishablePublish/);
  assert.match(variantHide, /variables: \{ id: variantId/);
  assert.match(variantHide, /resolveOnlineStorePublicationId/);
  assert.match(jobs, /syncVariantHideForAvailability/);
  assert.match(jobs, /JOB_TYPES\.HIDE_VARIANT/);
  assert.match(jobs, /JOB_TYPES\.UNHIDE_VARIANT/);
  assert.match(queue, /hide-variant:\$\{input\.shop\}:\$\{input\.variantId\}/);
});

test("variant hide owns restore state and enforces the 500-product limit", async () => {
  const [schema, service, settings] = await Promise.all([
    read("prisma/schema.prisma"),
    read("app/services/variant-hide.server.ts"),
    read("app/routes/app.settings.tsx"),
  ]);
  assert.match(schema, /model VariantInventoryState/);
  assert.match(schema, /@@unique\(\[shop, variantId\]\)/);
  assert.match(service, /productsCount/);
  assert.match(service, /limit: 501/);
  assert.match(service, /published_status:published/);
  assert.match(service, /variantInventoryState\.upsert/);
  assert.match(settings, /variantHideEnabled/);
  assert.match(settings, /up to 500 published products/);
});

test("cron authentication fails closed whenever CRON_SECRET is absent", async () => {
  const cron = await read("app/services/cron-auth.server.ts");
  assert.match(cron, /if \(!secret\)/);
  assert.match(cron, /Cron is not configured/);
  assert.doesNotMatch(cron, /NODE_ENV/);
});
