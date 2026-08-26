import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queueFindMany: vi.fn(),
  queueUpdateMany: vi.fn(),
  settingsFindUnique: vi.fn(),
  settingsUpdateMany: vi.fn(),
  sentCreate: vi.fn(),
  sentCreateMany: vi.fn(),
  transaction: vi.fn(),
  sendDigest: vi.fn(),
  automationAllowed: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  default: {
    alertQueue: {
      findMany: mocks.queueFindMany,
      updateMany: mocks.queueUpdateMany,
    },
    alertSettings: {
      findUnique: mocks.settingsFindUnique,
      updateMany: mocks.settingsUpdateMany,
    },
    alertSent: {
      create: mocks.sentCreate,
      createMany: mocks.sentCreateMany,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("../app/services/email.server", () => ({
  sendDigestEmail: mocks.sendDigest,
}));

vi.mock("../app/services/billing.server", () => ({
  isAutomationAllowed: mocks.automationAllowed,
}));

import { flushAlertQueue } from "../app/services/alerts.server";

const now = new Date("2026-08-24T14:10:00.000Z");

function queueItems(count: number, queuedAt: Date) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    shop: "alpha.myshopify.com",
    productId: `gid://shopify/Product/${index + 1}`,
    productTitle: `Product ${index + 1}`,
    variantId: "",
    variantTitle: "",
    alertType: index % 2 === 0 ? "OUT_OF_STOCK" : "LOW_STOCK",
    quantity: index % 2 === 0 ? 0 : 2,
    queuedAt,
    processed: false,
  }));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.automationAllowed.mockResolvedValue(true);
  mocks.settingsFindUnique.mockResolvedValue({
    shop: "alpha.myshopify.com",
    lowStockEnabled: true,
    alertFrequency: "IMMEDIATE",
    alertEmails: "merchant@example.com",
    lowStockThreshold: 5,
  });
  mocks.sendDigest.mockResolvedValue(undefined);
  mocks.queueUpdateMany.mockResolvedValue({ count: 50 });
  mocks.sentCreateMany.mockResolvedValue({ count: 50 });
  mocks.transaction.mockImplementation((operations: Promise<unknown>[]) =>
    Promise.all(operations),
  );
});

test("fifty immediate stock events are delivered in one summary email", async () => {
  mocks.queueFindMany.mockResolvedValue(
    queueItems(50, new Date("2026-08-24T14:07:59.000Z")),
  );

  const result = await flushAlertQueue(now);

  assert.deepEqual(result, { processed: 50 });
  assert.equal(mocks.sendDigest.mock.calls.length, 1);
  const payload = mocks.sendDigest.mock.calls[0][0];
  assert.equal(payload.subject, "Inventex Stock Alert Summary — 50 alerts");
  assert.equal(payload.items.length, 50);
  assert.match(payload.intro, /grouped into one email/);
  assert.equal(mocks.sentCreateMany.mock.calls[0][0].data.length, 50);
  assert.equal(
    mocks.sentCreateMany.mock.calls[0][0].data[0].frequency,
    "IMMEDIATE",
  );
  assert.equal(mocks.settingsUpdateMany.mock.calls.length, 0);
});

test("immediate summaries remain queued while new events are arriving", async () => {
  mocks.queueFindMany.mockResolvedValue(
    queueItems(50, new Date("2026-08-24T14:08:01.000Z")),
  );

  const result = await flushAlertQueue(now);

  assert.deepEqual(result, { processed: 0 });
  assert.equal(mocks.sendDigest.mock.calls.length, 0);
  assert.equal(mocks.queueUpdateMany.mock.calls.length, 0);
});
