/**
 * Resource route — POST /app/alerts/preview
 *
 * No default export (no component), so React Router returns the action
 * return value as JSON directly, never rendering a full HTML page.
 * This lets the client call it with a plain fetch() + bearer token.
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { sendDigestEmail } from "../services/email.server";
import { getBillingAccess } from "../services/billing.server";
import { billingAccessMessage } from "../services/billing";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const billing = await getBillingAccess({ admin, session, force: true });
  if (!billing.accessAllowed) {
    return Response.json({
      previewSent: false,
      previewError:
        billingAccessMessage(billing) ?? "Automation requires a plan.",
    });
  }

  const settings = await db.alertSettings.findUnique({ where: { shop } });
  if (!settings || !settings.lowStockEnabled) {
    return Response.json({
      previewSent: false,
      previewError:
        "Enable low stock alerts first, then save before sending a preview.",
    });
  }

  const emails = settings.alertEmails
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (emails.length === 0) {
    return Response.json({
      previewSent: false,
      previewError:
        "Add at least one recipient email first, then save before sending a preview.",
    });
  }

  const shopHandle = shop.replace(".myshopify.com", "");
  const productAdminUrl = `https://admin.shopify.com/store/${shopHandle}/products`;
  const variantTitle =
    settings.stockCheckLevel === "VARIANT" ? "Size: M / Color: Blue" : "";
  const items = [
    ...(settings.alertOnOutOfStock
      ? [
          {
            productTitle: "Sample sold-out product",
            variantTitle,
            alertType: "OUT_OF_STOCK" as const,
            quantity: 0,
            threshold: settings.lowStockThreshold,
            productAdminUrl,
          },
        ]
      : []),
    ...(settings.alertOnLowStock
      ? [
          {
            productTitle: "Sample low-stock product",
            variantTitle,
            alertType: "LOW_STOCK" as const,
            quantity: settings.lowStockThreshold,
            threshold: settings.lowStockThreshold,
            productAdminUrl,
          },
        ]
      : []),
  ];

  try {
    await sendDigestEmail({
      to: emails,
      shop,
      subject: `[Preview] Inventex Stock Alert Summary — ${items.length} alert${items.length === 1 ? "" : "s"}`,
      title: "Stock Alert Summary Preview",
      intro: `${items.length} sample stock alert${items.length === 1 ? "" : "s"} grouped into one email.`,
      items,
    });
    return Response.json({
      previewSent: true,
      previewEmails: emails.join(", "),
    });
  } catch (err: unknown) {
    return Response.json({
      previewSent: false,
      previewError:
        err instanceof Error ? err.message : "Failed to send preview email.",
    });
  }
};
