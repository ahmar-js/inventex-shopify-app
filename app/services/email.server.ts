/**
 * Email service — thin wrapper around Resend.
 *
 * Required env vars:
 *   RESEND_API_KEY   — your Resend secret key
 *   ALERT_FROM_EMAIL — verified sender, e.g. "alerts@yourdomain.com"
 *
 * Missing configuration throws before a delivery is recorded. This prevents
 * production from treating a skipped email as successfully sent.
 */

import { Resend } from "resend";

// ─── Lazy singleton ──────────────────────────────────────────

let _resend: Resend | null = null;

function getTransport() {
  const apiKey = requiredEmailEnvironment("RESEND_API_KEY");
  const from = requiredEmailEnvironment("ALERT_FROM_EMAIL");
  if (!_resend) {
    _resend = new Resend(apiKey);
  }
  return { client: _resend, from };
}

function requiredEmailEnvironment(name: "RESEND_API_KEY" | "ALERT_FROM_EMAIL") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to send Inventex alerts`);
  return value;
}

// ─── Types ──────────────────────────────────────────────────

export interface AlertEmailPayload {
  to: string[];
  shop: string;
  subject: string;
  productTitle: string;
  /** Variant title — empty string when checking at the product level */
  variantTitle: string;
  alertType: "LOW_STOCK" | "OUT_OF_STOCK";
  quantity: number;
  threshold: number;
  /** Direct admin link to the product */
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

// ─── Send single alert email ─────────────────────────────────

export async function sendAlertEmail(
  payload: AlertEmailPayload,
): Promise<void> {
  const { client, from } = getTransport();

  const { error } = await client.emails.send({
    from,
    to: payload.to,
    subject: payload.subject,
    html: buildSingleAlertHtml(payload),
  });

  if (error) {
    console.error("[email] Failed to send alert email:", error);
    throw new Error(`Email send failed: ${error.message}`);
  }

  console.log(
    `[email] Sent ${payload.alertType} alert for "${payload.productTitle}" to ${payload.to.join(", ")}`,
  );
}

// ─── Send digest (daily / weekly) ───────────────────────────

export async function sendDigestEmail(
  payload: DigestEmailPayload,
): Promise<void> {
  const { client, from } = getTransport();

  const { error } = await client.emails.send({
    from,
    to: payload.to,
    subject: payload.subject,
    html: buildDigestHtml(payload),
  });

  if (error) {
    console.error("[email] Failed to send digest email:", error);
    throw new Error(`Digest email send failed: ${error.message}`);
  }

  console.log(
    `[email] Sent digest (${payload.items.length} item(s)) for ${payload.shop} to ${payload.to.join(", ")}`,
  );
}

// ─── HTML builders ──────────────────────────────────────────

const CSS = `
  body { margin:0; padding:0; background:#f4f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  .wrap { max-width:600px; margin:32px auto; background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08); }
  .header { background:#1a1c1e; padding:24px 32px; }
  .header h1 { margin:0; color:#fff; font-size:20px; font-weight:600; }
  .header p { margin:4px 0 0; color:#adb5bd; font-size:13px; }
  .body { padding:32px; }
  .badge { display:inline-block; border-radius:20px; padding:4px 12px; font-size:12px; font-weight:600; letter-spacing:0.4px; margin-bottom:20px; }
  .badge-low  { background:#fff3cd; color:#856404; }
  .badge-out  { background:#f8d7da; color:#842029; }
  .product-card { background:#f8f9fa; border-radius:8px; padding:20px; margin-bottom:24px; border-left:4px solid #458fff; }
  .product-title { font-size:18px; font-weight:600; color:#1a1c1e; margin:0 0 4px; }
  .variant-title { font-size:14px; color:#6d7175; margin:0 0 16px; }
  .qty { font-size:32px; font-weight:700; color:#1a1c1e; }
  .qty-label { font-size:13px; color:#6d7175; margin-top:2px; }
  .threshold-note { font-size:13px; color:#6d7175; margin-top:4px; }
  .btn { display:inline-block; background:#458fff; color:#fff !important; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600; font-size:14px; margin-top:8px; }
  .footer { background:#f8f9fa; padding:20px 32px; text-align:center; font-size:12px; color:#8c9196; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:24px; }
  table.items th { background:#f8f9fa; padding:10px 12px; text-align:left; font-size:12px; color:#6d7175; border-bottom:1px solid #e1e3e5; }
  table.items td { padding:12px; font-size:14px; color:#1a1c1e; border-bottom:1px solid #f1f1f1; vertical-align:top; }
`;

function buildSingleAlertHtml(p: AlertEmailPayload): string {
  const isOut = p.alertType === "OUT_OF_STOCK";
  const badgeClass = isOut ? "badge-out" : "badge-low";
  const badgeText = isOut ? "OUT OF STOCK" : "LOW STOCK";
  const variantLine = p.variantTitle
    ? `<p class="variant-title">Variant: ${esc(p.variantTitle)}</p>`
    : "";
  const thresholdNote = !isOut
    ? `<p class="threshold-note">Your threshold is set to ≤ ${p.threshold} units.</p>`
    : "";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>Inventex &mdash; Stock Alert</h1>
    <p>${esc(p.shop)}</p>
  </div>
  <div class="body">
    <span class="badge ${badgeClass}">${badgeText}</span>
    <div class="product-card">
      <p class="product-title">${esc(p.productTitle)}</p>
      ${variantLine}
      <div class="qty">${p.quantity}</div>
      <div class="qty-label">units remaining</div>
      ${thresholdNote}
    </div>
    <a class="btn" href="${esc(p.productAdminUrl)}">View product in Shopify</a>
  </div>
  <div class="footer">You&rsquo;re receiving this because you enabled stock alerts in Inventex.</div>
</div>
</body></html>`;
}

function buildDigestHtml(p: DigestEmailPayload): string {
  const rows = p.items
    .map((item) => {
      const isOut = item.alertType === "OUT_OF_STOCK";
      const badge = isOut
        ? `<span style="color:#842029;font-weight:600">Out of stock</span>`
        : `<span style="color:#856404;font-weight:600">Low stock</span>`;
      const variant = item.variantTitle
        ? ` <span style="color:#6d7175;font-size:12px">(${esc(item.variantTitle)})</span>`
        : "";
      return `<tr>
      <td>${esc(item.productTitle)}${variant}</td>
      <td>${badge}</td>
      <td style="text-align:right">${item.quantity}</td>
      <td><a href="${esc(item.productAdminUrl)}" style="color:#458fff">View</a></td>
    </tr>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="header">
    <h1>Inventex &mdash; Stock Digest</h1>
    <p>${esc(p.shop)}</p>
  </div>
  <div class="body">
    <p style="color:#1a1c1e;margin-top:0">Here&rsquo;s a summary of ${p.items.length} stock alert${p.items.length !== 1 ? "s" : ""} since your last digest.</p>
    <table class="items">
      <thead><tr>
        <th>Product</th><th>Alert</th><th style="text-align:right">Qty</th><th>Link</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="footer">You&rsquo;re receiving this because you enabled stock alerts in Inventex.</div>
</div>
</body></html>`;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Escape HTML entities to prevent injection into email HTML. */
function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
