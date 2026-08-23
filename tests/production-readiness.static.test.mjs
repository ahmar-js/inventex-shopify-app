import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("production requires all runtime and alert-delivery secrets", async () => {
  const source = await read("app/shopify.server.ts");
  for (const name of [
    "SHOPIFY_API_SECRET",
    "DATABASE_URL",
    "CRON_SECRET",
    "RESEND_API_KEY",
    "ALERT_FROM_EMAIL",
  ]) {
    assert.match(source, new RegExp(`"${name}"`));
  }
});

test("ID-based follow-up writes retain the authenticated shop boundary", async () => {
  const scopes = await read("app/routes/webhooks.app.scopes_update.tsx");
  const alerts = await read("app/services/alerts.server.ts");
  const jobs = await read("app/services/jobs.server.ts");
  assert.match(scopes, /where: \{ id: session\.id, shop \}/);
  assert.match(alerts, /where: \{ id: existing\.id, shop, processed: false \}/);
  assert.doesNotMatch(
    jobs,
    /where: \{ id: job\.id, status: JobStatus\.PROCESSING \}/,
  );
});

test("API version and compliance topics remain aligned", async () => {
  const toml = await read("shopify.app.toml");
  const server = await read("app/shopify.server.ts");
  const codegen = await read(".graphqlrc.ts");
  assert.match(toml, /api_version = "2026-07"/);
  assert.match(server, /ApiVersion\.July26/);
  assert.match(codegen, /ApiVersion\.July26/);
  for (const topic of [
    "customers/data_request",
    "customers/redact",
    "shop/redact",
  ]) {
    assert.match(toml, new RegExp(topic.replace("/", "\\/")));
  }
});
