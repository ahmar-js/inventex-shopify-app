import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("collection sorting paginates, keeps Shopify manual, and chunks moves", async () => {
  const source = await read("app/services/collection-sort.server.ts");

  assert.match(source, /first: 250/);
  assert.match(source, /pageInfo \{ hasNextPage endCursor \}/);
  assert.match(
    source,
    /updateShopifyCollectionSortOrder\(admin, collectionId, "MANUAL"\)/,
  );
  assert.match(source, /chunkCollectionMoves\(moves\)/);
  assert.match(source, /waitForShopifyJob/);
  assert.match(source, /BULK_THRESHOLD = 2_000/);
  assert.match(source, /bulkOperationRunQuery/);
  assert.doesNotMatch(source, /collectionRule/);
});

test("UI changes base order and enable-all queries every collection", async () => {
  const route = await read("app/routes/app.sort-collection.tsx");
  const actions = await read("app/services/collection-sort-actions.server.ts");

  assert.doesNotMatch(route, /collectionUpdate\(/);
  assert.match(actions, /baseSortOrder: sortOrder/);
  assert.match(actions, /fetchAllCollectionIds\(admin\)/);
  assert.doesNotMatch(actions, /collectionIds.*formData/);
});

test("worker handles collection lifecycle and availability-triggered sorting", async () => {
  const worker = await read("app/services/jobs.server.ts");
  const queue = await read("app/services/webhooks.server.ts");

  assert.match(worker, /JOB_TYPES\.COLLECTION_CREATE/);
  assert.match(worker, /JOB_TYPES\.COLLECTION_UPDATE/);
  assert.match(worker, /JOB_TYPES\.COLLECTION_DELETE/);
  assert.match(worker, /enqueueSortsForProduct/);
  assert.match(queue, /`sort:\$\{input\.shop\}:\$\{input\.collectionId\}`/);
  assert.match(queue, /collectionSortDelayMs/);
});

test("new collections auto-sort by default and the setting is merchant-controlled", async () => {
  const schema = await read("prisma/schema.prisma");
  const settings = await read("app/routes/app.settings.tsx");

  assert.match(schema, /autoSortNewCollections\s+Boolean\s+@default\(true\)/);
  assert.match(settings, /name="autoSortNewCollections"/);
  assert.match(settings, /name="sortContinueSellingAsOos"/);
});
