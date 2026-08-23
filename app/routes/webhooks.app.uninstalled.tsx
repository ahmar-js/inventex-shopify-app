import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { logger } from "../services/logger.server";
import {
  authenticateAndEnqueueWebhook,
  JOB_TYPES,
} from "../services/webhooks.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, job } = await authenticateAndEnqueueWebhook(
    request,
    JOB_TYPES.APP_UNINSTALLED,
  );
  await db.session.deleteMany({ where: { shop } });
  logger.info("Offline and online sessions removed after uninstall", {
    shop,
    jobId: job.id,
    jobType: JOB_TYPES.APP_UNINSTALLED,
  });
  return new Response();
};
