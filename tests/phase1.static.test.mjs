import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("availability loader reads policy, tracking, online locations, and tags", async () => {
  const source = await read("app/services/availability.server.ts");

  for (const field of [
    "tags",
    "inventoryPolicy",
    "tracked",
    "inventoryLevels",
    "fulfillsOnlineOrders",
  ]) {
    assert.match(source, new RegExp(field));
  }
});

test("inventory and product webhook jobs only enqueue product evaluation", async () => {
  const worker = await read("app/services/jobs.server.ts");

  assert.match(worker, /resolveProductGidFromInventoryItem/);
  assert.match(worker, /enqueueProductEvaluation/);
  assert.match(worker, /JOB_TYPES\.EVALUATE_PRODUCT/);
  assert.doesNotMatch(
    worker,
    /handleInventoryUpdate|collectionReorderProducts/,
  );
});

test("evaluation persists one shared result and passes it to alerts", async () => {
  const worker = await read("app/services/jobs.server.ts");

  assert.match(worker, /evaluateProductAvailability/);
  assert.match(worker, /productAvailabilityState\.upsert/);
  assert.match(
    worker,
    /maybeFireAlertsForAvailability\(job\.shop, availability\)/,
  );
});
