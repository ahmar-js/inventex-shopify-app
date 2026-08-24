import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mocks.send };
  },
}));

vi.mock("../app/services/logger.server", () => ({
  logger: {
    debug: vi.fn(),
    info: mocks.info,
    warn: vi.fn(),
    error: mocks.error,
  },
}));

import {
  DEVELOPMENT_EMAIL_SENDER,
  sendAlertEmail,
  sendEmail,
} from "../app/services/email.server";

const alertPayload = {
  to: ["merchant@example.com"],
  shop: "alpha.myshopify.com",
  subject: "Inventory alert",
  productTitle: "Test product",
  variantTitle: "",
  alertType: "OUT_OF_STOCK" as const,
  quantity: 0,
  threshold: 5,
  productAdminUrl: "https://admin.shopify.com/store/alpha/products/1",
};

beforeEach(() => {
  mocks.send.mockReset();
  mocks.info.mockReset();
  mocks.error.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

test("delivery fails closed without a Resend API key", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("ALERT_FROM_EMAIL", "");
  await assert.rejects(sendAlertEmail(alertPayload), /RESEND_API_KEY is required/);
});

test("production delivery fails closed without a verified sender", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("ALERT_FROM_EMAIL", "");
  await assert.rejects(sendAlertEmail(alertPayload), /ALERT_FROM_EMAIL is required/);
});

test("development uses the Resend onboarding sender and supports HTML plus text", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("ALERT_FROM_EMAIL", "");
  mocks.send.mockResolvedValue({ data: { id: "email_123" }, error: null });

  const result = await sendEmail({
    to: "merchant@example.com",
    shop: "alpha.myshopify.com",
    subject: "Inventex test",
    html: "<p>HTML test</p>",
    text: "Plain-text test",
  });

  assert.equal(result.id, "email_123");
  assert.deepEqual(mocks.send.mock.calls[0][0], {
    from: DEVELOPMENT_EMAIL_SENDER,
    to: "merchant@example.com",
    subject: "Inventex test",
    html: "<p>HTML test</p>",
    text: "Plain-text test",
  });
  assert.equal(mocks.info.mock.calls[0][1].recipientCount, 1);
});

test("stock alert templates include HTML and plain-text alternatives", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("ALERT_FROM_EMAIL", "Inventex <alerts@example.com>");
  mocks.send.mockResolvedValue({ data: { id: "email_456" }, error: null });

  await sendAlertEmail(alertPayload);

  const message = mocks.send.mock.calls[0][0];
  assert.match(message.html, /Test product/);
  assert.match(message.text, /Product: Test product/);
  assert.match(message.text, /Status: Out of stock/);
});

test("Resend failures are logged and rethrown", async () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("ALERT_FROM_EMAIL", "");
  mocks.send.mockResolvedValue({
    data: null,
    error: { message: "Resend rejected the message", name: "validation_error" },
  });

  await assert.rejects(
    sendEmail({
      to: "merchant@example.com",
      subject: "Inventex test",
      text: "Test message",
    }),
    /Resend rejected the message/,
  );
  assert.equal(mocks.error.mock.calls[0][0], "Transactional email delivery failed");
  assert.equal(mocks.error.mock.calls[0][1].recipientCount, 1);
});
