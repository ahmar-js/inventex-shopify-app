import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../services/logger.server";
import {
  enqueueWebhook,
  JOB_TYPES,
} from "../services/webhooks.server";

interface ProductEventPayload {
  query_variables?: { productId?: unknown };
}

/**
 * Additive Shopify Events handler required by the current CLI configuration
 * schema. Classic webhooks remain enabled; this route follows the same
 * authenticate, deduplicate, enqueue, and return pattern.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload } =
    await authenticate.webhook(request);
  const eventPayload = payload as ProductEventPayload;
  const productId =
    request.headers.get("Shopify-Resource-Id") ??
    (typeof eventPayload.query_variables?.productId === "string"
      ? eventPayload.query_variables.productId
      : null);

  if (!productId) {
    logger.warn("Product event acknowledged without a product ID", {
      shop,
      topic: String(topic),
      webhookId,
    });
    return new Response();
  }

  const result = await enqueueWebhook({
    shop,
    topic: `${String(topic)}/update`,
    webhookId,
    jobType: JOB_TYPES.PRODUCT_UPDATE,
    payload: { productId },
  });
  logger.info(
    result.duplicate ? "Duplicate product event acknowledged" : "Product event enqueued",
    {
      shop,
      topic: String(topic),
      webhookId,
      jobId: result.job.id,
      jobType: JOB_TYPES.PRODUCT_UPDATE,
      productId,
    },
  );
  return new Response();
};
