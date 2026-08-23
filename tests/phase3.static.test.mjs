import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("hide state stores delay, publication cache, lock, and redirect ownership", async () => {
  const schema = await read("prisma/schema.prisma");
  for (const field of [
    "hideEnabled",
    "hideDelayDays",
    "redirectMode",
    "redirectPath",
    "onlineStorePublicationId",
    "hideJobId",
    "productTitle",
    "productHandle",
    "redirectId",
  ]) {
    assert.match(schema, new RegExp(field));
  }
});

test("hide changes Online Store only and owns tag plus optional redirect", async () => {
  const service = await read("app/services/hide.server.ts");
  assert.match(service, /catalogType: APP/);
  assert.match(service, /onlineStorePublicationId/);
  assert.match(service, /publishableUnpublish/);
  assert.match(service, /input: \[\{ publicationId \}\]/);
  assert.doesNotMatch(service, /resourcePublicationsV2|publishedIds\.map/);
  assert.match(service, /tagsAdd/);
  assert.match(service, /INVENTEX_HIDDEN_TAG/);
  assert.match(service, /urlRedirectCreate/);
  assert.match(service, /redirectId/);
});

test("unhide is tag-gated and reverses publication, tag, and redirect", async () => {
  const service = await read("app/services/hide.server.ts");
  assert.match(service, /!hasTag\(product\.tags, INVENTEX_HIDDEN_TAG\)/);
  assert.match(service, /publishablePublish/);
  assert.match(service, /tagsRemove/);
  assert.match(service, /urlRedirectDelete/);
  assert.match(
    service,
    /Product left unpublished because Inventex tag was removed/,
  );
});

test("availability schedules delayed hides and cancels them on restock", async () => {
  const worker = await read("app/services/jobs.server.ts");
  const queue = await read("app/services/webhooks.server.ts");
  assert.match(worker, /syncHideAutomationForAvailability/);
  assert.match(worker, /JOB_TYPES\.HIDE_PRODUCT/);
  assert.match(worker, /JOB_TYPES\.UNHIDE_PRODUCT/);
  assert.match(queue, /hideRunAfter\(input\.soldOutAt, input\.delayDays\)/);
  assert.match(queue, /cancelPendingProductHide/);
  assert.match(queue, /status: "COMPLETED"/);
});

test("enable scans all products, locks settings, and disable restores app-hidden rows", async () => {
  const hideRoute = await read("app/routes/app.hide.tsx");
  const actions = await read("app/services/hide-actions.server.ts");
  const service = await read("app/services/hide.server.ts");
  assert.match(hideRoute, /name="hideDelayDays"/);
  assert.match(hideRoute, /resourcePicker/);
  assert.match(hideRoute, /App-hidden products/);
  assert.match(actions, /enqueueHideCatalogScan/);
  assert.match(actions, /hideJobId/);
  assert.match(actions, /enqueueRepublishHiddenProducts/);
  assert.match(service, /products\(first: 250, after: \$cursor\)/);
  assert.match(service, /action: "HIDDEN"/);
});

test("redirect modes live in Settings and uninstall never republishes", async () => {
  const settings = await read("app/routes/app.settings.tsx");
  const uninstall = await read("app/routes/webhooks.app.uninstalled.tsx");
  const dashboard = await read("app/routes/app._index.tsx");
  assert.match(settings, /name="redirectMode"/);
  assert.match(settings, /value="none"/);
  assert.match(settings, /value="home"/);
  assert.match(settings, /value="custom"/);
  assert.doesNotMatch(uninstall, /publishablePublish|unhideProduct|republish/);
  assert.doesNotMatch(dashboard, /inventory\.server|scanExistingProducts/);
});
