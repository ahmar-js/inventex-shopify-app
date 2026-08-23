import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../services/logger.server";
import { deleteAllShopData } from "../services/shop-data.server";
import { enqueueWebhook, JOB_TYPES } from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId } = await authenticate.webhook(request);

  if (String(topic) === "SHOP_REDACT") {
    await deleteAllShopData(shop);
    logger.info("Shop data redacted", {
      shop,
      topic: String(topic),
      webhookId,
    });
    return new Response();
  }

  const jobType =
    String(topic) === "CUSTOMERS_DATA_REQUEST"
      ? JOB_TYPES.CUSTOMERS_DATA_REQUEST
      : JOB_TYPES.CUSTOMERS_REDACT;
  const result = await enqueueWebhook({
    shop,
    topic: String(topic),
    webhookId,
    jobType,
    // Inventex stores no customer-domain data. Persist only the delivery key
    // and topic, not the compliance payload's customer identifiers.
    payload: {},
  });
  logger.info(
    result.duplicate
      ? "Duplicate compliance webhook acknowledged"
      : "Compliance webhook enqueued",
    {
      shop,
      topic: String(topic),
      webhookId,
      jobId: result.job.id,
      jobType,
    },
  );
  return new Response();
};
