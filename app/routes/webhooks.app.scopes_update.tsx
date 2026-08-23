import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logger } from "../services/logger.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  logger.info("App scopes webhook received", { shop, topic: String(topic) });

  const current = Array.isArray(payload.current)
    ? payload.current.filter(
        (scope): scope is string => typeof scope === "string",
      )
    : [];
  if (session) {
    await db.session.updateMany({
      where: { id: session.id, shop },
      data: { scope: current.join(",") },
    });
  }
  return new Response();
};
