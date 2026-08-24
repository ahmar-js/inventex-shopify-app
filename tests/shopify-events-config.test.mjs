import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("Shopify CLI Events requirement has an authenticated async handler", async () => {
  const [toml, route] = await Promise.all([
    read("shopify.app.toml"),
    read("app/routes/events.products.tsx"),
  ]);

  assert.match(toml, /\[events\]\s+api_version = "unstable"/);
  assert.match(toml, /\[\[events\.subscription\]\]/);
  assert.match(toml, /handle = "inventex-product-events"/);
  assert.match(toml, /uri = "\/events\/products"/);
  assert.match(route, /authenticate\.webhook\(request\)/);
  assert.match(route, /enqueueWebhook\(/);
  assert.doesNotMatch(route, /collectionReorderProducts|publishableUnpublish/);
});
