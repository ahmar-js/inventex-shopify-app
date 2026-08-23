import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const modelNames = [
  "shopifyApiMetric",
  "operationalEvent",
  "deadLetterJob",
  "billingState",
  "alertQueue",
  "alertSent",
  "alertSettings",
  "collectionAutoSorting",
  "collectionRule",
  "excludedProduct",
  "productAvailabilityState",
  "variantInventoryState",
  "inventoryState",
  "shopSettings",
  "job",
  "session",
] as const;

const mocks = vi.hoisted(() => {
  const names = [
    "shopifyApiMetric",
    "operationalEvent",
    "deadLetterJob",
    "billingState",
    "alertQueue",
    "alertSent",
    "alertSettings",
    "collectionAutoSorting",
    "collectionRule",
    "excludedProduct",
    "productAvailabilityState",
    "variantInventoryState",
    "inventoryState",
    "shopSettings",
    "job",
    "session",
  ];
  return Object.fromEntries(
    names.map((name) => [name, { deleteMany: vi.fn() }]),
  ) as Record<string, { deleteMany: ReturnType<typeof vi.fn> }>;
});

const transaction = vi.hoisted(() => vi.fn());

vi.mock("../app/db.server", () => ({
  default: {
    ...mocks,
    $transaction: transaction,
  },
}));

import { deleteAllShopData } from "../app/services/shop-data.server";

beforeEach(() => {
  transaction.mockReset();
  transaction.mockImplementation(async (operations) => Promise.all(operations));
  for (const name of modelNames) {
    mocks[name].deleteMany.mockReset();
    mocks[name].deleteMany.mockResolvedValue({ count: 1 });
  }
});

test("shop redaction deletes every shop-owned model in one transaction", async () => {
  await deleteAllShopData("alpha.myshopify.com");

  assert.equal(transaction.mock.calls.length, 1);
  assert.equal(transaction.mock.calls[0][0].length, modelNames.length);
  for (const name of modelNames) {
    assert.deepEqual(mocks[name].deleteMany.mock.calls, [
      [{ where: { shop: "alpha.myshopify.com" } }],
    ]);
  }
});
