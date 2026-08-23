/**
 * Alert service — core business logic for stock alerts.
 *
 * Called by the inventory webhook after every stock change.
 * Responsible for:
 *  1. Loading the shop's alert settings
 *  2. Fetching current inventory from Shopify (product-level OR per-variant)
 *  3. Deciding which alert types should fire (low-stock / out-of-stock)
 *  4. Deduplication — never spam the same alert within the cooldown window
 *  5. IMMEDIATE → send email now via email.server
 *     DAILY/WEEKLY → write to AlertQueue; flushed by the cron endpoint
 */

import db from "../db.server";
import { sendAlertEmail } from "./email.server";
import type { AlertEmailPayload } from "./email.server";
import type { ProductAvailabilityResult } from "./availability.server";
import type { AvailabilityStatus } from "./availability";
import { isDigestDue } from "./alerts-schedule";
import { isAutomationAllowed } from "./billing.server";

// ─── Constants ───────────────────────────────────────────────

/** Cooldown window for IMMEDIATE alerts — prevents spam if inventory bounces */
const IMMEDIATE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Types ───────────────────────────────────────────────────

type AlertType = "LOW_STOCK" | "OUT_OF_STOCK";

interface InventoryTarget {
  productId:    string;
  productTitle: string;
  variantId:    string;  // empty string = product-level check
  variantTitle: string;
  quantity:     number;
  status:       AvailabilityStatus;
  tracked:      boolean;
}

// ─── Main entry point ────────────────────────────────────────

/**
 * Check whether any alerts should fire for a product whose inventory just
 * changed. Safe to call for every webhook — returns early when alerts are
 * disabled or not configured.
 */
export async function maybeFireAlertsForAvailability(
  shop: string,
  data: ProductAvailabilityResult,
): Promise<void> {
  if (data.ignored) return;

  const billingState = await db.billingState.findUnique({
    where: { shop },
    select: { accessAllowed: true },
  });
  if (!billingState?.accessAllowed) return;

  // ── 1. Load settings ─────────────────────────────────────
  const settings = await db.alertSettings.findUnique({ where: { shop } });
  if (!settings || !settings.lowStockEnabled) return;

  const emails = settings.alertEmails
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (emails.length === 0) return;

  // ── 2. Fetch inventory from Shopify ──────────────────────
  // ── 3. Build targets based on stockCheckLevel ────────────
  const targets: InventoryTarget[] =
    settings.stockCheckLevel === "VARIANT"
      ? data.variants.map((v) => ({
          productId:    data.productId,
          productTitle: data.productTitle,
          variantId:    v.variantId,
          variantTitle: v.title,
          quantity:     v.onlineQuantity,
          status:       v.status,
          tracked:      v.tracked,
        }))
      : [
          {
            productId:    data.productId,
            productTitle: data.productTitle,
            variantId:    "",
            variantTitle: "",
            quantity:     data.variants.reduce(
              (sum, variant) => sum + variant.onlineQuantity,
              0,
            ),
            status:       data.status,
            tracked:      data.variants.every((variant) => variant.tracked),
          },
        ];

  // ── 4. Evaluate & fire each target ───────────────────────
  for (const target of targets) {
    await evaluateTarget(target, settings, emails);
  }
}

// ─── Evaluate a single inventory target ─────────────────────

async function evaluateTarget(
  target: InventoryTarget,
  settings: {
    shop:              string;
    alertFrequency:    string;
    alertOnLowStock:   boolean;
    alertOnOutOfStock: boolean;
    lowStockThreshold: number;
    stockCheckLevel:   string;
  },
  emails: string[],
): Promise<void> {
  const { shop, alertFrequency, alertOnLowStock, alertOnOutOfStock, lowStockThreshold } = settings;

  // Determine which alert types apply
  const shouldCheckOutOfStock =
    alertOnOutOfStock && target.status === "soldOut";
  const shouldCheckLowStock   = alertOnLowStock
    && target.tracked
    && target.status === "inStock"
    && target.quantity > 0
    && target.quantity <= lowStockThreshold;

  if (!shouldCheckOutOfStock && !shouldCheckLowStock) return;

  const alertType: AlertType = shouldCheckOutOfStock ? "OUT_OF_STOCK" : "LOW_STOCK";

  // Cooldown check — don't fire duplicate alerts
  const alreadySent = await isInCooldown(
    shop,
    target.productId,
    target.variantId,
    alertType,
    alertFrequency,
  );
  if (alreadySent) {
    console.log(
      `[alerts] Skipping ${alertType} for "${target.productTitle}" (${target.variantTitle || "product"}) — cooldown active`,
    );
    return;
  }

  console.log(
    `[alerts] Firing ${alertType} for "${target.productTitle}" (${target.variantTitle || "product-level"}), qty=${target.quantity}`,
  );

  if (alertFrequency === "IMMEDIATE") {
    await sendImmediateAlert({ target, alertType, settings, emails });
  } else {
    await enqueueAlert({ target, alertType, shop });
  }
}

// ─── Immediate send ─────────────────────────────────────────

async function sendImmediateAlert({
  target,
  alertType,
  settings,
  emails,
}: {
  target:    InventoryTarget;
  alertType: AlertType;
  settings:  { shop: string; lowStockThreshold: number };
  emails:    string[];
}): Promise<void> {
  const isOut    = alertType === "OUT_OF_STOCK";
  const subject  = isOut
    ? `🚨 Out of stock: ${target.productTitle}${target.variantTitle ? ` — ${target.variantTitle}` : ""}`
    : `⚠️ Low stock: ${target.productTitle}${target.variantTitle ? ` — ${target.variantTitle}` : ""}`;

  const shopHandle = settings.shop.replace(".myshopify.com", "");
  // Extract numeric product id from GID (gid://shopify/Product/123456)
  const numericId  = target.productId.split("/").pop() ?? "";
  const productAdminUrl = `https://admin.shopify.com/store/${shopHandle}/products/${numericId}`;

  const payload: AlertEmailPayload = {
    to:               emails,
    shop:             settings.shop,
    subject,
    productTitle:     target.productTitle,
    variantTitle:     target.variantTitle,
    alertType,
    quantity:         target.quantity,
    threshold:        settings.lowStockThreshold,
    productAdminUrl,
  };

  try {
    await sendAlertEmail(payload);
    // Record the send for deduplication
    await recordAlertSent(
      settings.shop,
      target.productId,
      target.variantId,
      alertType,
      "IMMEDIATE",
    );
  } catch (err) {
    console.error("[alerts] sendAlertEmail threw:", err);
    // Do NOT re-throw — a failed email must never crash the webhook handler
  }
}

// ─── Queue for DAILY / WEEKLY ────────────────────────────────

async function enqueueAlert({
  target,
  alertType,
  shop,
}: {
  target:    InventoryTarget;
  alertType: AlertType;
  shop:      string;
}): Promise<void> {
  try {
    // Upsert: if there is already an unprocessed queue item for this
    // (shop, product, variant, alert type) just update the quantity
    // so the digest always shows the latest value.
    const existing = await db.alertQueue.findFirst({
      where: {
        shop,
        productId: target.productId,
        variantId: target.variantId,
        alertType,
        processed: false,
      },
    });

    if (existing) {
      await db.alertQueue.updateMany({
        where: { id: existing.id, shop, processed: false },
        data:  { quantity: target.quantity, queuedAt: new Date() },
      });
    } else {
      await db.alertQueue.create({
        data: {
          shop,
          productId:    target.productId,
          productTitle: target.productTitle,
          variantId:    target.variantId,
          variantTitle: target.variantTitle,
          alertType,
          quantity:     target.quantity,
        },
      });
    }

    console.log(`[alerts] Queued ${alertType} for "${target.productTitle}" (${shop})`);
  } catch (err) {
    console.error("[alerts] Failed to enqueue alert:", err);
  }
}

// ─── Cron — flush queued digests ─────────────────────────────

/**
 * Called by the cron endpoint (POST /cron/alerts).
 * Finds every shop that has unprocessed queue items, checks whether it is
 * time to send their digest, assembles and sends it.
 */
export async function flushAlertQueue(
  now = new Date(),
): Promise<{ processed: number }> {
  const unprocessed = await db.alertQueue.findMany({
    where:   { processed: false },
    orderBy: { queuedAt: "asc" },
  });

  if (unprocessed.length === 0) return { processed: 0 };

  // Group by shop
  const byShop = new Map<string, typeof unprocessed>();
  for (const item of unprocessed) {
    const list = byShop.get(item.shop) ?? [];
    list.push(item);
    byShop.set(item.shop, list);
  }

  let totalProcessed = 0;

  for (const [shop, items] of byShop) {
    if (!(await isAutomationAllowed(shop))) continue;
    const settings = await db.alertSettings.findUnique({ where: { shop } });
    if (!settings || !settings.lowStockEnabled) continue;

    const emails = settings.alertEmails
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    if (emails.length === 0) continue;

    // Check if it is time to send based on the shop's schedule
    if (!isDigestDue(settings, now)) {
      console.log(`[alerts] Shop ${shop} not yet due for digest, skipping`);
      continue;
    }

    // Build digest items
    const shopHandle = shop.replace(".myshopify.com", "");
    const digestItems = items.map((item) => {
      const numericId      = item.productId.split("/").pop() ?? "";
      const productAdminUrl = `https://admin.shopify.com/store/${shopHandle}/products/${numericId}`;
      return {
        productTitle: item.productTitle,
        variantTitle: item.variantTitle,
        alertType:    item.alertType as "LOW_STOCK" | "OUT_OF_STOCK",
        quantity:     item.quantity,
        threshold:    settings.lowStockThreshold,
        productAdminUrl,
      };
    });

    const frequency = settings.alertFrequency;
    const subject   = frequency === "WEEKLY"
      ? `Inventex Weekly Stock Digest — ${items.length} alert${items.length !== 1 ? "s" : ""}`
      : `Inventex Daily Stock Digest — ${items.length} alert${items.length !== 1 ? "s" : ""}`;

    try {
      const { sendDigestEmail } = await import("./email.server");
      await sendDigestEmail({ to: emails, shop, subject, items: digestItems });

      const itemIds = items.map(({ id }) => id);
      await db.$transaction([
        db.alertQueue.updateMany({
          where: { shop, id: { in: itemIds }, processed: false },
          data: { processed: true },
        }),
        db.alertSettings.updateMany({
          where: { shop },
          data: { lastDigestSentAt: now },
        }),
        db.alertSent.create({
          data: {
            shop,
            productId: "*",
            variantId: "*",
            alertType: "DIGEST",
            frequency,
            sentAt: now,
          },
        }),
      ]);

      totalProcessed += items.length;
    } catch (err) {
      console.error(`[alerts] Failed to send digest for ${shop}:`, err);
    }
  }

  return { processed: totalProcessed };
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Returns true if a same alert was already sent within the cooldown window.
 */
async function isInCooldown(
  shop:      string,
  productId: string,
  variantId: string,
  alertType: AlertType,
  frequency: string,
): Promise<boolean> {
  const cooldownMs = frequency === "IMMEDIATE" ? IMMEDIATE_COOLDOWN_MS : 0;
  if (cooldownMs === 0) {
    // For DAILY/WEEKLY the deduplication is via the queue (upsert above)
    return false;
  }

  const since = new Date(Date.now() - cooldownMs);
  const recent = await db.alertSent.findFirst({
    where: {
      shop,
      productId,
      variantId,
      alertType,
      frequency,
      sentAt: { gte: since },
    },
  });
  return recent !== null;
}

async function recordAlertSent(
  shop:      string,
  productId: string,
  variantId: string,
  alertType: string,
  frequency: string,
): Promise<void> {
  await db.alertSent.create({
    data: { shop, productId, variantId, alertType, frequency },
  });
}
