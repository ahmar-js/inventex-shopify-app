import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { sendAlertEmail } from "../app/services/email.server";

const payload = {
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

afterEach(() => vi.unstubAllEnvs());

test("alert delivery fails closed without a Resend API key", async () => {
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("ALERT_FROM_EMAIL", "alerts@example.com");
  await assert.rejects(sendAlertEmail(payload), /RESEND_API_KEY is required/);
});

test("alert delivery fails closed without a verified sender", async () => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("ALERT_FROM_EMAIL", "");
  await assert.rejects(sendAlertEmail(payload), /ALERT_FROM_EMAIL is required/);
});
