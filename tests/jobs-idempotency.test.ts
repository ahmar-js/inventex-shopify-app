import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findUniqueOrThrow: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  default: {
    job: {
      create: mocks.create,
      findUniqueOrThrow: mocks.findUniqueOrThrow,
    },
  },
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { webhook: vi.fn() },
}));

import {
  enqueueJob,
  enqueueWebhook,
  JOB_TYPES,
} from "../app/services/webhooks.server";

beforeEach(() => {
  mocks.create.mockReset();
  mocks.findUniqueOrThrow.mockReset();
});

test("enqueueJob creates a shop-scoped unique job once", async () => {
  const job = { id: "job-1", shop: "alpha.myshopify.com" };
  mocks.create.mockResolvedValue(job);

  const result = await enqueueJob({
    shop: "alpha.myshopify.com",
    type: JOB_TYPES.PRODUCT_UPDATE,
    payload: { id: 1 },
    uniqueKey: "webhook:hook-1",
  });

  assert.deepEqual(result, { job, duplicate: false });
  assert.equal(mocks.create.mock.calls[0][0].data.shop, "alpha.myshopify.com");
  assert.equal(mocks.create.mock.calls[0][0].data.uniqueKey, "webhook:hook-1");
});

test("enqueueJob acknowledges a PostgreSQL unique-key collision", async () => {
  const existing = { id: "job-1", shop: "alpha.myshopify.com" };
  mocks.create.mockRejectedValue({ code: "P2002" });
  mocks.findUniqueOrThrow.mockResolvedValue(existing);

  const result = await enqueueJob({
    shop: "alpha.myshopify.com",
    type: JOB_TYPES.PRODUCT_UPDATE,
    payload: { id: 1 },
    uniqueKey: "webhook:hook-1",
  });

  assert.deepEqual(result, { job: existing, duplicate: true });
  assert.deepEqual(mocks.findUniqueOrThrow.mock.calls[0][0].where, {
    shop_uniqueKey: {
      shop: "alpha.myshopify.com",
      uniqueKey: "webhook:hook-1",
    },
  });
});

test("webhook IDs become deterministic idempotency keys", async () => {
  const job = { id: "job-2", shop: "alpha.myshopify.com" };
  mocks.create.mockResolvedValue(job);

  await enqueueWebhook({
    shop: "alpha.myshopify.com",
    topic: "PRODUCTS_UPDATE",
    webhookId: "hook-42",
    jobType: JOB_TYPES.PRODUCT_UPDATE,
    payload: { id: 42 },
  });

  const data = mocks.create.mock.calls[0][0].data;
  assert.equal(data.uniqueKey, "webhook:hook-42");
  assert.deepEqual(data.payload, {
    webhookId: "hook-42",
    topic: "PRODUCTS_UPDATE",
    data: { id: 42 },
  });
});
