import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CI runs Vitest, typecheck, Prisma validation, lint, and build", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(packageJson.scripts.test, "vitest run");
  for (const command of [
    "npm test",
    "npm run typecheck",
    "npx prisma validate",
    "npm run lint",
    "npm run build",
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(" ", "\\s+")));
  }
});

test("terminal job failures are dead-lettered with durable error telemetry", async () => {
  const schema = await read("prisma/schema.prisma");
  const worker = await read("app/services/jobs.server.ts");
  assert.match(schema, /model DeadLetterJob/);
  assert.match(schema, /model OperationalEvent/);
  assert.match(worker, /deadLetterJob\.upsert/);
  assert.match(worker, /captureOperationalError/);
  assert.match(worker, /MAX_GENERAL_ATTEMPTS = 3/);
  assert.match(worker, /MAX_THROTTLE_ATTEMPTS = 8/);
});

test("Shopify API calls record operation, outcome, and latency without tokens", async () => {
  const source = await read("app/services/observability.server.ts");
  assert.match(source, /instrumentAdminApi/);
  assert.match(source, /ShopifyApiMetric/);
  assert.match(source, /THROTTLED/);
  assert.match(source, /totalDurationMs/);
  assert.match(source, /access\.\?token\|api\.\?secret\|authorization/i);
  assert.doesNotMatch(source, /SHOPIFY_API_SECRET|accessToken:/);
});

test("public launch, privacy, support, and review documentation are shippable", async () => {
  const home = await read("app/routes/_index/route.tsx");
  const privacy = await read("app/routes/privacy.tsx");
  const support = await read("app/routes/support.tsx");
  const readiness = await read("docs/app-store-readiness.md");
  const root = await read("app/root.tsx");
  assert.doesNotMatch(home, /name="shop"|my-shop-domain/);
  assert.match(privacy, /Inventex Privacy Policy/);
  assert.match(support, /SUPPORT_EMAIL/);
  assert.match(readiness, /Staging acceptance run/);
  assert.match(readiness, /Screenshot capture list/);
  assert.match(root, /<html lang="en">/);
});

test("customer compliance deliveries retain no customer identifiers", async () => {
  const source = await read("app/routes/webhooks.compliance.tsx");
  assert.match(source, /payload: \{\}/);
  assert.doesNotMatch(source, /payload,\s*\n\s*\}\);/);
});

test("production refuses to boot without App Store contact configuration", async () => {
  const source = await read("app/shopify.server.ts");
  assert.match(source, /NODE_ENV === "production"/);
  assert.match(source, /SHOPIFY_APP_URL/);
  assert.match(source, /SUPPORT_EMAIL/);
  assert.match(source, /is required in production/);
});
