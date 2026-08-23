import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  handleInventoryUpdate,
  type InventoryUpdatePayload,
} from "../services/inventory.server";

/**
 * Webhook handler for inventory_levels/update.
 *
 * Shopify sends a POST here whenever an inventory level changes.
 * We authenticate the webhook, then delegate to the service layer.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, admin, payload } =
    await authenticate.webhook(request);

  console.log(`[webhook] Received ${topic} for ${shop}`);

  if (!admin) {
    // The app was likely uninstalled — no valid session / access token.
    console.log(`[webhook] No admin context for ${shop}, skipping.`);
    return new Response();
  }

  try {
    await handleInventoryUpdate(
      admin,
      shop,
      payload as unknown as InventoryUpdatePayload,
    );
  } catch (error) {
    console.error(`[webhook] Error processing ${topic} for ${shop}:`, error);
    // Return 200 anyway so Shopify doesn't retry endlessly.
    // In production, send this to an error tracker.
  }

  return new Response();
};
