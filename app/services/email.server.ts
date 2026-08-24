/**
 * Server-only transactional email service backed by Resend.
 *
 * RESEND_API_KEY is always required to deliver email. ALERT_FROM_EMAIL is
 * required in production; development falls back to Resend's onboarding
 * sender so a developer can test without a verified domain.
 */

import { Resend, type CreateEmailOptions } from "resend";
import { logger } from "./logger.server";

export const DEVELOPMENT_EMAIL_SENDER =
  "Inventex <onboarding@resend.dev>";

let resendClient: Resend | null = null;
let resendApiKey: string | null = null;

export interface TransactionalEmailPayload {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  /** Optional shop context included in structured logs. */
  shop?: string;
}

export interface TransactionalEmailResult {
  id: string;
}

export class EmailDeliveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "EmailDeliveryError";
  }
}

export class EmailConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigurationError";
  }
}

export interface AlertEmailPayload {
  to: string[];
  shop: string;
  subject: string;
  productTitle: string;
  /** Variant title; empty when checking at product level. */
  variantTitle: string;
  alertType: "LOW_STOCK" | "OUT_OF_STOCK";
  quantity: number;
  threshold: number;
  productAdminUrl: string;
}

export interface DigestEmailPayload {
  to: string[];
  shop: string;
  subject: string;
  items: Array<{
    productTitle: string;
    variantTitle: string;
    alertType: "LOW_STOCK" | "OUT_OF_STOCK";
    quantity: number;
    threshold: number;
    productAdminUrl: string;
  }>;
}

export function resolveEmailSender() {
  const configured = process.env.ALERT_FROM_EMAIL?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return DEVELOPMENT_EMAIL_SENDER;
  throw new EmailConfigurationError(
    "ALERT_FROM_EMAIL is required to send Inventex email in production",
  );
}

/**
 * Reusable delivery helper for all Inventex transactional email.
 * Supports HTML, plain text, or both without exposing Resend to callers.
 */
export async function sendEmail(
  payload: TransactionalEmailPayload,
): Promise<TransactionalEmailResult> {
  const recipients = Array.isArray(payload.to) ? payload.to : [payload.to];
  if (recipients.length === 0 || recipients.some((item) => !item.trim())) {
    throw new Error("At least one email recipient is required");
  }
  if (!payload.subject.trim()) throw new Error("Email subject is required");

  const html = payload.html?.trim() ? payload.html : undefined;
  const plainText = payload.text?.trim() ? payload.text : undefined;
  if (!html && !plainText) {
    throw new Error("Email HTML or plain-text content is required");
  }

  const content = html
    ? plainText
      ? { html, text: plainText }
      : { html }
    : { text: plainText! };
  try {
    const apiKey = requiredApiKey();
    const from = resolveEmailSender();
    const client = getResendClient(apiKey);
    const message: CreateEmailOptions = {
      from,
      to: payload.to,
      subject: payload.subject,
      ...content,
    };
    const { data, error } = await client.emails.send(message);
    if (error) throw new EmailDeliveryError(error.message, error);
    if (!data?.id) {
      throw new EmailDeliveryError("Resend returned no email ID");
    }

    logger.info("Transactional email sent", {
      shop: payload.shop,
      emailId: data.id,
      recipientCount: recipients.length,
    });
    return { id: data.id };
  } catch (error) {
    logger.error("Transactional email delivery failed", {
      shop: payload.shop,
      recipientCount: recipients.length,
      error,
    });
    if (
      error instanceof EmailDeliveryError ||
      error instanceof EmailConfigurationError
    ) {
      throw error;
    }
    throw new EmailDeliveryError("Email delivery failed", error);
  }
}

export async function sendAlertEmail(
  payload: AlertEmailPayload,
): Promise<void> {
  await sendEmail({
    to: payload.to,
    shop: payload.shop,
    subject: payload.subject,
    html: buildSingleAlertHtml(payload),
    text: buildSingleAlertText(payload),
  });
}

export async function sendDigestEmail(
  payload: DigestEmailPayload,
): Promise<void> {
  await sendEmail({
    to: payload.to,
    shop: payload.shop,
    subject: payload.subject,
    html: buildDigestHtml(payload),
    text: buildDigestText(payload),
  });
}

function requiredApiKey() {
  const value = process.env.RESEND_API_KEY?.trim();
  if (!value) {
    throw new EmailConfigurationError(
      "RESEND_API_KEY is required to send Inventex email",
    );
  }
  return value;
}

function getResendClient(apiKey: string) {
  if (!resendClient || resendApiKey !== apiKey) {
    resendClient = new Resend(apiKey);
    resendApiKey = apiKey;
  }
  return resendClient;
}

const CSS = `
  body { margin:0; padding:0; background:#f4f6f8; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
  .wrap { max-width:600px; margin:32px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .header { background:#1a1c1e; padding:24px 32px; }
  .header h1 { margin:0; color:#fff; font-size:20px; font-weight:600; }
  .header p { margin:4px 0 0; color:#adb5bd; font-size:13px; }
  .body { padding:32px; }
  .badge { display:inline-block; border-radius:20px; padding:4px 12px; font-size:12px; font-weight:600; letter-spacing:.4px; margin-bottom:20px; }
  .badge-low { background:#fff3cd; color:#856404; }
  .badge-out { background:#f8d7da; color:#842029; }
  .product-card { background:#f8f9fa; border-radius:8px; padding:20px; margin-bottom:24px; border-left:4px solid #458fff; }
  .product-title { font-size:18px; font-weight:600; color:#1a1c1e; margin:0 0 4px; }
  .variant-title { font-size:14px; color:#6d7175; margin:0 0 16px; }
  .qty { font-size:32px; font-weight:700; color:#1a1c1e; }
  .qty-label,.threshold-note { font-size:13px; color:#6d7175; }
  .btn { display:inline-block; background:#458fff; color:#fff!important; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600; font-size:14px; margin-top:8px; }
  .footer { background:#f8f9fa; padding:20px 32px; text-align:center; font-size:12px; color:#8c9196; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:24px; }
  table.items th { background:#f8f9fa; padding:10px 12px; text-align:left; font-size:12px; color:#6d7175; border-bottom:1px solid #e1e3e5; }
  table.items td { padding:12px; font-size:14px; color:#1a1c1e; border-bottom:1px solid #f1f1f1; vertical-align:top; }
`;

function buildSingleAlertHtml(payload: AlertEmailPayload) {
  const outOfStock = payload.alertType === "OUT_OF_STOCK";
  const variant = payload.variantTitle
    ? `<p class="variant-title">Variant: ${escapeHtml(payload.variantTitle)}</p>`
    : "";
  const threshold = outOfStock
    ? ""
    : `<p class="threshold-note">Your threshold is set to &le; ${payload.threshold} units.</p>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="header"><h1>Inventex &mdash; Stock Alert</h1><p>${escapeHtml(payload.shop)}</p></div>
  <div class="body">
    <span class="badge ${outOfStock ? "badge-out" : "badge-low"}">${outOfStock ? "OUT OF STOCK" : "LOW STOCK"}</span>
    <div class="product-card">
      <p class="product-title">${escapeHtml(payload.productTitle)}</p>${variant}
      <div class="qty">${payload.quantity}</div><div class="qty-label">units remaining</div>${threshold}
    </div>
    <a class="btn" href="${escapeHtml(payload.productAdminUrl)}">View product in Shopify</a>
  </div>
  <div class="footer">You&rsquo;re receiving this because you enabled stock alerts in Inventex.</div>
</div></body></html>`;
}

function buildSingleAlertText(payload: AlertEmailPayload) {
  const lines = [
    "Inventex stock alert",
    `Store: ${payload.shop}`,
    `Status: ${payload.alertType === "OUT_OF_STOCK" ? "Out of stock" : "Low stock"}`,
    `Product: ${payload.productTitle}`,
  ];
  if (payload.variantTitle) lines.push(`Variant: ${payload.variantTitle}`);
  lines.push(`Quantity: ${payload.quantity}`);
  if (payload.alertType === "LOW_STOCK") {
    lines.push(`Low-stock threshold: ${payload.threshold}`);
  }
  lines.push(`View in Shopify: ${payload.productAdminUrl}`);
  return lines.join("\n");
}

function buildDigestHtml(payload: DigestEmailPayload) {
  const rows = payload.items
    .map((item) => {
      const outOfStock = item.alertType === "OUT_OF_STOCK";
      const variant = item.variantTitle
        ? ` <span style="color:#6d7175;font-size:12px">(${escapeHtml(item.variantTitle)})</span>`
        : "";
      return `<tr>
        <td>${escapeHtml(item.productTitle)}${variant}</td>
        <td><span style="color:${outOfStock ? "#842029" : "#856404"};font-weight:600">${outOfStock ? "Out of stock" : "Low stock"}</span></td>
        <td style="text-align:right">${item.quantity}</td>
        <td><a href="${escapeHtml(item.productAdminUrl)}" style="color:#458fff">View</a></td>
      </tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="header"><h1>Inventex &mdash; Stock Digest</h1><p>${escapeHtml(payload.shop)}</p></div>
  <div class="body">
    <p style="color:#1a1c1e;margin-top:0">Here&rsquo;s a summary of ${payload.items.length} stock alert${payload.items.length === 1 ? "" : "s"} since your last digest.</p>
    <table class="items"><thead><tr><th>Product</th><th>Alert</th><th style="text-align:right">Qty</th><th>Link</th></tr></thead><tbody>${rows}</tbody></table>
  </div>
  <div class="footer">You&rsquo;re receiving this because you enabled stock alerts in Inventex.</div>
</div></body></html>`;
}

function buildDigestText(payload: DigestEmailPayload) {
  const items = payload.items.map((item, index) => {
    const title = item.variantTitle
      ? `${item.productTitle} (${item.variantTitle})`
      : item.productTitle;
    return [
      `${index + 1}. ${title}`,
      `Status: ${item.alertType === "OUT_OF_STOCK" ? "Out of stock" : "Low stock"}`,
      `Quantity: ${item.quantity}`,
      item.alertType === "LOW_STOCK"
        ? `Low-stock threshold: ${item.threshold}`
        : null,
      `View in Shopify: ${item.productAdminUrl}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "Inventex stock digest",
    `Store: ${payload.shop}`,
    "",
    ...items.flatMap((item) => [item, ""]),
  ].join("\n").trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
